-- Read-only: must be 0 immediately before 012 apply.
SELECT count(*)::text AS ledger_012_rows FROM supabase_migrations.schema_migrations WHERE version = '012';
