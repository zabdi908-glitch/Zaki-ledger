-- Step 4E Phase 8: tenant isolation attacks against REAL copied tenants on staging.
-- Tenant A: 38832e8e-fa0f-45a3-96ce-3cb6da270cbe (zabdi908@gmail.com)
-- Tenant B: 0042d6e0-86f5-4c2e-970e-a0c7ac04106a (zabdi4549@gmail.com)
-- Attack must fail closed (error OR zero rows). Valid A->A must succeed.
\set ON_ERROR_STOP off

CREATE TEMP TABLE IF NOT EXISTS _t4e8_results (name text, passed boolean, detail text);
CREATE OR REPLACE FUNCTION pg_temp.t4e8_report(name text, passed boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _t4e8_results VALUES (name, passed, detail);
  RAISE NOTICE 'TEST: % | % | %', name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END, detail;
END;
$$;

-- denied: statement must raise any error (grant-level or RLS) when run as p_user
CREATE OR REPLACE FUNCTION pg_temp.t4e8_denied(p_user uuid, p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_raised boolean := false;
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_raised;
END;
$$;

-- invisible: query on B's row must return 0 rows when run as p_user (RLS filter)
CREATE OR REPLACE FUNCTION pg_temp.t4e8_invisible(p_user uuid, p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  EXECUTE p_sql INTO v_count;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_count = 0;
END;
$$;

-- noop: UPDATE/DELETE on B's row must affect 0 rows when run as p_user
CREATE OR REPLACE FUNCTION pg_temp.t4e8_noop(p_user uuid, p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n integer := -1;
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_n := -2; -- denied at grant level: also fail closed
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_n <= 0;
END;
$$;

-- service_ok: statement must succeed as service_role (trusted server path)
CREATE OR REPLACE FUNCTION pg_temp.t4e8_service_ok(p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_ok boolean := true;
BEGIN
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN v_ok;
END;
$$;

DO $t$
DECLARE
  v_a uuid := '38832e8e-fa0f-45a3-96ce-3cb6da270cbe';
  v_b uuid := '0042d6e0-86f5-4c2e-970e-a0c7ac04106a';
  v_bs_b uuid; v_bt_b uuid; v_rm_b uuid; v_rr_b uuid; v_rd_b uuid; v_ral_b uuid;
  v_a_client uuid; v_a_book uuid; v_b_client uuid; v_b_book uuid;
  v_ok boolean; v_cnt integer;
BEGIN
  SELECT client_entity_id, internal_ledger_book_id INTO v_a_client, v_a_book
    FROM public.default_tenant_identities WHERE user_id = v_a;
  SELECT client_entity_id, internal_ledger_book_id INTO v_b_client, v_b_book
    FROM public.default_tenant_identities WHERE user_id = v_b;
  SELECT id INTO v_bs_b FROM public.bank_statements WHERE user_id = v_b LIMIT 1;
  SELECT id INTO v_bt_b FROM public.bank_transactions WHERE user_id = v_b LIMIT 1;
  SELECT id INTO v_rm_b FROM public.reconciliation_matches WHERE user_id = v_b LIMIT 1;
  SELECT id INTO v_rr_b FROM public.reconciliation_reports WHERE user_id = v_b LIMIT 1;
  SELECT id INTO v_rd_b FROM public.reconciliation_decisions WHERE user_id = v_b LIMIT 1;
  SELECT ral.id INTO v_ral_b FROM public.reconciliation_audit_log ral
    JOIN public.reconciliation_matches rm ON rm.id = ral.reconciliation_match_id
    WHERE rm.user_id = v_b LIMIT 1;
  IF v_bs_b IS NULL OR v_bt_b IS NULL OR v_rm_b IS NULL THEN
    RAISE EXCEPTION 'fixture precondition failed: tenant B rows missing';
  END IF;

  -- ============ READ ATTACKS ============
  -- bank tables: authenticated has no SELECT grant (009) -> denied at grant level
  v_ok := pg_temp.t4e8_denied(v_a, format('SELECT count(*) FROM public.bank_statements WHERE id = %L', v_bs_b));
  PERFORM pg_temp.t4e8_report('R1 A reads B statement', v_ok, 'grant-denied');

  v_ok := pg_temp.t4e8_denied(v_a, format('SELECT count(*) FROM public.bank_transactions WHERE id = %L', v_bt_b));
  PERFORM pg_temp.t4e8_report('R2 A reads B bank transaction', v_ok, 'grant-denied');

  -- reconciliation tables: SELECT granted -> RLS must hide B rows
  v_ok := pg_temp.t4e8_invisible(v_a, format('SELECT count(*) FROM public.reconciliation_matches WHERE id = %L', v_rm_b));
  PERFORM pg_temp.t4e8_report('R3 A reads B match', v_ok, 'rls-filtered');

  IF v_rr_b IS NOT NULL THEN
    v_ok := pg_temp.t4e8_invisible(v_a, format('SELECT count(*) FROM public.reconciliation_reports WHERE id = %L', v_rr_b));
    PERFORM pg_temp.t4e8_report('R4 A reads B report', v_ok, 'rls-filtered');
  ELSE
    PERFORM pg_temp.t4e8_report('R4 A reads B report', true, 'B has no report');
  END IF;

  IF v_rd_b IS NOT NULL THEN
    v_ok := pg_temp.t4e8_invisible(v_a, format('SELECT count(*) FROM public.reconciliation_decisions WHERE id = %L', v_rd_b));
    PERFORM pg_temp.t4e8_report('R5 A reads B decision', v_ok, 'rls-filtered');
  ELSE
    PERFORM pg_temp.t4e8_report('R5 A reads B decision', true, 'B has no decision');
  END IF;

  IF v_ral_b IS NOT NULL THEN
    v_ok := pg_temp.t4e8_invisible(v_a, format('SELECT count(*) FROM public.reconciliation_audit_log WHERE id = %L', v_ral_b));
    PERFORM pg_temp.t4e8_report('R6 A reads B audit row', v_ok, 'rls-filtered');
  ELSE
    PERFORM pg_temp.t4e8_report('R6 A reads B audit row', true, 'B has no audit row');
  END IF;

  -- ============ MUTATION ATTACKS ============
  v_ok := pg_temp.t4e8_noop(v_a, format('UPDATE public.bank_statements SET closing_balance = closing_balance WHERE id = %L', v_bs_b));
  PERFORM pg_temp.t4e8_report('M1 A mutates B statement', v_ok, 'denied or 0 rows');

  v_ok := pg_temp.t4e8_noop(v_a, format('UPDATE public.reconciliation_matches SET confidence = confidence WHERE id = %L', v_rm_b));
  PERFORM pg_temp.t4e8_report('M2 A mutates B match', v_ok, 'rls 0 rows');

  v_ok := pg_temp.t4e8_noop(v_a, format('UPDATE public.reconciliation_matches SET approved_by = ''A-forged'' WHERE id = %L', v_rm_b));
  PERFORM pg_temp.t4e8_report('M3 A approves B match', v_ok, 'rls 0 rows');

  v_ok := pg_temp.t4e8_noop(v_a, format('DELETE FROM public.reconciliation_matches WHERE id = %L', v_rm_b));
  PERFORM pg_temp.t4e8_report('M4 A deletes B match', v_ok, 'rls 0 rows');

  v_ok := pg_temp.t4e8_denied(v_a, format('INSERT INTO public.bank_transactions (id, statement_id, user_id, amount) SELECT gen_random_uuid(), %L, %L, 1', v_bs_b, v_b));
  PERFORM pg_temp.t4e8_report('M5 A inserts txn on B statement', v_ok, 'denied');

  v_ok := pg_temp.t4e8_noop(v_a, format('UPDATE public.qb_transactions SET amount = amount WHERE user_id = %L', v_b));
  PERFORM pg_temp.t4e8_report('M6 A mutates B QB transactions', v_ok, 'denied or 0 rows');

  -- ============ AUDIT FORGERY ATTACKS ============
  v_ok := pg_temp.t4e8_denied(v_a, format('INSERT INTO public.reconciliation_audit_log (reconciliation_match_id, action, action_by, user_id, client_entity_id) VALUES (%L, ''forge'', ''A'', %L, %L)', v_rm_b, v_a, v_a_client));
  PERFORM pg_temp.t4e8_report('A1 A direct audit INSERT', v_ok, 'revoked (Z12)');

  v_ok := pg_temp.t4e8_denied(v_a, format('UPDATE public.reconciliation_audit_log SET action = ''forged'' WHERE id = %L', v_ral_b));
  PERFORM pg_temp.t4e8_report('A2 A direct audit UPDATE', v_ok, 'revoked (Z12)');

  v_ok := pg_temp.t4e8_denied(v_a, format('DELETE FROM public.reconciliation_audit_log WHERE id = %L', v_ral_b));
  PERFORM pg_temp.t4e8_report('A3 A direct audit DELETE', v_ok, 'revoked (Z12)');

  -- ============ SERVICE-PATH ATTACKS (service_role with mismatched canonical IDs) ============
  v_ok := NOT pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_bank_statement_v1(%L::uuid, jsonb_build_object(''file_name'',''attack'', ''file_format'',''csv'', ''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''source_provider'',''attacker'', ''source_account_id'',''x'', ''source_artifact_hash'',''h''), ''[]''::jsonb)',
    v_a, v_b_client, v_b_book));
  PERFORM pg_temp.t4e8_report('S1 p_user_id=A + Client B', v_ok, '23514 expected');

  v_ok := NOT pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_accounting_transactions_v1(%L::uuid, jsonb_build_array(jsonb_build_object(''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''provider'',''attacker'', ''organisation_id'',''x'', ''external_object_type'',''inv'', ''qb_transaction_id'',''1'', ''amount'',''1''))::jsonb)',
    v_a, v_b_client, v_b_book));
  PERFORM pg_temp.t4e8_report('S2 p_user_id=A + Book B', v_ok, '23514 expected');

  v_ok := NOT pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_bank_statement_v1(%L::uuid, jsonb_build_object(''file_name'',''attack2'', ''file_format'',''csv'', ''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''source_provider'',''attacker'', ''source_account_id'',''x'', ''source_artifact_hash'',''h2''), ''[]''::jsonb)',
    v_a, v_a_client, v_b_book));
  PERFORM pg_temp.t4e8_report('S3 Client A + Book B (cross pair)', v_ok, '23514 expected');

  v_ok := NOT pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_bank_statement_v1(%L::uuid, jsonb_build_object(''file_name'',''attack3'', ''file_format'',''csv''), ''[]''::jsonb)', v_a));
  PERFORM pg_temp.t4e8_report('S4 no canonical IDs supplied', v_ok, '23502 expected');

  v_ok := NOT pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_bank_statement_v1(%L::uuid, jsonb_build_object(''id'', %L::text, ''file_name'',''forged'', ''file_format'',''csv'', ''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''source_provider'',''attacker'', ''source_account_id'',''x'', ''source_artifact_hash'',''h3''), ''[]''::jsonb)',
    v_a, v_bs_b, v_a_client, v_a_book));
  PERFORM pg_temp.t4e8_report('S5 forged B statement id under A identity', v_ok, 'rejected');

  -- ============ VALID A->A OPERATIONS (must succeed) ============
  v_ok := pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_bank_statement_v1(%L::uuid, jsonb_build_object(''file_name'',''4e8-valid-1'', ''file_format'',''csv'', ''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''source_provider'',''4e8'', ''source_account_id'',''4e8'', ''source_artifact_hash'',''4e8-h1''), jsonb_build_array(jsonb_build_object(''transaction_date'',''2026-08-01'', ''amount'',''1.00''))::jsonb)',
    v_a, v_a_client, v_a_book));
  PERFORM pg_temp.t4e8_report('V1 A ingests own statement (valid)', v_ok);

  v_ok := pg_temp.t4e8_service_ok(format(
    'SELECT public.ingest_accounting_transactions_v1(%L::uuid, jsonb_build_array(jsonb_build_object(''client_entity_id'', %L::text, ''ledger_book_id'', %L::text, ''provider'',''4e8'', ''organisation_id'',''4e8'', ''external_object_type'',''inv'', ''qb_transaction_id'',''4e8-1'', ''posted_date'',''2026-08-01'', ''amount'',''2.00''))::jsonb)',
    v_a, v_a_client, v_a_book));
  PERFORM pg_temp.t4e8_report('V2 A ingests own QB transactions (valid)', v_ok);

  SELECT count(*) INTO v_cnt FROM public.bank_statements
    WHERE user_id = v_a AND file_name = '4e8-valid-1'
      AND client_entity_id = v_a_client AND ledger_book_id = v_a_book;
  PERFORM pg_temp.t4e8_report('V3 new row stamped with A canonical ids', v_cnt = 1, 'count=' || v_cnt);
END;
$t$;

SELECT name, passed, detail FROM _t4e8_results ORDER BY name;
