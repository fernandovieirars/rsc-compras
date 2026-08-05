-- ============================================================
-- Realinhamento das datas à LINHA DE BASE 1
-- Fonte: Cronograma_Ambev_semana_29 (21/07/2026), campo Baseline Number=1
--
-- POR QUE
-- As datas carregadas até aqui vinham do cronograma de 30/07, que é o PLANO DE
-- RECUPERAÇÃO (término 19/10/2026). A linha de base 1 é o plano oficial
-- rebaselinado em 21/07 (término 10/12/2026) — 52 dias de diferença. O
-- planejamento definiu a base 1 como referência dos prazos de compra.
--
-- Detalhe que não é óbvio: na base 1 o desvio contra o "atual" é 0 em todas as
-- 279 tarefas, porque o rebaseline fotografou o plano já atrasado. Quem
-- comparar "atual vs base 1" procurando atraso não vai achar nenhum. O atraso
-- real está entre a base 0 e a base 1 (mobiliário: 13/05 → 03/08).
--
-- REGRA DO PRAZO
-- data_limite_compra = data_necessaria - antecedencia_dias (10 dias corridos).
-- Mantida igual à das planilhas de origem.
--
-- MAPEAMENTO atividade → tarefa da base 1
--   Esquadrias                → 1.8.5.1 esquadrias de madeira      02/11
--   Revestimento banh/cantina → 1.7.2 revestimento de parede       21/09
--   Pavimentação estac./rot.  → 1.10.4.6 Pavimentação              11/09
--   Pisos internos            → 1.7.1 instalação de pisos          04/09
--   Forro de gesso            → 1.8.1 forro gesso acartonado       28/08
--   Pintura interna           → 1.8.3 pintura de paredes           05/10
--   Pintura externa           → 1.8.3 (mesma tarefa; ver nota)     05/10
--   Informática               → 1.9.3.1 fornecimento computadores  30/11
--   Mobiliário                → 1.1.8 marco contratual (ver nota)  01/09
--
-- NÃO MEXIDAS por já coincidirem com a base 1: emboço interno (14/05),
-- impermeabilização de jardineiras (06/08), infra de ar-condicionado (17/08),
-- impermeabilização de laje (25/08), copa e cozinha (31/08), comunicação
-- visual (03/08). A coincidência em 6 de 18 é o que dá confiança no mapeamento.
--
-- NÃO MEXIDAS por falta de correspondência confiável — ver compras_alerta_mapa:
--   Piso externo (item 4)  → já CONTRATADO; nenhuma tarefa bate com 27/07
--   Contrapiso   (item 7)  → candidatas 1.5.2.5 (22/07) e 1.15.1.7 (Feirinha)
--   Jardinagem   (item 8)  → já CONTRATADO; espalhada em 1.10.1.3 e 1.10.4.7
-- ============================================================

do $$
declare
  v_obra uuid;
begin
  select id into v_obra from compras_obra where slug = 'escola-ambev';
  if v_obra is null then
    raise notice 'obra escola-ambev não encontrada; nada a fazer';
    return;
  end if;

  -- ---- Contratações: início da atividade e prazo de contratação ----
  with novo(atividade, inicio) as (values
    ('Esquadrias — madeira, alumínio e portas sanitárias', date '2026-11-02'),
    ('Revestimento de piso e paredes — banheiros e cantina', date '2026-09-21'),
    ('Pavimentação externa — estacionamento e rotatória',  date '2026-09-11'),
    ('Pisos internos — salas e demais áreas',              date '2026-09-04'),
    ('Forro de gesso acartonado',                          date '2026-08-28'),
    ('Pintura interna — paredes e forros',                 date '2026-10-05'),
    ('Pintura externa — fachadas e áreas externas',        date '2026-10-05'),
    ('Informática — computadores e rede',                  date '2026-11-30'),
    ('Mobiliário — salas, biblioteca e administrativo',    date '2026-09-01')
  )
  update compras_contratacao c
     set data_inicio       = n.inicio,
         prazo_contratacao = n.inicio - 10,
         atualizado_em     = now()
    from novo n
   where c.obra_id = v_obra and c.ativo and c.atividade = n.atividade;

  -- ---- Materiais: seguem a atividade a que pertencem ----
  with novo(atividade, necessaria) as (values
    ('Esquadrias — madeira, alumínio e portas sanitárias', date '2026-11-02'),
    ('Revestimento de piso e paredes — banheiros e cantina', date '2026-09-21'),
    ('Pavimentação externa — estacionamento e rotatória',  date '2026-09-11'),
    ('Pisos internos — salas e demais áreas',              date '2026-09-04'),
    ('Forro de gesso acartonado',                          date '2026-08-28'),
    ('Pintura interna — paredes e forros',                 date '2026-10-05'),
    ('Pintura de paredes — referência interna/externa compartilhada', date '2026-10-05'),
    ('Informática — computadores e rede',                  date '2026-11-30'),
    ('Mobiliário — salas, biblioteca e administrativo',    date '2026-09-01')
  )
  update compras_material m
     set data_necessaria     = n.necessaria,
         data_limite_compra  = n.necessaria - 10,
         atualizado_em       = now()
    from novo n
   where m.obra_id = v_obra and m.ativo and m.atividade = n.atividade;

  -- ---- Término da obra: 19/10 (recuperação) → 10/12 (base 1) ----
  update compras_obra
     set termino_obra = date '2026-12-10'
   where id = v_obra;
end $$;

-- ------------------------------------------------------------
-- Nota de origem nos dois casos que não têm tarefa própria no cronograma.
-- Fica no registro para quem for cobrar o prazo saber de onde ele saiu.
-- ------------------------------------------------------------
update compras_contratacao
   set escopo_negociacao = coalesce(escopo_negociacao || ' ', '') ||
       'Prazo derivado do marco contratual 1.1.8 (MOBILIÁRIOS E COMUNICAÇÃO VISUAL, ' ||
       '01/09/2026): o cronograma não tem tarefa própria de fornecimento de mobiliário. ' ||
       'Se o planejamento abrir essa tarefa, revisar esta data.'
 where ativo and atividade = 'Mobiliário — salas, biblioteca e administrativo'
   and coalesce(escopo_negociacao, '') not like '%marco contratual 1.1.8%';

update compras_contratacao
   set escopo_negociacao = coalesce(escopo_negociacao || ' ', '') ||
       'Pintura externa não tem tarefa separada na base 1 — usa a mesma 1.8.3 da ' ||
       'pintura interna (05/10). É a mesma linha 2.6.3 da PC que já é compartilhada.'
 where ativo and atividade = 'Pintura externa — fachadas e áreas externas'
   and coalesce(escopo_negociacao, '') not like '%mesma 1.8.3%';
