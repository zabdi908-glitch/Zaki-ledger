-- ZAKI-REPAIR-013-PREP: add supersession columns (identical DDL to migration 013 Z1).
-- Idempotent; additive only; no data change. Runs BEFORE migration 013 so the
-- repair can supersede historical rows (013's Z2 refuses to apply while
-- duplicate live auto claims exist, so supersession must exist first).
BEGIN;
ALTER TABLE public.reconciliation_matches
  ADD COLUMN IF NOT EXISTS superseded_at           timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_match_id  uuid,
  ADD COLUMN IF NOT EXISTS supersede_reason        text,
  ADD COLUMN IF NOT EXISTS supersede_operation_id  uuid;
ALTER TABLE public.reconciliation_audit_log
  ADD COLUMN IF NOT EXISTS operation_id uuid,
  ADD COLUMN IF NOT EXISTS previous_state jsonb,
  ADD COLUMN IF NOT EXISTS resulting_state jsonb,
  ADD COLUMN IF NOT EXISTS evidence jsonb;
COMMIT;
NOTIFY pgrst, 'reload schema';
