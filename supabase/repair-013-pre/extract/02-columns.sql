SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'reconciliation_matches',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_matches'),
  'qb_transactions',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='qb_transactions'),
  'bank_transactions',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_transactions'),
  'bank_statements',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='bank_statements'),
  'reconciliation_audit_log',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_audit_log'),
  'financial_relationships',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_relationships'),
  'financial_allocations',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_allocations')
) AS result;
