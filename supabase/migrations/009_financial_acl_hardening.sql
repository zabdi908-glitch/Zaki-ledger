-- Zaki Ledger - financial ingestion least-privilege hardening
--
-- Supabase's postgres/supabase_admin default privileges materialized broad
-- table ACLs when these tables were created. Migration 008 granted the
-- service role its required SELECT/INSERT rights, but a GRANT cannot remove
-- those pre-existing privileges. Reset the four ingestion-table ACLs
-- explicitly, then grant back only what the SECURITY INVOKER RPCs and current
-- server-side reads require. Ownership and migration/admin capability remain
-- with postgres; no default privileges or unrelated tables are changed.

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.bank_statements,
  public.bank_transactions,
  public.qb_transactions,
  public.bank_statement_transaction_observations
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON TABLE
  public.bank_statements,
  public.bank_transactions,
  public.qb_transactions,
  public.bank_statement_transaction_observations
TO service_role;

-- Keep RPC exposure explicit after resetting the supporting table ACLs.
REVOKE EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid) TO service_role;

COMMIT;
