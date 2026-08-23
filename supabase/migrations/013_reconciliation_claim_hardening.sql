-- Zaki Ledger - Migration 013: Reconciliation Claim Hardening (D1-D5)
--
-- Defect remediation after the adversarial local Supabase staging verdict
-- (branch fix/reconciliation-candidate-hardening, base b67bc99):
--
--   D1  DB-enforced exclusive auto 1:1 claim (partial unique index +
--       atomic persist RPC) — concurrent workers can no longer double-claim
--       one QB row.
--   D2  Temporal stronger-evidence semantics: unresolved weak unapproved
--       auto suggestions no longer permanently reserve their QB row;
--       deterministic supersession rule (>=95 floor, >=20 delta) with
--       preserved historical evidence + audit events.
--   D3  Privilege lineage: explicit grants for the reconciliation store
--       surface. The current Supabase base no longer materializes the old
--       broad default privileges, and migrations 001-012 never granted the
--       four reconciliation tables. No manual grants required after reset.
--   D4  Approved-match immutability at the DB layer (guard trigger) with an
--       explicit controlled correction path (unapprove RPC).
--   D5  Same-ledger-book guard for match endpoints (trigger).
--   L   Approval transitions are controlled and audited (invariant L):
--       raw table UPDATEs can never mint an approval; only the
--       approve_reconciliation_matches_v1 RPC transitions a match into the
--       approved state, atomically with its audit evidence.
--   M   Manual reconciliation and automatic exclusive claims serialize on
--       the same locked bank/QB endpoint rows, in deterministic order. The
--       manual financial transition and its audit evidence are one database
--       transaction.
--   Z1b Repair/transition evidence columns on the audit log are immutable to
--       UPDATE for every role, matching the 012 evidence-immutability model.
--
-- Never modifies migrations 010/011/012. Additive only. One transaction.

BEGIN;

-- =========================================================================
-- Z1. Supersession columns (D2) — additive, nullable
-- =========================================================================

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

-- =========================================================================
-- Z1b. Repair-evidence immutability for the four new audit columns
-- =========================================================================
-- 012's audit_log_evidence_immutable_v1 covers action, action_by, action_at
-- and the confidence columns. The four columns added above hold repair and
-- transition evidence and must enjoy the same protection: they are written
-- only at INSERT time and can never be changed by any role afterwards
-- (mirrors 012 Z9d — no role exception, same as the existing model). The
-- historical-repair prep (supabase/repair-013-pre/13-repair-prep.sql) installs
-- the identical trigger so the protection exists from prep time onward; this
-- copy makes the protection part of the deployed 013 invariant surface.
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

-- One-shot, transaction-bound capabilities used by the row guard.  Unlike a
-- custom GUC these rows cannot be minted by an API caller: the schema and
-- table are inaccessible to API roles and only SECURITY DEFINER transition
-- functions may insert them.  The trigger consumes the capability on use.
CREATE SCHEMA IF NOT EXISTS reconciliation_private;
REVOKE ALL ON SCHEMA reconciliation_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS reconciliation_private.transition_capabilities (
  txid bigint NOT NULL,
  match_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'unapprove', 'supersede', 'manual')),
  actor_id uuid,
  operation_id uuid NOT NULL,
  PRIMARY KEY (txid, match_id, action)
);
REVOKE ALL ON TABLE reconciliation_private.transition_capabilities
  FROM PUBLIC, anon, authenticated, service_role;

