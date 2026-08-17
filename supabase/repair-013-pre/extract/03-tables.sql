SET default_transaction_read_only = on;
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
