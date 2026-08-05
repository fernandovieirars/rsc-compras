-- =====================================================================
-- Remetente do alerta configurável POR SQL, não por secret do painel.
--
-- POR QUE
-- O remetente estava só na variável NOTIF_FROM_EMAIL — que nem chegou a ser
-- definida, por isso os e-mails saíam de 'onboarding@resend.dev', o endereço
-- de teste do Resend. Trocar isso exigiria abrir o painel do Supabase e mexer
-- em secrets: justamente o passo manual que trava a automação.
--
-- Com esta tabela, no dia em que o domínio for verificado, ligar o remetente
-- definitivo é UM UPDATE. Sem painel, sem deploy, sem secret.
-- =====================================================================

create table if not exists public.compras_config (
  id              boolean primary key default true,
  remetente_nome  text not null default 'Rio Sul Obras',
  remetente_email text not null default 'onboarding@resend.dev',
  app_url         text not null default 'https://rsc-compras-obra.vercel.app',
  atualizado_em   timestamptz not null default now(),
  constraint compras_config_linha_unica check (id)   -- uma linha só
);

comment on table public.compras_config is
  'Linha única de configuração do envio. Existe para o remetente poder ser '
  'trocado por SQL no dia em que o domínio for verificado no Resend, sem '
  'depender do painel do Supabase.';
comment on column public.compras_config.remetente_email is
  'Enquanto for onboarding@resend.dev, o Resend está em modo de teste e SÓ '
  'entrega para o dono da conta. Trocar para avisos@riosulconstrucoes.com.br '
  'assim que o domínio estiver verificado.';

insert into public.compras_config (id) values (true) on conflict (id) do nothing;

alter table public.compras_config enable row level security;
grant select on public.compras_config to anon, authenticated;
drop policy if exists p_sel on public.compras_config;
create policy p_sel on public.compras_config for select to anon, authenticated using (true);
-- Sem UPDATE para anon de propósito: quem tem o link não deve poder trocar o
-- remetente dos e-mails da empresa. Essa troca é por SQL, feita uma vez.
