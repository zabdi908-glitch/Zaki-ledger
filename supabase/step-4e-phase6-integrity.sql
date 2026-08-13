-- Step 4E Phase 6: post-012 data integrity on staging (read-only).
\set ON_ERROR_STOP on

-- A. Canonical backfill correctness
SELECT '== P6 bs_stamp_matches_registry' AS k, count(*)::text AS v FROM public.bank_statements AS bs
JOIN public.default_tenant_identities AS reg ON reg.user_id = bs.user_id
WHERE bs.client_entity_id IS DISTINCT FROM reg.client_entity_id
   OR bs.ledger_book_id IS DISTINCT FROM reg.internal_ledger_book_id;

SELECT '== P6 bs_null_stamps' AS k, count(*)::text AS v FROM public.bank_statements
WHERE client_entity_id IS NULL OR ledger_book_id IS NULL;

SELECT '== P6 qt_stamp_matches_registry' AS k, count(*)::text AS v FROM public.qb_transactions AS qt
JOIN public.default_tenant_identities AS reg ON reg.user_id = qt.user_id
WHERE qt.client_entity_id IS DISTINCT FROM reg.client_entity_id
   OR qt.ledger_book_id IS DISTINCT FROM reg.internal_ledger_book_id;

SELECT '== P6 qt_null_stamps' AS k, count(*)::text AS v FROM public.qb_transactions
WHERE client_entity_id IS NULL OR ledger_book_id IS NULL;

SELECT '== P6 bt_inherit_mismatch' AS k, count(*)::text AS v FROM public.bank_transactions AS bt
JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
WHERE bt.client_entity_id IS DISTINCT FROM bs.client_entity_id;

SELECT '== P6 bt_null_stamps' AS k, count(*)::text AS v FROM public.bank_transactions WHERE client_entity_id IS NULL;

SELECT '== P6 rm_inherit_mismatch' AS k, count(*)::text AS v FROM public.reconciliation_matches AS rm
JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
WHERE rm.client_entity_id IS DISTINCT FROM bs.client_entity_id;

SELECT '== P6 rm_null_stamps' AS k, count(*)::text AS v FROM public.reconciliation_matches WHERE client_entity_id IS NULL;

SELECT '== P6 rr_inherit_mismatch' AS k, count(*)::text AS v FROM public.reconciliation_reports AS rr
JOIN public.bank_statements AS bs ON bs.id = rr.statement_id
WHERE rr.client_entity_id IS DISTINCT FROM bs.client_entity_id;

SELECT '== P6 rd_inherit_mismatch' AS k, count(*)::text AS v FROM public.reconciliation_decisions AS rd
JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
WHERE rd.client_entity_id IS DISTINCT FROM bs.client_entity_id;

SELECT '== P6 audit_null_user' AS k, count(*)::text AS v FROM public.reconciliation_audit_log WHERE user_id IS NULL;
SELECT '== P6 audit_null_client' AS k, count(*)::text AS v FROM public.reconciliation_audit_log WHERE client_entity_id IS NULL;

SELECT '== P6 audit_user_mismatch_vs_match' AS k, count(*)::text AS v FROM public.reconciliation_audit_log AS ral
JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
WHERE ral.user_id IS DISTINCT FROM rm.user_id;

SELECT '== P6 audit_client_mismatch_vs_match' AS k, count(*)::text AS v FROM public.reconciliation_audit_log AS ral
JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
WHERE ral.client_entity_id IS DISTINCT FROM rm.client_entity_id;

-- C. Bootstrap behavior: zero 012 bootstrap audit noise
SELECT '== P6 bootstrap_012_audit_rows' AS k, count(*)::text AS v FROM public.canonical_audit_ledger
WHERE metadata_redacted->>'bootstrap_version' = '012';

SELECT '== P6 audit_ledger_total' AS k, count(*)::text AS v FROM public.canonical_audit_ledger;

-- Guard objects exist
SELECT '== P6 write_guard_triggers' AS k, count(*)::text AS v FROM information_schema.triggers
WHERE trigger_name IN ('write_guard_root_stamp','write_guard_client_stamp','audit_log_write_guard')
  AND event_object_schema = 'public';

SELECT '== P6 immutability_triggers' AS k, count(*)::text AS v FROM information_schema.triggers
WHERE trigger_name IN ('client_stamp_immutable','ledger_book_id_immutable','audit_log_stamp_immutable','audit_log_evidence_immutable','audit_log_no_delete')
  AND event_object_schema = 'public';

SELECT '== P6 composite_fks' AS k, count(*)::text AS v FROM information_schema.table_constraints
WHERE constraint_schema = 'public' AND constraint_name IN
('fk_bank_transactions_statement_client','fk_bank_statements_ledger_client','fk_bank_statements_client',
 'fk_qb_transactions_ledger_client','fk_qb_transactions_client','fk_matches_statement_client',
 'fk_matches_bank_txn_client','fk_matches_statement_bank_txn','fk_reports_statement_client',
 'fk_decisions_statement_client','fk_audit_log_match','fk_audit_log_user');

-- Parent unique indexes
SELECT '== P6 parent_unique_indexes' AS k, count(*)::text AS v FROM pg_indexes
WHERE schemaname = 'public' AND indexname IN
('uk_bank_statements_id_client','uk_bank_transactions_id_client','uk_bank_transactions_statement_id','uk_qb_transactions_id_client');

-- Audit DML privileges revoked from authenticated
SELECT '== P6 audit_authenticated_dml_grants' AS k, count(*)::text AS v FROM information_schema.table_privileges
WHERE table_name = 'reconciliation_audit_log' AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');

-- Audit anon privileges
SELECT '== P6 audit_anon_grants' AS k, count(*)::text AS v FROM information_schema.table_privileges
WHERE table_name = 'reconciliation_audit_log' AND grantee = 'anon';
