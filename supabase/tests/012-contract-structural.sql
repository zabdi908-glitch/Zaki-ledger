-- Migration 012 Structural Contract Tests ? single DO block with pg_temp reporter
-- Run via: psql -f supabase/tests/012-contract-structural.sql (or supabase db query)

CREATE TEMP TABLE IF NOT EXISTS _t012_results (name text, passed boolean, detail text);

CREATE OR REPLACE FUNCTION pg_temp.test_report(name text, passed boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _t012_results VALUES (name, passed, detail);
  RAISE NOTICE 'TEST: % | % | %', name, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END, detail;
END;
$$;

DO $$
DECLARE
  rec record;
  cols text[];
  missing text[];
  tbl_name text;
  cnt integer;
BEGIN
  -- Z1: Additive columns
  FOR rec IN SELECT * FROM (VALUES
    ('bank_statements', ARRAY['client_entity_id','ledger_book_id']),
    ('bank_transactions', ARRAY['client_entity_id']),
    ('qb_transactions', ARRAY['client_entity_id','ledger_book_id']),
    ('reconciliation_matches', ARRAY['client_entity_id']),
    ('reconciliation_reports', ARRAY['client_entity_id']),
    ('reconciliation_decisions', ARRAY['client_entity_id']),
    ('reconciliation_audit_log', ARRAY['client_entity_id','user_id'])
  ) AS t(tbl, required_cols)
  LOOP
    SELECT array_agg(c.column_name) INTO cols FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=rec.tbl;
    missing := ARRAY(SELECT unnest(rec.required_cols) EXCEPT SELECT unnest(cols));
    PERFORM pg_temp.test_report('Z1: '||rec.tbl||' columns', array_length(missing,1) IS NULL,
      COALESCE('missing:'||array_to_string(missing,','), 'ok'));
  END LOOP;

  -- Z5: Composite FKs
  FOREACH tbl_name IN ARRAY ARRAY[
    'fk_bank_transactions_statement_client','fk_bank_statements_ledger_client',
    'fk_bank_statements_client','fk_qb_transactions_ledger_client',
    'fk_qb_transactions_client','fk_matches_statement_client',
    'fk_matches_bank_txn_client','fk_matches_statement_bank_txn',
    'fk_reports_statement_client','fk_decisions_statement_client']
  LOOP
    SELECT count(*) INTO cnt FROM information_schema.table_constraints
    WHERE constraint_name=tbl_name AND constraint_schema='public';
    PERFORM pg_temp.test_report('Z5: FK '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'NOT FOUND' END);
  END LOOP;

  -- Z4: Unique indexes
  FOREACH tbl_name IN ARRAY ARRAY[
    'uk_bank_statements_id_client','uk_bank_transactions_id_client',
    'uk_bank_transactions_statement_id','uk_qb_transactions_id_client']
  LOOP
    SELECT count(*) INTO cnt FROM pg_indexes WHERE indexname=tbl_name AND schemaname='public';
    PERFORM pg_temp.test_report('Z4: Index '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'NOT FOUND' END);
  END LOOP;

  -- Z6: Audit log redesign
  SELECT is_nullable INTO tbl_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='reconciliation_match_id';
  PERFORM pg_temp.test_report('Z6a: match_id nullable', tbl_name='YES', tbl_name);
  SELECT is_nullable INTO tbl_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='user_id';
  PERFORM pg_temp.test_report('Z6e: user_id NOT NULL', tbl_name='NO', tbl_name);
  SELECT delete_rule INTO tbl_name FROM information_schema.referential_constraints
  WHERE constraint_name='fk_audit_log_user' AND constraint_schema='public';
  PERFORM pg_temp.test_report('Z6f: user_id FK RESTRICT', tbl_name='RESTRICT', COALESCE(tbl_name,'NULL'));

  -- Z8: Write-guard triggers
  FOREACH tbl_name IN ARRAY ARRAY['bank_statements','qb_transactions'] LOOP
    SELECT count(*) INTO cnt FROM information_schema.triggers
    WHERE trigger_name='write_guard_root_stamp' AND event_object_table=tbl_name AND trigger_schema='public';
    PERFORM pg_temp.test_report('Z8: root guard on '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  END LOOP;
  FOREACH tbl_name IN ARRAY ARRAY['bank_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions'] LOOP
    SELECT count(*) INTO cnt FROM information_schema.triggers
    WHERE trigger_name='write_guard_client_stamp' AND event_object_table=tbl_name AND trigger_schema='public';
    PERFORM pg_temp.test_report('Z8: child guard on '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  END LOOP;
  SELECT count(*) INTO cnt FROM information_schema.triggers
  WHERE trigger_name='audit_log_write_guard' AND event_object_table='reconciliation_audit_log' AND trigger_schema='public';
  PERFORM pg_temp.test_report('Z8: audit guard', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);

  -- Z9: Immutability triggers
  FOREACH tbl_name IN ARRAY ARRAY['bank_statements','bank_transactions','qb_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions'] LOOP
    SELECT count(*) INTO cnt FROM information_schema.triggers
    WHERE trigger_name='client_stamp_immutable' AND event_object_table=tbl_name AND trigger_schema='public';
    PERFORM pg_temp.test_report('Z9: client immut on '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  END LOOP;
  FOREACH tbl_name IN ARRAY ARRAY['bank_statements','qb_transactions'] LOOP
    SELECT count(*) INTO cnt FROM information_schema.triggers
    WHERE trigger_name='ledger_book_id_immutable' AND event_object_table=tbl_name AND trigger_schema='public';
    PERFORM pg_temp.test_report('Z9: ledger immut on '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  END LOOP;
  SELECT count(*) INTO cnt FROM information_schema.triggers
  WHERE trigger_name='audit_log_evidence_immutable' AND trigger_schema='public';
  PERFORM pg_temp.test_report('Z9: evidence immut', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.triggers
  WHERE trigger_name='audit_log_no_delete' AND trigger_schema='public';
  PERFORM pg_temp.test_report('Z9: no-delete trigger', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.triggers
  WHERE trigger_name='audit_log_stamp_immutable' AND trigger_schema='public';
  PERFORM pg_temp.test_report('Z9: audit stamp immut', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);

  -- Z10: RPCs
  SELECT count(*) INTO cnt FROM information_schema.routines WHERE routine_name='canonical_default_tenant_context_for_self_v1' AND routine_schema='public';
  PERFORM pg_temp.test_report('Z10: self-context RPC', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.routines WHERE routine_name='canonical_default_tenant_ids_v1' AND routine_schema='public';
  PERFORM pg_temp.test_report('Z10: ids helper RPC', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.routines WHERE routine_name='ingest_bank_statement_v1' AND routine_schema='public';
  PERFORM pg_temp.test_report('Z10: bank ingestion RPC', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.routines WHERE routine_name='ingest_accounting_transactions_v1' AND routine_schema='public';
  PERFORM pg_temp.test_report('Z10: accounting ingestion RPC', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);

  -- Z7: QB same-client
  SELECT count(*) INTO cnt FROM information_schema.routines WHERE routine_name='match_qb_same_client_v1' AND routine_schema='public';
  PERFORM pg_temp.test_report('Z7: QB same-client fn', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);
  SELECT count(*) INTO cnt FROM information_schema.triggers WHERE trigger_name='match_qb_same_client_check' AND trigger_schema='public';
  PERFORM pg_temp.test_report('Z7: QB same-client trigger', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);

  -- Z12: Audit ACL
  SELECT count(*) INTO cnt FROM information_schema.table_privileges
  WHERE table_name='reconciliation_audit_log' AND grantee='authenticated' AND privilege_type='INSERT';
  PERFORM pg_temp.test_report('Z12: auth no INSERT', cnt=0, CASE WHEN cnt=0 THEN 'ok' ELSE 'GRANTED' END);
  SELECT count(*) INTO cnt FROM information_schema.table_privileges
  WHERE table_name='reconciliation_audit_log' AND grantee='authenticated' AND privilege_type='UPDATE';
  PERFORM pg_temp.test_report('Z12: auth no UPDATE', cnt=0, CASE WHEN cnt=0 THEN 'ok' ELSE 'GRANTED' END);
  SELECT count(*) INTO cnt FROM information_schema.table_privileges
  WHERE table_name='reconciliation_audit_log' AND grantee='authenticated' AND privilege_type='DELETE';
  PERFORM pg_temp.test_report('Z12: auth no DELETE', cnt=0, CASE WHEN cnt=0 THEN 'ok' ELSE 'GRANTED' END);
  SELECT count(*) INTO cnt FROM information_schema.table_privileges
  WHERE table_name='reconciliation_audit_log' AND grantee='anon';
  PERFORM pg_temp.test_report('Z12: anon no privileges', cnt=0, CASE WHEN cnt=0 THEN 'ok' ELSE 'ANON HAS ACCESS' END);
  SELECT count(*) INTO cnt FROM pg_policies
  WHERE policyname='Users can read their own audit log' AND tablename='reconciliation_audit_log';
  PERFORM pg_temp.test_report('Z12: SELECT policy exists', cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'MISSING' END);

  -- Z11: Read-path indexes
  FOREACH tbl_name IN ARRAY ARRAY[
    'idx_bank_statements_client','idx_bank_transactions_client',
    'idx_qb_transactions_client','idx_reconciliation_matches_client',
    'idx_reconciliation_reports_client','idx_reconciliation_decisions_client',
    'idx_reconciliation_audit_log_client','idx_reconciliation_audit_log_user']
  LOOP
    SELECT count(*) INTO cnt FROM pg_indexes WHERE indexname=tbl_name AND schemaname='public';
    PERFORM pg_temp.test_report('Z11: index '||tbl_name, cnt>0, CASE WHEN cnt>0 THEN 'ok' ELSE 'NOT FOUND' END);
  END LOOP;

  -- B10: Root write guards on both root tables
  PERFORM pg_temp.test_report('B10: root guards on bank_statements+qb_transactions',
    EXISTS(SELECT 1 FROM information_schema.triggers WHERE trigger_name='write_guard_root_stamp' AND event_object_table='bank_statements') AND
    EXISTS(SELECT 1 FROM information_schema.triggers WHERE trigger_name='write_guard_root_stamp' AND event_object_table='qb_transactions'),
    'verified');

  -- B11: Audit DML revoked
  SELECT count(*) INTO cnt FROM information_schema.table_privileges
  WHERE table_name='reconciliation_audit_log' AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  PERFORM pg_temp.test_report('B11: auth DML revoked', cnt=0, CASE WHEN cnt=0 THEN 'ok' ELSE 'FAIL: found '||cnt END);
END;
$$;

DO $$
DECLARE
  pass_count integer;
  fail_count integer;
  fails text;
BEGIN
  SELECT count(*) FILTER (WHERE passed), count(*) FILTER (WHERE NOT passed)
    INTO pass_count, fail_count FROM _t012_results;
  SELECT string_agg(name || ' :: ' || detail, E'
') INTO fails FROM _t012_results WHERE NOT passed;
  RAISE NOTICE 'TOTAL: pass=%, fail=%', pass_count, fail_count;
  IF fail_count > 0 THEN
    RAISE EXCEPTION 'STRUCTURAL CONTRACT FAILED:%', E'
' || fails;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS pg_temp.test_report(text, boolean, text);
