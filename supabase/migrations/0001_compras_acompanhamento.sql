-- =====================================================================
-- Acompanhamento de CONTRATAÇÕES (terceirizadas) e COMPRAS (materiais)
--
-- Traz para um lugar só as duas planilhas que circulavam por e-mail entre
-- planejamento, compras e o gestor da obra. O problema que isso resolve não é
-- o cálculo (a planilha calculava bem) — é a cópia: compras preenche cotação
-- num arquivo, o gestor marca "Contratado: Sim" noutro, e ninguém sabe qual é
-- o verdadeiro. Aqui a linha é uma só.
--
-- O QUE NÃO É COLUNA, DE PROPÓSITO
-- Farol (ATRASADO/ATENÇÃO/OK), prioridade (ATRASADO/URGENTE/PRÓXIMO/
-- PROGRAMADO) e ação ("COMPRAR ATÉ dd/mm/aaaa") são FÓRMULAS na planilha e
-- dependem da data-base, que anda todo dia. Gravar isso em coluna produziria
-- uma planilha que envelhece calada — exatamente o que acontece hoje com o
-- arquivo parado na caixa de entrada. O app recalcula ao renderizar.
--
-- Idempotente: seguro rodar mais de uma vez.
-- =====================================================================

create table if not exists public.compras_obra (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  nome                text not null,
  cliente             text,
  data_base           date,
  antecedencia_dias   integer not null default 10,
  alerta_atencao_dias integer not null default 5,
  urgente_dias        integer not null default 3,
  proximo_dias        integer not null default 10,
  termino_obra        date,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now()
);

comment on table public.compras_obra is
  'Obra acompanhada e os parâmetros do cálculo de prazos — o cabeçalho das planilhas.';
comment on column public.compras_obra.data_base is
  'Data de referência do farol. NULL (o normal) = usar HOJE, que é o que mantém '
  'o acompanhamento vivo. Preencher só para congelar uma foto.';
comment on column public.compras_obra.slug is
  'Identificador na URL (?obra=escola-ambev). É como o link é compartilhado.';

create table if not exists public.compras_contratacao (
  id                   uuid primary key default gen_random_uuid(),
  obra_id              uuid not null references public.compras_obra(id) on delete cascade,
  item                 integer,
  atividade            text not null,
  data_inicio          date,
  data_termino         date,
  prazo_contratacao    date,
  status_processo      text not null default 'PENDENTE',
  contratado           boolean not null default false,
  data_contratacao     date,
  fornecedor_escolhido text,
  valor_contratado     numeric(14,2),
  linhas_pc_mo         text,
  valor_pc_mo          numeric(14,2),
  linhas_pc_material   text,
  valor_pc_material    numeric(14,2),
  valor_pc_total       numeric(14,2)
    generated always as (coalesce(valor_pc_mo,0) + coalesce(valor_pc_material,0)) stored,
  cot1_fornecedor text, cot1_escopo text, cot1_valor numeric(14,2),
  cot2_fornecedor text, cot2_escopo text, cot2_valor numeric(14,2),
  cot3_fornecedor text, cot3_escopo text, cot3_valor numeric(14,2),
  obs_composicao       text,
  observacoes          text,
  ativo                boolean not null default true,
  atualizado_em        timestamptz not null default now(),
  atualizado_por_nome  text,
  constraint compras_contratacao_status check (status_processo in
    ('PENDENTE','EM COTAÇÃO','EM NEGOCIAÇÃO','CONTRATADO','NÃO SE APLICA')),
  constraint compras_contratacao_unica unique (obra_id, atividade)
);

comment on table public.compras_contratacao is
  'Uma linha por serviço terceirizado a contratar. Espelha a planilha "Prazos de contratação e cotações".';
comment on column public.compras_contratacao.atividade is
  'Nome do serviço. É a CHAVE de reimportação da planilha e o que amarra os '
  'materiais a esta contratação — mudar o texto cria linha nova em vez de atualizar.';
comment on column public.compras_contratacao.contratado is
  'A coluna "Contratado Sim/Não". Redundante com status_processo = CONTRATADO '
  'por decisão: é o campo que o gestor de obra realmente usa. O app mantém os dois em sincronia.';
comment on column public.compras_contratacao.ativo is
  'Reimportar a planilha nunca apaga linha: o que sumiu vira ativo=false, '
  'preservando cotações e histórico já lançados.';

