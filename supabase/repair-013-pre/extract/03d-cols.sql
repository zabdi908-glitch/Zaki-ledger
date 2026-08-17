SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'legacy_record_mappings',(SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='legacy_record_mappings'),
  'legacy_record_types',(SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='legacy_record_types'),
  'financial_observation_links',(SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_observation_links'),
  'reconciliation_reports',(SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='reconciliation_reports'),
  'financial_observation_revisions',(SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_observation_revisions')
) AS result;
