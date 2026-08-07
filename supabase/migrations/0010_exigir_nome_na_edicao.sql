-- ============================================================
-- Edição anônima passa a ser recusada pelo banco
--
-- POR QUE
-- A caixa que pede o nome era só do navegador. Testado: sem nome, a tela não
-- grava mesmo — zero requisições. Mas `anon` tem UPDATE nas duas tabelas e
-- `atualizado_por_nome` era nullable sem constraint nenhuma, então quem tem o
-- link gravava por fora: console do navegador, curl, qualquer coisa.
--
-- Para o uso real — saber quem destravou ou parou cada item na reunião de obra
-- — a caixa bastava. O que ela não sustentava era a conversa "eu não mudei
-- isso", porque o campo vazio não distinguia carga inicial de edição anônima.
--
-- O QUE ISTO NÃO É
-- Não é autenticação. Ninguém impede alguém de digitar um nome falso. Para
-- isso seria preciso login de verdade (a casca do rsc-platform), que é outro
-- projeto. Isto fecha só o buraco do anônimo silencioso.
--
-- POR QUE SÓ PARA anon/authenticated
-- As migrations e as edge functions rodam como service_role e precisam
-- continuar gravando sem nome de pessoa — carga de dados não tem autor humano.
-- ============================================================

-- ---- 1. As linhas que vieram das migrations ganham autor explícito ----
-- Sem isto, as 96 linhas carregadas por migration ficariam indistinguíveis de
-- uma edição anônima assim que a regra entrasse: campo vazio significaria duas
-- coisas ao mesmo tempo, que é exatamente o problema que se está corrigindo.
update compras_contratacao
   set atualizado_por_nome = 'carga inicial (planejamento)'
 where atualizado_por_nome is null or btrim(atualizado_por_nome) = '';

update compras_material
   set atualizado_por_nome = 'carga inicial (planejamento)'
 where atualizado_por_nome is null or btrim(atualizado_por_nome) = '';

update compras_evento
   set por_nome = 'carga inicial (planejamento)'
 where por_nome is null or btrim(por_nome) = '';

-- ---- 2. A regra ----
--
-- ⚠️ A versão óbvia desta função NÃO funciona, e o teste pegou:
--
--     if coalesce(btrim(new.atualizado_por_nome),'') = '' then ...
--
-- Num UPDATE que não mencione a coluna, `new.atualizado_por_nome` herda o valor
-- que já estava na linha. Como o passo 1 acima preencheu todas as linhas, o
-- campo nunca chegava vazio e a regra passava batido — o backfill derrotava a
-- checagem que ele deveria apoiar.
--
-- Por isso a exigência é sobre o PAR: quem edita tem que declarar QUEM e
-- QUANDO na mesma instrução. Um `PATCH {"status_processo":"X"}` solto não mexe
-- em `atualizado_em`, então é recusado. O app já manda os dois juntos.
create or replace function compras_exigir_nome()
returns trigger language plpgsql as $fn$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;                                   -- migrations e edge functions
  end if;
  if coalesce(btrim(new.atualizado_por_nome), '') = '' then
    raise exception
      'Edição sem identificação. Informe seu nome antes de alterar este item.'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.atualizado_em is not distinct from old.atualizado_em then
    raise exception
      'Edição sem identificação: o nome de quem alterou não foi declarado nesta operação.'
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

create or replace function compras_exigir_nome_evento()
returns trigger language plpgsql as $fn$
begin
  if current_user in ('anon', 'authenticated')
     and coalesce(btrim(new.por_nome), '') = '' then
    raise exception
      'Registro de histórico sem identificação.'
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_exigir_nome_contratacao on compras_contratacao;
create trigger trg_exigir_nome_contratacao before insert or update
  on compras_contratacao for each row execute function compras_exigir_nome();

drop trigger if exists trg_exigir_nome_material on compras_material;
create trigger trg_exigir_nome_material before insert or update
  on compras_material for each row execute function compras_exigir_nome();

drop trigger if exists trg_exigir_nome_evento on compras_evento;
create trigger trg_exigir_nome_evento before insert
  on compras_evento for each row execute function compras_exigir_nome_evento();
