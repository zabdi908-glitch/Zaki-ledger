-- Zaki Ledger - Migration 012: Reconciliation Canonical Tenant Spine
--
-- Implements the frozen Step 4B design (Patch 2 applied 2026-08-12).
-- One transaction.  Backfill, composite FKs, write-guard + immutability
-- triggers, audit ACL/RLS hardening, self-context RPC, and ingestion RPC
-- canonical-validation-before-idempotency reorder.
--
-- No Migration 010/011 edits.  No production changes.  Design only.

BEGIN;

-- =========================================================================
-- Z1. Additive canonical columns (all nullable)
-- =========================================================================

ALTER TABLE public.bank_statements
  ADD COLUMN IF NOT EXISTS client_entity_id uuid,
  ADD COLUMN IF NOT EXISTS ledger_book_id    uuid;

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS client_entity_id uuid;

ALTER TABLE public.qb_transactions
  ADD COLUMN IF NOT EXISTS client_entity_id uuid,
  ADD COLUMN IF NOT EXISTS ledger_book_id    uuid;

ALTER TABLE public.reconciliation_matches
  ADD COLUMN IF NOT EXISTS client_entity_id uuid;

ALTER TABLE public.reconciliation_reports
  ADD COLUMN IF NOT EXISTS client_entity_id uuid;

ALTER TABLE public.reconciliation_decisions
  ADD COLUMN IF NOT EXISTS client_entity_id uuid;

ALTER TABLE public.reconciliation_audit_log
  ADD COLUMN IF NOT EXISTS client_entity_id uuid,
  ADD COLUMN IF NOT EXISTS user_id          uuid;  -- nullable; backfilled, then SET NOT NULL

-- =========================================================================
-- Z2. Classify and bootstrap eligible users missing a registry row
-- =========================================================================

-- Eligibility predicate (exact match with 011 backfill):
--   confirmed_at IS NOT NULL
--   AND deleted_at IS NULL
--   AND COALESCE(is_anonymous, false) = false

-- Bootstrap only ELIGIBLE + REGISTRY MISSING users.
-- Registry-existing eligible users are NOT re-bootstrapped (zero audit noise).

DO $z2$
DECLARE
  v_user_id uuid;
  v_count   integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users AS u
    WHERE u.confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL
      AND COALESCE(u.is_anonymous, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM public.default_tenant_identities AS reg
        WHERE reg.user_id = u.id
      )
  LOOP
    -- Advisory lock reuse (same seed 11 as Migration 011)
    PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 11));

    -- Re-check absence under lock
    IF NOT EXISTS (
      SELECT 1 FROM public.default_tenant_identities WHERE user_id = v_user_id
    ) THEN
      PERFORM public.ensure_default_tenant_for_user_v1(v_user_id);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Migration 012 Z2: bootstrapped % eligible users missing registry', v_count;
END;
$z2$;

-- =========================================================================
-- Z3. Backfill canonical stamps on all seven reconciliation tables
-- =========================================================================

-- 3a. bank_statements — anchor from default_tenant_identities
UPDATE public.bank_statements AS bs
SET client_entity_id = reg.client_entity_id,
    ledger_book_id   = reg.internal_ledger_book_id
FROM public.default_tenant_identities AS reg
WHERE bs.user_id = reg.user_id
  AND bs.client_entity_id IS NULL
  AND reg.client_entity_id IS NOT NULL
  AND reg.internal_ledger_book_id IS NOT NULL;

-- 3b. bank_transactions — inherit from parent bank_statements
UPDATE public.bank_transactions AS bt
SET client_entity_id = bs.client_entity_id
FROM public.bank_statements AS bs
WHERE bt.statement_id = bs.id
  AND bt.client_entity_id IS NULL
  AND bs.client_entity_id IS NOT NULL;

-- 3c. qb_transactions — anchor from default_tenant_identities
UPDATE public.qb_transactions AS qt
SET client_entity_id = reg.client_entity_id,
    ledger_book_id   = reg.internal_ledger_book_id
FROM public.default_tenant_identities AS reg
WHERE qt.user_id = reg.user_id
  AND qt.client_entity_id IS NULL
  AND reg.client_entity_id IS NOT NULL
  AND reg.internal_ledger_book_id IS NOT NULL;

-- 3d. reconciliation_matches — inherit from parent bank_statements
UPDATE public.reconciliation_matches AS rm
SET client_entity_id = bs.client_entity_id
FROM public.bank_statements AS bs
WHERE rm.statement_id = bs.id
  AND rm.client_entity_id IS NULL
  AND bs.client_entity_id IS NOT NULL;

-- 3e. reconciliation_reports — inherit from parent bank_statements
UPDATE public.reconciliation_reports AS rr
SET client_entity_id = bs.client_entity_id
FROM public.bank_statements AS bs
WHERE rr.statement_id = bs.id
  AND rr.client_entity_id IS NULL
  AND bs.client_entity_id IS NOT NULL;

