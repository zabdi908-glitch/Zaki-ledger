-- Read-only: canonical_audit_ledger column list.
SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS cols
FROM information_schema.columns
WHERE table_schema='public' AND table_name='canonical_audit_ledger';
