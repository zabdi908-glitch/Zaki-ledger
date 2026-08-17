#!/usr/bin/env bash
# Hash-verified frozen-artifact stage runner (rehearsal only).
#
# Executes ONLY a frozen stage artifact whose SHA-256 matches its freeze
# record and whose environment-mode gate is REHEARSAL. This is the same
# discipline the production runbook applies to PRODUCTION artifacts; the
# rehearsal driver additionally hard-pins the target to the scratch
# restore database.
#
# The verified artifact sha256 AND the EXECUTION_PACKAGE_SHA256 are passed
# into the repair transaction via PGOPTIONS (zaki.repair_artifact_sha256 /
# zaki.repair_package_sha256) so they are recorded verbatim into the
# immutable audit evidence and gate-checked in SQL — the artifact itself
# cannot know its own file hash at build time (self-reference), so the
# driver is the binding mechanism, and the SQL gates refuse a missing/
# mismatched value.
#
# Stage 1 apply EXPORTS the database-side execution receipt written by the
# artifact inside its own transaction (extract/13-stage1-receipt.sql) to
# artifacts/stage1-receipt-REHEARSAL-<sha12>.json. That export is OPERATOR
# EVIDENCE ONLY — the immutable receipt ROW is the authorization root the
# stage-2 artifact validates at execution; the stage-2 freeze cross-checks
# the export's derivable fields.
#
# Usage:
#   run-stage.sh --stage 1|2 --artifact <frozen.sql> --freeze-record <freeze.json> \
#                [--expect apply|noop] [--stage1-receipt <receipt.json> (stage 2)]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$ROOT/bin/build_repair_package.py"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
GEN_DIR="${GEN_DIR:-$ROOT/rehearsal/generated}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/artifacts}"

STAGE=""; ARTIFACT=""; FREEZE_RECORD=""; EXPECT="apply"; STAGE1_RECEIPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2;;
    --artifact) ARTIFACT="$2"; shift 2;;
    --freeze-record) FREEZE_RECORD="$2"; shift 2;;
    --expect) EXPECT="$2"; shift 2;;
    --stage1-receipt) STAGE1_RECEIPT="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

[ -n "$STAGE" ] && [ -n "$ARTIFACT" ] && [ -n "$FREEZE_RECORD" ] \
  || { echo "usage: $0 --stage 1|2 --artifact <sql> --freeze-record <json> [--expect apply|noop] [--stage1-receipt <json>]" >&2; exit 2; }
[ -f "$ARTIFACT" ] || { echo "error: artifact not found: $ARTIFACT" >&2; exit 2; }
[ -f "$FREEZE_RECORD" ] || { echo "error: freeze record not found: $FREEZE_RECORD" >&2; exit 2; }

# Rehearsal-only mechanical barrier: the target must be the scratch restore
# inside the local container. There is no production path through this
# driver.
[ "$(docker inspect --format '{{.Name}}' "$CONTAINER" 2>/dev/null || true)" = "/$CONTAINER" ] \
  || { echo "error: container $CONTAINER is not a local docker container — this driver is rehearsal-only" >&2; exit 2; }
[ "$DB" = "repair_drill" ] \
  || { echo "error: this driver executes REHEARSAL artifacts only against the scratch restore database repair_drill (got $DB)" >&2; exit 2; }

RECORD_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['artifact_sha256'])" "$FREEZE_RECORD")"
ARTIFACT_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[ "$ARTIFACT_SHA" = "$RECORD_SHA" ] \
  || { echo "error: artifact sha256 $ARTIFACT_SHA does not match freeze record $RECORD_SHA" >&2; exit 2; }

RECORD_MODE="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['environment_mode'])" "$FREEZE_RECORD")"
[ "$RECORD_MODE" = "REHEARSAL" ] \
  || { echo "error: freeze record mode is $RECORD_MODE — this driver is rehearsal-only" >&2; exit 2; }

grep -q "REHEARSAL artifact refuses database identity" "$ARTIFACT" \
  || { echo "error: artifact does not carry the REHEARSAL identity gate" >&2; exit 2; }

