-- =====================================================================
-- Destinatários do alerta diário, log de envio, e as VIEWS de painel.
--
-- POR QUE AS VIEWS EXISTEM
-- O farol e a prioridade já vivem em JavaScript no app (traduzidos das
-- fórmulas da planilha e testados contra o Excel em testes/calculo.test.js).
-- O e-mail diário precisa da mesma conta — e uma segunda implementação em
-- TypeScript dentro da Edge Function seria a terceira cópia da mesma regra.
-- Cópia de regra é como cópia de planilha: uma hora divergem, e a divergência
-- aparece num e-mail dizendo "OK" para um item que a tela mostra vermelho.
--
-- Então a regra vira VIEW, e a Edge Function não calcula nada: só lê.
--
-- A data-base usa o fuso de São Paulo, não current_date. current_date no
-- Supabase é UTC: às 21h no Brasil ele já virou o dia seguinte, e o alerta da
-- noite classificaria como ATRASADO um item que ainda vence amanhã.
--
-- Idempotente: seguro rodar mais de uma vez.
-- =====================================================================

create table if not exists public.compras_destinatario (
  id            uuid primary key default gen_random_uuid(),
  obra_id       uuid not null references public.compras_obra(id) on delete cascade,
  nome          text not null,
  email         text not null,
  papel         text not null default 'compras',
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  constraint compras_destinatario_papel check (papel in ('compras','gestor','planejamento','diretoria')),
  constraint compras_destinatario_email check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
  constraint compras_destinatario_unico unique (obra_id, email)
);

comment on table public.compras_destinatario is
  'Quem recebe o alerta diário. Editável pelo app — não é lista fixa em código, '
  'senão trocar uma pessoa do setor de compras vira tarefa de programador.';
comment on constraint compras_destinatario_email on public.compras_destinatario is
  'Barra endereço malformado na entrada. A lista de contatos do outro app tem '
  'um "fernando.vieira@hotmil.com" que só foi descoberto no log de erro meses '
  'depois — isso não pega typo de domínio válido, mas pega o resto.';

create index if not exists ix_compras_destinatario_obra
  on public.compras_destinatario(obra_id) where ativo;

create table if not exists public.compras_envio_log (
  id           bigint generated always as identity primary key,
  obra_id      uuid references public.compras_obra(id) on delete set null,
  destinatario text not null,
  assunto      text,
  status       text not null,
  erro         text,
  resumo       jsonb,
  em           timestamptz not null default now()
);

comment on table public.compras_envio_log is
  'Todo envio, com sucesso ou erro. O outro app acumulou 181 falhas silenciosas '
  'de Resend em modo de teste porque ninguém olhava o log — aqui a tela de '
  'Relatório mostra o último resultado, para a falha aparecer sozinha.';

create index if not exists ix_compras_envio_log_em on public.compras_envio_log(em desc);

-- ── Painel: a regra de prazo, em um lugar só ─────────────────────────
create or replace view public.compras_painel_contratacao
with (security_invoker = true) as
select c.*,
       b.data_base,
       (c.prazo_contratacao - b.data_base) as dias_para_prazo,
       f.farol,
       case when c.prazo_contratacao is null then ''
            when f.farol = 'OK' then 'OK'
            else 'CONTRATAR ATÉ ' || to_char(c.prazo_contratacao, 'DD/MM/YYYY')
       end as acao
from public.compras_contratacao c
join public.compras_obra o on o.id = c.obra_id
cross join lateral (
  select coalesce(o.data_base, (now() at time zone 'America/Sao_Paulo')::date) as data_base
) b
cross join lateral (
  select case
    when c.prazo_contratacao is null then null
    when c.prazo_contratacao < b.data_base then 'ATRASADO'
    when c.prazo_contratacao - b.data_base <= o.alerta_atencao_dias then 'ATENÇÃO'
    else 'OK'
  end as farol
) f
where c.ativo;

comment on view public.compras_painel_contratacao is
  'Contratações ativas com farol e ação já calculados. Espelha exatamente o '
  '=SE(prazo<base;"ATRASADO";SE(prazo-base<=alerta;"ATENÇÃO";"OK")) da planilha.';

create or replace view public.compras_painel_material
with (security_invoker = true) as
select m.*,
       b.data_base,
       (m.data_limite_compra - b.data_base) as dias_para_limite,
       p.prioridade,
       case when m.data_limite_compra is null then ''
            when p.prioridade = 'PROGRAMADO' then 'OK'
            else 'COMPRAR ATÉ ' || to_char(m.data_limite_compra, 'DD/MM/YYYY')
       end as acao
from public.compras_material m
join public.compras_obra o on o.id = m.obra_id
cross join lateral (
  select coalesce(o.data_base, (now() at time zone 'America/Sao_Paulo')::date) as data_base
) b
cross join lateral (
  select case
    when m.data_limite_compra is null then null
    when m.data_limite_compra < b.data_base then 'ATRASADO'
    when m.data_limite_compra - b.data_base <= o.urgente_dias then 'URGENTE'
    when m.data_limite_compra - b.data_base <= o.proximo_dias then 'PRÓXIMO'
    else 'PROGRAMADO'
  end as prioridade
) p
where m.ativo;

comment on view public.compras_painel_material is
  'Materiais ativos com prioridade e ação já calculados. Mesma regra do app e '
  'da planilha, para o e-mail diário nunca discordar da tela.';

-- ── Acesso ───────────────────────────────────────────────────────────
alter table public.compras_destinatario enable row level security;
alter table public.compras_envio_log    enable row level security;

grant select, insert, update on public.compras_destinatario to anon, authenticated;
grant select                 on public.compras_envio_log    to anon, authenticated;
grant select on public.compras_painel_contratacao, public.compras_painel_material to anon, authenticated;

drop policy if exists p_sel on public.compras_destinatario;
drop policy if exists p_ins on public.compras_destinatario;
drop policy if exists p_upd on public.compras_destinatario;
create policy p_sel on public.compras_destinatario for select to anon, authenticated using (true);
create policy p_ins on public.compras_destinatario for insert to anon, authenticated with check (true);
create policy p_upd on public.compras_destinatario for update to anon, authenticated using (true) with check (true);

drop policy if exists p_sel on public.compras_envio_log;
create policy p_sel on public.compras_envio_log for select to anon, authenticated using (true);

-- ── Agendamento ──────────────────────────────────────────────────────
-- Dias úteis às 11:00 UTC = 08:00 BRT, mesmo horário dos outros avisos da casa.
-- Fim de semana fica de fora de propósito: aviso de prazo de compra no sábado
-- não gera ação, só ensina a equipe a ignorar o remetente.
-- Para incluir sábado e domingo, trocar '1-5' por '*'.
--
-- O comando é copiado do job que já existe, trocando só a função-alvo: assim o
-- token de serviço nunca precisa ser digitado nem versionado em lugar nenhum.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'notificar-planos-vencidos-diario')
     and not exists (select 1 from cron.job where jobname = 'alerta-compras-diario') then
    perform cron.schedule(
      'alerta-compras-diario',
      '0 11 * * 1-5',
      (select replace(command, 'notificar-planos-vencidos', 'alerta-compras-diario')
         from cron.job where jobname = 'notificar-planos-vencidos-diario')
    );
  end if;
end $$;
