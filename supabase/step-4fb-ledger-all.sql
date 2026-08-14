SELECT string_agg(version, ',' ORDER BY version) AS versions FROM supabase_migrations.schema_migrations;
