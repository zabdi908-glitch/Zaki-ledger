SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'financial_relationship_endpoints',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_relationship_endpoints'),
  'financial_observations',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_observations'),
  'canonical_audit_ledger',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='canonical_audit_ledger'),
  'ledger_books',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='ledger_books'),
  'client_entities',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='client_entities'),
  'practices',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='practices')
) AS result;
