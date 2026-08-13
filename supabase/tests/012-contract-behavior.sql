-- ============================================================================
-- Migration 012 Behavioral Contract Tests
-- Write guards, immutability, same-client, FK SET NULL, audit ACL, SQL-level
-- Run: npx supabase db query -f supabase/tests/012-contract-behavior.sql
-- ============================================================================


CREATE OR REPLACE FUNCTION pg_temp.test_report(name text, passed boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'TEST: % | % | %', name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END, detail;
END;
$$;

-- ============================================================================
-- Setup: create two test users with complete tenant registries
-- ============================================================================

-- User A
INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at, email_confirmed_at)
VALUES ('a0000000-0000-0000-0000-000000000001', 'user-a@test.local', 'x',
        '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at, email_confirmed_at)
VALUES ('a0000000-0000-0000-0000-000000000002', 'user-b@test.local', 'x',
        '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

-- Ineligible user (not confirmed)
INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
VALUES ('a0000000-0000-0000-0000-000000000003', 'ineligible@test.local', 'x',
        '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now())
ON CONFLICT (id) DO NOTHING;

-- Bootstrap both eligible users via Migration 011 RPC (idempotent)
SELECT public.ensure_default_tenant_for_user_v1('a0000000-0000-0000-0000-000000000001');
SELECT public.ensure_default_tenant_for_user_v1('a0000000-0000-0000-0000-000000000002');

-- Fetch resolved canonical IDs
DO $$
DECLARE
  reg_a record;
  reg_b record;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities
  WHERE user_id = 'a0000000-0000-0000-0000-000000000001';
  SELECT * INTO reg_b FROM public.default_tenant_identities
  WHERE user_id = 'a0000000-0000-0000-0000-000000000002';

  PERFORM pg_temp.test_report('Setup: User A registry exists', reg_a.client_entity_id IS NOT NULL);
  PERFORM pg_temp.test_report('Setup: User B registry exists', reg_b.client_entity_id IS NOT NULL);
  PERFORM pg_temp.test_report('Setup: User A and B have different clients', reg_a.client_entity_id <> reg_b.client_entity_id);
END;
$$;

-- ============================================================================
-- R1-R8: Write-guard rejection — root tables
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  reg_a record;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;

  -- R1: bank_statements INSERT with ledger_book_id NULL → REJECTED
  BEGIN
    INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id)
    VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'ledger_book_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R1: bank_statements INSERT without ledger_book_id rejected', ok, err_msg);

  -- R2: bank_statements INSERT with client_entity_id NULL → REJECTED
  BEGIN
    INSERT INTO public.bank_statements (id, user_id, file_format, ledger_book_id)
    VALUES (gen_random_uuid(), aid, 'csv', reg_a.internal_ledger_book_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R2: bank_statements INSERT without client_entity_id rejected', ok, err_msg);

  -- R3: bank_statements INSERT with both stamps NULL → REJECTED
  BEGIN
    INSERT INTO public.bank_statements (id, user_id, file_format)
    VALUES (gen_random_uuid(), aid, 'csv');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R3: bank_statements INSERT with both NULL rejected', ok, err_msg);

  -- R4: bank_statements INSERT with both stamps valid → SUCCESS
  BEGIN
    INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
    VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id);
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R4: bank_statements INSERT with both stamps valid succeeds', ok, err_msg);

  -- R5-R8: Same for qb_transactions
  BEGIN
    INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id)
    VALUES (gen_random_uuid(), aid, now()::date, 100, reg_a.client_entity_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'ledger_book_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R5: qb_transactions INSERT without ledger_book_id rejected', ok, err_msg);

  BEGIN
    INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, ledger_book_id)
    VALUES (gen_random_uuid(), aid, now()::date, 100, reg_a.internal_ledger_book_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R6: qb_transactions INSERT without client_entity_id rejected', ok, err_msg);

  BEGIN
    INSERT INTO public.qb_transactions (id, user_id, posted_date, amount)
    VALUES (gen_random_uuid(), aid, now()::date, 100);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R7: qb_transactions INSERT with both NULL rejected', ok, err_msg);

  BEGIN
    INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id, ledger_book_id)
    VALUES (gen_random_uuid(), aid, now()::date, 100, reg_a.client_entity_id, reg_a.internal_ledger_book_id);
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R8: qb_transactions INSERT with both stamps valid succeeds', ok, err_msg);
END;
$$;