# The stable execution-package sha of the checked-out package, passed via
# PGOPTIONS and gate-checked against the literal embedded in the artifact.
PACKAGE_SHA="$(python3 - "$BUILDER" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("build_repair_package", sys.argv[1])
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
print(bp.execution_package_sha256())
PY
)"
RECORD_PACKAGE_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['execution_package_sha256'])" "$FREEZE_RECORD")"
[ "$PACKAGE_SHA" = "$RECORD_PACKAGE_SHA" ] \
  || { echo "error: checked-out EXECUTION_PACKAGE_SHA256 $PACKAGE_SHA does not match freeze record $RECORD_PACKAGE_SHA — wrong package state" >&2; exit 2; }
grep -q "$PACKAGE_SHA" "$ARTIFACT" \
  || { echo "error: artifact does not embed the checked-out EXECUTION_PACKAGE_SHA256" >&2; exit 2; }

if [ "$STAGE" = "2" ]; then
  [ -n "$STAGE1_RECEIPT" ] && [ -f "$STAGE1_RECEIPT" ] \
    || { echo "error: stage 2 requires --stage1-receipt <receipt-export.json> (post-stage-1 database checkpoint; a caller-created stage-1 proof JSON is not an authorization root)" >&2; exit 2; }
  RECEIPT_ARTIFACT_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['artifact_sha256'])" "$STAGE1_RECEIPT")"
  RECORD_STAGE1_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['stage1_artifact_sha256'])" "$FREEZE_RECORD")"
  [ "$RECEIPT_ARTIFACT_SHA" = "$RECORD_STAGE1_SHA" ] \
    || { echo "error: stage-1 receipt artifact sha $RECEIPT_ARTIFACT_SHA does not match the freeze record stage-1 artifact $RECORD_STAGE1_SHA" >&2; exit 2; }
fi

mkdir -p "$GEN_DIR"
LOG="$GEN_DIR/run-stage${STAGE}-$(basename "$ARTIFACT" .sql)-${EXPECT}.log"

# Driver-side bindings: the verified artifact sha AND the execution-package
# sha go in via PGOPTIONS (libpq startup packet -> server-side SET), which
# the repair transaction records into the immutable audit evidence and
# gate-checks in SQL.
run_artifact() {
  docker exec -e "PGOPTIONS=-czaki.repair_artifact_sha256=$ARTIFACT_SHA -czaki.repair_package_sha256=$PACKAGE_SHA" \
    -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U supabase_admin -d "$DB"
}

echo "== stage $STAGE ($EXPECT) =="
echo "artifact:  $(basename "$ARTIFACT")  sha256=$ARTIFACT_SHA"
echo "package:   $PACKAGE_SHA"
run_artifact < "$ARTIFACT" 2>&1 | tee "$LOG"

if [ "$EXPECT" = "apply" ]; then
  grep -q "superseded .* rows" "$LOG" || { echo "FAIL: stage $STAGE did not apply" >&2; exit 1; }
else
  grep -q "ALREADY APPLIED" "$LOG" || { echo "FAIL: stage $STAGE did not verify as a no-op" >&2; exit 1; }
fi

if [ "$STAGE" = "1" ] && [ "$EXPECT" = "apply" ]; then
  # Export the database-side stage-1 execution receipt written by the
  # artifact INSIDE ITS OWN TRANSACTION (the stage-2 authorization root).
  # The export is operator evidence only; the stage-2 freeze revalidates
  # its derivable fields and the stage-2 artifact revalidates the actual
  # DB row + live state before any stage-2 work.
  RECEIPT="$ARTIFACT_DIR/stage1-receipt-REHEARSAL-${ARTIFACT_SHA:0:12}.json"
  docker exec -i "$CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 \
    -U supabase_admin -d "$DB" \
    < "$ROOT/extract/13-stage1-receipt.sql" > "$RECEIPT"
  python3 - "$RECEIPT" "$ARTIFACT_SHA" <<'PY'
import json, sys
rec = json.load(open(sys.argv[1], encoding="utf-8"))
assert rec.get("artifact_sha256") == sys.argv[2], "receipt export artifact sha mismatch"
assert rec.get("receipt_sha256"), "receipt export lacks canonical hash"
print(f"exported stage-1 execution receipt (canonical {rec['receipt_sha256'][:16]}…)")
PY
fi

echo "stage $STAGE ($EXPECT) complete"
