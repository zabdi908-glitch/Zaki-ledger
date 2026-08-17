SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'legacy_record_mappings',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='legacy_record_mappings'),
  'financial_observation_links',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_observation_links'),
  'financial_events',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_events'),
  'financial_event_observation_links',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_event_observation_links'),
  'financial_event_fact_resolutions',(SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_event_fact_resolutions')
) AS result;
