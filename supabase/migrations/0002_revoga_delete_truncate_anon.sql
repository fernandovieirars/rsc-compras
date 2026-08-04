-- =====================================================================
-- Tira do papel `anon` privilégios que a 0001 achou que não tinha dado.
--
-- O projeto carrega um grant amplo herdado ("grant all on all tables in schema
-- public to anon") de antes destas tabelas existirem. Grants SOMAM — os grants
-- finos da 0001 não substituíram nada, e as tabelas novas nasceram com DELETE e
-- TRUNCATE liberados para anon.
--
-- DELETE já estava barrado pelo RLS: não existe policy de delete, então a linha
-- some do alcance antes de a operação acontecer. TRUNCATE é outra história —
-- ele IGNORA row level security. Não é alcançável pela API (PostgREST não expõe
-- TRUNCATE), mas é privilégio que contradiz o desenho do app, que nunca apaga
-- linha: item que sai da planilha vira ativo = false.
--
-- Idempotente: revoke de privilégio ausente não é erro.
-- =====================================================================

revoke delete, truncate, references, trigger
  on public.compras_obra, public.compras_contratacao,
     public.compras_material, public.compras_evento
  from anon;

-- compras_evento é trilha de auditoria. Poder alterar um registro de "quem mudou
-- o quê" destruiria exatamente aquilo que ele existe para provar.
revoke update on public.compras_evento from anon, authenticated;

-- Estado esperado depois desta migration:
--   compras_obra, compras_contratacao, compras_material → SELECT, INSERT, UPDATE
--   compras_evento                                      → SELECT, INSERT
