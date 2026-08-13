-- ============================================================================
-- Migration 012 Behavioral Contract Tests — Addendum
-- Self-context RPC (authenticated role) + old-shape ingestion fail-closed
-- Run: docker cp + psql -f (never pipe SQL through docker exec stdin)
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.test_report(name text, passed boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'TEST: % | % | %', name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END, detail;
END;
$$;

-- ---------------------------------------------------------------------------
-- Setup: user A with complete tenant registry
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at, email_confirmed_at)
VALUES ('b0000000-0000-0000-0000-000000000001', 'extra-a@test.local', 'x',
        '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

SELECT public.ensure_default_tenant_for_user_v1('b0000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- 1. Self-context RPC — authenticated JWT returns the caller's own context
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_reg record;
  v_practice_id uuid;
  v_membership_id uuid;
  v_client_id uuid;
  v_ledger_id uuid;
  ok boolean;
  err_msg text;
BEGIN
  SELECT * INTO v_reg FROM public.default_tenant_identities
  WHERE user_id = 'b0000000-0000-0000-0000-000000000001';

  -- Simulate an authenticated JWT by switching role + setting the JWT claim.
  -- canonical_default_tenant_context_for_self_v1() is SECURITY DEFINER and is
  -- EXECUTE-granted only to the authenticated role; auth.uid() reads
  -- request.jwt.claim.sub.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000001', true);
    SELECT f.practice_id, f.practice_membership_id, f.client_entity_id, f.internal_ledger_book_id
      INTO v_practice_id, v_membership_id, v_client_id, v_ledger_id
    FROM public.canonical_default_tenant_context_for_self_v1() AS f;
    RESET ROLE;
    ok := true;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
    err_msg := SQLERRM;
  END;

  PERFORM pg_temp.test_report('Self-context RPC: call succeeds as authenticated', ok, COALESCE(err_msg, ''));
  PERFORM pg_temp.test_report('Self-context RPC: returns own client_entity_id',
    v_client_id = v_reg.client_entity_id,
    'expected=' || v_reg.client_entity_id || ' got=' || COALESCE(v_client_id::text, 'NULL'));
  PERFORM pg_temp.test_report('Self-context RPC: returns own internal ledger_book_id',
    v_ledger_id = v_reg.internal_ledger_book_id,
    'expected=' || v_reg.internal_ledger_book_id || ' got=' || COALESCE(v_ledger_id::text, 'NULL'));
  PERFORM pg_temp.test_report('Self-context RPC: returns practice_id',
    v_practice_id = v_reg.practice_id,
    'expected=' || v_reg.practice_id || ' got=' || COALESCE(v_practice_id::text, 'NULL'));
  PERFORM pg_temp.test_report('Self-context RPC: returns practice_membership_id',
    v_membership_id = v_reg.practice_membership_id,
    'expected=' || v_reg.practice_membership_id || ' got=' || COALESCE(v_membership_id::text, 'NULL'));
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Old-shape ingestion fail-closed BEFORE artifact reuse
--    A statement JSON that omits client_entity_id/ledger_book_id but carries a
--    source_artifact_hash that would otherwise match an existing row MUST
--    raise 23502 and must NOT reuse/return the existing artifact.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_reg record;
  v_stmt_id uuid := gen_random_uuid();
  v_attempt jsonb;
  v_result jsonb;
  v_count integer;
  ok boolean;
  err_code text;
  err_msg text;
BEGIN
  SELECT * INTO v_reg FROM public.default_tenant_identities
  WHERE user_id = 'b0000000-0000-0000-0000-000000000001';

  -- Seed a canonical statement with a known artifact hash (direct SQL, valid stamps).
  INSERT INTO public.bank_statements (
    id, user_id, file_name, file_format, currency, source_provider,
    source_organisation_id, source_account_id, source_artifact_hash,
    client_entity_id, ledger_book_id
  ) VALUES (
    v_stmt_id, 'b0000000-0000-0000-0000-000000000001', 'old-shape.csv', 'csv',
    'GBP', 'test-bank', 'org-extra', 'acct-extra', 'artifact-hash-extra-001',
    v_reg.client_entity_id, v_reg.internal_ledger_book_id
  );

  -- Old-shape payload: no client_entity_id / ledger_book_id, but the same
  -- artifact hash that already exists for this user.
  v_attempt := jsonb_build_object(
    'id', gen_random_uuid(),
    'file_name', 'old-shape.csv',
    'file_format', 'csv',
    'source_provider', 'test-bank',
    'source_organisation_id', 'org-extra',
    'source_account_id', 'acct-extra',
    'source_artifact_hash', 'artifact-hash-extra-001'
  );

  BEGIN
    -- Run as service_role so the RPC auth guard passes; the canonical
    -- validation must reject BEFORE any artifact reuse.
    SET LOCAL ROLE service_role;
    v_result := public.ingest_bank_statement_v1(
      'b0000000-0000-0000-0000-000000000001',
      v_attempt,
      '[]'::jsonb
    );
    RESET ROLE;
    ok := false; err_code := 'no error raised'; err_msg := 'RPC returned: ' || v_result::text;
  EXCEPTION WHEN OTHERS THEN
    err_code := SQLSTATE;
    err_msg := SQLERRM;
    ok := (SQLSTATE = '23502') AND (SQLERRM LIKE '%canonical%');
  END;

  PERFORM pg_temp.test_report('Old-shape ingestion: raises 23502 (fail-closed)', ok,
    'sqlstate=' || err_code || ' err=' || err_msg);

  -- No statement was created by the failed attempt; no transactions inserted.
  SELECT count(*) INTO v_count FROM public.bank_statements
  WHERE user_id = 'b0000000-0000-0000-0000-000000000001'
    AND source_artifact_hash = 'artifact-hash-extra-001';
  PERFORM pg_temp.test_report('Old-shape ingestion: no new statement row', v_count = 1,
    'rows=' || v_count || ' (expected exactly 1 seeded row)');

  SELECT count(*) INTO v_count FROM public.bank_transactions
  WHERE statement_id = v_stmt_id;
  PERFORM pg_temp.test_report('Old-shape ingestion: no transactions inserted', v_count = 0,
    'rows=' || v_count);

  -- Cleanup the seeded row.
  DELETE FROM public.bank_statements WHERE id = v_stmt_id;
END;
$$;

DROP FUNCTION IF EXISTS pg_temp.test_report(text, boolean, text);