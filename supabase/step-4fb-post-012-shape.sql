-- Read-only: prove Migration 012 committed (canonical columns + constraints exist).
SELECT string_agg(table_name || '(' || column_name || ')', ', ' ORDER BY table_name, column_name) AS canonical_columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('bank_statements','bank_transactions','qb_transactions',
                     'reconciliation_matches','reconciliation_reports',
                     'reconciliation_decisions','reconciliation_audit_log')
  AND column_name IN ('client_entity_id','ledger_book_id');
