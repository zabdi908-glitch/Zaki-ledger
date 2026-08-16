#!/usr/bin/env bash
# Drift / failure-injection rehearsal: five deliberate mutations of the
# scratch snapshot, each followed by a stage-1 run that MUST abort with zero
# partial changes (single-transaction rollback).
#
# Cases (spec: Phase 14 failure/drift tests):
#   1. change one target approval
#   2. change amount
#   3. substitute match (repoint a target's QB endpoint)
#   4. create unexpected duplicate endpoint
#   5. change survivor
#
# Each case: fresh restore -> prep -> inject -> stage 1 (expect abort) ->
# verify zero partial changes. Evidence tee'd to $LOG_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"
RESTORE="$ROOT/rehearsal/restore-scratch.sh"

mkdir -p "$LOG_DIR"
PSQL="docker exec -i $CONTAINER psql -U supabase_admin -d $DB"
PSQL_STRICT="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

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
  "$RESTORE" >/dev/null
  $PSQL_STRICT < "$ROOT/13-repair-prep.sql" >/dev/null
  echo "injecting: $name"
  $PSQL_STRICT <<SQL >/dev/null
BEGIN;
$inject
COMMIT;
SQL

  # Stage 1 must abort. psql's exit status does NOT reflect SQL errors
  # without ON_ERROR_STOP, so the abort is detected from the diagnosis
  # output (every fail-closed precondition raises a STOP/FAIL exception)
  # and proven by the zero-partial-change verification below.
  local out
  out=$($PSQL < "$ROOT/14a-stage1-unapproved-repair.sql" 2>&1) || true
  echo "$out" | tee "$LOG_DIR/drift-$name.log"
  if echo "$out" | grep -q "STAGE 1: superseded 154 rows"; then
    echo "FAIL: stage 1 applied despite the injection ($name)"
    exit 1
  fi
  if ! echo "$out" | grep -qE "STOP|FAIL"; then
    echo "FAIL: stage 1 did not abort after injection ($name)"
    exit 1
  fi

  # Zero partial changes: the repair must have written nothing.
  local superseded repair_audits
  superseded=$($PSQL_STRICT -tAc \
    "SELECT count(*) FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL AND supersede_operation_id = '0a1a1a01-4a5e-4b1a-8c01-013000000001'")
  repair_audits=$($PSQL_STRICT -tAc \
    "SELECT count(*) FROM public.reconciliation_audit_log WHERE action = 'match_repair_superseded'")
  if [ "$superseded" != "0" ] || [ "$repair_audits" != "0" ]; then
    echo "FAIL: partial changes detected after abort ($name): superseded=$superseded audit=$repair_audits"
    exit 1
  fi
  echo "PASS: $name aborted with zero partial changes"
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
