-- ZAKI-REPAIR-013-PREP: add supersession columns (identical DDL to migration 013 Z1)
-- plus repair-evidence immutability (identical to migration 013 Z1b).
-- Idempotent; additive only; no data change. Runs BEFORE migration 013 so the
-- repair can supersede historical rows (013's Z2 refuses to apply while
-- duplicate live auto claims exist, so supersession must exist first).
--
-- The immutability trigger is installed here as well as in 013 so the new
-- repair-evidence columns are protected from the moment the prep runs —
-- including the interim if stage 1 commits and stage 2 is pending
-- authorization. It blocks UPDATE of operation_id / previous_state /
-- resulting_state / evidence for every role (mirroring 012's
-- audit_log_evidence_immutable_v1); the columns are only ever written at
-- INSERT time.
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

CREATE OR REPLACE FUNCTION public.audit_log_repair_evidence_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation repair audit evidence is immutable'
    USING ERRCODE = '42806';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_repair_evidence_immutable
  ON public.reconciliation_audit_log;
CREATE TRIGGER audit_log_repair_evidence_immutable
  BEFORE UPDATE OF operation_id, previous_state, resulting_state, evidence
  ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_repair_evidence_immutable_v1();

COMMIT;
NOTIFY pgrst, 'reload schema';
