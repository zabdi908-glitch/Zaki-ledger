-- Read-only export of the stage-1 execution receipt (database-side
-- authorization root).
--
-- WHAT THIS IS: operator EVIDENCE ONLY. The immutable receipt ROW in
-- public.repair_stage1_receipt — written by stage 1 inside its own
-- transaction — is the authorization root; stage 2 validates that actual
-- row and independently recomputes the exact stage-1 state before any
-- stage-2 work. This export is never re-imported or trusted by any
-- artifact as an authorization.
--
-- Usage (rehearsal):
--   docker exec -i supabase_db_Zaki-ledger psql -X -q -A -t \
--     -v ON_ERROR_STOP=1 -U supabase_admin -d repair_drill \
--     -f extract/13-stage1-receipt.sql > artifacts/stage1-receipt-REHEARSAL-<sha12>.json
--
-- Usage (production, inside the authorized window, after stage-1 COMMIT):
--   psql -X -q -A -t -v ON_ERROR_STOP=1 "$PROD_CONN" \
--     -f extract/13-stage1-receipt.sql > <window-artifacts>/stage1-receipt-PRODUCTION-<sha12>.json
SET TIME ZONE 'UTC';
SELECT to_jsonb(r) AS receipt
FROM public.repair_stage1_receipt r;