-- ============================================================================
-- R9-R14: Write-guard rejection — child tables
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  reg_a record;
  stmt_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;

  -- Create valid parent statement for child tests
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_id;

  -- R9: bank_transactions INSERT without client_entity_id → REJECTED
  BEGIN
    INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount)
    VALUES (gen_random_uuid(), stmt_id, aid, now()::date, 100);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R9: bank_transactions INSERT without client_entity_id rejected', ok, err_msg);

  -- R10: bank_transactions INSERT with client_entity_id → SUCCESS
  BEGIN
    INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
    VALUES (gen_random_uuid(), stmt_id, aid, now()::date, 100, reg_a.client_entity_id);
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R10: bank_transactions INSERT with client_entity_id succeeds', ok, err_msg);

  -- R11: reconciliation_matches INSERT without client_entity_id → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, matched_by)
    VALUES (gen_random_uuid(), aid, stmt_id, gen_random_uuid(), 'auto');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R11: matches INSERT without client_entity_id rejected', ok, err_msg);

  -- R13: reconciliation_reports INSERT without client_entity_id → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_reports (id, user_id, statement_id)
    VALUES (gen_random_uuid(), aid, stmt_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R13: reports INSERT without client_entity_id rejected', ok, err_msg);

  -- R14: reconciliation_decisions INSERT without client_entity_id → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_decisions (id, user_id, statement_id, bank_transaction_id, decision_type)
    VALUES (gen_random_uuid(), aid, stmt_id, gen_random_uuid(), 'approve');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('R14: decisions INSERT without client_entity_id rejected', ok, err_msg);
END;
$$;

-- ============================================================================
-- Canonical stamp immutability transitions
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  bid uuid := 'a0000000-0000-0000-0000-000000000002';
  reg_a record;
  reg_b record;
  stmt_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;
  SELECT * INTO reg_b FROM public.default_tenant_identities WHERE user_id = bid;

  -- Create a statement WITH canonical stamps. Post-012 the write-guard requires
  -- both stamps on INSERT; the NULL -> value backfill transition applies to
  -- pre-012 rows and is exercised by the recovery drill that re-runs Migration 012.
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_id;

  -- Test: canonical A -> same A (no-op, allowed)
  BEGIN
    UPDATE public.bank_statements
    SET client_entity_id = reg_a.client_entity_id
    WHERE id = stmt_id;
    ok := true; err_msg := 'same value update succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: A -> same A allowed (no-op)', ok, err_msg);

  -- Test: ledger_book_id A -> same A (no-op, allowed)
  BEGIN
    UPDATE public.bank_statements
    SET ledger_book_id = reg_a.internal_ledger_book_id
    WHERE id = stmt_id;
    ok := true; err_msg := 'same value update succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: ledger A -> same A allowed (no-op)', ok, err_msg);

  -- Test: canonical A -> different B (rejected)
  BEGIN
    UPDATE public.bank_statements
    SET client_entity_id = reg_b.client_entity_id
    WHERE id = stmt_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: A -> B rejected', ok, err_msg);

  -- Test: ledger_book_id A -> different B (rejected)
  BEGIN
    UPDATE public.bank_statements
    SET ledger_book_id = reg_b.internal_ledger_book_id
    WHERE id = stmt_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: ledger A -> B rejected', ok, err_msg);

  -- Test: canonical A -> NULL (rejected)
  BEGIN
    UPDATE public.bank_statements
    SET client_entity_id = NULL
    WHERE id = stmt_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: A -> NULL rejected', ok, err_msg);

  -- Test: ledger_book_id A -> NULL (rejected)
  BEGIN
    UPDATE public.bank_statements
    SET ledger_book_id = NULL
    WHERE id = stmt_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Immutability: ledger A -> NULL rejected', ok, err_msg);

  -- Cleanup
  DELETE FROM public.bank_statements WHERE id = stmt_id;
END;
$$;