-- Shared serialization primitive (invariant M). Every controlled path locks
-- bank endpoints first and QB endpoints second; each set is UUID-sorted. The
-- bank lock stabilizes the per-bank relationship while the QB lock serializes
-- all manual and automatic decisions affecting the exclusive claim endpoint.
CREATE OR REPLACE FUNCTION reconciliation_private.lock_bank_endpoints_v1(
  p_bank_transaction_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN
    SELECT DISTINCT endpoint_id
    FROM unnest(COALESCE(p_bank_transaction_ids, '{}'::uuid[])) AS endpoint(endpoint_id)
    WHERE endpoint_id IS NOT NULL
    ORDER BY endpoint_id
  LOOP
    PERFORM 1
    FROM public.bank_transactions
    WHERE id = v_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank transaction endpoint not found'
        USING ERRCODE = '23503';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION reconciliation_private.lock_qb_endpoints_v1(
  p_qb_transaction_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN
    SELECT DISTINCT endpoint_id
    FROM unnest(COALESCE(p_qb_transaction_ids, '{}'::uuid[])) AS endpoint(endpoint_id)
    WHERE endpoint_id IS NOT NULL
    ORDER BY endpoint_id
  LOOP
    PERFORM 1
    FROM public.qb_transactions
    WHERE id = v_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QB transaction endpoint not found'
        USING ERRCODE = '23503';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION reconciliation_private.lock_bank_endpoints_v1(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION reconciliation_private.lock_qb_endpoints_v1(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

-- Superseded row -> new row pointer. ON DELETE SET NULL: rejecting the new
-- row must never strand the preserved historical row.
-- DEFERRABLE INITIALLY DEFERRED: the persist RPC supersedes the holder
-- (writing the pointer) BEFORE inserting the new row inside one transaction;
-- the referential check therefore runs at COMMIT, when both rows exist.
ALTER TABLE public.reconciliation_matches
  DROP CONSTRAINT IF EXISTS fk_matches_superseded_by;
ALTER TABLE public.reconciliation_matches
  ADD CONSTRAINT fk_matches_superseded_by
  FOREIGN KEY (superseded_by_match_id)
  REFERENCES public.reconciliation_matches (id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- =========================================================================
-- Z2. Pre-apply duplicate-claim diagnosis (loud, deterministic)
-- =========================================================================
-- If a database already carries two live automatic rows for one QB row, the
-- exclusive index below cannot be built. Fail with a diagnosable message
-- instead of a raw index error; an operator must run a reviewed dedup.
-- (Fresh/local databases have no rows and pass through.)

DO $z2$
DECLARE
  v_count integer;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT qb_id, ', ')
    INTO v_count, v_sample
  FROM (
    SELECT qb_transaction_id::text AS qb_id
    FROM (
      SELECT qb_transaction_id
      FROM public.reconciliation_matches
      WHERE matched_by = 'auto'
        AND qb_transaction_id IS NOT NULL
        AND superseded_at IS NULL
      GROUP BY qb_transaction_id
      HAVING count(*) > 1
    ) AS dupes
    LIMIT 5
  ) AS sample;

  IF v_count > 0 THEN
    RAISE EXCEPTION 'NO-GO: % QB rows already carry multiple live auto claims (sample: %)',
      v_count, v_sample
      USING HINT = 'Run a reviewed dedup of duplicate live auto claims before retrying';
  END IF;
END;
$z2$;

-- =========================================================================
-- Z3. Exclusive auto-claim index (D1)
-- =========================================================================
-- Exactly the exclusive claim class: live automatic claims with a claimed
-- QB row. Manual rows (explicit allocations, many:1) are never constrained;
-- superseded rows are historical evidence, not claims.

CREATE UNIQUE INDEX IF NOT EXISTS uk_matches_auto_live_qb
  ON public.reconciliation_matches (qb_transaction_id)
  WHERE matched_by = 'auto'
    AND qb_transaction_id IS NOT NULL
    AND superseded_at IS NULL;

-- =========================================================================
-- Z4. Privilege lineage (D3)
-- =========================================================================
-- Migrations 001-012 relied on Supabase base-image default privileges for
-- these tables; the current base no longer materializes them. Reset the ACLs
-- explicitly and grant exactly the documented contract (see
-- migration-012-tenant-isolation.test.ts surface notes and 012 Z12):
--   service_role: full store surface (audit DML retained per the 012
--                 contract; actual mutation stays blocked by the 012
--                 evidence-immutability triggers).
--   authenticated: ALL + RLS on matches/reports/decisions; SELECT-only on
--                 the audit log; nothing on bank-side tables (009).
--   anon: nothing.

REVOKE ALL PRIVILEGES ON TABLE
  public.reconciliation_matches,
  public.reconciliation_reports,
  public.reconciliation_decisions,
  public.reconciliation_audit_log,
  public.user_merchant_preferences
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.reconciliation_matches,
  public.reconciliation_reports,
  public.reconciliation_decisions,
  public.reconciliation_audit_log
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.reconciliation_matches,
  public.reconciliation_reports,
  public.reconciliation_decisions
TO authenticated;

GRANT SELECT ON TABLE public.reconciliation_audit_log TO authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.user_merchant_preferences
  TO service_role, authenticated;

-- =========================================================================
-- Z5. Approved-match immutability + supersession-evidence guard (D4)
-- =========================================================================
-- Immutable-by-default with one controlled correction path:
--   - approved rows: no raw UPDATE/DELETE; only the unapprove RPC with a
--     one-shot transaction capability may clear approval, and it may change
--     nothing else;
--   - superseded rows: historical evidence, no UPDATE/DELETE at all;
--   - superseded_* columns: writable only through the controlled
--     supersession RPCs with one-shot transaction capabilities — raw DML
--     can never silently kill or fake a claim transition.

CREATE OR REPLACE FUNCTION public.reconciliation_match_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_correction boolean := false;
  v_supersede  boolean := false;
  v_approval   boolean := false;
  v_manual     boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Invariant L: approval evidence may only be born through the
    -- controlled, audited approval RPC. No raw INSERT may mint an
    -- approved row.
    IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'approval state may only be set through the controlled approval path'
        USING ERRCODE = '42806';
    END IF;

    IF NEW.matched_by = 'manual' THEN
      DELETE FROM reconciliation_private.transition_capabilities
      WHERE txid = txid_current() AND match_id = NEW.id AND action = 'manual'
      RETURNING true INTO v_manual;
      IF NOT COALESCE(v_manual, false) THEN
        RAISE EXCEPTION 'manual reconciliation writes require the controlled atomic path'
          USING ERRCODE = '42806';
      END IF;
    ELSIF NEW.matched_by = 'auto' AND NEW.qb_transaction_id IS NOT NULL THEN
      -- Even a legacy/raw automatic insert participates in invariant M. The
      -- application RPC already holds these locks, so the calls are reentrant.
      PERFORM reconciliation_private.lock_bank_endpoints_v1(ARRAY[NEW.bank_transaction_id]);
      PERFORM reconciliation_private.lock_qb_endpoints_v1(ARRAY[NEW.qb_transaction_id]);
      IF EXISTS (
        SELECT 1 FROM public.reconciliation_matches
        WHERE qb_transaction_id = NEW.qb_transaction_id
          AND matched_by = 'manual'
          AND superseded_at IS NULL
      ) THEN
        RAISE EXCEPTION 'automatic claim blocked by a protected manual relationship'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'approved reconciliation matches are immutable; clear approval through the controlled correction path first'
        USING ERRCODE = '42806';
    END IF;
    -- session_user (not current_user): this is a SECURITY DEFINER trigger, so
    -- current_user is always the function owner. session_user is 'postgres'
    -- only for direct admin/maintenance connections; every PostgREST
    -- connection (any JWT role) arrives as 'authenticator' and stays blocked.
    IF OLD.superseded_at IS NOT NULL
       AND session_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'superseded reconciliation matches are historical evidence and cannot be deleted'
        USING ERRCODE = '42806';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE ----------------------------------------------------------------
  IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
     OR NEW.superseded_by_match_id IS DISTINCT FROM OLD.superseded_by_match_id
     OR NEW.supersede_reason IS DISTINCT FROM OLD.supersede_reason
     OR NEW.supersede_operation_id IS DISTINCT FROM OLD.supersede_operation_id THEN
    DELETE FROM reconciliation_private.transition_capabilities
    WHERE txid = txid_current() AND match_id = OLD.id AND action = 'supersede'
    RETURNING true INTO v_supersede;
  END IF;

  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    IF OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL THEN
      DELETE FROM reconciliation_private.transition_capabilities
      WHERE txid = txid_current() AND match_id = OLD.id AND action = 'approve'
      RETURNING true INTO v_approval;
    ELSIF OLD.approved_at IS NOT NULL AND NEW.approved_at IS NULL THEN
      DELETE FROM reconciliation_private.transition_capabilities
      WHERE txid = txid_current() AND match_id = OLD.id AND action = 'unapprove'
      RETURNING true INTO v_correction;
    END IF;
  END IF;

  IF NEW.matched_by = 'manual'
     AND (NEW.qb_transaction_id IS DISTINCT FROM OLD.qb_transaction_id
          OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
          OR NEW.statement_id IS DISTINCT FROM OLD.statement_id
          OR NEW.confidence IS DISTINCT FROM OLD.confidence
          OR NEW.match_reason IS DISTINCT FROM OLD.match_reason
          OR NEW.flagged_level IS DISTINCT FROM OLD.flagged_level
          OR NEW.matched_by IS DISTINCT FROM OLD.matched_by
          OR NEW.matched_at IS DISTINCT FROM OLD.matched_at
          OR NEW.audit_memo IS DISTINCT FROM OLD.audit_memo) THEN
    DELETE FROM reconciliation_private.transition_capabilities
    WHERE txid = txid_current() AND match_id = OLD.id AND action = 'manual'
    RETURNING true INTO v_manual;
    IF NOT COALESCE(v_manual, false) THEN
      RAISE EXCEPTION 'manual reconciliation writes require the controlled atomic path'
        USING ERRCODE = '42806';
    END IF;
  ELSIF NEW.matched_by = 'auto'
        AND (NEW.qb_transaction_id IS DISTINCT FROM OLD.qb_transaction_id
             OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
             OR NEW.statement_id IS DISTINCT FROM OLD.statement_id
             OR NEW.matched_by IS DISTINCT FROM OLD.matched_by) THEN
    -- Automatic persistence inserts immutable claim proposals. Relationship
    -- repoints must be expressed as a supersession/new claim, never raw UPDATE.
    RAISE EXCEPTION 'approved/automatic claim endpoints are immutable to direct rewrite'
      USING ERRCODE = '42806';
  END IF;

  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'superseded reconciliation matches are historical evidence and cannot be updated'
      USING ERRCODE = '42806';
  END IF;

  IF (NEW.superseded_at          IS DISTINCT FROM OLD.superseded_at
      OR NEW.superseded_by_match_id IS DISTINCT FROM OLD.superseded_by_match_id
      OR NEW.supersede_reason    IS DISTINCT FROM OLD.supersede_reason
      OR NEW.supersede_operation_id IS DISTINCT FROM OLD.supersede_operation_id)
     AND NOT COALESCE(v_supersede, false) THEN
    RAISE EXCEPTION 'supersession fields may only be written through the controlled supersession path'
      USING ERRCODE = '42806';
  END IF;

  -- Invariant L: approval-field transitions (approval, re-approval,
  -- clearing) happen only through the controlled RPCs. The correction
  -- branch below still constrains approved rows to approval-clearing only.
  IF (NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     AND NOT COALESCE(v_approval, false)
     AND NOT COALESCE(v_correction, false) THEN
    RAISE EXCEPTION 'approval transitions require the controlled approval path'
      USING ERRCODE = '42806';
  END IF;

  IF OLD.approved_at IS NOT NULL THEN
    IF NOT COALESCE(v_correction, false) THEN
      RAISE EXCEPTION 'approved reconciliation matches are immutable'
        USING ERRCODE = '42806';
    END IF;
    IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'the correction path may only clear approval'
        USING ERRCODE = '42806';
    END IF;
    IF NEW.qb_transaction_id   IS DISTINCT FROM OLD.qb_transaction_id
       OR NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id
       OR NEW.statement_id     IS DISTINCT FROM OLD.statement_id
       OR NEW.confidence       IS DISTINCT FROM OLD.confidence
       OR NEW.match_reason     IS DISTINCT FROM OLD.match_reason
       OR NEW.flagged_level    IS DISTINCT FROM OLD.flagged_level
       OR NEW.matched_by       IS DISTINCT FROM OLD.matched_by
       OR NEW.matched_at       IS DISTINCT FROM OLD.matched_at
       OR NEW.audit_memo       IS DISTINCT FROM OLD.audit_memo
       OR NEW.client_entity_id IS DISTINCT FROM OLD.client_entity_id
       OR NEW.user_id          IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'approved reconciliation matches are immutable: only approval clearing is permitted'
        USING ERRCODE = '42806';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reconciliation_match_approved_guard
  ON public.reconciliation_matches;
CREATE TRIGGER reconciliation_match_approved_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.reconciliation_match_guard_v1();

-- =========================================================================
-- Z6. Ledger-book alignment guard (D5)
-- =========================================================================
-- A match's book is derivable from both endpoints (statement book on the
-- bank side, ledger_book_id on the QB side). Cross-book matches would
-- reconcile two different ledgers. Only NEW writes are validated; legacy
-- rows with NULL books are never re-validated — fully backward compatible.

CREATE OR REPLACE FUNCTION public.match_book_alignment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stmt_book uuid;
  v_qb_book   uuid;
BEGIN
  IF NEW.qb_transaction_id IS NOT NULL THEN
    SELECT bs.ledger_book_id INTO v_stmt_book
    FROM public.bank_statements AS bs
    WHERE bs.id = NEW.statement_id;

    SELECT qt.ledger_book_id INTO v_qb_book
    FROM public.qb_transactions AS qt
    WHERE qt.id = NEW.qb_transaction_id;

    IF v_stmt_book IS NOT NULL
       AND v_qb_book IS NOT NULL
       AND v_stmt_book IS DISTINCT FROM v_qb_book THEN
      RAISE EXCEPTION 'reconciliation match endpoints belong to different ledger books'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER match_book_alignment
  BEFORE INSERT OR UPDATE OF qb_transaction_id, statement_id
  ON public.reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.match_book_alignment_v1();

-- =========================================================================
-- Z7. Controlled RPCs (D1 + D2 + D4)
-- =========================================================================
-- Mutation RPCs are SECURITY DEFINER with explicit role guards and narrowly
-- granted EXECUTE privileges. Private lock/capability helpers are inaccessible
-- to API roles.

-- 7a. Atomic auto-match persistence with exclusive-claim resolution.
CREATE OR REPLACE FUNCTION public.persist_auto_matches_v1(
  p_user_id          uuid,
  p_statement_id     uuid,
  p_client_entity_id uuid,
  p_matches          jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item            jsonb;
  v_statement       public.bank_statements%ROWTYPE;
  v_bank             uuid;
  v_bank_ids         uuid[];
  v_qb              uuid;
  v_qb_ids           uuid[];
  v_conf            numeric;
  v_score           integer;
  v_new_id          uuid;
  v_item_id         uuid;
  v_proposed_id     uuid;
  v_holder          public.reconciliation_matches%ROWTYPE;
  v_existing_bank   uuid;
  v_manual_exists   boolean;
  v_inserted        uuid[] := '{}';
  v_superseded      uuid[] := '{}';
  v_conflicted      uuid[] := '{}';
  v_blocked         uuid[] := '{}';
  v_operation_id    uuid := gen_random_uuid();
  v_errmsg          text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_matches) <> 'array' THEN
    RAISE EXCEPTION 'p_matches must be a JSON array';
  END IF;

  -- Validate the statement scope before taking any endpoint lock.
  SELECT * INTO v_statement
  FROM public.bank_statements AS bs
  WHERE bs.id = p_statement_id
    AND bs.user_id = p_user_id
    AND bs.client_entity_id = p_client_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'statement does not belong to the user/client scope'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_matches) AS item(value)
    GROUP BY NULLIF(value->>'bank_transaction_id', '')::uuid
    HAVING NULLIF(value->>'bank_transaction_id', '')::uuid IS NOT NULL
       AND count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matches contains a duplicate bank transaction endpoint'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_matches) AS item(value)
    GROUP BY NULLIF(value->>'qb_transaction_id', '')::uuid
    HAVING NULLIF(value->>'qb_transaction_id', '')::uuid IS NOT NULL
       AND count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matches contains a duplicate QB transaction endpoint'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT bank_id ORDER BY bank_id), '{}'::uuid[])
    INTO v_bank_ids
  FROM (
    SELECT NULLIF(value->>'bank_transaction_id', '')::uuid AS bank_id
    FROM jsonb_array_elements(p_matches)
  ) AS banks
  WHERE bank_id IS NOT NULL;

  SELECT COALESCE(array_agg(DISTINCT qb_id ORDER BY qb_id), '{}'::uuid[])
    INTO v_qb_ids
  FROM (
    SELECT NULLIF(value->>'qb_transaction_id', '')::uuid AS qb_id
    FROM jsonb_array_elements(p_matches)
  ) AS qbs
  WHERE qb_id IS NOT NULL;

  -- Invariant M lock order: every bank endpoint, then every QB endpoint,
  -- UUID-sorted inside the private helpers. No relationship read occurs
  -- before both endpoint sets are locked.
  PERFORM reconciliation_private.lock_bank_endpoints_v1(v_bank_ids);
  PERFORM reconciliation_private.lock_qb_endpoints_v1(v_qb_ids);

  -- Revalidate every endpoint under the locks. A later write is never based
  -- on the earlier unlocked existence check.
  FOREACH v_bank IN ARRAY v_bank_ids
  LOOP
    PERFORM 1
    FROM public.bank_transactions AS bt
    WHERE bt.id = v_bank
      AND bt.statement_id = p_statement_id
      AND bt.user_id = p_user_id
      AND bt.client_entity_id = p_client_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank transaction does not belong to the statement/user/client scope'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOREACH v_qb IN ARRAY v_qb_ids
  LOOP
    PERFORM 1
    FROM public.qb_transactions AS qt
    WHERE qt.id = v_qb
      AND qt.user_id = p_user_id
      AND qt.client_entity_id = p_client_entity_id
      AND qt.ledger_book_id = v_statement.ledger_book_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QB transaction does not belong to the user/client/ledger book scope'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(p_matches)
    ORDER BY NULLIF(value->>'qb_transaction_id', '')::uuid,
             NULLIF(value->>'bank_transaction_id', '')::uuid
  LOOP
    v_item_id := NULLIF(v_item->>'id', '')::uuid;
    v_proposed_id := COALESCE(v_item_id, gen_random_uuid());
    v_qb      := NULLIF(v_item->>'qb_transaction_id', '')::uuid;
    v_conf    := NULLIF(v_item->>'confidence', '')::numeric;
    v_score   := COALESCE(round(v_conf * 100), 0);

    IF v_qb IS NULL THEN
      v_blocked := v_blocked || v_proposed_id;
      CONTINUE;
    END IF;

    -- The bank lock makes this read stable across controlled writers. Never
    -- supersede a holder if this bank endpoint is already represented.
    SELECT id INTO v_existing_bank
    FROM public.reconciliation_matches
    WHERE bank_transaction_id = NULLIF(v_item->>'bank_transaction_id', '')::uuid
      AND statement_id = p_statement_id;
    IF v_existing_bank IS NOT NULL THEN
      v_blocked := v_blocked || v_proposed_id;
      CONTINUE;
    END IF;

    -- Relationship reads occur only after the shared QB lock.
    SELECT * INTO v_holder
    FROM public.reconciliation_matches
    WHERE qb_transaction_id = v_qb
      AND matched_by = 'auto'
      AND superseded_at IS NULL
    FOR UPDATE;

    SELECT EXISTS (
      SELECT 1
      FROM public.reconciliation_matches
      WHERE qb_transaction_id = v_qb
        AND matched_by = 'manual'
        AND superseded_at IS NULL
    ) INTO v_manual_exists;

    IF v_manual_exists THEN
      v_blocked := v_blocked || v_proposed_id;
      CONTINUE;
    END IF;

    IF v_holder.id IS NOT NULL THEN
      -- Deterministic supersession rule (mirrored in lib/reconciliation-matching.ts):
      --   old is unapproved auto; new score >= 95; new - old >= 20.
      IF v_holder.approved_at IS NOT NULL THEN
        v_blocked := v_blocked || v_proposed_id;
        CONTINUE;
      END IF;
      IF v_score < 95
         OR (v_score - COALESCE(round(COALESCE(v_holder.confidence, 0) * 100), 0)) < 20 THEN
        v_blocked := v_blocked || v_proposed_id;
        CONTINUE;
      END IF;

      INSERT INTO reconciliation_private.transition_capabilities
        (txid, match_id, action, actor_id, operation_id)
      VALUES (txid_current(), v_holder.id, 'supersede', NULL, v_operation_id);
      UPDATE public.reconciliation_matches
      SET superseded_at          = now(),
          superseded_by_match_id = v_proposed_id,
          supersede_reason       = 'stronger_evidence',
          supersede_operation_id = v_operation_id
      WHERE id = v_holder.id;

      INSERT INTO public.reconciliation_audit_log
        (id, reconciliation_match_id, action, action_by, action_at,
         old_confidence, new_confidence, user_id, client_entity_id,
         operation_id, previous_state, resulting_state, evidence)
      VALUES
        (gen_random_uuid(), v_holder.id, 'match_superseded', 'system',
         now(), v_holder.confidence, v_conf, p_user_id, p_client_entity_id,
         v_operation_id,
         jsonb_build_object('superseded_at', v_holder.superseded_at,
                            'superseded_by_match_id', v_holder.superseded_by_match_id),
         jsonb_build_object('superseded_at', now(),
                            'superseded_by_match_id', v_proposed_id,
                            'supersede_reason', 'stronger_evidence'),
         jsonb_build_object('qb_transaction_id', v_qb,
                            'replacement_match_id', v_proposed_id));

      v_superseded := v_superseded || v_holder.id;
    END IF;

    v_new_id := NULL;
    BEGIN
      INSERT INTO public.reconciliation_matches
        (id, user_id, statement_id, bank_transaction_id, qb_transaction_id,
         confidence, match_reason, flagged_level, matched_by, matched_at,
         audit_memo, client_entity_id)
      VALUES
        (v_proposed_id, p_user_id, p_statement_id,
         NULLIF(v_item->>'bank_transaction_id', '')::uuid, v_qb,
         v_conf, NULLIF(v_item->>'match_reason', ''),
         COALESCE(NULLIF(v_item->>'flagged_level', ''), 'red'), 'auto',
         COALESCE(NULLIF(v_item->>'matched_at', ''), now()::text)::timestamptz,
         v_item->'audit_memo', p_client_entity_id)
      ON CONFLICT (bank_transaction_id, statement_id) DO NOTHING
      RETURNING id INTO v_new_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_errmsg = MESSAGE_TEXT;
      IF v_errmsg LIKE '%uk_matches_auto_live_qb%' THEN
        v_conflicted := v_conflicted || v_proposed_id;
        CONTINUE;
      END IF;
      RAISE;
    END;

    IF v_new_id IS NOT NULL THEN
      v_inserted := v_inserted || v_new_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted',     to_jsonb(v_inserted),
    'superseded',   to_jsonb(v_superseded),
    'conflicted',   to_jsonb(v_conflicted),
    'blocked',      to_jsonb(v_blocked),
    'operation_id', v_operation_id
  );
END;
$$;

-- 7b. Atomic manual transition (invariant M). Validation, endpoint locks,
--     eligible automatic supersession, manual persistence, and all audit
--     evidence commit once or roll back together.
CREATE OR REPLACE FUNCTION public.create_manual_match_v1(
  p_user_id             uuid,
  p_statement_id        uuid,
  p_bank_transaction_id uuid,
  p_qb_transaction_id   uuid,
  p_confidence           numeric,
  p_match_reason         text,
  p_flagged_level        text,
  p_matched_at           timestamptz,
  p_audit_memo           jsonb,
  p_operation_id         uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reconciliation_private, pg_temp
AS $$
DECLARE
  v_statement    public.bank_statements%ROWTYPE;
  v_existing     public.reconciliation_matches%ROWTYPE;
  v_claim        public.reconciliation_matches%ROWTYPE;
  v_saved        public.reconciliation_matches%ROWTYPE;
  v_manual_id    uuid;
  v_old_qb       uuid;
  v_qb_ids       uuid[];
  v_now          timestamptz := COALESCE(p_matched_at, now());
  v_action       text;
  v_noop         boolean := false;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires service_role'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_statement_id IS NULL
     OR p_bank_transaction_id IS NULL OR p_qb_transaction_id IS NULL
     OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'manual reconciliation requires complete actor and endpoint ids'
      USING ERRCODE = '23502';
  END IF;

  -- Initial ownership/alignment validation gives callers precise failures;
  -- every fact used for the write is rechecked under endpoint locks below.
  SELECT * INTO v_statement
  FROM public.bank_statements AS bs
  WHERE bs.id = p_statement_id
    AND bs.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'statement does not belong to the user'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.bank_transactions AS bt
  WHERE bt.id = p_bank_transaction_id
    AND bt.statement_id = p_statement_id
    AND bt.user_id = p_user_id
    AND bt.client_entity_id = v_statement.client_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction does not belong to the statement/user/client scope'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.qb_transactions AS qt
  WHERE qt.id = p_qb_transaction_id
    AND qt.user_id = p_user_id
    AND qt.client_entity_id = v_statement.client_entity_id
    AND qt.ledger_book_id = v_statement.ledger_book_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QB transaction does not belong to the user/client/ledger book scope'
      USING ERRCODE = '23514';
  END IF;

  -- Invariant M lock order. Locking the bank first stabilizes any prior
  -- relationship long enough to include its old QB endpoint in the sorted
  -- QB lock set.
  PERFORM reconciliation_private.lock_bank_endpoints_v1(ARRAY[p_bank_transaction_id]);

  SELECT * INTO v_existing
  FROM public.reconciliation_matches
  WHERE bank_transaction_id = p_bank_transaction_id
    AND statement_id = p_statement_id;
  v_old_qb := v_existing.qb_transaction_id;
  SELECT COALESCE(array_agg(DISTINCT qb_id ORDER BY qb_id), '{}'::uuid[])
    INTO v_qb_ids
  FROM unnest(ARRAY[p_qb_transaction_id, v_old_qb]) AS endpoint(qb_id)
  WHERE qb_id IS NOT NULL;
  PERFORM reconciliation_private.lock_qb_endpoints_v1(v_qb_ids);

  -- Revalidate all write-driving facts under the endpoint locks.
  PERFORM 1
  FROM public.bank_transactions AS bt
  JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
  JOIN public.qb_transactions AS qt ON qt.id = p_qb_transaction_id
  WHERE bt.id = p_bank_transaction_id
    AND bt.statement_id = p_statement_id
    AND bt.user_id = p_user_id
    AND bs.user_id = p_user_id
    AND bt.client_entity_id = bs.client_entity_id
    AND qt.user_id = p_user_id
    AND qt.client_entity_id = bs.client_entity_id
    AND bs.ledger_book_id IS NOT NULL
    AND qt.ledger_book_id = bs.ledger_book_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual match endpoints are not aligned to one tenant/client/ledger book'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing
  FROM public.reconciliation_matches
  WHERE bank_transaction_id = p_bank_transaction_id
    AND statement_id = p_statement_id
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation relationship is already approved; unapprove it before overriding'
      USING ERRCODE = '23514';
  END IF;
  IF v_existing.id IS NOT NULL AND v_existing.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'superseded reconciliation evidence cannot be rewritten'
      USING ERRCODE = '23514';
  END IF;

  v_manual_id := COALESCE(v_existing.id, gen_random_uuid());
  v_noop := v_existing.id IS NOT NULL
            AND v_existing.matched_by = 'manual'
            AND v_existing.qb_transaction_id = p_qb_transaction_id;

  -- A protected automatic claim cannot be displaced by a manual operation.
  -- An eligible unapproved claim is resolved inside this same transaction.
  SELECT * INTO v_claim
  FROM public.reconciliation_matches
  WHERE qb_transaction_id = p_qb_transaction_id
    AND matched_by = 'auto'
    AND superseded_at IS NULL
  FOR UPDATE;

  IF v_claim.id IS NOT NULL AND v_claim.id IS DISTINCT FROM v_existing.id THEN
    IF v_claim.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'protected automatic relationship is already approved'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_claim.id, 'supersede', p_user_id, p_operation_id);
    UPDATE public.reconciliation_matches
    SET superseded_at          = v_now,
        superseded_by_match_id = v_manual_id,
        supersede_reason       = 'manual_override',
        supersede_operation_id = p_operation_id
    WHERE id = v_claim.id;

    INSERT INTO public.reconciliation_audit_log
      (id, reconciliation_match_id, action, action_by, action_at,
       old_confidence, new_confidence, user_id, client_entity_id,
       operation_id, previous_state, resulting_state, evidence)
    VALUES
      (gen_random_uuid(), v_claim.id, 'match_superseded', p_user_id::text, v_now,
       v_claim.confidence, p_confidence, p_user_id, v_statement.client_entity_id,
       p_operation_id,
       jsonb_build_object('superseded_at', v_claim.superseded_at,
                          'superseded_by_match_id', v_claim.superseded_by_match_id),
       jsonb_build_object('superseded_at', v_now,
                          'superseded_by_match_id', v_manual_id,
                          'supersede_reason', 'manual_override'),
       jsonb_build_object('qb_transaction_id', p_qb_transaction_id,
                          'manual_match_id', v_manual_id));
  END IF;

  IF v_noop THEN
    v_saved := v_existing;
  ELSIF v_existing.id IS NULL THEN
    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_manual_id, 'manual', p_user_id, p_operation_id);
    INSERT INTO public.reconciliation_matches
      (id, user_id, statement_id, bank_transaction_id, qb_transaction_id,
       confidence, match_reason, flagged_level, matched_by, matched_at,
       audit_memo, client_entity_id)
    VALUES
      (v_manual_id, p_user_id, p_statement_id, p_bank_transaction_id,
       p_qb_transaction_id, p_confidence, p_match_reason,
       COALESCE(NULLIF(p_flagged_level, ''), 'green'), 'manual', v_now,
       p_audit_memo, v_statement.client_entity_id)
    RETURNING * INTO v_saved;
    v_action := 'match_manual_created';
  ELSE
    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_existing.id, 'manual', p_user_id, p_operation_id);
    UPDATE public.reconciliation_matches
    SET qb_transaction_id = p_qb_transaction_id,
        confidence        = p_confidence,
        match_reason      = p_match_reason,
        flagged_level     = COALESCE(NULLIF(p_flagged_level, ''), 'green'),
        matched_by        = 'manual',
        matched_at        = v_now,
        audit_memo        = p_audit_memo
    WHERE id = v_existing.id
    RETURNING * INTO v_saved;
    v_action := 'match_manual_override';
  END IF;

  IF v_action IS NOT NULL THEN
    INSERT INTO public.reconciliation_audit_log
      (id, reconciliation_match_id, action, action_by, action_at,
       old_confidence, new_confidence, user_id, client_entity_id,
       operation_id, previous_state, resulting_state, evidence)
    VALUES
      (gen_random_uuid(), v_saved.id, v_action, p_user_id::text, v_now,
       v_existing.confidence, v_saved.confidence, p_user_id,
       v_statement.client_entity_id, p_operation_id,
       CASE WHEN v_existing.id IS NULL THEN NULL ELSE to_jsonb(v_existing) END,
       to_jsonb(v_saved),
       jsonb_build_object('bank_transaction_id', v_saved.bank_transaction_id,
                          'qb_transaction_id', v_saved.qb_transaction_id,
                          'audit_memo', v_saved.audit_memo));
  END IF;

  RETURN to_jsonb(v_saved);
