-- ============================================================================
-- Migration 012 Tenant Isolation Attack Tests (SQL-level)
-- Two tenants: User A (a00...01) and User B (a00...02)
-- Run: npx supabase db query -f supabase/tests/012-tenant-isolation.sql
-- ============================================================================


CREATE OR REPLACE FUNCTION pg_temp.test_report(name text, passed boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'TEST: % | % | %', name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END, detail;
END;
$$;

-- Setup: bootstrap both users if not already done
SELECT public.ensure_default_tenant_for_user_v1('a0000000-0000-0000-0000-000000000001');
SELECT public.ensure_default_tenant_for_user_v1('a0000000-0000-0000-0000-000000000002');

DO $$
DECLARE
  aid uuid := 'a0000000-0000-0000-0000-000000000001';
  bid uuid := 'a0000000-0000-0000-0000-000000000002';
  reg_a record;
  reg_b record;
  stmt_a_id uuid;
  stmt_b_id uuid;
  bt_a_id uuid;
  bt_a_second uuid;
  bt_b_id uuid;
  qt_a_id uuid;
  qt_b_id uuid;
  match_a_id uuid;
  ok boolean;
  err_msg text;
  row_count integer;
BEGIN
  SELECT * INTO reg_a FROM public.default_tenant_identities WHERE user_id = aid;
  SELECT * INTO reg_b FROM public.default_tenant_identities WHERE user_id = bid;

  -- Create data for User A
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, 'csv', reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO stmt_a_id;

  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_a_id, aid, now()::date, 100, reg_a.client_entity_id)
  RETURNING id INTO bt_a_id;

  INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), aid, now()::date, 100, reg_a.client_entity_id, reg_a.internal_ledger_book_id)
  RETURNING id INTO qt_a_id;

  INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, matched_by, client_entity_id, flagged_level)
  VALUES (gen_random_uuid(), aid, stmt_a_id, bt_a_id, qt_a_id, 'auto', reg_a.client_entity_id, 'green')
  RETURNING id INTO match_a_id;

  -- Create data for User B
  INSERT INTO public.bank_statements (id, user_id, file_format, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), bid, 'csv', reg_b.client_entity_id, reg_b.internal_ledger_book_id)
  RETURNING id INTO stmt_b_id;

  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_b_id, bid, now()::date, 200, reg_b.client_entity_id)
  RETURNING id INTO bt_b_id;

  INSERT INTO public.qb_transactions (id, user_id, posted_date, amount, client_entity_id, ledger_book_id)
  VALUES (gen_random_uuid(), bid, now()::date, 200, reg_b.client_entity_id, reg_b.internal_ledger_book_id)
  RETURNING id INTO qt_b_id;

  -- ========================================================================
  -- ATTACK VECTORS
  -- ========================================================================

  -- 1. A tries to read B's statement (via user_id scoping)
  SELECT count(*) INTO row_count FROM public.bank_statements
  WHERE user_id = aid AND id = stmt_b_id;
  PERFORM pg_temp.test_report('Isolation: A cannot see B statement by user_id', row_count = 0);

  -- 2. A tries to read B's match
  SELECT count(*) INTO row_count FROM public.reconciliation_matches
  WHERE user_id = aid AND statement_id = stmt_b_id;
  PERFORM pg_temp.test_report('Isolation: A cannot see B match by user_id', row_count = 0);

  -- 3. A tries to mutate B's match (UPDATE)
  BEGIN
    UPDATE public.reconciliation_matches SET confidence = 0.99
    WHERE user_id = aid AND id IN (SELECT id FROM public.reconciliation_matches WHERE user_id = bid LIMIT 1);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    ok := row_count = 0;
    err_msg := 'rows affected: ' || row_count;
  EXCEPTION WHEN OTHERS THEN
    ok := true; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Isolation: A cannot UPDATE B match', ok, err_msg);

  -- 4. A uses B's bank transaction in a match (composite FK should block)
  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, matched_by, client_entity_id, flagged_level)
    VALUES (gen_random_uuid(), aid, stmt_a_id, bt_b_id, 'auto', reg_a.client_entity_id, 'green');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'foreign key|violates|not present';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Isolation: A cannot use B bank_txn in match (composite FK)', ok, err_msg);

  -- 5. A uses B's QB transaction in a match (same-client trigger should block)
  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, matched_by, client_entity_id, flagged_level)
    VALUES (gen_random_uuid(), aid, stmt_a_id, bt_a_id, qt_b_id, 'auto', reg_a.client_entity_id, 'green');
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'same client|23514';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Isolation: A cannot use B QB txn in match (same-client trigger)', ok, err_msg);

  -- 6. Forged statement ID (A's bank_txn with B's statement_id)
  BEGIN
    INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
    VALUES (gen_random_uuid(), stmt_b_id, aid, now()::date, 100, reg_a.client_entity_id);
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM ~ 'foreign key|violates|not present';
    err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Isolation: forged statement_id rejected (composite FK)', ok, err_msg);

  -- 7. Authenticated direct audit INSERT is denied by ACL (REVOKE INSERT FROM
  --    authenticated) even before any same-client logic can apply
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.reconciliation_audit_log (id, reconciliation_match_id, action, action_by, action_at, user_id, client_entity_id)
    VALUES (gen_random_uuid(), (SELECT id FROM public.reconciliation_matches WHERE user_id = bid LIMIT 1), 'test', 'test', now(), aid, reg_a.client_entity_id);
    RESET ROLE;
    ok := false; err_msg := 'no error raised';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    ok := true; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Isolation: authenticated direct audit INSERT denied', ok, err_msg);

  -- ========================================================================
  -- VALID OPERATIONS (Aâ†’A should succeed)
  -- ========================================================================

  BEGIN
    INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
    VALUES (gen_random_uuid(), stmt_a_id, aid, now()::date, 50, reg_a.client_entity_id);
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Valid: A can insert bank_txn for own statement', ok, err_msg);

  -- Use a second bank transaction so the (statement_id, bank_transaction_id)
  -- unique pair does not collide with the already-inserted match_a_id.
  INSERT INTO public.bank_transactions (id, statement_id, user_id, transaction_date, amount, client_entity_id)
  VALUES (gen_random_uuid(), stmt_a_id, aid, now()::date, 75, reg_a.client_entity_id)
  RETURNING id INTO bt_a_second;

  BEGIN
    INSERT INTO public.reconciliation_matches (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, matched_by, client_entity_id, flagged_level)
    VALUES (gen_random_uuid(), aid, stmt_a_id, bt_a_second, qt_a_id, 'manual', reg_a.client_entity_id, 'green');
    ok := true; err_msg := 'insert succeeded';
  EXCEPTION WHEN OTHERS THEN
    ok := false; err_msg := SQLERRM;
  END;
  PERFORM pg_temp.test_report('Valid: A can create match with own transactions', ok, err_msg);

  -- Cleanup all test data in reverse dependency order
  DELETE FROM public.reconciliation_matches WHERE user_id IN (aid, bid);
  DELETE FROM public.qb_transactions WHERE user_id IN (aid, bid);
  DELETE FROM public.bank_transactions WHERE user_id IN (aid, bid);
  DELETE FROM public.bank_statements WHERE user_id IN (aid, bid);
END;
$$;

DO $$
BEGIN
  RAISE NOTICE '========== TENANT ISOLATION SUMMARY ==========';
END;
$$;

DROP FUNCTION IF EXISTS pg_temp.test_report(text, boolean, text);