create table if not exists public.compras_material (
  id                  uuid primary key default gen_random_uuid(),
  obra_id             uuid not null references public.compras_obra(id) on delete cascade,
  contratacao_id      uuid references public.compras_contratacao(id) on delete set null,
  item                integer,
  atividade           text,
  linha_pc            text not null,
  material            text not null,
  unidade             text,
  quantidade          numeric(16,6),
  custo_unit_pc       numeric(16,6),
  custo_total_pc      numeric(16,2),
  data_necessaria     date,
  data_limite_compra  date,
  fornecedor          text,
  valor_unit_cotado   numeric(16,6),
  valor_total_cotado  numeric(16,2)
    generated always as (
      case when quantidade is null or valor_unit_cotado is null then null
           else round(quantidade * valor_unit_cotado, 2) end
    ) stored,
  status_compra       text not null default 'PENDENTE',
  comprado            boolean not null default false,
  data_compra         date,
  entrega_prevista    date,
  entrega_realizada   date,
  observacoes         text,
  ativo               boolean not null default true,
  atualizado_em       timestamptz not null default now(),
  atualizado_por_nome text,
  constraint compras_material_status check (status_compra in
    ('PENDENTE','EM COTAÇÃO','EM NEGOCIAÇÃO','COMPRADO','ENTREGUE','NÃO SE APLICA'))
);

comment on table public.compras_material is
  'Uma linha por material a comprar. Espelha a planilha "Materiais a comprar".';
comment on column public.compras_material.data_limite_compra is
  'Data-limite de compra. Vem da contratação vinculada, não da data necessária '
  'na obra: é o mesmo prazo do serviço que vai aplicar o material.';
comment on column public.compras_material.valor_total_cotado is
  'Calculada (quantidade × valor unitário cotado), equivalente ao =F*N da '
  'planilha. NULL enquanto não houver cotação — não zero, para o total cotado '
  'não misturar item cotado com item ainda sem preço.';

create unique index if not exists ux_compras_material_linha
  on public.compras_material(obra_id, linha_pc, md5(material));
create index if not exists ix_compras_material_limite
  on public.compras_material(obra_id, data_limite_compra);
create index if not exists ix_compras_material_contratacao
  on public.compras_material(contratacao_id);
create index if not exists ix_compras_contratacao_prazo
  on public.compras_contratacao(obra_id, prazo_contratacao);

-- Evolução: a resposta para "por que este item está parado há três semanas?",
-- que a planilha nunca deu — nela, editar é sobrescrever.
create table if not exists public.compras_evento (
  id           bigint generated always as identity primary key,
  obra_id      uuid not null references public.compras_obra(id) on delete cascade,
  origem       text not null,
  ref_id       uuid,
  referencia   text,
  campo        text not null,
  valor_antes  text,
  valor_depois text,
  em           timestamptz not null default now(),
  por_nome     text,
  constraint compras_evento_origem check (origem in ('contratacao','material'))
);

comment on table public.compras_evento is
  'Trilha de mudanças: um registro por campo alterado. É o que transforma a '
  'planilha em acompanhamento — mostra quanto tempo um item ficou EM COTAÇÃO e quem destravou.';
comment on column public.compras_evento.referencia is
  'Nome legível copiado no momento do evento, para o histórico continuar '
  'legível mesmo se a linha for renomeada depois.';

create index if not exists ix_compras_evento_obra on public.compras_evento(obra_id, em desc);
create index if not exists ix_compras_evento_ref  on public.compras_evento(ref_id, em desc);

-- ── Acesso por link aberto ───────────────────────────────────────────
-- Decisão do dono: quem tem o link acompanha e edita, sem login — é o que faz
-- o setor de compras e o gestor usarem de verdade. O conteúdo é prazo e cotação
-- de obra, não dado pessoal.
-- DELETE não é concedido a ninguém pelo link: a planilha se reimporta, e o que
-- sai dela vira ativo=false. Assim um clique errado não apaga cotação alheia.
alter table public.compras_obra         enable row level security;
alter table public.compras_contratacao  enable row level security;
alter table public.compras_material     enable row level security;
alter table public.compras_evento       enable row level security;

grant usage on schema public to anon;
grant select, insert, update on public.compras_obra        to anon, authenticated;
grant select, insert, update on public.compras_contratacao to anon, authenticated;
grant select, insert, update on public.compras_material    to anon, authenticated;
grant select, insert          on public.compras_evento     to anon, authenticated;

do $$
declare t text; acao text;
begin
  foreach t in array array['compras_obra','compras_contratacao','compras_material','compras_evento']
  loop
    foreach acao in array array['sel','ins','upd']
    loop
      execute format('drop policy if exists p_%s on public.%I', acao, t);
    end loop;
    execute format('create policy p_sel on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy p_ins on public.%I for insert to anon, authenticated with check (true)', t);
    if t <> 'compras_evento' then
      execute format('create policy p_upd on public.%I for update to anon, authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;
