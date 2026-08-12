-- =====================================================================
-- Prazos de compra passam a sair do cronograma vigente (Ambev ATUALIZADO
-- 30/07, término 19/10). Substitui a referência adotada pela migration 0008.
--
-- POR QUE ESTA MIGRATION EXISTE
-- Existem DOIS cronogramas do mesmo projeto, ambos com 279 tarefas e a mesma
-- linha de base 0 (a contratual, término 29/06/2026 — já vencida):
--
--   • Cronograma_Ambev_semana_29 (21/07), salvo em 05/08 — termina 10/12
--   • Cronograma Ambev ATUALIZADO -30-07,  salvo em 11/08 — termina 19/10
--
-- Eles têm 216 tarefas idênticas e 63 diferentes: o segundo é o primeiro
-- comprimido em 52 dias. A 0008 adotou o `semana_29`. O planejamento reviu e
-- definiu o `ATUALIZADO 30/07` como o plano que a obra executa, então é dele
-- que os prazos de compra passam a sair. É uma decisão de planejamento, não
-- uma correção de leitura — as datas que a 0008 gravou existem e estavam
-- transcritas corretamente, só que do outro arquivo.
--
-- ⚠️ Uma armadilha para quem for conferir: em CADA arquivo a linha de base 1 é
-- idêntica ao plano atual daquele mesmo arquivo, nas 279 tarefas. A base 1 é
-- uma fotografia do próprio plano, não uma referência comum aos dois — não dá
-- para usá-la para decidir qual arquivo vale. O mesmo vale para as 6
-- atividades que a 0008 não tocou (emboço, jardineiras, ar-condicionado, laje,
-- copa, comunicação visual): elas batem com os DOIS arquivos, porque estão
-- entre as 216 tarefas iguais. Não são evidência de nada.
--
-- O BUG QUE INDEPENDE DA ESCOLHA
-- A 0008 reescreveu `data_inicio` e não tocou em `data_termino`. Hoje, no
-- banco, duas atividades terminam antes de começar:
--   item 2 Esquadrias    — começa 02/11, termina 04/09
--   item 3 Revestimento  — começa 21/09, termina 11/09
-- Por isso esta migration grava os DOIS lados do período, e no fim cria uma
-- constraint para que a próxima carga torta não passe despercebida.
--
-- O QUE MUDA NO PRAZO (soma 285 dias de folga que não existiam, em 8 pacotes)
--   item  2 Esquadrias      18/09 → 31/05   110 dias mais cedo (já vencido)
--   item  3 Revestimento    01/09 → 25/06    68 dias mais cedo (já vencido)
--   item 17 Informática     31/10 → 12/09    49 dias mais cedo
--   item 15 Mobiliário      12/08 → 14/07    29 dias mais cedo (já vencido)
--   item  9 Pavimentação    01/09 → 21/08    11 dias mais cedo
--   item 11 Pisos internos  15/08 → 07/08     8 dias mais cedo (já vencido)
--   item 13 Pintura interna 25/09 → 20/09     5 dias mais cedo
--   item 14 Pintura externa 25/09 → 20/09     5 dias mais cedo
--   item 12 Forro de gesso  13/08 → 08/09    26 dias mais TARDE
-- Quatro deles vencem no passado: não é efeito colateral desta migration, é a
-- urgência que estava escondida aparecendo. Compras precisa ser avisado.
--
-- O PRAZO É RECALCULADO AQUI, NÃO DEIXADO PARA O GATILHO
-- O gatilho da 0009 só recalcula quando `antecedencia_dias` da linha não é
-- nulo, e pavimentação, pintura interna e externa estão com ele nulo — ficariam
-- com início novo e prazo velho, que é pior que o estado de hoje porque
-- pareceria consertado. Onde o gatilho age, ele usa a mesma fórmula e chega no
-- mesmo valor. A antecedência de cada pacote é preservada: ela é decisão de
-- compras, não do cronograma.
--
-- NÃO MEXIDAS de propósito
--   item 4 Piso externo: mapeamento ambíguo (1.10.3.4 e 1.10.4.3) e já
--   CONTRATADO — o prazo não tem mais efeito.
--   item 7 Contrapiso: fica em 22/07, que é a data do `semana_29`. No
--   cronograma vigente a 1.5.2.5 começa 20/08, ou seja, seguir o novo
--   arquivo AFROUXARIA um prazo que já venceu. Mantida a data mais cedo de
--   propósito; a nota da linha é atualizada abaixo para não seguir citando a
--   base 1 do arquivo antigo como se fosse a referência em vigor.
--
-- Idempotente: reaplicar não muda nada depois da primeira vez.
-- =====================================================================

do $$
declare
  v_obra   uuid;
  v_padrao integer;
