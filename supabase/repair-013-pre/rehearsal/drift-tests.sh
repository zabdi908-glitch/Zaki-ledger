#!/usr/bin/env bash
# Drift / failure-injection rehearsal: five deliberate mutations of the
# scratch snapshot, each followed by a stage-1 run of the FROZEN,
# SHA-verified REHEARSAL artifact that MUST abort with zero partial changes
# (single-transaction rollback).
#
# Cases (spec: Phase 14 failure/drift tests):
#   1. change one target approval
#   2. change amount
#   3. substitute match (repoint a target's QB endpoint)
#   4. create unexpected duplicate endpoint
#   5. change survivor
#
# Each case: fresh restore -> prep -> inject -> capture FULL-STATE digest ->
# stage 1 (expect abort) -> capture digest again -> digests must be equal
# (blocker 6: full state preservation, not just repair row counts).
# Evidence tee'd to $LOG_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$ROOT/bin/build_repair_package.py"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
ARTIFACT_DIR="$ROOT/artifacts/drift-tests"   # private to this test run
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"
RESTORE="$ROOT/rehearsal/restore-scratch.sh"
DIGEST="$ROOT/rehearsal/state-digest.sh"
# No dated dump defaults (blocker 8): the driver must be pointed at the
# explicit dump files to restore — omitted env vars FAIL, never silently
# substitute an old snapshot.
SCHEMA_DUMP="${SCHEMA_DUMP:-}"
DATA_DUMP="${DATA_DUMP:-}"
[ -n "$SCHEMA_DUMP" ] && [ -n "$DATA_DUMP" ] \
  || { echo "error: this driver requires explicit SCHEMA_DUMP and DATA_DUMP env vars (no defaults — fresh dumps only)" >&2; exit 2; }
[ -f "$SCHEMA_DUMP" ] && [ -f "$DATA_DUMP" ] \
  || { echo "error: dump file not found (SCHEMA_DUMP=$SCHEMA_DUMP DATA_DUMP=$DATA_DUMP)" >&2; exit 2; }

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR" "$LOG_DIR"
PSQL="docker exec -i $CONTAINER psql -U supabase_admin -d $DB"
PSQL_STRICT="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

# Freeze + verify the REHEARSAL stage-1 artifact once; every case executes
# exactly these bytes.
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
STAGE1_SHA="$(sha256sum "$STAGE1_ARTIFACT" | awk '{print $1}')"
# The execution driver's GUCs (artifact sha recorded into the audit
# evidence, package sha gate-checked against the embedded literal; the
# gates abort if missing/mismatched).
PACKAGE_SHA="$(python3 - "$BUILDER" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("build_repair_package", sys.argv[1])
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
print(bp.execution_package_sha256())
PY
)"
GUC="-czaki.repair_artifact_sha256=$STAGE1_SHA -czaki.repair_package_sha256=$PACKAGE_SHA"

# Fixed targets (from manifests/stage1-unapproved-targets.csv, first row):
#   target 00d77a13-2a24-4fb9-a760-70761628a85c  (R3 unapproved)
#     qb 027cdfa7-f24c-4e52-ab03-6b78490687a0
#     bank b90f8b9a-95d6-4ff3-9379-f3ed35da8df4
#     survivor c3a2addf-4c52-406c-bcc4-f336d6f223f8
#   another QB of the same user/client/book: 130b21ed-869f-4485-8732-186c9f166d12
#   smoke endpoint with exactly one live-auto row (new-endpoint injection):
#     qb 67151ef0-0538-4cae-aea0-4239f1386dba
#     bank d557285e-4b68-4cad-bed0-eec1d22ea46c  stmt cae8cc48-266c-4073-a6df-275f297d6bad
TARGET="00d77a13-2a24-4fb9-a760-70761628a85c"
TARGET_BANK="b90f8b9a-95d6-4ff3-9379-f3ed35da8df4"
TARGET_SURVIVOR="c3a2addf-4c52-406c-bcc4-f336d6f223f8"
OTHER_QB="130b21ed-869f-4485-8732-186c9f166d12"
SMOKE_QB="67151ef0-0538-4cae-aea0-4239f1386dba"
SMOKE_BANK="d557285e-4b68-4cad-bed0-eec1d22ea46c"
SMOKE_STMT="cae8cc48-266c-4073-a6df-275f297d6bad"