-- 3f. reconciliation_decisions — inherit from parent bank_statements
UPDATE public.reconciliation_decisions AS rd
SET client_entity_id = bs.client_entity_id
FROM public.bank_statements AS bs
WHERE rd.statement_id = bs.id
  AND rd.client_entity_id IS NULL
  AND bs.client_entity_id IS NOT NULL;

-- 3g. reconciliation_audit_log — backfill user_id from parent match;
--     client_entity_id from match's client_entity_id
UPDATE public.reconciliation_audit_log AS ral
SET user_id          = rm.user_id,
    client_entity_id = rm.client_entity_id
FROM public.reconciliation_matches AS rm
WHERE ral.reconciliation_match_id = rm.id
  AND ral.user_id IS NULL;

-- STOP if any audit row cannot be resolved.
DO $z3g$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.reconciliation_audit_log WHERE user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'NO-GO: audit rows with unresolvable user_id'
      USING HINT = 'Resolve orphan audit rows before retrying';
  END IF;
END;
$z3g$;

-- =========================================================================
-- Z4. Parent unique indexes (required for composite FKs)
-- =========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uk_bank_statements_id_client
  ON public.bank_statements (id, client_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS uk_bank_transactions_id_client
  ON public.bank_transactions (id, client_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS uk_bank_transactions_statement_id
  ON public.bank_transactions (statement_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uk_qb_transactions_id_client
  ON public.qb_transactions (id, client_entity_id);

-- =========================================================================
-- Z5. Composite foreign keys (immediate validation)
-- =========================================================================

-- bank_transactions → bank_statements (child must belong to same client)
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT fk_bank_transactions_statement_client
  FOREIGN KEY (statement_id, client_entity_id)
  REFERENCES public.bank_statements (id, client_entity_id)
  ON DELETE CASCADE;

-- bank_statements → ledger_books + client_entities
ALTER TABLE public.bank_statements
  ADD CONSTRAINT fk_bank_statements_ledger_client
  FOREIGN KEY (ledger_book_id, client_entity_id)
  REFERENCES public.ledger_books (id, client_entity_id)
  ON DELETE RESTRICT;

ALTER TABLE public.bank_statements
  ADD CONSTRAINT fk_bank_statements_client
  FOREIGN KEY (client_entity_id)
  REFERENCES public.client_entities (id)
  ON DELETE RESTRICT;

-- qb_transactions → ledger_books + client_entities
ALTER TABLE public.qb_transactions
  ADD CONSTRAINT fk_qb_transactions_ledger_client
  FOREIGN KEY (ledger_book_id, client_entity_id)
  REFERENCES public.ledger_books (id, client_entity_id)
  ON DELETE RESTRICT;

ALTER TABLE public.qb_transactions
  ADD CONSTRAINT fk_qb_transactions_client
  FOREIGN KEY (client_entity_id)
  REFERENCES public.client_entities (id)
  ON DELETE RESTRICT;

-- reconciliation_matches → bank_statements + bank_transactions
ALTER TABLE public.reconciliation_matches
  ADD CONSTRAINT fk_matches_statement_client
  FOREIGN KEY (statement_id, client_entity_id)
  REFERENCES public.bank_statements (id, client_entity_id)
  ON DELETE CASCADE;

ALTER TABLE public.reconciliation_matches
  ADD CONSTRAINT fk_matches_bank_txn_client
  FOREIGN KEY (bank_transaction_id, client_entity_id)
  REFERENCES public.bank_transactions (id, client_entity_id)
  ON DELETE CASCADE;

ALTER TABLE public.reconciliation_matches
  ADD CONSTRAINT fk_matches_statement_bank_txn
  FOREIGN KEY (statement_id, bank_transaction_id)
  REFERENCES public.bank_transactions (statement_id, id)
  ON DELETE CASCADE;

-- reconciliation_reports → bank_statements
ALTER TABLE public.reconciliation_reports
  ADD CONSTRAINT fk_reports_statement_client
  FOREIGN KEY (statement_id, client_entity_id)
  REFERENCES public.bank_statements (id, client_entity_id)
  ON DELETE CASCADE;

-- reconciliation_decisions → bank_statements (RESTRICT per design Section 17)
ALTER TABLE public.reconciliation_decisions
  ADD CONSTRAINT fk_decisions_statement_client
  FOREIGN KEY (statement_id, client_entity_id)
  REFERENCES public.bank_statements (id, client_entity_id)
  ON DELETE RESTRICT;

-- =========================================================================
-- Z6. Audit log redesign
-- =========================================================================

-- 6a. Make match pointer nullable
ALTER TABLE public.reconciliation_audit_log
  ALTER COLUMN reconciliation_match_id DROP NOT NULL;

-- 6b. Drop old CASCADE FK
ALTER TABLE public.reconciliation_audit_log
  DROP CONSTRAINT IF EXISTS reconciliation_audit_log_reconciliation_match_id_fkey;

-- 6c. Add SET NULL FK on match pointer
ALTER TABLE public.reconciliation_audit_log
  ADD CONSTRAINT fk_audit_log_match
  FOREIGN KEY (reconciliation_match_id)
  REFERENCES public.reconciliation_matches (id)
  ON DELETE SET NULL;

-- 6d. SET NOT NULL on user_id (only after Z3g verified every row has user_id)
ALTER TABLE public.reconciliation_audit_log
  ALTER COLUMN user_id SET NOT NULL;

-- 6e. Add user_id FK to auth.users (RESTRICT per design Section 14)
ALTER TABLE public.reconciliation_audit_log
  ADD CONSTRAINT fk_audit_log_user
  FOREIGN KEY (user_id)
  REFERENCES auth.users (id)
  ON DELETE RESTRICT;

-- =========================================================================
-- Z7. QB same-client guard
-- =========================================================================

CREATE OR REPLACE FUNCTION public.match_qb_same_client_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_qb_client uuid;
BEGIN
  IF NEW.qb_transaction_id IS NOT NULL AND NEW.client_entity_id IS NOT NULL THEN
    SELECT client_entity_id INTO v_qb_client
    FROM public.qb_transactions
    WHERE id = NEW.qb_transaction_id;
    IF v_qb_client IS DISTINCT FROM NEW.client_entity_id THEN
      RAISE EXCEPTION 'match QB transaction must belong to the same client'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER match_qb_same_client_check
  BEFORE INSERT OR UPDATE OF qb_transaction_id, client_entity_id
  ON public.reconciliation_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.match_qb_same_client_v1();

-- =========================================================================
-- Z8. Write-guard trigger functions + attachments
-- =========================================================================

-- A. Child-table guard: requires client_entity_id NOT NULL on INSERT
CREATE OR REPLACE FUNCTION public.require_reconciliation_client_stamp_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- B. Root-table guard: requires BOTH client_entity_id AND ledger_book_id NOT NULL on INSERT
CREATE OR REPLACE FUNCTION public.require_reconciliation_root_stamp_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical client_entity_id'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.ledger_book_id IS NULL THEN
      RAISE EXCEPTION 'reconciliation writes require a canonical ledger_book_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- C. Audit log write guard: requires user_id + client_entity_id NOT NULL on INSERT
CREATE OR REPLACE FUNCTION public.audit_log_write_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'audit log requires user_id'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.client_entity_id IS NULL THEN
      RAISE EXCEPTION 'audit log requires client_entity_id'
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger attachments
CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

CREATE TRIGGER write_guard_root_stamp
  BEFORE INSERT ON public.qb_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_root_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER write_guard_client_stamp
  BEFORE INSERT ON public.reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.require_reconciliation_client_stamp_v1();

CREATE TRIGGER audit_log_write_guard
  BEFORE INSERT ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_write_guard_v1();

-- =========================================================================
-- Z9. Immutability triggers
-- =========================================================================

-- 9a. client_entity_id immutability (NULL → value allowed once)
CREATE OR REPLACE FUNCTION public.client_stamp_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.client_entity_id IS NOT NULL
     AND NEW.client_entity_id IS DISTINCT FROM OLD.client_entity_id THEN
    RAISE EXCEPTION 'client_entity_id is immutable once set'
      USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END;
$$;

-- 9b. ledger_book_id immutability (same transition semantics)
CREATE OR REPLACE FUNCTION public.ledger_book_id_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.ledger_book_id IS NOT NULL
     AND NEW.ledger_book_id IS DISTINCT FROM OLD.ledger_book_id THEN
    RAISE EXCEPTION 'ledger_book_id is immutable once set'
      USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END;
$$;

-- 9c. Audit log stamp immutability (client_entity_id + user_id)
CREATE OR REPLACE FUNCTION public.audit_log_stamp_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.client_entity_id IS NOT NULL
     AND NEW.client_entity_id IS DISTINCT FROM OLD.client_entity_id THEN
    RAISE EXCEPTION 'audit log client_entity_id is immutable'
      USING ERRCODE = '42806';
  END IF;
  IF OLD.user_id IS NOT NULL
     AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'audit log user_id is immutable'
      USING ERRCODE = '42806';
  END IF;
  RETURN NEW;
END;
$$;

-- 9d. Audit evidence immutability (action, action_by, action_at, confidence columns)
CREATE OR REPLACE FUNCTION public.audit_log_evidence_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation audit evidence is immutable'
    USING ERRCODE = '42806';
END;
$$;

-- Attach client_entity_id immutability on all seven tables
CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.qb_transactions
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

CREATE TRIGGER client_stamp_immutable
  BEFORE UPDATE OF client_entity_id ON public.reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.client_stamp_immutable_v1();

-- Attach ledger_book_id immutability on root tables
CREATE TRIGGER ledger_book_id_immutable
  BEFORE UPDATE OF ledger_book_id ON public.bank_statements
  FOR EACH ROW EXECUTE FUNCTION public.ledger_book_id_immutable_v1();

CREATE TRIGGER ledger_book_id_immutable
  BEFORE UPDATE OF ledger_book_id ON public.qb_transactions
  FOR EACH ROW EXECUTE FUNCTION public.ledger_book_id_immutable_v1();

-- Audit log stamp immutability
CREATE TRIGGER audit_log_stamp_immutable
  BEFORE UPDATE OF client_entity_id, user_id ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_stamp_immutable_v1();

-- Audit log evidence immutability (UPDATE of evidence columns)
CREATE TRIGGER audit_log_evidence_immutable
  BEFORE UPDATE OF action, action_by, action_at, old_confidence, new_confidence
  ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_evidence_immutable_v1();

-- Audit log no-delete
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON public.reconciliation_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_evidence_immutable_v1();

-- =========================================================================
-- Z10. RPCs
-- =========================================================================

-- 10a. Self-context RPC (read-only, authenticated only)
CREATE OR REPLACE FUNCTION public.canonical_default_tenant_context_for_self_v1()
RETURNS TABLE (
  practice_id            uuid,
  practice_membership_id uuid,
  client_entity_id       uuid,
  internal_ledger_book_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reg     public.default_tenant_identities%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'default tenant context requires an authenticated JWT'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_reg
  FROM public.default_tenant_identities
  WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'default tenant identity not found'
      USING ERRCODE = '23503';
  END IF;

  IF v_reg.practice_id IS NULL
     OR v_reg.practice_membership_id IS NULL
     OR v_reg.client_entity_id IS NULL
     OR v_reg.internal_ledger_book_id IS NULL THEN
    RAISE EXCEPTION 'default tenant identity is incomplete'
      USING ERRCODE = '23502';
  END IF;

  -- Full graph validation
  PERFORM 1 FROM public.practices AS p
  WHERE p.id = v_reg.practice_id
    AND p.created_by_user_id = v_user_id
    AND p.status = 'active'
    AND p.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default practice identity ownership mismatch'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.practice_memberships AS pm
  WHERE pm.id = v_reg.practice_membership_id
    AND pm.practice_id = v_reg.practice_id
    AND pm.user_id = v_user_id
    AND pm.role = 'owner'
    AND pm.status = 'active'
    AND pm.valid_to IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default practice membership identity ownership mismatch'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.client_entities AS ce
  WHERE ce.id = v_reg.client_entity_id
    AND ce.practice_id = v_reg.practice_id
    AND ce.status = 'active'
    AND ce.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default client entity identity ownership mismatch'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.ledger_books AS lb
  WHERE lb.id = v_reg.internal_ledger_book_id
    AND lb.client_entity_id = v_reg.client_entity_id
    AND lb.book_kind = 'internal'
    AND lb.status = 'active'
    AND lb.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'default internal ledger identity ownership mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT v_reg.practice_id,
         v_reg.practice_membership_id,
         v_reg.client_entity_id,
         v_reg.internal_ledger_book_id;
END;
$$;

-- ACL: authenticated may EXECUTE; anon + service_role denied
REVOKE ALL ON FUNCTION public.canonical_default_tenant_context_for_self_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.canonical_default_tenant_context_for_self_v1()
  TO authenticated;

-- 10b. Service-only canonical tenant helper
CREATE OR REPLACE FUNCTION public.canonical_default_tenant_ids_v1(
  p_user_id uuid
)
RETURNS TABLE (
  practice_id            uuid,
  practice_membership_id uuid,
  client_entity_id       uuid,
  internal_ledger_book_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_reg public.default_tenant_identities%ROWTYPE;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'canonical tenant resolution requires service_role'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_reg
  FROM public.default_tenant_identities
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'default tenant identity not found for user'
      USING ERRCODE = '23503';
  END IF;

  IF v_reg.practice_id IS NULL
     OR v_reg.practice_membership_id IS NULL
     OR v_reg.client_entity_id IS NULL
     OR v_reg.internal_ledger_book_id IS NULL THEN
    RAISE EXCEPTION 'default tenant identity is incomplete for user'
      USING ERRCODE = '23502';
  END IF;

  RETURN QUERY
  SELECT v_reg.practice_id,
         v_reg.practice_membership_id,
         v_reg.client_entity_id,
         v_reg.internal_ledger_book_id;
END;
$$;

REVOKE ALL ON FUNCTION public.canonical_default_tenant_ids_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canonical_default_tenant_ids_v1(uuid)
  TO service_role;

-- 10c. Updated bank statement ingestion RPC
--      Canonical validation BEFORE idempotent/artifact-reuse return.

CREATE OR REPLACE FUNCTION public.ingest_bank_statement_v1(
  p_user_id        uuid,
  p_statement      jsonb,
  p_transactions   jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_statement_id          uuid := COALESCE(NULLIF(p_statement->>'id', '')::uuid, gen_random_uuid());
  v_inserted_statement_id uuid;
  v_transaction_id        uuid;
  v_item                  jsonb;
  v_provider              text := NULLIF(btrim(p_statement->>'source_provider'), '');
  v_organisation_id       text := NULLIF(btrim(p_statement->>'source_organisation_id'), '');
  v_account_id            text := NULLIF(btrim(p_statement->>'source_account_id'), '');
  v_artifact_hash         text := NULLIF(btrim(p_statement->>'source_artifact_hash'), '');
  v_external_id           text;
  v_inserted_count        integer := 0;
  v_reused_count          integer := 0;
  -- Canonical context (validated before any insert/reuse)
  v_client_entity_id      uuid := NULLIF(p_statement->>'client_entity_id', '')::uuid;
  v_ledger_book_id        uuid := NULLIF(p_statement->>'ledger_book_id', '')::uuid;
  v_reg_client            uuid;
  v_reg_ledger            uuid;
BEGIN
  -- Auth guard (unchanged from 008)
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'RPC user does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires an authenticated user or service_role'
      USING ERRCODE = '42501';
  END IF;

  -- Canonical validation — MUST run before artifact reuse (Section 18)
  IF v_client_entity_id IS NULL OR v_ledger_book_id IS NULL THEN
    RAISE EXCEPTION 'canonical client_entity_id and ledger_book_id are required'
      USING ERRCODE = '23502';
  END IF;

  SELECT reg.client_entity_id, reg.internal_ledger_book_id
    INTO v_reg_client, v_reg_ledger
  FROM public.default_tenant_identities AS reg
  WHERE reg.user_id = p_user_id;

  IF v_reg_client IS NULL THEN
    RAISE EXCEPTION 'canonical tenant identity not found for user'
      USING ERRCODE = '23503';
  END IF;

  IF v_client_entity_id IS DISTINCT FROM v_reg_client THEN
    RAISE EXCEPTION 'supplied client_entity_id does not match user canonical client'
      USING ERRCODE = '23514';
  END IF;

  IF v_ledger_book_id IS DISTINCT FROM v_reg_ledger THEN
    RAISE EXCEPTION 'supplied ledger_book_id does not match user canonical ledger'
      USING ERRCODE = '23514';
  END IF;

  -- Input validation
  IF jsonb_typeof(p_transactions) <> 'array' THEN
    RAISE EXCEPTION 'p_transactions must be a JSON array';
  END IF;

  -- Statement insert / artifact reuse
  INSERT INTO public.bank_statements (
    id, user_id, file_name, file_format,
    statement_period_start, statement_period_end, currency,
    opening_balance, closing_balance, transaction_count,
    source_provider, source_organisation_id, source_account_id,
    source_account_metadata, source_artifact_hash,
    client_entity_id, ledger_book_id
  ) VALUES (
    v_statement_id, p_user_id, p_statement->>'file_name', p_statement->>'file_format',
    NULLIF(p_statement->>'statement_period_start', '')::date,
    NULLIF(p_statement->>'statement_period_end', '')::date,
    NULLIF(p_statement->>'currency', ''),
    NULLIF(p_statement->>'opening_balance', '')::numeric,
    NULLIF(p_statement->>'closing_balance', '')::numeric,
    COALESCE(NULLIF(p_statement->>'transaction_count', '')::integer, jsonb_array_length(p_transactions)),
    v_provider, v_organisation_id, v_account_id,
    p_statement->'source_account_metadata', v_artifact_hash,
    v_client_entity_id, v_ledger_book_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_statement_id;

  IF v_inserted_statement_id IS NULL THEN
    IF v_artifact_hash IS NULL OR v_provider IS NULL THEN
      RAISE EXCEPTION 'Statement insert conflicted without a reusable artifact identity';
    END IF;
    SELECT bs.id INTO v_statement_id
    FROM public.bank_statements AS bs
    WHERE bs.user_id = p_user_id
      AND bs.source_provider = v_provider
      AND bs.source_organisation_id IS NOT DISTINCT FROM v_organisation_id
      AND bs.source_account_id IS NOT DISTINCT FROM v_account_id
      AND bs.source_artifact_hash = v_artifact_hash;
    IF v_statement_id IS NULL THEN
      RAISE EXCEPTION 'Statement artifact conflict could not be resolved';
    END IF;
    RETURN jsonb_build_object(
      'statement_id', v_statement_id,
      'inserted_count', 0,
      'reused_count', jsonb_array_length(p_transactions),
      'reused_artifact', true
    );
  END IF;

  -- Per-transaction insert
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transactions)
  LOOP
    v_transaction_id := NULL;
    v_external_id := NULLIF(btrim(v_item->>'external_transaction_id'), '');

    IF v_provider IS NOT NULL AND v_account_id IS NOT NULL AND v_external_id IS NOT NULL THEN
      INSERT INTO public.bank_transactions (
        id, statement_id, user_id, transaction_date, posted_date,
        merchant, description, amount, currency, transaction_id, memo,
        external_transaction_id, source_provider, source_organisation_id,
        source_account_id, identity_fingerprint, identity_fingerprint_version,
        client_entity_id
      ) VALUES (
        gen_random_uuid(), v_statement_id, p_user_id,
        (v_item->>'transaction_date')::date,
        NULLIF(v_item->>'posted_date', '')::date,
        v_item->>'merchant', v_item->>'description', (v_item->>'amount')::numeric,
        NULLIF(v_item->>'currency', ''),
        COALESCE(NULLIF(v_item->>'transaction_id', ''), v_external_id),
        v_item->>'memo', v_external_id, v_provider, v_organisation_id,
        v_account_id, NULLIF(v_item->>'identity_fingerprint', ''),
        NULLIF(v_item->>'identity_fingerprint_version', '')::integer,
        v_client_entity_id
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_transaction_id;

      IF v_transaction_id IS NULL THEN
        SELECT bt.id INTO v_transaction_id
        FROM public.bank_transactions AS bt
        WHERE bt.user_id = p_user_id
          AND bt.source_provider = v_provider
          AND bt.source_organisation_id IS NOT DISTINCT FROM v_organisation_id
          AND bt.source_account_id = v_account_id
          AND bt.external_transaction_id = v_external_id;
        v_reused_count := v_reused_count + 1;
      ELSE
        v_inserted_count := v_inserted_count + 1;
      END IF;
    ELSE
      INSERT INTO public.bank_transactions (
        id, statement_id, user_id, transaction_date, posted_date,
        merchant, description, amount, currency, transaction_id, memo,
        external_transaction_id, source_provider, source_organisation_id,
        source_account_id, identity_fingerprint, identity_fingerprint_version,
        client_entity_id
      ) VALUES (
        gen_random_uuid(), v_statement_id, p_user_id,
        (v_item->>'transaction_date')::date,
        NULLIF(v_item->>'posted_date', '')::date,
        v_item->>'merchant', v_item->>'description', (v_item->>'amount')::numeric,
        NULLIF(v_item->>'currency', ''), NULLIF(v_item->>'transaction_id', ''),
        v_item->>'memo', v_external_id, v_provider, v_organisation_id,
        v_account_id, NULLIF(v_item->>'identity_fingerprint', ''),
        NULLIF(v_item->>'identity_fingerprint_version', '')::integer,
        v_client_entity_id
      ) RETURNING id INTO v_transaction_id;
      v_inserted_count := v_inserted_count + 1;
    END IF;

    IF v_transaction_id IS NULL THEN
      RAISE EXCEPTION 'Canonical bank transaction identity could not be resolved';
    END IF;

    INSERT INTO public.bank_statement_transaction_observations (
      user_id, statement_id, bank_transaction_id, source_row_number,
      source_reference_hash, observed_at, created_at
    ) VALUES (
      p_user_id, v_statement_id, v_transaction_id,
      NULLIF(v_item->>'source_row_number', '')::integer,
      NULLIF(v_item->>'source_reference_hash', ''), now(), now()
    )
    ON CONFLICT (statement_id, bank_transaction_id) DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object(
    'statement_id', v_statement_id,
    'inserted_count', v_inserted_count,
    'reused_count', v_reused_count,
    'reused_artifact', false
  );
END;
$$;

-- 10d. Updated accounting transaction ingestion RPC
--      Canonical validation BEFORE idempotent/artifact-reuse return.

CREATE OR REPLACE FUNCTION public.ingest_accounting_transactions_v1(
  p_user_id       uuid,
  p_transactions  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item                 jsonb;
  v_transaction_id       uuid;
  v_provider             text;
  v_organisation_id      text;
  v_object_type          text;
  v_external_id          text;
  v_artifact_hash        text;
  v_source_row_number    integer;
  v_provider_identity_id uuid;
  v_artifact_identity_id uuid;
  v_inserted_count       integer := 0;
  v_reused_count         integer := 0;
  -- Canonical context
  v_client_entity_id     uuid;
  v_ledger_book_id       uuid;
  v_reg_client           uuid;
  v_reg_ledger           uuid;
BEGIN
  -- Auth guard (unchanged from 008)
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'RPC user does not match authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires an authenticated user or service_role'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_transactions) <> 'array' THEN
    RAISE EXCEPTION 'p_transactions must be a JSON array';
  END IF;

  -- Canonical validation — MUST run before processing any item (Section 18)
  -- Extract canonical IDs from the first transaction item
  v_client_entity_id := NULLIF(btrim(p_transactions->0->>'client_entity_id'), '')::uuid;
  v_ledger_book_id   := NULLIF(btrim(p_transactions->0->>'ledger_book_id'), '')::uuid;

  IF v_client_entity_id IS NULL OR v_ledger_book_id IS NULL THEN
    RAISE EXCEPTION 'canonical client_entity_id and ledger_book_id are required'
      USING ERRCODE = '23502';
  END IF;

  SELECT reg.client_entity_id, reg.internal_ledger_book_id
    INTO v_reg_client, v_reg_ledger
  FROM public.default_tenant_identities AS reg
  WHERE reg.user_id = p_user_id;

  IF v_reg_client IS NULL THEN
    RAISE EXCEPTION 'canonical tenant identity not found for user'
      USING ERRCODE = '23503';
  END IF;

  IF v_client_entity_id IS DISTINCT FROM v_reg_client THEN
    RAISE EXCEPTION 'supplied client_entity_id does not match user canonical client'
      USING ERRCODE = '23514';
  END IF;

  IF v_ledger_book_id IS DISTINCT FROM v_reg_ledger THEN
    RAISE EXCEPTION 'supplied ledger_book_id does not match user canonical ledger'
      USING ERRCODE = '23514';
  END IF;

  -- Process transactions
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transactions)
  LOOP
    v_transaction_id := NULL;
    v_provider_identity_id := NULL;
    v_artifact_identity_id := NULL;
    v_provider := NULLIF(btrim(v_item->>'provider'), '');
    v_organisation_id := NULLIF(btrim(v_item->>'organisation_id'), '');
    v_object_type := NULLIF(btrim(v_item->>'external_object_type'), '');
    v_external_id := NULLIF(btrim(v_item->>'qb_transaction_id'), '');
    v_artifact_hash := NULLIF(btrim(v_item->>'source_artifact_hash'), '');
    v_source_row_number := NULLIF(v_item->>'source_row_number', '')::integer;

    INSERT INTO public.qb_transactions (
      id, user_id, qb_transaction_id, qb_account_id, posted_date, amount,
      description, account_name, account_type, currency, synced_from_qb_at,
      provider, organisation_id, external_object_type,
      identity_fingerprint, identity_fingerprint_version,
      source_artifact_hash, source_row_number,
      client_entity_id, ledger_book_id
    ) VALUES (
      COALESCE(NULLIF(v_item->>'id', '')::uuid, gen_random_uuid()),
      p_user_id, v_external_id, NULLIF(v_item->>'qb_account_id', ''),
      (v_item->>'posted_date')::date, (v_item->>'amount')::numeric,
      v_item->>'description', v_item->>'account_name', v_item->>'account_type',
      NULLIF(v_item->>'currency', ''), now(), v_provider, v_organisation_id,
      v_object_type, NULLIF(v_item->>'identity_fingerprint', ''),
      NULLIF(v_item->>'identity_fingerprint_version', '')::integer,
      v_artifact_hash, v_source_row_number,
      v_client_entity_id, v_ledger_book_id
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_transaction_id;

    IF v_transaction_id IS NULL THEN
      IF v_provider IS NOT NULL AND v_organisation_id IS NOT NULL
         AND v_object_type IS NOT NULL AND v_external_id IS NOT NULL THEN
        SELECT qt.id INTO v_provider_identity_id
        FROM public.qb_transactions AS qt
        WHERE qt.user_id = p_user_id
          AND qt.provider = v_provider
          AND qt.organisation_id = v_organisation_id
          AND qt.external_object_type = v_object_type
          AND qt.qb_transaction_id = v_external_id;
      END IF;

      IF v_provider IS NOT NULL AND v_artifact_hash IS NOT NULL
         AND v_source_row_number IS NOT NULL THEN
        SELECT qt.id INTO v_artifact_identity_id
        FROM public.qb_transactions AS qt
        WHERE qt.user_id = p_user_id
          AND qt.provider = v_provider
          AND qt.organisation_id IS NOT DISTINCT FROM v_organisation_id
          AND qt.source_artifact_hash = v_artifact_hash
          AND qt.source_row_number = v_source_row_number;
      END IF;

      IF v_provider_identity_id IS NOT NULL
         AND v_artifact_identity_id IS NOT NULL
         AND v_provider_identity_id IS DISTINCT FROM v_artifact_identity_id THEN
        RAISE EXCEPTION 'Provider identity conflicts with artifact identity'
          USING ERRCODE = '23505';
      END IF;

      v_transaction_id := COALESCE(v_provider_identity_id, v_artifact_identity_id);
      IF v_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Accounting transaction conflict could not be resolved';
      END IF;
      v_reused_count := v_reused_count + 1;
    ELSE
      v_inserted_count := v_inserted_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted_count', v_inserted_count,
    'reused_count', v_reused_count
  );
END;
$$;

-- Re-assert RPC ACLs (matching 008/009 pattern)
REVOKE EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_bank_statement_v1(uuid, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_accounting_transactions_v1(uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_statement_bank_transactions_v1(uuid, uuid)
  TO service_role;

-- The ingestion RPCs are SECURITY INVOKER and resolve the caller's canonical
-- tenant registry BEFORE any write/reuse (Section 18 fail-closed contract).
-- Migration 011 revoked all table privileges on the registry, so grant the
-- service role the read it needs to run those RPCs; direct DML is still denied.
GRANT SELECT ON TABLE public.default_tenant_identities TO service_role;

-- =========================================================================
-- Z11. Read-path indexes
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_bank_statements_client
  ON public.bank_statements (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_client
  ON public.bank_transactions (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_qb_transactions_client
  ON public.qb_transactions (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_client
  ON public.reconciliation_matches (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_client
  ON public.reconciliation_reports (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_decisions_client
  ON public.reconciliation_decisions (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_audit_log_client
  ON public.reconciliation_audit_log (client_entity_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_audit_log_user
  ON public.reconciliation_audit_log (user_id);

-- =========================================================================
-- Z12. Audit log privilege model (immutable accounting evidence)
-- =========================================================================

-- Drop the old FOR ALL policy (both 003 shape and any prior draft)
DROP POLICY IF EXISTS "Users can only access their own audit log"
  ON public.reconciliation_audit_log;

-- Read-only SELECT policy: authenticated sees only their own audit rows
CREATE POLICY "Users can read their own audit log"
  ON public.reconciliation_audit_log
  FOR SELECT
  USING (auth.uid() = user_id);

-- Revoke direct DML from authenticated
REVOKE INSERT, UPDATE, DELETE ON public.reconciliation_audit_log FROM authenticated;

-- anon gets no audit access
REVOKE ALL ON public.reconciliation_audit_log FROM anon;

-- =========================================================================
-- Z13. End-of-migration invariant assertions
-- =========================================================================

-- B1: No bank_statements row has non-NULL client_entity_id referencing a
--     non-existent or wrong-practice client
DO $b1$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.bank_statements AS bs
  LEFT JOIN public.client_entities AS ce ON ce.id = bs.client_entity_id
  WHERE bs.client_entity_id IS NOT NULL AND ce.id IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B1 FAIL: % bank_statements rows have dangling client_entity_id', v_count;
  END IF;
END;
$b1$;

-- B2: No child bank_transaction has client_entity_id different from parent statement
DO $b2$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.bank_transactions AS bt
  JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
  WHERE bt.client_entity_id IS DISTINCT FROM bs.client_entity_id
    AND bt.client_entity_id IS NOT NULL
    AND bs.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B2 FAIL: % bank_transactions with client mismatch vs parent', v_count;
  END IF;
END;
$b2$;

-- B3: No match has client_entity_id different from parent statement
DO $b3$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_matches AS rm
  JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
  WHERE rm.client_entity_id IS DISTINCT FROM bs.client_entity_id
    AND rm.client_entity_id IS NOT NULL
    AND bs.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B3 FAIL: % matches with client mismatch vs parent statement', v_count;
  END IF;
END;
$b3$;

-- B4: No match has client_entity_id different from its bank_transaction
DO $b4$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_matches AS rm
  JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
  WHERE rm.client_entity_id IS DISTINCT FROM bt.client_entity_id
    AND rm.client_entity_id IS NOT NULL
    AND bt.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B4 FAIL: % matches with client mismatch vs bank transaction', v_count;
  END IF;
END;
$b4$;

-- B5: No report has client_entity_id different from parent statement
DO $b5$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_reports AS rr
  JOIN public.bank_statements AS bs ON bs.id = rr.statement_id
  WHERE rr.client_entity_id IS DISTINCT FROM bs.client_entity_id
    AND rr.client_entity_id IS NOT NULL
    AND bs.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B5 FAIL: % reports with client mismatch vs parent statement', v_count;
  END IF;
END;
$b5$;

-- B6: No decision has client_entity_id different from parent statement
DO $b6$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_decisions AS rd
  JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
  WHERE rd.client_entity_id IS DISTINCT FROM bs.client_entity_id
    AND rd.client_entity_id IS NOT NULL
    AND bs.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B6 FAIL: % decisions with client mismatch vs parent statement', v_count;
  END IF;
END;
$b6$;

-- B7: No audit row has user_id NULL
DO $b7$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_audit_log
  WHERE user_id IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B7 FAIL: % audit rows with NULL user_id', v_count;
  END IF;
END;
$b7$;

-- B8: All composite FKs validate (no violations)
--     (If Migration 012 reaches this point, all ADD CONSTRAINT passed immediate
--      validation. This is a belt-and-suspenders existence check.)
DO $b8$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_bank_transactions_statement_client'
  ) THEN
    RAISE EXCEPTION 'B8 FAIL: composite FK fk_bank_transactions_statement_client missing';
  END IF;
END;
$b8$;

-- B9: No audit row has client_entity_id different from parent match (for non-NULL match pointers)
DO $b9$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.reconciliation_audit_log AS ral
  JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
  WHERE ral.client_entity_id IS DISTINCT FROM rm.client_entity_id
    AND ral.client_entity_id IS NOT NULL
    AND rm.client_entity_id IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'B9 FAIL: % audit rows with client mismatch vs parent match', v_count;
  END IF;
END;
$b9$;

-- B10: Root-table write guard triggers exist
DO $b10$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'write_guard_root_stamp'
      AND event_object_table = 'bank_statements'
  ) THEN
    RAISE EXCEPTION 'B10 FAIL: Missing write_guard_root_stamp on bank_statements';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'write_guard_root_stamp'
      AND event_object_table = 'qb_transactions'
  ) THEN
    RAISE EXCEPTION 'B10 FAIL: Missing write_guard_root_stamp on qb_transactions';
  END IF;
END;
$b10$;

-- B11: Audit log authenticated DML revoked
DO $b11$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_name = 'reconciliation_audit_log'
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'B11 FAIL: authenticated has INSERT/UPDATE/DELETE on reconciliation_audit_log';
  END IF;
END;
$b11$;

-- =========================================================================
-- PostgREST schema reload
-- =========================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