-- ============================================================================
-- QB same-client enforcement
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  bid uuid := 'a0000000-0000-0000-0000-000000000002';
  reg_a record;
  reg_b record;
  stmt_a_id uuid;
  stmt_b_id uuid;
  bt_a_id uuid;
  qt_a_id uuid;
  qt_b_id uuid;
  match_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;
  SELECT * INTO reg_b FROM public.default_tenant_identities WHERE user_id = bid;

  -- Create valid root rows for user A
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_a_id;

  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_a_id, aid, now()::date, 100, reg_a.client_entity_id)
  RETURNING id INTO bt_a_id;

  -- Create QB transactions for both users
  INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, now()::date, 100, reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO qt_a_id;

  INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), bid, now()::date, 200, reg_b.client_entity_id, reg_b.internal_ledger_book_id)
  RETURNING id INTO qt_b_id;

  -- Test: match with same-client QB → SUCCESS
  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, matched_by, client_entity_id, flagged_level)
    VALUES (gen_random_uuid(), aid, stmt_a_id, bt_a_id, qt_a_id, 'auto', reg_a.client_entity_id, 'green')
    RETURNING id INTO match_id;
    ok := true; err_msg := 'same-client insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('QB: same-client match insert succeeds', ok, err_msg);

  -- Test: match with cross-client QB → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, matched_by, client_entity_id, flagged_level)
    VALUES (gen_random_uuid(), aid, stmt_a_id, bt_a_id, qt_b_id, 'auto', reg_a.client_entity_id, 'green');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'same client|23514';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('QB: cross-client match insert rejected', ok, err_msg);

  -- Test: delete QB transaction → match qb_transaction_id becomes NULL, client_entity_id preserved
  DELETE FROM public.qb_transactions WHERE id = qt_a_id;
  SELECT qb_transaction_id, client_entity_id INTO ok, err_msg FROM public.reconciliation_matches WHERE id = match_id;
  PERFORM pg_temp.test_report('QB: delete cascades to SET NULL on match, preserves client_entity_id',
    ok IS NULL AND err_msg IS NOT NULL,
    'qb_txn_id=' || COALESCE(ok::text, 'NULL') || ' client=' || err_msg
  );

  -- Cleanup
  DELETE FROM public.reconciliation_matches WHERE id = match_id;
END;
$$;