END;
$$;

-- 7c. Manual-decision sweep retained for compatibility. It now participates
--     in invariant M and validates the owner/client scope under the QB lock.
CREATE OR REPLACE FUNCTION public.supersede_auto_claims_v1(
  p_user_id          uuid,
  p_client_entity_id uuid,
  p_qb_transaction_id uuid,
  p_reason           text,
  p_operation_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reconciliation_private, pg_temp
AS $$
DECLARE
  v_claim      public.reconciliation_matches%ROWTYPE;
  v_superseded uuid[] := '{}';
  v_bank_ids   uuid[];
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_qb_transaction_id IS NULL THEN
    RETURN jsonb_build_object('superseded', '[]'::jsonb);
  END IF;

  SELECT COALESCE(array_agg(DISTINCT bank_transaction_id ORDER BY bank_transaction_id), '{}'::uuid[])
    INTO v_bank_ids
  FROM public.reconciliation_matches
  WHERE qb_transaction_id = p_qb_transaction_id
    AND matched_by = 'auto'
    AND superseded_at IS NULL;
  PERFORM reconciliation_private.lock_bank_endpoints_v1(v_bank_ids);
  PERFORM reconciliation_private.lock_qb_endpoints_v1(ARRAY[p_qb_transaction_id]);

  PERFORM 1
  FROM public.qb_transactions
  WHERE id = p_qb_transaction_id
    AND user_id = p_user_id
    AND client_entity_id = p_client_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QB transaction does not belong to the user/client scope'
      USING ERRCODE = '23514';
  END IF;

  FOR v_claim IN
    SELECT *
    FROM public.reconciliation_matches
    WHERE qb_transaction_id = p_qb_transaction_id
      AND matched_by = 'auto'
      AND superseded_at IS NULL
      AND approved_at IS NULL
      AND client_entity_id = p_client_entity_id
      AND user_id = p_user_id
    ORDER BY id
    FOR UPDATE
  LOOP
    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_claim.id, 'supersede', NULL, p_operation_id);

    UPDATE public.reconciliation_matches
    SET superseded_at          = now(),
        superseded_by_match_id = NULL,
        supersede_reason       = COALESCE(NULLIF(btrim(p_reason), ''), 'manual_override'),
        supersede_operation_id = p_operation_id
    WHERE id = v_claim.id;

    INSERT INTO public.reconciliation_audit_log
      (id, reconciliation_match_id, action, action_by, action_at,
       old_confidence, new_confidence, user_id, client_entity_id,
       operation_id, previous_state, resulting_state, evidence)
    VALUES
      (gen_random_uuid(), v_claim.id, 'match_superseded', 'system',
       now(), v_claim.confidence, NULL, p_user_id, p_client_entity_id,
       p_operation_id,
       jsonb_build_object('superseded_at', v_claim.superseded_at),
       jsonb_build_object('superseded_at', now(),
                          'supersede_reason', COALESCE(NULLIF(btrim(p_reason), ''), 'manual_override')),
       jsonb_build_object('qb_transaction_id', p_qb_transaction_id));

    v_superseded := v_superseded || v_claim.id;
  END LOOP;

  RETURN jsonb_build_object('superseded', to_jsonb(v_superseded));
