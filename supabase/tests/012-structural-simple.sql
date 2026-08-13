DO $$
DECLARE
  tbl text; cnt integer;
BEGIN
  RAISE NOTICE 'Z1: checking columns...';
  -- Verify all columns exist via simple existence checks
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_statements' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: bank_statements.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_statements' AND column_name='ledger_book_id') THEN RAISE EXCEPTION 'FAIL: bank_statements.ledger_book_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_transactions' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: bank_transactions.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='qb_transactions' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: qb_transactions.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='qb_transactions' AND column_name='ledger_book_id') THEN RAISE EXCEPTION 'FAIL: qb_transactions.ledger_book_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_matches' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: reconciliation_matches.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_reports' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: reconciliation_reports.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_decisions' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: reconciliation_decisions.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='client_entity_id') THEN RAISE EXCEPTION 'FAIL: reconciliation_audit_log.client_entity_id'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='user_id') THEN RAISE EXCEPTION 'FAIL: reconciliation_audit_log.user_id'; END IF;
  RAISE NOTICE 'Z1: PASS - all 10 columns exist';

  RAISE NOTICE 'Z5: checking FKs...';
  FOREACH tbl IN ARRAY ARRAY['fk_bank_transactions_statement_client','fk_bank_statements_ledger_client','fk_bank_statements_client','fk_qb_transactions_ledger_client','fk_qb_transactions_client','fk_matches_statement_client','fk_matches_bank_txn_client','fk_matches_statement_bank_txn','fk_reports_statement_client','fk_decisions_statement_client']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name=tbl AND constraint_schema='public') THEN RAISE EXCEPTION 'FAIL: missing FK %', tbl; END IF;
  END LOOP;
  RAISE NOTICE 'Z5: PASS - all 10 composite FKs exist';

  RAISE NOTICE 'Z6: checking audit redesign...';
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='reconciliation_match_id') <> 'YES'
    THEN RAISE EXCEPTION 'FAIL: match_id not nullable'; END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_audit_log' AND column_name='user_id') <> 'NO'
    THEN RAISE EXCEPTION 'FAIL: user_id not NOT NULL'; END IF;
  IF (SELECT delete_rule FROM information_schema.referential_constraints WHERE constraint_name='fk_audit_log_user' AND constraint_schema='public') <> 'RESTRICT'
    THEN RAISE EXCEPTION 'FAIL: user_id FK not RESTRICT'; END IF;
  RAISE NOTICE 'Z6: PASS - nullable, not null, restrict';

  RAISE NOTICE 'Z8: checking write guards...';
  FOREACH tbl IN ARRAY ARRAY['bank_statements','qb_transactions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='write_guard_root_stamp' AND event_object_table=tbl AND trigger_schema='public')
      THEN RAISE EXCEPTION 'FAIL: missing root guard on %', tbl; END IF;
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['bank_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='write_guard_client_stamp' AND event_object_table=tbl AND trigger_schema='public')
      THEN RAISE EXCEPTION 'FAIL: missing child guard on %', tbl; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='audit_log_write_guard' AND event_object_table='reconciliation_audit_log' AND trigger_schema='public')
    THEN RAISE EXCEPTION 'FAIL: missing audit guard'; END IF;
  RAISE NOTICE 'Z8: PASS - all 7 write guards present';

  RAISE NOTICE 'Z9: checking immutability triggers...';
  FOREACH tbl IN ARRAY ARRAY['bank_statements','bank_transactions','qb_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='client_stamp_immutable' AND event_object_table=tbl AND trigger_schema='public')
      THEN RAISE EXCEPTION 'FAIL: missing client immut on %', tbl; END IF;
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['bank_statements','qb_transactions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='ledger_book_id_immutable' AND event_object_table=tbl AND trigger_schema='public')
      THEN RAISE EXCEPTION 'FAIL: missing ledger immut on %', tbl; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='audit_log_evidence_immutable' AND trigger_schema='public')
    THEN RAISE EXCEPTION 'FAIL: missing evidence immut'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='audit_log_no_delete' AND trigger_schema='public')
    THEN RAISE EXCEPTION 'FAIL: missing no-delete'; END IF;
  RAISE NOTICE 'Z9: PASS - all 10 immutability triggers present';

  RAISE NOTICE 'Z12: checking audit ACL...';
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name='reconciliation_audit_log' AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE'))
    THEN RAISE EXCEPTION 'FAIL: authenticated has DML on audit_log'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_name='reconciliation_audit_log' AND grantee='anon')
    THEN RAISE EXCEPTION 'FAIL: anon has privileges on audit_log'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='Users can read their own audit log' AND tablename='reconciliation_audit_log')
    THEN RAISE EXCEPTION 'FAIL: SELECT policy missing'; END IF;
  RAISE NOTICE 'Z12: PASS - DML revoked, anon blocked, SELECT policy present';

  RAISE NOTICE 'Z10: checking RPCs...';
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='canonical_default_tenant_context_for_self_v1' AND routine_schema='public') THEN RAISE EXCEPTION 'FAIL: self-context RPC'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='canonical_default_tenant_ids_v1' AND routine_schema='public') THEN RAISE EXCEPTION 'FAIL: ids helper RPC'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='ingest_bank_statement_v1' AND routine_schema='public') THEN RAISE EXCEPTION 'FAIL: bank ingestion RPC'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='ingest_accounting_transactions_v1' AND routine_schema='public') THEN RAISE EXCEPTION 'FAIL: accounting RPC'; END IF;
  RAISE NOTICE 'Z10: PASS - all 4 RPCs present';

  RAISE NOTICE 'Z7: checking QB guard...';
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='match_qb_same_client_v1' AND routine_schema='public') THEN RAISE EXCEPTION 'FAIL: QB fn'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='match_qb_same_client_check' AND trigger_schema='public') THEN RAISE EXCEPTION 'FAIL: QB trigger'; END IF;
  RAISE NOTICE 'Z7: PASS - QB same-client guard present';

  RAISE NOTICE 'ALL STRUCTURAL TESTS PASSED';
END;
$$;