-- ============================================================================
-- Audit evidence immutability
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  reg_a record;
  stmt_id uuid;
  bt_id uuid;
  match_id uuid;
  audit_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;

  -- Create fixtures
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_id;

  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_id, aid, now()::date, 100, reg_a.client_entity_id)
  RETURNING id INTO bt_id;

  INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, matched_by, client_entity_id, flagged_level)
  VALUES (gen_random_uuid(), aid, stmt_id, bt_id, 'auto', reg_a.client_entity_id, 'green')
  RETURNING id INTO match_id;

  -- A8: service_role INSERT audit row → SUCCESS
  BEGIN
    INSERT INTO public.reconciliation_audit_log (
      id, reconciliation_match_id, action, action_by, action_at, user_id, client_entity_id
    ) VALUES (
      gen_random_uuid(), match_id, 'match_approved', 'test', now(), aid, reg_a.client_entity_id
    )
    RETURNING id INTO audit_id;
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('A8: service_role audit INSERT succeeds', ok, err_msg);

  -- A10: service_role INSERT with NULL user_id → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_audit_log (id, reconciliation_match_id, action, action_by, action_at, client_entity_id)
    VALUES (gen_random_uuid(), match_id, 'test', 'test', now(), reg_a.client_entity_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'user_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('A10: audit INSERT with NULL user_id rejected', ok, err_msg);

  -- A11: service_role INSERT with NULL client_entity_id → REJECTED
  BEGIN
    INSERT INTO public.reconciliation_audit_log (id, reconciliation_match_id, action, action_by, action_at, user_id)
    VALUES (gen_random_uuid(), match_id, 'test', 'test', now(), aid);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'client_entity_id|23502';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('A11: audit INSERT with NULL client_entity_id rejected', ok, err_msg);

  -- A12: UPDATE audit evidence → REJECTED
  BEGIN
    UPDATE public.reconciliation_audit_log SET action = 'tampered' WHERE id = audit_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('A12: audit evidence UPDATE rejected', ok, err_msg);

  -- A13: DELETE audit row → REJECTED
  BEGIN
    DELETE FROM public.reconciliation_audit_log WHERE id = audit_id;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'immutable|42806';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('A13: audit DELETE rejected', ok, err_msg);

  -- Cleanup
  DELETE FROM public.reconciliation_matches WHERE id = match_id;
END;
$$;

-- ============================================================================
-- Decision RESTRICT
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  reg_a record;
  stmt_id uuid;
  dec_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;

  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_id;

  INSERT INTO public.reconciliation_decisions (id, user_id, statement_id, bank_transaction_id, decision_type, client_entity_id)
  VALUES (gen_random_uuid(), aid, stmt_id, gen_random_uuid(), 'approve', reg_a.client_entity_id)
  RETURNING id INTO dec_id;

  -- Try to delete the parent statement → should fail due to RESTRICT
  BEGIN
    DELETE FROM public.bank_statements WHERE id = stmt_id;
    ok := false; err_msg := 'no error raised — RESTRICT violated';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'restrict|foreign key';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Decision: DELETE statement with decisions rejected (RESTRICT)', ok, err_msg);

  -- Cleanup
  DELETE FROM public.reconciliation_decisions WHERE id = dec_id;
  DELETE FROM public.bank_statements WHERE id = stmt_id;
END;
$$;

-- ============================================================================
-- Audit FK SET NULL — delete parent match, audit row survives
-- ============================================================================

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  reg_a record;
  stmt_id uuid;
  bt_id uuid;
  match_id uuid;
  audit_id uuid;
  r record;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;

  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_id;

  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_id, aid, now()::date, 100, reg_a.client_entity_id)
  RETURNING id INTO bt_id;

  INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, matched_by, client_entity_id, flagged_level)
  VALUES (gen_random_uuid(), aid, stmt_id, bt_id, 'auto', reg_a.client_entity_id, 'green')
  RETURNING id INTO match_id;

  INSERT INTO public.reconciliation_audit_log (id, reconciliation_match_id, action, action_by, action_at, user_id, client_entity_id)
  VALUES (gen_random_uuid(), match_id, 'match_approved', 'test', now(), aid, reg_a.client_entity_id)
  RETURNING id INTO audit_id;

  -- Delete parent match → audit row survives with SET NULL on reconciliation_match_id
  DELETE FROM public.reconciliation_matches WHERE id = match_id;

  SELECT * INTO r FROM public.reconciliation_audit_log WHERE id = audit_id;
  PERFORM pg_temp.test_report(
    'FK SET NULL: audit row survives match deletion',
    r.id IS NOT NULL,
    'row present'
  );
  PERFORM pg_temp.test_report(
    'FK SET NULL: reconciliation_match_id becomes NULL',
    r.reconciliation_match_id IS NULL,
    'match_id=' || COALESCE(r.reconciliation_match_id::text, 'NULL')
  );
  PERFORM pg_temp.test_report(
    'FK SET NULL: user_id preserved',
    r.user_id = aid,
    'user_id=' || r.user_id
  );
  PERFORM pg_temp.test_report(
    'FK SET NULL: client_entity_id preserved',
    r.client_entity_id = reg_a.client_entity_id,
    'client=' || r.client_entity_id
  );
  PERFORM pg_temp.test_report(
    'FK SET NULL: action evidence preserved',
    r.action = 'match_approved',
    'action=' || r.action
  );

  -- Cleanup: delete audit row and child rows (order matters for FKs)
  DELETE FROM public.bank_transactions WHERE id = bt_id;
  DELETE FROM public.bank_statements WHERE id = stmt_id;
  -- audit row still exists (no-delete trigger prevents deletion — but we set match_id to NULL)
  -- Actually cleanup isn't possible due to no-delete trigger. The audit row remains as test artifact.
END;
$$;

-- Summary
DO $$
BEGIN
  RAISE NOTICE '========== BEHAVIORAL TEST SUMMARY ==========';
  RAISE NOTICE 'All behavioral tests run against local DB with Migration 012 applied.';
END;
$$;

DROP FUNCTION IF EXISTS pg_temp.test_report(text, boolean, text);
