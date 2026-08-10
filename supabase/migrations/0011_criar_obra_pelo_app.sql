-- =====================================================================
-- Cadastro de obra pela tela, sem reabrir o buraco que a 0006 fechou.
--
-- O PROBLEMA
-- O acompanhamento nasceu para uma obra só. Com várias, criar obra virou
-- tarefa de programador: `compras_obra` é somente-leitura para o app desde a
-- migration 0006, então cada obra nova exigia uma migration, um merge e uma
-- espera. Não dá — a lista de obras muda mais rápido que o repositório.
--
-- POR QUE NÃO BASTA DAR `insert` NA TABELA
-- Duas razões, e a segunda é a que morde:
--
--   1. Quem escreve em compras_obra escreve em `data_base`. Data-base
--      preenchida CONGELA o farol num dia fixo: a tela para de envelhecer e
--      ninguém percebe, porque tudo continua carregando normalmente. É
--      exatamente o defeito da planilha que este app existe para corrigir.
--
--   2. O guarda de permissões da 0007 declara `compras_obra → SELECT` e roda
--      de hora em hora devolvendo tudo ao lugar. Um `grant insert` na tabela
--      seria revogado sozinho em até 60 minutos, e o cadastro quebraria depois
--      do deploy, longe de quem mexeu. O guarda não olha função — então a
--      porta certa é uma RPC, não um grant.
--
-- A SAÍDA
-- Uma função `security definer` que insere APENAS o que é seguro: nome,
-- cliente e término. `data_base` não está na assinatura; obra criada aqui
-- nasce com data-base nula, que é o que mantém o farol vivo.
--
-- Idempotente: `create or replace` e grants repetíveis.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Slug: o identificador que vai para a URL (?obra=escola-ambev).
-- Fica em função própria para ter uma fonte única — o app NÃO gera slug do
-- lado dele, senão duas regras divergem no dia em que alguém acentuar diferente.
-- `translate` é preferível a `unaccent` porque não depende de extensão
-- instalada no projeto.
-- ---------------------------------------------------------------------
create or replace function public.compras_slug(p_texto text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select trim(both '-' from regexp_replace(
    lower(translate(coalesce(p_texto, ''),
      'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
      'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn')),
    '[^a-z0-9]+', '-', 'g'));
$$;

comment on function public.compras_slug(text) is
  'Nome da obra → identificador de URL. Fonte única da regra: o app não gera slug.';

-- ---------------------------------------------------------------------
-- Criação da obra.
-- ---------------------------------------------------------------------
create or replace function public.compras_criar_obra(
  p_nome                     text,
  p_cliente                  text default null,
  p_termino                  date default null,
  p_copiar_destinatarios_de  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_nome     text := nullif(btrim(p_nome), '');
  v_cliente  text := nullif(btrim(p_cliente), '');
  v_base     text;
  v_slug     text;
  v_n        integer := 1;
  v_id       uuid;
  v_copiados integer := 0;
begin
  if v_nome is null then
    raise exception 'Informe o nome da obra.' using errcode = '22023';
  end if;
  if length(v_nome) > 120 then
    raise exception 'Nome da obra muito longo (máximo 120 caracteres).' using errcode = '22023';
  end if;
  -- Término no passado quase sempre é ano digitado errado, e a obra nasceria
  -- com todo o farol vermelho sem que ninguém entendesse por quê.
  if p_termino is not null and p_termino < current_date then
    raise exception 'A data de término já passou (%). Confira o ano.', to_char(p_termino, 'DD/MM/YYYY')
      using errcode = '22023';
  end if;

  v_base := left(public.compras_slug(v_nome), 60);
  if coalesce(v_base, '') = '' then
    raise exception 'O nome precisa ter ao menos uma letra ou número.' using errcode = '22023';
  end if;

  -- Duas obras podem se chamar "Reforma da fachada" em anos diferentes. O
  -- sufixo mantém o link de cada uma estável em vez de recusar o cadastro.
  v_slug := v_base;
  while exists (select 1 from public.compras_obra o where o.slug = v_slug) loop
    v_n := v_n + 1;
    if v_n > 99 then
      raise exception 'Já existem obras demais com um nome parecido com esse.' using errcode = '22023';
    end if;
    v_slug := v_base || '-' || v_n;
  end loop;

  -- `data_base` fora da lista de propósito — ver o cabeçalho.
  insert into public.compras_obra (slug, nome, cliente, termino_obra)
  values (v_slug, v_nome, v_cliente, p_termino)
  returning id into v_id;

  -- Sem isto, obra nova nasce sem ninguém na lista: o alerta diário monta o
  -- e-mail, não encontra destinatário e não envia — sem erro, só silêncio. É a
  -- falha mais fácil de não perceber em todo o fluxo.
  if p_copiar_destinatarios_de is not null then
    insert into public.compras_destinatario (obra_id, nome, email, papel)
    select v_id, d.nome, d.email, d.papel
      from public.compras_destinatario d
     where d.obra_id = p_copiar_destinatarios_de
       and d.ativo
    on conflict (obra_id, email) do nothing;
    get diagnostics v_copiados = row_count;
  end if;

  return jsonb_build_object(
    'id', v_id, 'slug', v_slug, 'nome', v_nome,
    'destinatarios_copiados', v_copiados);
end;
$$;

comment on function public.compras_criar_obra(text, text, date, uuid) is
  'Cria a obra a partir da tela. Insere só nome/cliente/término — data_base '
  'continua inalcançável pelo app, que é o motivo de a tabela ser somente-leitura.';

-- O helper de slug é detalhe interno: quem chama é a função acima, já como dona.
revoke all on function public.compras_slug(text) from public;
revoke all on function public.compras_criar_obra(text, text, date, uuid) from public;
grant execute on function public.compras_criar_obra(text, text, date, uuid) to anon, authenticated;
