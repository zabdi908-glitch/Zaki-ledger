#!/usr/bin/env bash
# Hash-verified frozen-artifact stage runner (rehearsal only).
#
# Executes ONLY a frozen stage artifact whose SHA-256 matches its freeze
# record and whose environment-mode gate is REHEARSAL. This is the same
# discipline the production runbook applies to PRODUCTION artifacts; the
# rehearsal driver additionally hard-pins the target to the scratch
# restore database.
#
# Usage:
#   run-stage.sh --stage 1|2 --artifact <frozen.sql> --freeze-record <freeze.json> \
#                [--expect apply|noop] [--stage1-proof <proof.json> (stage 2)]
#
# Stage 1 writes its execution proof to artifacts/stage1-proof-<sha8>.json
# (artifact sha + executed_at + result + log sha) — the stage-2 freeze
# requires it, so stage-2 authorization is mechanically post-stage-1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
GEN_DIR="${GEN_DIR:-$ROOT/rehearsal/generated}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/artifacts}"

STAGE=""; ARTIFACT=""; FREEZE_RECORD=""; EXPECT="apply"; STAGE1_PROOF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2;;
    --artifact) ARTIFACT="$2"; shift 2;;
    --freeze-record) FREEZE_RECORD="$2"; shift 2;;
    --expect) EXPECT="$2"; shift 2;;
    --stage1-proof) STAGE1_PROOF="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

[ -n "$STAGE" ] && [ -n "$ARTIFACT" ] && [ -n "$FREEZE_RECORD" ] \
  || { echo "usage: $0 --stage 1|2 --artifact <sql> --freeze-record <json> [--expect apply|noop] [--stage1-proof <json>]" >&2; exit 2; }
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

if [ "$STAGE" = "2" ]; then
  [ -n "$STAGE1_PROOF" ] && [ -f "$STAGE1_PROOF" ] \
    || { echo "error: stage 2 requires --stage1-proof <proof.json> (post-stage-1 authorization)" >&2; exit 2; }
  PROOF_ARTIFACT_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['artifact_sha256'])" "$STAGE1_PROOF")"
  RECORD_STAGE1_SHA="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['stage1_artifact_sha256'])" "$FREEZE_RECORD")"
  [ "$PROOF_ARTIFACT_SHA" = "$RECORD_STAGE1_SHA" ] \
    || { echo "error: stage-1 proof artifact sha $PROOF_ARTIFACT_SHA does not match the freeze record stage-1 artifact $RECORD_STAGE1_SHA" >&2; exit 2; }
fi

mkdir -p "$GEN_DIR"
LOG="$GEN_DIR/run-stage${STAGE}-$(basename "$ARTIFACT" .sql)-${EXPECT}.log"
PSQL="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

echo "== stage $STAGE ($EXPECT) =="
echo "artifact:  $(basename "$ARTIFACT")  sha256=$ARTIFACT_SHA"
$PSQL < "$ARTIFACT" 2>&1 | tee "$LOG"

if [ "$EXPECT" = "apply" ]; then
  grep -q "superseded .* rows" "$LOG" || { echo "FAIL: stage $STAGE did not apply" >&2; exit 1; }
else
  grep -q "ALREADY APPLIED" "$LOG" || { echo "FAIL: stage $STAGE did not verify as a no-op" >&2; exit 1; }
fi

if [ "$STAGE" = "1" ] && [ "$EXPECT" = "apply" ]; then
  PROOF="$ARTIFACT_DIR/stage1-proof-REHEARSAL-${ARTIFACT_SHA:0:12}.json"
  RESULT="APPLIED"
  [ "$EXPECT" = "noop" ] && RESULT="NOOP"
  EXECUTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$PROOF" "$ARTIFACT" "$ARTIFACT_SHA" "$EXECUTED_AT" "$RESULT" "$LOG" <<'PY'
import json, hashlib, sys
proof_path, artifact, artifact_sha, executed_at, result, log_path = sys.argv[1:]
log_sha = hashlib.sha256(open(log_path, "rb").read()).hexdigest()
doc = {
    "package": "repair-013-pre",
    "proof_schema_version": 1,
    "stage": 1,
    "artifact_file": artifact.split("/")[-1],
    "artifact_sha256": artifact_sha,
    "environment_mode": "REHEARSAL",
    "database": "repair_drill",
    "executed_at": executed_at,
    "result": result,
    "log_file": log_path.split("/")[-1],
    "log_sha256": log_sha,
}
with open(proof_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(f"stage-1 execution proof: {proof_path}")
PY
fi

echo "stage $STAGE ($EXPECT) complete"
