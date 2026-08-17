#!/usr/bin/env bash
# Authorization / identity / failure-substitution rehearsal (Phase 9,
# database-side cases). Each case restores a fresh scratch copy, injects a
# deliberate drift or substitution, and proves the frozen stage artifacts
# FAIL CLOSED with zero partial changes.
#
# Cases:
#   G1 practice_id drift (client_entities.practice_id repointed)
#   G2 client_entities row drift (tenant row archived)
#   G3 stage-1 target approved_by drift (approved_at stays NULL)
#   G4 stale supersession fields on a stage-1 target
#   G5 stage-2 rerun with an altered repair audit row (evidence mismatch
#      must ABORT, never no-op)
#   G6 partial stage-2 completion (row superseded, audit insert missing)
#   G7 partial stage-2 completion (row superseded + altered audit row)
#   G8 rehearsal artifact executed against a non-rehearsal database
#      identity (the local dev database `postgres`) — gate must abort
#   G9 production artifact executed against the wrong database identity
#      (scratch restore) — gate must abort
#
# All cases prove zero partial changes after the abort.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$ROOT/bin/build_repair_package.py"
RUNNER="$ROOT/rehearsal/run-stage.sh"
RESTORE="$ROOT/rehearsal/restore-scratch.sh"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
ARTIFACT_DIR="$ROOT/artifacts/auth-tests"   # private to this test run
GEN_DIR="$ROOT/rehearsal/generated"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"

PSQL="docker exec -i $CONTAINER psql -U supabase_admin -d $DB"
PSQL_STRICT="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

STAGE1_OP="0a1a1a01-4a5e-4b1a-8c01-013000000001"
STAGE2_OP="0a1a1a01-4a5e-4b1a-8c01-013000000002"

# Fixed ids (from the committed manifests / basis):
STAGE1_TARGET="00d77a13-2a24-4fb9-a760-70761628a85c"
TARGET_CLIENT="daa94c07-e040-4a68-9c2f-b7f1c57582c8"
S2_CANDIDATE="00b58efe-507b-466d-b200-43eb01cb00f7"   # R3 candidate (the review's reversal sample)
S2_SURVIVOR="066f2437-0444-4c92-8690-cf822fa247d9"   # its committed basis survivor

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR" "$GEN_DIR" "$LOG_DIR"

freeze_stage1() {
  # Freeze the REHEARSAL stage-1 artifact once; reused across cases. Only
  # the artifact filename is printed (builder progress goes to the log).
  python3 "$BUILDER" freeze --stage 1 --environment-mode REHEARSAL --out-dir "$ARTIFACT_DIR" >/dev/null
  python3 - "$ARTIFACT_DIR" <<'PY'
import json, glob, sys, os
records = sorted(glob.glob(os.path.join(sys.argv[1], "freeze-14a-*.json")))
if not records:
    raise SystemExit("no stage-1 freeze record found")
print(json.load(open(records[-1]))["artifact_file"])
PY
}

fresh_restore_prep() {
  "$RESTORE" >/dev/null
  $PSQL_STRICT < "$ROOT/13-repair-prep.sql" >/dev/null
}

stage1_artifact="$(freeze_stage1)"
stage1_record="$ARTIFACT_DIR/freeze-$(basename "$stage1_artifact" .sql).json"
stage1_path="$ARTIFACT_DIR/$stage1_artifact"

expect_abort_and_clean() {
  # $1 = log file, $2 = case label. Asserts a STOP/FAIL abort and zero
  # partial changes.
  local log="$1" name="$2"
  local superseded repair_audits
  if grep -qE "superseded [0-9]+ rows" "$log"; then
    echo "FAIL: $name applied despite the injection" >&2
    exit 1
  fi
  if ! grep -qE "STOP|FAIL" "$log"; then
    echo "FAIL: $name did not abort" >&2
    exit 1
  fi
  superseded=$($PSQL_STRICT -tAc \
    "SELECT count(*) FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL AND supersede_operation_id IN ('$STAGE1_OP','$STAGE2_OP')")
  repair_audits=$($PSQL_STRICT -tAc \
    "SELECT count(*) FROM public.reconciliation_audit_log WHERE action = 'match_repair_superseded'")
  if [ "$superseded" != "0" ] || [ "$repair_audits" != "0" ]; then
    echo "FAIL: partial changes detected after abort ($name): superseded=$superseded audit=$repair_audits" >&2
    exit 1
  fi
  echo "PASS: $name aborted with zero partial changes"
}

