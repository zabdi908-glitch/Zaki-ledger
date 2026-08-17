SET default_transaction_read_only = on;
SELECT 'identity' AS k,
  current_database() AS db,
  inet_server_addr()::text AS server_addr,
  version() AS pg_version,
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('001','002','003','004','005','006','007','008','009','010','011','012','013')) AS ledger_rows_001_013;
