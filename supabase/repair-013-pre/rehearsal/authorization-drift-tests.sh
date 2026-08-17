#!/usr/bin/env bash
# Authorization / identity / failure-substitution rehearsal (Phase 9,
# database-side cases). Each case restores a fresh scratch copy, injects a
# deliberate drift or substitution, and proves the frozen stage artifacts
# FAIL CLOSED with zero partial changes — proven by FULL-STATE digests of
# all 11 relevant tables (blocker 6), not just repair row counts.
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
#   G10 post-stage-1 supersede_reason drift — stage 2 must ABORT with zero
#       stage-2 changes (blocker 1: exact stage-1 revalidation)
#   G11 post-stage-1 survivor-link drift (superseded_by_match_id) — abort
#   G12 post-stage-1 supersede_operation_id drift — abort
#   G13 post-stage-1 approval/accounting identity drift (approved_at/by) —
#       abort
#   G14 stage-1 audit evidence drift (second same-operation tampered audit
#       row; the stored row is UPDATE/DELETE-immutable via 012) — abort
#   G15 candidate/survivor substitution: an authorized candidate
#       pre-superseded with the wrong survivor — abort
#   G16 deliberately held conflicting lock — lock_timeout (SQLSTATE 55P03),
#       zero mutation, full-state digest identical (blocker 5)
#   G17 statement_timeout mechanism proof (SQLSTATE 57014 + rollback
#       semantics; the artifact's finite statement_timeout is fixed at
#       build time, this proves the timeout/rollback contract)
#   G18 missing artifact-sha GUC — the P0b gate aborts before any lock or
#       write, zero mutation
#
# All cases prove zero partial changes after the abort.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$ROOT/bin/build_repair_package.py"
RUNNER="$ROOT/rehearsal/run-stage.sh"
RESTORE="$ROOT/rehearsal/restore-scratch.sh"
DIGEST="$ROOT/rehearsal/state-digest.sh"
CONTAINER="${CONTAINER:-supabase_db_Zaki-ledger}"
DB="${DB:-repair_drill}"
ARTIFACT_DIR="$ROOT/artifacts/auth-tests"   # private to this test run
GEN_DIR="$ROOT/rehearsal/generated"
LOG_DIR="${LOG_DIR:-/tmp/zaki-repair-rehearsal}"
# No dated dump defaults (blocker 8): the driver must be pointed at the
# explicit dump files to restore — omitted env vars FAIL, never silently
# substitute an old snapshot.
SCHEMA_DUMP="${SCHEMA_DUMP:-}"
DATA_DUMP="${DATA_DUMP:-}"
[ -n "$SCHEMA_DUMP" ] && [ -n "$DATA_DUMP" ] \
  || { echo "error: this driver requires explicit SCHEMA_DUMP and DATA_DUMP env vars (no defaults — fresh dumps only)" >&2; exit 2; }
[ -f "$SCHEMA_DUMP" ] && [ -f "$DATA_DUMP" ] \
  || { echo "error: dump file not found (SCHEMA_DUMP=$SCHEMA_DUMP DATA_DUMP=$DATA_DUMP)" >&2; exit 2; }

PSQL="docker exec -i $CONTAINER psql -U supabase_admin -d $DB"
PSQL_STRICT="docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 -U supabase_admin -d $DB"

STAGE1_OP="0a1a1a01-4a5e-4b1a-8c01-013000000001"
STAGE2_OP="0a1a1a01-4a5e-4b1a-8c01-013000000002"