# ---------------------------------------------------------------------------
# G1 practice_id drift: repoint the tenant row of an affected client to a
# second practice. client_entities is lock-protected and identity-checked.
# NOTE: the composite FK canonical_audit_ledger(client_entity_id,
# practice_id) -> client_entities(id, practice_id) normally makes this state
# unconstructible — the DB itself pins the practice identity. This case
# drops that FK to emulate a corrupted restore and proves the repair-time
# practice_id check fails closed anyway.
# ---------------------------------------------------------------------------
echo "=== G1: practice_id drift ==="
fresh_restore_prep
$PSQL_STRICT <<SQL >/dev/null
ALTER TABLE public.canonical_audit_ledger
  DROP CONSTRAINT canonical_audit_ledger_client_entity_id_practice_id_fkey;
CREATE TEMP TABLE p_copy AS SELECT * FROM public.practices LIMIT 1;
UPDATE p_copy SET id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
INSERT INTO public.practices SELECT * FROM p_copy;
UPDATE public.client_entities
   SET practice_id = 'aaaaaaaa-0000-4000-8000-0000000000d1'
 WHERE id = '$TARGET_CLIENT';
SQL
out=$($PSQL < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g1-practice-id.log"
expect_abort_and_clean "$LOG_DIR/auth-g1-practice-id.log" "G1"

# ---------------------------------------------------------------------------
# G2 client_entities row drift: archive the tenant row.
# ---------------------------------------------------------------------------
echo "=== G2: client_entities row drift ==="
fresh_restore_prep
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.client_entities
   SET status = 'archived', archived_at = now()
 WHERE id = '$TARGET_CLIENT';
SQL
out=$($PSQL < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g2-client-entity.log"
expect_abort_and_clean "$LOG_DIR/auth-g2-client-entity.log" "G2"

# ---------------------------------------------------------------------------
# G3 stage-1 target approved_by drift (approved_at stays NULL).
# ---------------------------------------------------------------------------
echo "=== G3: stage-1 target approved_by drift ==="
fresh_restore_prep
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET approved_by = 'drift-injection' WHERE id = '$STAGE1_TARGET';
SQL
out=$($PSQL < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g3-approved-by.log"
expect_abort_and_clean "$LOG_DIR/auth-g3-approved-by.log" "G3"

# ---------------------------------------------------------------------------
# G4 stale supersession fields on a stage-1 target (superseded_at NULL).
# ---------------------------------------------------------------------------
echo "=== G4: stale supersession fields ==="
fresh_restore_prep
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET supersede_reason = 'drift-injection' WHERE id = '$STAGE1_TARGET';
SQL
out=$($PSQL < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g4-stale-supersession.log"
expect_abort_and_clean "$LOG_DIR/auth-g4-stale-supersession.log" "G4"

# ---------------------------------------------------------------------------
# Stage-2 cases need a full applied stage-1 + frozen stage-2.
# ---------------------------------------------------------------------------
apply_stage1() {
  fresh_restore_prep
  ARTIFACT_DIR="$ARTIFACT_DIR" "$RUNNER" --stage 1 --artifact "$stage1_path" --freeze-record "$stage1_record" --expect apply >/dev/null
  STAGE1_PROOF="$ARTIFACT_DIR/$(ls "$ARTIFACT_DIR" | grep '^stage1-proof-REHEARSAL-' | sort | tail -1)"
}

freeze_stage2() {
  CONFIRM_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local manifest="$GEN_DIR/auth-test-manifest.json"
  python3 "$BUILDER" rehearsal-manifest --confirmation-timestamp "$CONFIRM_TS" --out "$manifest" >/dev/null
  python3 "$BUILDER" freeze --stage 2 --environment-mode REHEARSAL \
    --auth-manifest "$manifest" --stage1-artifact "$stage1_path" \
    --stage1-execution-proof "$STAGE1_PROOF" --out-dir "$ARTIFACT_DIR" >/dev/null
  python3 - "$ARTIFACT_DIR" <<'PY'
import json, glob, sys, os
records = sorted(glob.glob(os.path.join(sys.argv[1], "freeze-14b-*.json")))
if not records:
    raise SystemExit("no stage-2 freeze record found")
print(json.load(open(records[-1]))["artifact_file"])
PY
}

# ---------------------------------------------------------------------------
# G5 stage-2 rerun with an altered repair audit row: the no-op verification
#    must compare byte-exact stored evidence — an extra same-operation audit
#    row with tampered evidence must ABORT, never silently no-op.
#    (The stored row itself is UPDATE/DELETE-immutable: 012's
#    audit_log_evidence_immutable_v1 blocks the mutation, so the injection
#    is an INSERT of a second, tampered same-operation row.)
# ---------------------------------------------------------------------------
echo "=== G5: altered stage-2 audit evidence on rerun ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
stage2_record="$ARTIFACT_DIR/freeze-$(basename "$stage2_artifact" .sql).json"
"$RUNNER" --stage 2 --artifact "$ARTIFACT_DIR/$stage2_artifact" --freeze-record "$stage2_record" \
  --stage1-proof "$STAGE1_PROOF" --expect apply >/dev/null
$PSQL_STRICT <<SQL >/dev/null
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT 'dddddddd-0000-4000-8000-0000000000f5', m.id, 'match_repair_superseded',
       'tampered-actor', now(), m.confidence, m.confidence,
       m.client_entity_id, m.user_id, '$STAGE2_OP',
       '{}'::jsonb, '{}'::jsonb, '{"tampered": true}'::jsonb
FROM public.reconciliation_matches m WHERE m.id = '$S2_CANDIDATE';
SQL
out=$($PSQL < "$ARTIFACT_DIR/$stage2_artifact" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g5-audit-evidence.log"
if grep -q "ALREADY APPLIED" "$LOG_DIR/auth-g5-audit-evidence.log"; then
  echo "FAIL: G5 rerun accepted altered audit evidence as a no-op" >&2
  exit 1
fi
grep -qE "STOP|FAIL" "$LOG_DIR/auth-g5-audit-evidence.log" \
  || { echo "FAIL: G5 did not abort" >&2; exit 1; }
echo "PASS: G5 altered audit evidence aborts the rerun (no silent no-op)"

# ---------------------------------------------------------------------------
# G6 partial stage-2: one authorized row superseded, audit insert missing
#    (the crash window between the UPDATE and the audit INSERT).
# ---------------------------------------------------------------------------
echo "=== G6: partial stage-2 (supersession without audit row) ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
stage2_record="$ARTIFACT_DIR/freeze-$(basename "$stage2_artifact" .sql).json"
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET
  superseded_at = now(),
  superseded_by_match_id = '$S2_SURVIVOR',
  supersede_reason = 'unsupported_approved_claim',
  supersede_operation_id = '$STAGE2_OP'
WHERE id = '$S2_CANDIDATE';
SQL
out=$($PSQL < "$ARTIFACT_DIR/$stage2_artifact" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g6-partial-no-audit.log"
superseded=$($PSQL_STRICT -tAc \
  "SELECT count(*) FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL AND supersede_operation_id = '$STAGE2_OP'")
repair_audits=$($PSQL_STRICT -tAc \
  "SELECT count(*) FROM public.reconciliation_audit_log WHERE action = 'match_repair_superseded' AND operation_id = '$STAGE2_OP'")
grep -qE "STOP|FAIL" "$LOG_DIR/auth-g6-partial-no-audit.log" \
  || { echo "FAIL: G6 did not abort" >&2; exit 1; }
if [ "$repair_audits" != "0" ]; then
  echo "FAIL: G6 wrote audit rows after the abort (audit=$repair_audits)" >&2
  exit 1
fi
echo "PASS: G6 partial stage-2 aborted with zero new writes (injected row remains, no new rows)"

# ---------------------------------------------------------------------------
# G7 partial stage-2: one authorized row superseded + an altered audit row
#    (post-crash tamper with an audit row present).
# ---------------------------------------------------------------------------
echo "=== G7: partial stage-2 (supersession + altered audit row) ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
stage2_record="$ARTIFACT_DIR/freeze-$(basename "$stage2_artifact" .sql).json"
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET
  superseded_at = now(),
  superseded_by_match_id = '$S2_SURVIVOR',
  supersede_reason = 'unsupported_approved_claim',
  supersede_operation_id = '$STAGE2_OP'
WHERE id = '$S2_CANDIDATE';
INSERT INTO public.reconciliation_audit_log
  (id, reconciliation_match_id, action, action_by, action_at,
   old_confidence, new_confidence, client_entity_id, user_id,
   operation_id, previous_state, resulting_state, evidence)
SELECT 'dddddddd-0000-4000-8000-0000000000f7', m.id, 'match_repair_superseded',
       'tampered-actor', now(), m.confidence, m.confidence,
       m.client_entity_id, m.user_id, '$STAGE2_OP',
       '{}'::jsonb, '{}'::jsonb, '{"tampered": true}'::jsonb
FROM public.reconciliation_matches m WHERE m.id = '$S2_CANDIDATE';
SQL
out=$($PSQL < "$ARTIFACT_DIR/$stage2_artifact" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g7-partial-altered-audit.log"
grep -qE "STOP|FAIL" "$LOG_DIR/auth-g7-partial-altered-audit.log" \
  || { echo "FAIL: G7 did not abort" >&2; exit 1; }
if grep -qE "superseded 98 rows" "$LOG_DIR/auth-g7-partial-altered-audit.log"; then
  echo "FAIL: G7 applied despite partial prior state" >&2
  exit 1
fi
echo "PASS: G7 partial stage-2 with altered audit row aborted with zero new writes"

# ---------------------------------------------------------------------------
# G8 rehearsal artifact vs a non-rehearsal database identity (local dev
#    database `postgres`): the REHEARSAL gate must abort before any write.
# ---------------------------------------------------------------------------
echo "=== G8: rehearsal artifact against non-rehearsal database identity ==="
out=$(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=0 -U supabase_admin -d postgres \
  < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g8-rehearsal-vs-devdb.log"
grep -q "REHEARSAL artifact refuses database identity" "$LOG_DIR/auth-g8-rehearsal-vs-devdb.log" \
  || { echo "FAIL: G8 rehearsal artifact did not refuse the non-rehearsal database identity" >&2; exit 1; }
echo "PASS: G8 rehearsal artifact refused the non-rehearsal database identity"

# ---------------------------------------------------------------------------
# G9 production artifact vs the wrong database identity (scratch restore):
#    the PRODUCTION gate must abort before any write.
# ---------------------------------------------------------------------------
echo "=== G9: production artifact against wrong database identity ==="
TMP_PROD="$(mktemp -d)"
python3 "$BUILDER" freeze --stage 1 --environment-mode PRODUCTION \
  --project-ref fqvekbzwghjurkcawpgg --out-dir "$TMP_PROD" >/dev/null
prod_artifact="$TMP_PROD/$(python3 - "$TMP_PROD" <<'PY'
import json, glob, sys, os
records = sorted(glob.glob(os.path.join(sys.argv[1], "freeze-14a-*.json")))
print(json.load(open(records[-1]))["artifact_file"])
PY
)"
superseded_before=$($PSQL_STRICT -tAc \
  "SELECT count(*) FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL AND supersede_operation_id = '$STAGE1_OP'")
out=$(docker exec -e PGOPTIONS="-c zaki.repair_project_ref=fqvekbzwghjurkcawpgg" \
  -i "$CONTAINER" psql -v ON_ERROR_STOP=0 -U supabase_admin -d "$DB" \
  < "$prod_artifact" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g9-production-vs-scratch.log"
grep -q "PRODUCTION artifact requires the exact production database identity" "$LOG_DIR/auth-g9-production-vs-scratch.log" \
  || { echo "FAIL: G9 production artifact did not refuse the wrong database identity" >&2; exit 1; }
superseded_after=$($PSQL_STRICT -tAc \
  "SELECT count(*) FROM public.reconciliation_matches WHERE superseded_at IS NOT NULL AND supersede_operation_id = '$STAGE1_OP'")
if [ "$superseded_after" != "$superseded_before" ]; then
  echo "FAIL: G9 production artifact wrote to the scratch database (before=$superseded_before after=$superseded_after)" >&2
  exit 1
fi
rm -rf "$TMP_PROD"
echo "PASS: G9 production artifact refused the wrong database identity with zero writes"

echo "ALL AUTHORIZATION DRIFT CASES PASS"