begin
  select id, coalesce(antecedencia_dias, 10) into v_obra, v_padrao
    from compras_obra where slug = 'escola-ambev';
  if v_obra is null then
    raise notice 'obra escola-ambev não encontrada; nada a fazer';
    return;
  end if;

  -- ---- Contratações: início e término direto das tarefas do cronograma ----
  -- Conferidos um a um contra o XML de 30/07 (WBS → Start/Finish).
  with novo(atividade, inicio, termino, wbs) as (values
    ('Esquadrias — madeira, alumínio e portas sanitárias',   date '2026-07-15', date '2026-09-04', '1.8.5'),
    ('Revestimento de piso e paredes — banheiros e cantina', date '2026-07-15', date '2026-08-25', '1.7.2'),
    ('Pavimentação externa — estacionamento e rotatória',    date '2026-08-31', date '2026-09-04', '1.10.4.6'),
    ('Pisos internos — salas e demais áreas',                date '2026-08-27', date '2026-09-11', '1.7.1'),
    ('Forro de gesso acartonado',                            date '2026-09-23', date '2026-10-19', '1.8.1'),
    ('Pintura interna — paredes e forros',                   date '2026-09-30', date '2026-10-15', '1.8.3'),
    -- pintura externa divide a 1.8.3 com a interna; ver 0012
    ('Pintura externa — fachadas e áreas externas',          date '2026-09-30', date '2026-10-15', '1.8.3'),
    ('Mobiliário — salas, biblioteca e administrativo',      date '2026-08-03', date '2026-10-19', '1.9'),
    ('Informática — computadores e rede',                    date '2026-10-12', date '2026-10-14', '1.9.3.1')
  )
  update compras_contratacao c
     set data_inicio       = n.inicio,
         data_termino      = n.termino,
         prazo_contratacao = n.inicio - coalesce(c.antecedencia_dias, v_padrao),
         atualizado_em     = now()
    from novo n
   where c.obra_id = v_obra and c.ativo and c.atividade = n.atividade
     and (c.data_inicio  is distinct from n.inicio
       or c.data_termino is distinct from n.termino);

  -- ---- Materiais: a data necessária é a data em que a atividade começa ----
  with novo(atividade, necessaria) as (values
    ('Esquadrias — madeira, alumínio e portas sanitárias',   date '2026-07-15'),
    ('Revestimento de piso e paredes — banheiros e cantina', date '2026-07-15'),
    ('Pavimentação externa — estacionamento e rotatória',    date '2026-08-31'),
    ('Pisos internos — salas e demais áreas',                date '2026-08-27'),
    ('Forro de gesso acartonado',                            date '2026-09-23'),
    ('Pintura interna — paredes e forros',                   date '2026-09-30'),
    ('Pintura de paredes — referência interna/externa compartilhada', date '2026-09-30'),
    ('Mobiliário — salas, biblioteca e administrativo',      date '2026-08-03'),
    ('Informática — computadores e rede',                    date '2026-10-12')
  )
  update compras_material m
     set data_necessaria    = n.necessaria,
         data_limite_compra = n.necessaria - coalesce(m.antecedencia_dias, v_padrao),
         atualizado_em      = now()
    from novo n
   where m.obra_id = v_obra and m.ativo and m.atividade = n.atividade
     and m.data_necessaria is distinct from n.necessaria;

  -- ---- Término da obra: 10/12 (0008) → 19/10, o FinishDate do cronograma ----
  update compras_obra
     set termino_obra = date '2026-10-19'
   where id = v_obra and termino_obra is distinct from date '2026-10-19';

  -- ---- A nota do contrapiso não pode seguir citando a referência antiga ----
  update compras_contratacao
     set obs_composicao = obs_composicao ||
           ' [12/08/2026] A referência passou a ser o cronograma ATUALIZADO 30/07,'
           ' onde a 1.5.2.5 começa 20/08. Mantivemos 22/07 (data do semana_29) por'
           ' ser a mais cedo: seguir o arquivo novo aqui só afrouxaria um prazo que'
           ' já venceu.'
   where obra_id = v_obra
     and atividade = 'Contrapiso e regularização — salas e áreas internas'
     and obs_composicao is not null
     and obs_composicao not like '%ATUALIZADO 30/07%';
end $$;

-- ---------------------------------------------------------------------
-- Guarda: nenhuma atividade pode começar depois de terminar. Era assim que o
-- erro aparecia na tela (esquadrias começando 59 dias depois de acabar) e é a
-- forma mais barata de a próxima carga errada não passar despercebida.
-- ---------------------------------------------------------------------
alter table public.compras_contratacao
  drop constraint if exists compras_contratacao_periodo;
alter table public.compras_contratacao
  add constraint compras_contratacao_periodo
  check (data_inicio is null or data_termino is null or data_inicio <= data_termino)
  not valid;

-- `not valid` acima só para o alter não falhar caso reste linha antiga fora da
-- regra; a validação abaixo confirma que hoje não resta nenhuma.
alter table public.compras_contratacao validate constraint compras_contratacao_periodo;

comment on constraint compras_contratacao_periodo on public.compras_contratacao is
  'Atividade não pode começar depois de terminar. A violação apareceu quando a '
  'migration 0008 reescreveu inícios sem tocar nos términos.';
