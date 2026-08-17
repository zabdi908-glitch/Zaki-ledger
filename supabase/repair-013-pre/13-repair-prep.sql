-- ZAKI-REPAIR-013-PREP: add supersession columns (identical DDL to migration 013 Z1)
-- plus repair-evidence immutability (identical to migration 013 Z1b), plus
-- the stage-1 execution receipt table (the database-side authorization
-- root for stage 2).
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

-- Stage-1 execution receipt (the database-side authorization root for stage
-- 2). Stage 1 inserts exactly one row INSIDE THE SAME TRANSACTION as the
-- 154 supersessions and audit rows, so a committed stage-1 result always
-- carries its receipt and no receipt can exist without the exact stage-1
-- state. The row is immutable (UPDATE/DELETE blocked) and unique per
-- operation id; stage 2 validates the actual row and independently
-- recomputes the exact stage-1 state before any stage-2 work. A
-- caller-created stage-1 "proof" JSON is operator evidence only and is
-- NEVER the authorization root.
CREATE TABLE IF NOT EXISTS public.repair_stage1_receipt (
  receipt_sha256                 text PRIMARY KEY,
  execution_package_sha256       text NOT NULL,
  artifact_sha256                text NOT NULL,
  operation_id                   uuid NOT NULL UNIQUE,
  environment_mode               text NOT NULL
    CHECK (environment_mode IN ('REHEARSAL', 'PRODUCTION')),
  project_ref                    text,
  target_manifest_sha256         text NOT NULL,
  target_digest_sha256           text NOT NULL,
  survivor_mapping_digest_sha256 text NOT NULL,
  audit_digest_sha256            text NOT NULL,
  postcondition_digest_sha256    text NOT NULL,
  executed_at                    timestamptz NOT NULL,
  db_identity                    text NOT NULL
);

CREATE OR REPLACE FUNCTION public.repair_stage1_receipt_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'repair stage-1 execution receipt is immutable'
    USING ERRCODE = '42806';
END;
$$;

DROP TRIGGER IF EXISTS repair_stage1_receipt_immutable
  ON public.repair_stage1_receipt;
CREATE TRIGGER repair_stage1_receipt_immutable
  BEFORE UPDATE OR DELETE
  ON public.repair_stage1_receipt
  FOR EACH ROW EXECUTE FUNCTION public.repair_stage1_receipt_immutable_v1();

COMMIT;
NOTIFY pgrst, 'reload schema';