END;
$$;

-- 7d. Controlled unapprove (D4 correction path): the ONLY way to clear
--     approval. Audited, idempotent, ownership-checked.
CREATE OR REPLACE FUNCTION public.unapprove_reconciliation_matches_v1(
  p_user_id   uuid,
  p_match_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id         uuid;
  v_row        public.reconciliation_matches%ROWTYPE;
  v_unapproved uuid[] := '{}';
  v_skipped    uuid[] := '{}';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'RPC requires service_role'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_match_ids, '{}'::uuid[])
  LOOP
    SELECT * INTO v_row
    FROM public.reconciliation_matches
    WHERE id = v_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_skipped := v_skipped || v_id;
      CONTINUE;
    END IF;

    IF v_row.approved_at IS NULL THEN
      v_skipped := v_skipped || v_id;
      CONTINUE;
    END IF;

    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_id, 'unapprove', p_user_id, gen_random_uuid());

    UPDATE public.reconciliation_matches
    SET approved_by = NULL,
        approved_at = NULL
    WHERE id = v_id;

    INSERT INTO public.reconciliation_audit_log
      (id, reconciliation_match_id, action, action_by, action_at,
       old_confidence, new_confidence, user_id, client_entity_id)
    VALUES
      (gen_random_uuid(), v_id, 'match_unapproved', p_user_id::text,
       now(), v_row.confidence, v_row.confidence,
       p_user_id, v_row.client_entity_id);

    v_unapproved := v_unapproved || v_id;
  END LOOP;

  RETURN jsonb_build_object(
    'unapproved', to_jsonb(v_unapproved),
    'skipped',    to_jsonb(v_skipped)
  );