run_case() {
  local name="$1"
  local inject="$2"
  echo "=== drift case: $name ==="
  "$RESTORE" --schema-dump "$SCHEMA_DUMP" --data-dump "$DATA_DUMP" >/dev/null
  $PSQL_STRICT < "$ROOT/13-repair-prep.sql" >/dev/null
  echo "injecting: $name"
  $PSQL_STRICT <<SQL >/dev/null
BEGIN;
$inject
COMMIT;
SQL

  # FULL-STATE digest AFTER injection, BEFORE the repair attempt.
  local before after
  before="$("$DIGEST")"

  # Stage 1 must abort. psql's exit status does NOT reflect SQL errors
  # without ON_ERROR_STOP, so the abort is detected from the diagnosis
  # output (every fail-closed precondition raises a STOP/FAIL exception)
  # and proven by the full-state digest equality below.
  local out
  out=$(docker exec -e "PGOPTIONS=$GUC" -i "$CONTAINER" psql -U supabase_admin -d "$DB" \
    < "$STAGE1_ARTIFACT" 2>&1) || true
  echo "$out" | tee "$LOG_DIR/drift-$name.log"
  if echo "$out" | grep -q "STAGE 1: superseded 154 rows"; then
    echo "FAIL: stage 1 applied despite the injection ($name)"
    exit 1
  fi
  if ! echo "$out" | grep -qE "STOP|FAIL"; then
    echo "FAIL: stage 1 did not abort after injection ($name)"
    exit 1
  fi

  # FULL-STATE preservation: the repair must have written nothing anywhere
  # (all 11 tables digest-identical, including the injected state).
  after="$("$DIGEST")"
  if [ "$before" != "$after" ]; then
    echo "FAIL: full-state digest changed after abort ($name)"
    echo "before: $before"
    echo "after:  $after"
    exit 1
  fi
  echo "PASS: $name aborted with zero partial changes (full-state digest identical)"
  echo
}

run_case "01-approval-change" "UPDATE public.reconciliation_matches SET approved_at = now(), approved_by = 'drift-injection' WHERE id = '$TARGET';"

run_case "02-amount-change" "UPDATE public.bank_transactions SET amount = amount + 1 WHERE id = '$TARGET_BANK';"

run_case "03-substituted-match" "UPDATE public.reconciliation_matches SET qb_transaction_id = '$OTHER_QB' WHERE id = '$TARGET';"

run_case "04-new-duplicate-endpoint" "INSERT INTO public.bank_transactions
  (id, statement_id, user_id, transaction_date, posted_date, merchant, description, amount, currency, transaction_id, memo, external_transaction_id, source_provider, source_organisation_id, source_account_id, identity_fingerprint, identity_fingerprint_version, client_entity_id)
  SELECT 'dddddddd-0000-4000-8000-0000000000e1', statement_id, user_id, transaction_date, posted_date, merchant, description, amount, currency, transaction_id, memo, external_transaction_id, source_provider, source_organisation_id, source_account_id, identity_fingerprint, identity_fingerprint_version, client_entity_id
  FROM public.bank_transactions WHERE id = '$SMOKE_BANK';
INSERT INTO public.reconciliation_matches
  (id, user_id, statement_id, bank_transaction_id, qb_transaction_id, confidence, match_reason, flagged_level, matched_by, matched_at, audit_memo, client_entity_id)
  SELECT 'dddddddd-0000-4000-8000-0000000000e2', m.user_id, m.statement_id, 'dddddddd-0000-4000-8000-0000000000e1', m.qb_transaction_id, m.confidence, 'drift-injection', 'red', 'auto', now(), NULL, m.client_entity_id
  FROM public.reconciliation_matches m
  WHERE m.qb_transaction_id = '$SMOKE_QB' AND m.statement_id = '$SMOKE_STMT'
  LIMIT 1;"

run_case "05-survivor-changed" "UPDATE public.reconciliation_matches SET superseded_at = now(), supersede_reason = 'drift-injection' WHERE id = '$TARGET_SURVIVOR';"

echo "ALL DRIFT CASES PASS"
