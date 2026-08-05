-- =====================================================================
-- Corta o privilégio que sobra do anon.
--
-- CAUSA RAIZ (vale saber, porque vai se repetir)
-- O schema public deste projeto tem DEFAULT PRIVILEGES concedendo TUDO ao anon:
--
--   pg_default_acl → anon=arwdDxtm/postgres
--   (a=insert r=select w=update d=delete D=truncate x=references t=trigger m=maintain)
--
-- É o padrão do Supabase. Consequência: TODA tabela nova criada em public
-- nasce, para o anon, com insert/update/delete/truncate liberados — os grants
-- finos escritos nas migrations SOMAM, não substituem.
--
-- Na prática quem barra é o RLS, e todas as tabelas têm RLS ligado. Mas
-- privilégio que o app não usa não deveria existir: no dia em que uma policy
-- for afrouxada por engano, é o grant amplo que transforma o engano em dano.
-- TRUNCATE em particular IGNORA row level security.
--
-- Idempotente: revoke de privilégio ausente não é erro.
-- =====================================================================

-- compras_obra: o app só LÊ. Escrita aqui permitiria gravar data_base e
-- congelar o farol de todos numa data fixa — o app pararia de envelhecer sem
-- ninguém notar, que é exatamente o defeito da planilha que ele corrige.
revoke insert, update, delete, truncate, references, trigger
  on public.compras_obra from anon;
drop policy if exists p_ins on public.compras_obra;
drop policy if exists p_upd on public.compras_obra;

-- compras_config: guarda o remetente dos e-mails da empresa. Só leitura.
revoke insert, update, delete, truncate, references, trigger
  on public.compras_config from anon, authenticated;

-- compras_envio_log: quem escreve é a Edge Function (service_role). O app lê.
revoke insert, update, delete, truncate, references, trigger
  on public.compras_envio_log from anon, authenticated;

-- compras_destinatario: o cadastro pela tela precisa de insert e update.
revoke delete, truncate, references, trigger
  on public.compras_destinatario from anon, authenticated;

-- Views de painel: leitura e nada mais.
revoke insert, update, delete, truncate, references, trigger
  on public.compras_painel_contratacao, public.compras_painel_material
  from anon, authenticated;

-- Estado esperado ao fim:
--   compras_obra, compras_config, compras_envio_log, painel_*  → SELECT
--   compras_contratacao, compras_material, compras_destinatario → SELECT, INSERT, UPDATE
--   compras_evento                                             → SELECT, INSERT
