#!/usr/bin/env bash
# REHEARSAL-ONLY chain: freeze -> verify -> execute -> rerun for the repair
# stages, against the local scratch restore.
#
# Sequence: prep -> freeze+run stage 1 (apply) -> stage 1 rerun (no-op) ->
#           per-run rehearsal authorization manifest (fresh post-stage-1
#           timestamps) -> freeze+run stage 2 (apply) -> stage 2 rerun
#           (no-op) -> stage 1 after stage 2 (own-state no-op) -> final
#           state.
#
# MIGRATION 013 IS DELIBERATELY NOT CHAINED HERE. It is a separate,
# separately authorized operation; the rehearsal compatibility check lives
# in run-migration-013.sh and must be invoked explicitly.
#
# Mechanical rehearsal-only barriers (this script has NO production path):
#   - target must be a local docker container (name check);
#   - target database must be the scratch restore `repair_drill`;
#   - every executed artifact must be REHEARSAL-mode and SHA-verified
#     against its freeze record (enforced by run-stage.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$ROOT/bin/build_repair_package.py"
RUNNER="$ROOT/rehearsal/run-stage.sh"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
ARTIFACT_DIR="$ROOT/artifacts"
GEN_DIR="$ROOT/rehearsal/generated"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"
# Rehearsal dumps (explicit, never defaulted — blocker 8: no dated dump
# defaults anywhere; restore-scratch.sh requires both paths and the chain
# FAILS here if they are not supplied). Hashes are recorded in
# rehearsal/EVIDENCE.md.
SCHEMA_DUMP="${SCHEMA_DUMP:-}"
DATA_DUMP="${DATA_DUMP:-}"
[ -n "$SCHEMA_DUMP" ] && [ -n "$DATA_DUMP" ] \
  || { echo "error: this chain requires explicit SCHEMA_DUMP and DATA_DUMP env vars (no defaults — fresh dumps only)" >&2; exit 2; }
[ -f "$SCHEMA_DUMP" ] && [ -f "$DATA_DUMP" ] \
  || { echo "error: dump file not found (SCHEMA_DUMP=$SCHEMA_DUMP DATA_DUMP=$DATA_DUMP)" >&2; exit 2; }

# Rehearsal-only barrier at the entry point.
[ "$(docker inspect --format '{{.Name}}' "$CONTAINER" 2>/dev/null || true)" = "/$CONTAINER" ] \
  || { echo "error: $CONTAINER is not a local docker container — this chain is rehearsal-only" >&2; exit 2; }
[ "$DB" = "repair_drill" ] \
  || { echo "error: this chain is rehearsal-only and executes against the scratch restore database repair_drill (got $DB)" >&2; exit 2; }

