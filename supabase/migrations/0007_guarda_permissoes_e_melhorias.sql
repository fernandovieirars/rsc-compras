-- =====================================================================
-- Guarda de permissões (horário), domínio dos destinatários e atraso de entrega.
--
-- POR QUE O GUARDA EXISTE
-- O schema public deste projeto tem DEFAULT PRIVILEGES concedendo TUDO ao anon
-- (pg_default_acl → anon=arwdDxtm). Toda tabela nova nasce aberta, e os grants
-- finos das migrations SOMAM em vez de substituir. Corrigir uma vez não basta:
-- a próxima tabela repete o problema, e a correção anterior nunca aparece como
-- regressão porque ninguém consulta privilégio no dia a dia.
--
-- Então em vez de corrigir, DECLARA-SE o que cada tabela pode dar ao anon, e
-- uma rotina horária devolve tudo ao lugar. Só grava log quando acha desvio —
-- tabela de log vazia significa que nada saiu do lugar desde a instalação.
--
-- Na primeira execução encontrou 18 desvios reais no papel `authenticated`,
-- que as correções manuais anteriores tinham deixado passar.
-- =====================================================================

create table if not exists public.compras_seguranca_log (
  id         bigint generated always as identity primary key,
  em         timestamptz not null default now(),
  achados    jsonb not null,
  corrigidos integer not null default 0
);
comment on table public.compras_seguranca_log is
  'Registro do guarda de permissões. Linha só é gravada quando havia desvio.';
alter table public.compras_seguranca_log enable row level security;
drop policy if exists p_sel on public.compras_seguranca_log;
create policy p_sel on public.compras_seguranca_log for select to anon, authenticated using (true);

create or replace function public.reforcar_permissoes_compras()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  esperado constant jsonb := jsonb_build_object(
    'compras_obra',              jsonb_build_array('SELECT'),
    'compras_config',            jsonb_build_array('SELECT'),
    'compras_envio_log',         jsonb_build_array('SELECT'),
    'compras_seguranca_log',     jsonb_build_array('SELECT'),
    'compras_painel_contratacao',jsonb_build_array('SELECT'),
    'compras_painel_material',   jsonb_build_array('SELECT'),
    'compras_contratacao',       jsonb_build_array('SELECT','INSERT','UPDATE'),
    'compras_material',          jsonb_build_array('SELECT','INSERT','UPDATE'),
    'compras_destinatario',      jsonb_build_array('SELECT','INSERT','UPDATE'),
    'compras_evento',            jsonb_build_array('SELECT','INSERT')
  );
  todos constant text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  tabela text; papel text; priv text; permitidos text[];
  achados jsonb := '[]'::jsonb; n int := 0; oid_tabela oid;
begin
  for tabela in select jsonb_object_keys(esperado) loop
    select c.oid into oid_tabela from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = tabela;
    continue when oid_tabela is null;

    select array(select jsonb_array_elements_text(esperado -> tabela)) into permitidos;

    foreach papel in array array['anon','authenticated'] loop
      foreach priv in array todos loop
        if not (priv = any(permitidos)) and has_table_privilege(papel, oid_tabela, priv) then
          execute format('revoke %s on public.%I from %I', priv, tabela, papel);
          achados := achados || jsonb_build_object('tabela', tabela, 'papel', papel, 'privilegio_retirado', priv);
          n := n + 1;
        end if;
      end loop;
    end loop;

    -- RLS desligada é o furo grave: sem ela, o grant vira acesso direto.
    if exists (select 1 from pg_class where oid = oid_tabela and not relrowsecurity and relkind = 'r') then
      execute format('alter table public.%I enable row level security', tabela);
      achados := achados || jsonb_build_object('tabela', tabela, 'rls', 'religada');
      n := n + 1;
    end if;
  end loop;

  if n > 0 then
    insert into public.compras_seguranca_log (achados, corrigidos) values (achados, n);
  end if;
  return jsonb_build_object('corrigidos', n, 'achados', achados);
end $$;

comment on function public.reforcar_permissoes_compras is
  'Guarda de permissões: devolve os privilégios ao mínimo declarado e religa '
  'RLS se alguém desligar. Roda de hora em hora pelo pg_cron.';

revoke all on function public.reforcar_permissoes_compras() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'reforcar-permissoes-compras') then
    perform cron.schedule('reforcar-permissoes-compras', '43 * * * *',
                          $sql$select public.reforcar_permissoes_compras()$sql$);
  end if;
end $$;

-- ── Domínios aceitos no cadastro de destinatário ─────────────────────
-- O link é aberto. Sem esta trava, qualquer pessoa poderia inscrever o e-mail
-- de um terceiro e gerar spam diário em nome da Rio Sul. Lista configurável em
-- vez de constante: o gestor pode usar e-mail pessoal, e liberar isso não pode
-- virar tarefa de programador.
alter table public.compras_config
  add column if not exists dominios_email text[] not null
  default array['riosulconstrucoes.com.br'];

create or replace function public.validar_dominio_destinatario()
returns trigger language plpgsql as $$
declare permitidos text[];
begin
  select dominios_email into permitidos from public.compras_config where id;
  if permitidos is null or array_length(permitidos,1) is null then return new; end if;
  if not (lower(split_part(new.email, '@', 2)) = any(permitidos)) then
    raise exception 'E-mail fora dos domínios aceitos (%). Ajuste compras_config.dominios_email para liberar.',
      array_to_string(permitidos, ', ');
  end if;
  return new;
end $$;

drop trigger if exists t_dominio_destinatario on public.compras_destinatario;
create trigger t_dominio_destinatario
  before insert or update of email on public.compras_destinatario
  for each row execute function public.validar_dominio_destinatario();

-- ── Atraso de entrega no painel ──────────────────────────────────────
-- Comprar não é receber. Entrega prevista DEPOIS da data em que o material é
-- necessário atrasa o serviço mesmo com a compra "resolvida" — e na coluna
-- Status o item aparece como COMPRADO. É o atraso mais perigoso do conjunto.
create or replace view public.compras_painel_material
with (security_invoker = true) as
select m.*,
       b.data_base,
       (m.data_limite_compra - b.data_base) as dias_para_limite,
       p.prioridade,
       case when m.data_limite_compra is null then ''
            when p.prioridade = 'PROGRAMADO' then 'OK'
            else 'COMPRAR ATÉ ' || to_char(m.data_limite_compra, 'DD/MM/YYYY')
       end as acao,
       case when m.entrega_realizada is not null
             or m.entrega_prevista is null
             or m.data_necessaria is null then null
            when m.entrega_prevista > m.data_necessaria
             then m.entrega_prevista - m.data_necessaria
            else null
       end as atraso_entrega_dias
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

grant select on public.compras_painel_material to anon, authenticated;
select public.reforcar_permissoes_compras();
