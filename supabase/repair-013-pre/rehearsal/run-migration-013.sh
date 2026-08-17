#!/usr/bin/env bash
# REHEARSAL-ONLY migration-013 compatibility check on the repaired scratch
# copy. NOT part of the repair chain: migration 013 application to
# production is a separately authorized future operation, and this script
# deliberately never chains with the repair stages.
#
# Mechanical rehearsal-only barriers: local docker container + scratch
# database repair_drill only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS="$(cd "$ROOT/../migrations" && pwd)"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"

[ "$(docker inspect --format '{{.Name}}' "$CONTAINER" 2>/dev/null || true)" = "/$CONTAINER" ] \
  || { echo "error: $CONTAINER is not a local docker container — this script is rehearsal-only" >&2; exit 2; }
[ "$DB" = "repair_drill" ] \
  || { echo "error: this script is rehearsal-only and executes against repair_drill (got $DB)" >&2; exit 2; }

mkdir -p "$LOG_DIR"
PSQL="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

echo "== migration 013 post-repair compatibility (rehearsal-only) =="
$PSQL < "$MIGRATIONS/013_reconciliation_claim_hardening.sql" | tee "$LOG_DIR/09-migration-013.log"

echo "== post-013 invariants =="
$PSQL <<'SQL' | tee "$LOG_DIR/10-post-013-state.log"
SELECT (SELECT count(*) FROM public.reconciliation_matches)            AS total_matches,
       (SELECT count(*) FROM public.reconciliation_matches
        WHERE superseded_at IS NOT NULL)                               AS superseded,
       (SELECT count(*) FROM (
          SELECT qb_transaction_id FROM public.reconciliation_matches
          WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL
          GROUP BY qb_transaction_id HAVING count(*) > 1) d)           AS duplicate_live_auto_endpoints;
SQL

echo "migration 013 rehearsal check complete"