if [ "${1:-}" = "--fresh" ]; then
  rm -f "$ARTIFACT_DIR"/14a-* "$ARTIFACT_DIR"/14b-* "$ARTIFACT_DIR"/freeze-* \
        "$ARTIFACT_DIR"/stage1-proof-* \
        "$ARTIFACT_DIR"/rehearsal-authorization-manifest-* \
        "$GEN_DIR"/*.json "$GEN_DIR"/*.log
fi

mkdir -p "$ARTIFACT_DIR" "$GEN_DIR" "$LOG_DIR"
PSQL="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

echo "== fresh scratch restore =="
"$ROOT/rehearsal/restore-scratch.sh" \
  --schema-dump "$SCHEMA_DUMP" --data-dump "$DATA_DUMP" >/dev/null

echo "== restore parity =="
$PSQL < "$ROOT/rehearsal/parity-check.sql" | tee "$LOG_DIR/00-parity.log"

echo "== prep =="
$PSQL < "$ROOT/13-repair-prep.sql" | tee "$LOG_DIR/01-prep.log"

echo "== freeze stage 1 (REHEARSAL) =="
python3 "$BUILDER" freeze --stage 1 --environment-mode REHEARSAL --out-dir "$ARTIFACT_DIR"
STAGE1_ARTIFACT="$ARTIFACT_DIR/$(python3 - "$ARTIFACT_DIR" <<'PY'
import json, glob, sys, os
records = sorted(glob.glob(os.path.join(sys.argv[1], "freeze-14a-*.json")))
if not records:
    raise SystemExit("no stage-1 freeze record found")
print(json.load(open(records[-1]))["artifact_file"])
PY
)"
STAGE1_RECORD="$ARTIFACT_DIR/freeze-$(basename "$STAGE1_ARTIFACT" .sql).json"
python3 "$BUILDER" verify --artifact "$STAGE1_RECORD"

echo "== stage 1 apply =="
"$RUNNER" --stage 1 --artifact "$STAGE1_ARTIFACT" --freeze-record "$STAGE1_RECORD" --expect apply

echo "== stage 1 rerun (expect no-op) =="
"$RUNNER" --stage 1 --artifact "$STAGE1_ARTIFACT" --freeze-record "$STAGE1_RECORD" --expect noop

STAGE1_PROOF="$ARTIFACT_DIR/$(ls "$ARTIFACT_DIR" | grep '^stage1-proof-REHEARSAL-' | sort | tail -1)"
[ -n "$STAGE1_PROOF" ] && [ -f "$STAGE1_PROOF" ] \
  || { echo "error: stage-1 execution proof missing after stage 1" >&2; exit 1; }

# STAGE-1 CHECKPOINT. The stage-2 authorization manifest is created only
# now, stamped with a confirmation timestamp AFTER the recorded stage-1
# execution — the freeze below enforces the ordering. The executed manifest
# is committed under artifacts/ as part of the rehearsal evidence.
echo "== authorization checkpoint: sign the rehearsal stage-2 manifest =="
CONFIRM_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REHEARSAL_MANIFEST="$ARTIFACT_DIR/rehearsal-authorization-manifest-${CONFIRM_TS}.json"
python3 "$BUILDER" rehearsal-manifest \
  --confirmation-timestamp "$CONFIRM_TS" \
  --out "$REHEARSAL_MANIFEST"

echo "== freeze stage 2 (REHEARSAL, post-stage-1) =="
python3 "$BUILDER" freeze --stage 2 --environment-mode REHEARSAL \
  --auth-manifest "$REHEARSAL_MANIFEST" \
  --stage1-artifact "$STAGE1_ARTIFACT" \
  --stage1-execution-proof "$STAGE1_PROOF" \
  --out-dir "$ARTIFACT_DIR"
STAGE2_ARTIFACT="$ARTIFACT_DIR/$(python3 - "$ARTIFACT_DIR" <<'PY'
import json, glob, sys, os
records = sorted(glob.glob(os.path.join(sys.argv[1], "freeze-14b-*.json")))
if not records:
    raise SystemExit("no stage-2 freeze record found")
print(json.load(open(records[-1]))["artifact_file"])
PY
)"
STAGE2_RECORD="$ARTIFACT_DIR/freeze-$(basename "$STAGE2_ARTIFACT" .sql).json"
# Independent verification with full regeneration: expected stage-2 bytes
# are rebuilt from the committed basis + authorization manifest + stage-1
# proof in a temporary location and must be byte-identical to the frozen
# artifact (blocker 3).
python3 "$BUILDER" verify --artifact "$STAGE2_RECORD" \
  --stage1-artifact "$STAGE1_ARTIFACT" \
  --auth-manifest "$REHEARSAL_MANIFEST" \
  --stage1-execution-proof "$STAGE1_PROOF"

echo "== stage 2 apply (rehearsal authorization manifest) =="
"$RUNNER" --stage 2 --artifact "$STAGE2_ARTIFACT" --freeze-record "$STAGE2_RECORD" \
  --stage1-proof "$STAGE1_PROOF" --expect apply

echo "== stage 2 rerun (expect no-op) =="
"$RUNNER" --stage 2 --artifact "$STAGE2_ARTIFACT" --freeze-record "$STAGE2_RECORD" \
  --stage1-proof "$STAGE1_PROOF" --expect noop

echo "== stage 1 after stage 2 (expect own-state no-op) =="
"$RUNNER" --stage 1 --artifact "$STAGE1_ARTIFACT" --freeze-record "$STAGE1_RECORD" --expect noop

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

echo "rehearsal chain complete (migration 013 NOT included — run rehearsal/run-migration-013.sh explicitly)"