# Fixed ids (from the committed manifests / basis):
STAGE1_TARGET="00d77a13-2a24-4fb9-a760-70761628a85c"
TARGET_CLIENT="daa94c07-e040-4a68-9c2f-b7f1c57582c8"
S2_CANDIDATE="00b58efe-507b-466d-b200-43eb01cb00f7"   # R3 candidate (the review's reversal sample)
S2_SURVIVOR="066f2437-0444-4c92-8690-cf822fa247d9"   # its committed basis survivor
# A genuinely WRONG survivor for both the stage-1 target (whose committed
# survivor is c3a2addf…) and the stage-2 candidate (066f2437…): a real live
# match id that is neither — NOTE the stage-1 target's OWN survivor is
# c3a2addf…, so a wrong-survivor injection must use a different id or the
# drift is a no-op (G11 regression caught 2026-08-17).
S2_WRONG_SURVIVOR="00368dd0-4a00-4306-b811-8fe4c3a2fbfa"

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
  "$RESTORE" --schema-dump "$SCHEMA_DUMP" --data-dump "$DATA_DUMP" >/dev/null
  $PSQL_STRICT < "$ROOT/13-repair-prep.sql" >/dev/null
}

stage1_artifact="$(freeze_stage1)"
stage1_record="$ARTIFACT_DIR/freeze-$(basename "$stage1_artifact" .sql).json"
stage1_path="$ARTIFACT_DIR/$stage1_artifact"
STAGE1_SHA="$(sha256sum "$stage1_path" | awk '{print $1}')"

# Run a stage artifact with the driver's artifact-sha GUC (the SQL gate
# requires it; the driver verifies the sha against the freeze record first).
run_with_guc() {
  local artifact="$1" sha="$2"
  docker exec -e "PGOPTIONS=-czaki.repair_artifact_sha256=$sha" -i "$CONTAINER" \
    psql -U supabase_admin -d "$DB" < "$artifact" 2>&1 || true
}