END;
$$;

-- 7e. Controlled approval (invariant L): the ONLY way a match enters the
--     approved state. Ownership- and eligibility-checked; the transition
--     and its audit evidence commit in one transaction — an audit failure
--     rolls the approval back.
CREATE OR REPLACE FUNCTION reconciliation_private.approve_matches_core_v1(
  p_user_id      uuid,
  p_statement_id uuid,
  p_match_ids    uuid[],
  p_approved_by  text,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reconciliation_private, pg_temp
AS $$
DECLARE
  v_id        uuid;
  v_bank_ids  uuid[];
  v_qb_ids    uuid[];
  v_row       public.reconciliation_matches%ROWTYPE;
  v_now       timestamptz := now();
  v_approved  uuid[] := '{}';
  v_skipped   uuid[] := '{}';
BEGIN
  -- The statement must belong to the user — forged scopes fail closed
  -- before any write.
  PERFORM 1
  FROM public.bank_statements AS bs
  WHERE bs.id = p_statement_id
    AND bs.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'statement does not belong to the user'
      USING ERRCODE = '23514';
  END IF;

  -- Match ids are an untrusted request surface. Read only enough endpoint
  -- identity to acquire the shared deterministic locks, then re-read and
  -- validate every relationship under those locks before approval.
  SELECT COALESCE(array_agg(DISTINCT bank_transaction_id ORDER BY bank_transaction_id), '{}'::uuid[])
    INTO v_bank_ids
  FROM public.reconciliation_matches
  WHERE id = ANY(COALESCE(p_match_ids, '{}'::uuid[]))
    AND statement_id = p_statement_id
    AND user_id = p_user_id;
  PERFORM reconciliation_private.lock_bank_endpoints_v1(v_bank_ids);

  SELECT COALESCE(array_agg(DISTINCT qb_transaction_id ORDER BY qb_transaction_id), '{}'::uuid[])
    INTO v_qb_ids
  FROM public.reconciliation_matches
  WHERE id = ANY(COALESCE(p_match_ids, '{}'::uuid[]))
    AND statement_id = p_statement_id
    AND user_id = p_user_id
    AND qb_transaction_id IS NOT NULL;
  PERFORM reconciliation_private.lock_qb_endpoints_v1(v_qb_ids);

  FOR v_id IN
    SELECT DISTINCT match_id
    FROM unnest(COALESCE(p_match_ids, '{}'::uuid[])) AS requested(match_id)
    ORDER BY match_id
  LOOP
    SELECT * INTO v_row
    FROM public.reconciliation_matches
    WHERE id = v_id
      AND statement_id = p_statement_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_skipped := v_skipped || v_id;
      CONTINUE;
    END IF;

    IF (v_row.approved_at IS NULL) IS DISTINCT FROM (v_row.approved_by IS NULL) THEN
      RAISE EXCEPTION 'match has malformed approval state'
        USING ERRCODE = '23514';
    END IF;

    -- Eligibility: superseded rows are historical evidence and can never
    -- be approved; already-approved rows are skipped idempotently so a
    -- retry neither re-stamps nor duplicates audit evidence.
    IF v_row.superseded_at IS NOT NULL OR v_row.approved_at IS NOT NULL THEN
      v_skipped := v_skipped || v_id;
      CONTINUE;
    END IF;

    -- Recheck endpoint integrity at the approval boundary, even though write
    -- triggers also enforce it when the relationship is first created.
    PERFORM 1
    FROM public.bank_statements bs
    JOIN public.bank_transactions bt
      ON bt.id = v_row.bank_transaction_id
     AND bt.statement_id = bs.id
     AND bt.user_id = p_user_id
     AND bt.client_entity_id = v_row.client_entity_id
    LEFT JOIN public.qb_transactions qt
      ON qt.id = v_row.qb_transaction_id
    WHERE bs.id = p_statement_id
      AND bs.user_id = p_user_id
      AND bs.client_entity_id = v_row.client_entity_id
      AND (qt.id IS NULL OR (
        qt.user_id = p_user_id
        AND qt.client_entity_id = v_row.client_entity_id
        AND bs.ledger_book_id IS NOT NULL
        AND qt.ledger_book_id = bs.ledger_book_id
      ));
    IF NOT FOUND OR v_row.qb_transaction_id IS NULL
       OR v_row.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'match is malformed or ineligible for approval'
        USING ERRCODE = '23514';
    END IF;

    -- Approval turns an automatic row into a protected claim. Historical
    -- inconsistent state is not repaired here: fail closed if a live manual
    -- relationship already occupies the same QB endpoint. Because the QB row
    -- is locked above, a concurrent manual transition cannot appear between
    -- this check and commit.
    IF v_row.matched_by = 'auto' AND EXISTS (
      SELECT 1
      FROM public.reconciliation_matches AS manual_match
      WHERE manual_match.qb_transaction_id = v_row.qb_transaction_id
        AND manual_match.matched_by = 'manual'
        AND manual_match.superseded_at IS NULL
        AND manual_match.id <> v_row.id
    ) THEN
      RAISE EXCEPTION 'automatic approval blocked by a protected manual relationship on the QB endpoint'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO reconciliation_private.transition_capabilities
      (txid, match_id, action, actor_id, operation_id)
    VALUES (txid_current(), v_id, 'approve', p_user_id, p_operation_id);

    UPDATE public.reconciliation_matches
    SET approved_by = p_approved_by,
        approved_at = v_now
    WHERE id = v_id;

    INSERT INTO public.reconciliation_audit_log
      (id, reconciliation_match_id, action, action_by, action_at,
       old_confidence, new_confidence, user_id, client_entity_id,
       operation_id, previous_state, resulting_state, evidence)
    VALUES
      (gen_random_uuid(), v_id, 'match_approved', p_approved_by, v_now,
       v_row.confidence, v_row.confidence, p_user_id, v_row.client_entity_id,
       p_operation_id,
       jsonb_build_object('approved_at', v_row.approved_at, 'approved_by', v_row.approved_by),
       jsonb_build_object('approved_at', v_now, 'approved_by', p_approved_by),
       jsonb_build_object('bank_transaction_id', v_row.bank_transaction_id,
                          'qb_transaction_id', v_row.qb_transaction_id,
                          'confidence', v_row.confidence,
                          'match_reason', v_row.match_reason,
                          'audit_memo', v_row.audit_memo));

    v_approved := v_approved || v_id;
  END LOOP;

  RETURN jsonb_build_object(
    'approved', to_jsonb(v_approved),
    'skipped',  to_jsonb(v_skipped)
  );
END;
$$;

REVOKE ALL ON FUNCTION reconciliation_private.approve_matches_core_v1(uuid, uuid, uuid[], text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Authenticated accountant path. Actor identity is exclusively auth.uid();
-- callers cannot supply either the owner id or audit actor label.
CREATE OR REPLACE FUNCTION public.approve_reconciliation_matches_v1(
  p_statement_id uuid,
  p_match_ids uuid[],
  p_operation_id uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reconciliation_private, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR COALESCE(auth.role(), '') <> 'authenticated' THEN
    RAISE EXCEPTION 'authenticated actor required' USING ERRCODE = '42501';
  END IF;
  RETURN reconciliation_private.approve_matches_core_v1(
    v_actor, p_statement_id, p_match_ids, v_actor::text, p_operation_id
  );
END;
$$;

-- Server path is deliberately separate and cannot be invoked by an
-- authenticated JWT. The server has already authenticated the user and passes
-- that verified id; the audit records both that subject and the operation id.
CREATE OR REPLACE FUNCTION public.approve_reconciliation_matches_service_v1(
  p_user_id uuid,
  p_statement_id uuid,
  p_match_ids uuid[],
  p_approved_by text,
  p_operation_id uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, reconciliation_private, pg_temp
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  RETURN reconciliation_private.approve_matches_core_v1(
    p_user_id, p_statement_id, p_match_ids,
    COALESCE(NULLIF(btrim(p_approved_by), ''), p_user_id::text), p_operation_id
  );
END;
$$;

-- ACLs: service_role only (same pattern as the 008/012 ingestion RPCs).
REVOKE ALL ON FUNCTION public.persist_auto_matches_v1(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_manual_match_v1(uuid, uuid, uuid, uuid, numeric, text, text, timestamptz, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supersede_auto_claims_v1(uuid, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unapprove_reconciliation_matches_v1(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_reconciliation_matches_v1(uuid, uuid[], uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.approve_reconciliation_matches_service_v1(uuid, uuid, uuid[], text, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_auto_matches_v1(uuid, uuid, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_manual_match_v1(uuid, uuid, uuid, uuid, numeric, text, text, timestamptz, jsonb, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.supersede_auto_claims_v1(uuid, uuid, uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unapprove_reconciliation_matches_v1(uuid, uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_reconciliation_matches_v1(uuid, uuid[], uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_reconciliation_matches_service_v1(uuid, uuid, uuid[], text, uuid)
  TO service_role;

-- =========================================================================
-- Z8. End-of-migration invariant assertions
-- =========================================================================

-- C1: exclusive-claim index exists and is unique
DO $c1$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'uk_matches_auto_live_qb' AND schemaname = 'public'
  ) THEN
    RAISE EXCEPTION 'C1 FAIL: uk_matches_auto_live_qb missing';
  END IF;
END;
$c1$;

-- C2: guard triggers attached
DO $c2$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'reconciliation_match_approved_guard'
      AND event_object_table = 'reconciliation_matches'
  ) THEN
    RAISE EXCEPTION 'C2 FAIL: reconciliation_match_approved_guard missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'match_book_alignment'
      AND event_object_table = 'reconciliation_matches'
  ) THEN
    RAISE EXCEPTION 'C2 FAIL: match_book_alignment missing';
  END IF;
END;
$c2$;

-- C2b: repair-evidence immutability trigger attached (Z1b)
DO $c2b$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'audit_log_repair_evidence_immutable'
      AND event_object_table = 'reconciliation_audit_log'
  ) THEN
    RAISE EXCEPTION 'C2b FAIL: audit_log_repair_evidence_immutable missing';
  END IF;
END;
$c2b$;

-- C3: service_role holds the full store surface
DO $c3$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'reconciliation_matches',
    'reconciliation_reports',
    'reconciliation_decisions',
    'reconciliation_audit_log'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_table
        AND grantee = 'service_role'
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      HAVING count(DISTINCT privilege_type) < 4
    ) THEN
      RAISE EXCEPTION 'C3 FAIL: service_role lacks full DML on %', v_table;
    END IF;
  END LOOP;
END;
$c3$;

-- C4: authenticated still has no DML on the audit log (012 Z12 preserved)
DO $c4$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'reconciliation_audit_log'
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'C4 FAIL: authenticated regained audit-log DML';
  END IF;
END;
$c4$;

-- C5: authenticated has no EXECUTE on the new RPCs
DO $c5$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'persist_auto_matches_v1(uuid, uuid, uuid, jsonb)',
    'create_manual_match_v1(uuid, uuid, uuid, uuid, numeric, text, text, timestamp with time zone, jsonb, uuid)',
    'supersede_auto_claims_v1(uuid, uuid, uuid, text, uuid)',
    'unapprove_reconciliation_matches_v1(uuid, uuid[])',
    'approve_reconciliation_matches_service_v1(uuid, uuid, uuid[], text, uuid)'
  ]
  LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'C5 FAIL: authenticated can EXECUTE %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'C5 FAIL: anon can EXECUTE %', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated',
      'approve_reconciliation_matches_v1(uuid, uuid[], uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAIL: authenticated approval RPC is unavailable';
  END IF;
  IF has_function_privilege('service_role',
      'approve_reconciliation_matches_v1(uuid, uuid[], uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAIL: service_role can invoke authenticated approval RPC';
  END IF;
END;
$c5$;

-- =========================================================================
-- PostgREST schema reload
-- =========================================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
