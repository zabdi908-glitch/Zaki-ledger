#!/usr/bin/env bash
# Stage replay driver against the scratch restore (rehearsal only).
#
# Sequence: prep -> stage 1 apply -> stage 1 rerun (no-op) ->
#           stage 2 apply (TEST manifest) -> stage 2 rerun (no-op) ->
#           stage 1 after stage 2 (own-state no-op) -> migration 013.
#
# Output is tee'd to $LOG_DIR for the evidence record. Any abort stops the
# chain (set -e + ON_ERROR_STOP), which is exactly the fail-closed behavior
# being rehearsed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$(cd "$ROOT/../migrations" && pwd)"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"

mkdir -p "$LOG_DIR"
PSQL="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

echo "== prep =="
$PSQL < "$ROOT/13-repair-prep.sql" | tee "$LOG_DIR/01-prep.log"

echo "== stage 1 apply =="
$PSQL < "$ROOT/14a-stage1-unapproved-repair.sql" | tee "$LOG_DIR/02-stage1-apply.log"

echo "== stage 1 rerun (expect no-op) =="
$PSQL < "$ROOT/14a-stage1-unapproved-repair.sql" | tee "$LOG_DIR/03-stage1-rerun.log"

echo "== stage 2 apply (TEST manifest) =="
$PSQL < "$ROOT/14b-stage2-approved-repair.sql" | tee "$LOG_DIR/04-stage2-apply.log"

echo "== stage 2 rerun (expect no-op) =="
$PSQL < "$ROOT/14b-stage2-approved-repair.sql" | tee "$LOG_DIR/05-stage2-rerun.log"

echo "== stage 1 after stage 2 (expect own-state no-op) =="
$PSQL < "$ROOT/14a-stage1-unapproved-repair.sql" | tee "$LOG_DIR/06-stage1-after-stage2.log"

echo "== migration 013 post-repair compatibility =="
$PSQL < "$MIGRATIONS/013_reconciliation_claim_hardening.sql" | tee "$LOG_DIR/07-migration-013.log"

echo "== final state =="
$PSQL <<'SQL' | tee "$LOG_DIR/08-final-state.log"
SELECT (SELECT count(*) FROM public.reconciliation_matches)            AS total_matches,
       (SELECT count(*) FROM public.reconciliation_matches
        WHERE superseded_at IS NOT NULL)                               AS superseded,
       (SELECT count(*) FROM public.reconciliation_matches
        WHERE superseded_at IS NULL)                                   AS live,
       (SELECT count(*) FROM (
          SELECT qb_transaction_id FROM public.reconciliation_matches
          WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
          GROUP BY qb_transaction_id HAVING count(*) > 1) d)           AS duplicate_live_auto_endpoints,
       (SELECT count(*) FROM public.reconciliation_audit_log
        WHERE action = 'match_repair_superseded')                      AS repair_audit_rows;
SQL

echo "rehearsal sequence complete"