expect_abort_and_clean() {
  # $1 = log file, $2 = case label. Asserts a STOP/FAIL abort and a
  # FULL-STATE digest equality (zero partial changes anywhere).
  local log="$1" name="$2"
  if grep -qE "superseded [0-9]+ rows" "$log"; then
    echo "FAIL: $name applied despite the injection" >&2
    exit 1
  fi
  if ! grep -qE "STOP|FAIL|canceling statement due to (lock|statement) timeout" "$log"; then
    echo "FAIL: $name did not abort" >&2
    exit 1
  fi
  local after
  after="$("$DIGEST")"
  if [ "$DIGEST_BEFORE" != "$after" ]; then
    echo "FAIL: full-state digest changed after abort ($name)" >&2
    echo "before: $DIGEST_BEFORE" >&2
    echo "after:  $after" >&2
    exit 1
  fi
  echo "PASS: $name aborted with zero partial changes (full-state digest identical)"
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$stage1_path" "$STAGE1_SHA")
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$stage1_path" "$STAGE1_SHA")
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$stage1_path" "$STAGE1_SHA")
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$stage1_path" "$STAGE1_SHA")
echo "$out" | tee "$LOG_DIR/auth-g4-stale-supersession.log"
expect_abort_and_clean "$LOG_DIR/auth-g4-stale-supersession.log" "G4"

# ---------------------------------------------------------------------------
# Stage-2 cases need a full applied stage-1 + frozen stage-2.
# ---------------------------------------------------------------------------
apply_stage1() {
  fresh_restore_prep
  # Each case is an independent execution of the same frozen artifact, and
  # the builder refuses to OVERWRITE a proof (immutability — a fresh
  # execution legitimately differs by executed_at + execution-log hash).
  # The proof name is deterministic on the artifact sha, so the suite must
  # drop the previous case's proof from its private dir before the runner
  # generates the new one.
  rm -f "$ARTIFACT_DIR"/stage1-proof-REHEARSAL-*.json
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
STAGE2_SHA="$(sha256sum "$ARTIFACT_DIR/$stage2_artifact" | awk '{print $1}')"
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$ARTIFACT_DIR/$stage2_artifact" "$STAGE2_SHA")
echo "$out" | tee "$LOG_DIR/auth-g5-audit-evidence.log"
if grep -q "ALREADY APPLIED" "$LOG_DIR/auth-g5-audit-evidence.log"; then
  echo "FAIL: G5 rerun accepted altered audit evidence as a no-op" >&2
  exit 1
fi
expect_abort_and_clean "$LOG_DIR/auth-g5-audit-evidence.log" "G5"

# ---------------------------------------------------------------------------
# G6 partial stage-2: one authorized row superseded, audit insert missing
#    (the crash window between the UPDATE and the audit INSERT) — the
#    failure-after-update-before-audit case (blocker 6).
# ---------------------------------------------------------------------------
echo "=== G6: partial stage-2 (supersession without audit row) ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
stage2_record="$ARTIFACT_DIR/freeze-$(basename "$stage2_artifact" .sql).json"
STAGE2_SHA="$(sha256sum "$ARTIFACT_DIR/$stage2_artifact" | awk '{print $1}')"
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET
  superseded_at = now(),
  superseded_by_match_id = '$S2_SURVIVOR',
  supersede_reason = 'unsupported_approved_claim',
  supersede_operation_id = '$STAGE2_OP'
WHERE id = '$S2_CANDIDATE';
SQL
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$ARTIFACT_DIR/$stage2_artifact" "$STAGE2_SHA")
echo "$out" | tee "$LOG_DIR/auth-g6-partial-no-audit.log"
expect_abort_and_clean "$LOG_DIR/auth-g6-partial-no-audit.log" "G6"

# ---------------------------------------------------------------------------
# G7 partial stage-2: one authorized row superseded + an altered audit row
#    (post-crash tamper with an audit row present).
# ---------------------------------------------------------------------------
echo "=== G7: partial stage-2 (supersession + altered audit row) ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
stage2_record="$ARTIFACT_DIR/freeze-$(basename "$stage2_artifact" .sql).json"
STAGE2_SHA="$(sha256sum "$ARTIFACT_DIR/$stage2_artifact" | awk '{print $1}')"
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
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$ARTIFACT_DIR/$stage2_artifact" "$STAGE2_SHA")
echo "$out" | tee "$LOG_DIR/auth-g7-partial-altered-audit.log"
expect_abort_and_clean "$LOG_DIR/auth-g7-partial-altered-audit.log" "G7"

# ---------------------------------------------------------------------------
# G8 rehearsal artifact vs a non-rehearsal database identity (local dev
#    database `postgres`): the REHEARSAL gate must abort before any write
#    (and before the sha gate — environment identity is validated first).
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

# ---------------------------------------------------------------------------
# G10-G14: post-stage-1 checkpoint mutations (blocker 1). After a complete
# stage-1 apply, mutate the committed stage-1 state and run the FROZEN
# stage-2 artifact: EVERY case must abort with zero stage-2 changes and a
# full-state digest identical to the mutated pre-run state.
# ---------------------------------------------------------------------------
run_post_checkpoint_case() {
  local name="$1" inject="$2"
  echo "=== $name ==="
  apply_stage1
  local s2art
  s2art="$(freeze_stage2)"
  local s2sha
  s2sha="$(sha256sum "$ARTIFACT_DIR/$s2art" | awk '{print $1}')"
  $PSQL_STRICT <<SQL >/dev/null
BEGIN;
$inject
COMMIT;
SQL
  DIGEST_BEFORE="$("$DIGEST")"
  local out
  out=$(run_with_guc "$ARTIFACT_DIR/$s2art" "$s2sha")
  echo "$out" | tee "$LOG_DIR/auth-$name.log"
  if grep -qE "STAGE 2: superseded [0-9]+ rows" "$LOG_DIR/auth-$name.log"; then
    echo "FAIL: $name applied stage 2 despite the post-checkpoint mutation" >&2
    exit 1
  fi
  expect_abort_and_clean "$LOG_DIR/auth-$name.log" "$name"
}

# G10: supersede_reason drifted on a stage-1 target after the checkpoint.
run_post_checkpoint_case "g10-stage1-reason-drift" \
  "UPDATE public.reconciliation_matches SET supersede_reason = 'tampered-reason' WHERE id = '$STAGE1_TARGET';"

# G11: survivor link drifted on a stage-1 target after the checkpoint.
run_post_checkpoint_case "g11-stage1-survivor-drift" \
  "UPDATE public.reconciliation_matches SET superseded_by_match_id = '$S2_WRONG_SURVIVOR' WHERE id = '$STAGE1_TARGET';"

# G12: supersede operation id drifted on a stage-1 target.
run_post_checkpoint_case "g12-stage1-opid-drift" \
  "UPDATE public.reconciliation_matches SET supersede_operation_id = '0a1a1a01-4a5e-4b1a-8c01-999999999999' WHERE id = '$STAGE1_TARGET';"

# G13: approval/accounting identity drifted on a stage-1 target (approved).
run_post_checkpoint_case "g13-stage1-approval-drift" \
  "UPDATE public.reconciliation_matches SET approved_at = now(), approved_by = 'drift-injection' WHERE id = '$STAGE1_TARGET';"

# G14: stage-1 audit evidence drift — a second same-operation tampered audit
#      row on a stage-1 target (the stored row is UPDATE/DELETE-immutable,
#      so drift is only constructible as an extra row; stage 2 must reject
#      the duplicate, never treat the target as "done").
run_post_checkpoint_case "g14-stage1-audit-drift" \
  "INSERT INTO public.reconciliation_audit_log
     (id, reconciliation_match_id, action, action_by, action_at,
      old_confidence, new_confidence, client_entity_id, user_id,
      operation_id, previous_state, resulting_state, evidence)
   SELECT 'dddddddd-0000-4000-8000-0000000000e4', m.id, 'match_repair_superseded',
          'tampered-actor', now(), m.confidence, m.confidence,
          m.client_entity_id, m.user_id, '$STAGE1_OP',
          '{}'::jsonb, '{}'::jsonb, '{\"tampered\": true}'::jsonb
   FROM public.reconciliation_matches m WHERE m.id = '$STAGE1_TARGET';"

# ---------------------------------------------------------------------------
# G15 candidate/survivor substitution: an authorized candidate is
#    pre-superseded with the stage-2 operation id but the WRONG survivor.
#    The dispatcher finds 97 live / 0 done — neither clean apply nor clean
#    no-op — and aborts; no row is ever "fixed up".
# ---------------------------------------------------------------------------
echo "=== G15: candidate/survivor substitution ==="
apply_stage1
stage2_artifact="$(freeze_stage2)"
STAGE2_SHA="$(sha256sum "$ARTIFACT_DIR/$stage2_artifact" | awk '{print $1}')"
$PSQL_STRICT <<SQL >/dev/null
UPDATE public.reconciliation_matches SET
  superseded_at = now(),
  superseded_by_match_id = '$S2_WRONG_SURVIVOR',
  supersede_reason = 'unsupported_approved_claim',
  supersede_operation_id = '$STAGE2_OP'
WHERE id = '$S2_CANDIDATE';
SQL
DIGEST_BEFORE="$("$DIGEST")"
out=$(run_with_guc "$ARTIFACT_DIR/$stage2_artifact" "$STAGE2_SHA")
echo "$out" | tee "$LOG_DIR/auth-g15-candidate-survivor-substitution.log"
if grep -qE "STAGE 2: superseded [0-9]+ rows" "$LOG_DIR/auth-g15-candidate-survivor-substitution.log"; then
  echo "FAIL: G15 stage 2 applied despite the substituted survivor" >&2
  exit 1
fi
expect_abort_and_clean "$LOG_DIR/auth-g15-candidate-survivor-substitution.log" "G15"

# ---------------------------------------------------------------------------
# G16 deliberately held conflicting lock: a second session holds ACCESS
#    EXCLUSIVE on reconciliation_matches; the repair's finite lock_timeout
#    (SQLSTATE 55P03) must fire, the transaction must roll back, and the
#    full-state digest must be identical (blocker 5).
# ---------------------------------------------------------------------------
echo "=== G16: deliberately held conflicting lock (lock_timeout 55P03) ==="
fresh_restore_prep
# The BEFORE digest MUST be captured before the lock holder starts: the
# digest reads reconciliation_matches, which an ACCESS EXCLUSIVE holder
# blocks — captured after the lock, the digest would wait out the whole
# 60s hold and stage 1 would then run against a RELEASED lock (G16
# regression caught 2026-08-17: stage 1 applied instead of timing out).
DIGEST_BEFORE="$("$DIGEST")"
# Session B: hold ACCESS EXCLUSIVE on reconciliation_matches for 60s
# (longer than the artifact's 30s lock_timeout — guaranteed timeout, no
# retry possible by construction).
docker exec -d "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 \
  -c "BEGIN; LOCK TABLE public.reconciliation_matches IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); ROLLBACK;" \
  >/dev/null 2>&1
sleep 2
start=$(date +%s)
out=$(run_with_guc "$stage1_path" "$STAGE1_SHA")
end=$(date +%s)
echo "$out" | tee "$LOG_DIR/auth-g16-lock-timeout.log"
grep -q "canceling statement due to lock timeout" "$LOG_DIR/auth-g16-lock-timeout.log" \
  || { echo "FAIL: G16 did not report a lock timeout (55P03)" >&2; exit 1; }
elapsed=$((end - start))
if [ "$elapsed" -gt 120 ]; then
  echo "FAIL: G16 lock wait exceeded the finite timeout window (took ${elapsed}s)" >&2
  exit 1
fi
if grep -qE "STAGE 1: superseded 154 rows" "$LOG_DIR/auth-g16-lock-timeout.log"; then
  echo "FAIL: G16 stage 1 applied despite the lock timeout" >&2
  exit 1
fi
expect_abort_and_clean "$LOG_DIR/auth-g16-lock-timeout.log" "G16"
# Let session B finish in the background; it rolls back after its sleep.

# ---------------------------------------------------------------------------
# G17 statement_timeout mechanism proof (57014 + rollback semantics). The
#    artifact's statement_timeout is fixed at build time (120s); this case
#    proves the timeout/rollback CONTRACT with a tiny local value: the
#    timed-out transaction must leave zero changes.
# ---------------------------------------------------------------------------
echo "=== G17: statement_timeout mechanism (57014 + rollback) ==="
DIGEST_BEFORE="$("$DIGEST")"
out=$(printf "%s\n" \
  "BEGIN;" \
  "SET LOCAL statement_timeout = '200ms';" \
  "UPDATE public.bank_statements" \
  "   SET file_name = 'g17-timeout-injection.csv'" \
  " WHERE id = (SELECT id FROM public.bank_statements ORDER BY id LIMIT 1);" \
  "SELECT pg_sleep(1);" \
  "COMMIT;" | $PSQL_STRICT 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g17-statement-timeout.log"
grep -q "canceling statement due to statement timeout" "$LOG_DIR/auth-g17-statement-timeout.log" \
  || { echo "FAIL: G17 did not report a statement timeout (57014)" >&2; exit 1; }
if grep -q "^COMMIT" "$LOG_DIR/auth-g17-statement-timeout.log"; then
  echo "FAIL: G17 transaction committed despite the statement timeout" >&2
  exit 1
fi
after="$("$DIGEST")"
if [ "$DIGEST_BEFORE" != "$after" ]; then
  echo "FAIL: G17 timed-out transaction left partial changes (statement-timeout rollback broken)" >&2
  exit 1
fi
echo "PASS: G17 statement timeout (57014) rolled the transaction back with zero changes"

# ---------------------------------------------------------------------------
# G18 missing artifact-sha GUC: the P0b gate must abort before any lock or
#    write, with a full-state digest identical to the pristine restore.
# ---------------------------------------------------------------------------
echo "=== G18: missing artifact-sha GUC ==="
fresh_restore_prep
DIGEST_BEFORE="$("$DIGEST")"
out=$(docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" \
  < "$stage1_path" 2>&1) || true
echo "$out" | tee "$LOG_DIR/auth-g18-missing-sha-guc.log"
grep -q "zaki.repair_artifact_sha256 is missing or malformed" "$LOG_DIR/auth-g18-missing-sha-guc.log" \
  || { echo "FAIL: G18 missing-sha GUC did not trip the P0b gate" >&2; exit 1; }
expect_abort_and_clean "$LOG_DIR/auth-g18-missing-sha-guc.log" "G18"

echo "ALL AUTHORIZATION DRIFT CASES PASS"
