# Repair Package Final Identity/Proof Correction Report

## 1. Verdict

**REPAIR PACKAGE READY FOR FINAL GO/NO-GO REVIEW.**

The three final-review blockers are resolved: the forgeable caller-created stage-1 proof is replaced by an immutable database-side execution receipt written inside stage 1's own transaction and independently revalidated by stage 2 (§6–§7); every G1–G18 case including G8/G9 proves zero writes by full before/after 11-table digest equality (§8); the committed package regenerates byte-identically and passes a clean-clone verification (§9). The exact execution-package commit P (§2) was rehearsed end-to-end on the local scratch restore (§10) and all validation is green (§11). Production execution remains gated on a separately authorized repair window; migration 013 application, deployment, and unfreeze are separately authorized future operations — this package performs none of them.

## 2. Execution-package commit P

`5db350fe899508fb039128513780d768644ada9d` — the execution package whose
exact tree was rehearsed on the local scratch restore (see §10). Its
parent `e905eb5448d8cc63821872cb68807802790092fa` carries the package
code; `5db350fe` adds a rehearsal-driver timing fix (manifest
confirmation stamps strictly post-date the receipt's executed_at) that
touches no package file — EXECUTION_PACKAGE_SHA256, working copies, and
all bindings are identical across both. No commit was amended.

## 3. Evidence commit E

The evidence-only descendant commit proving P (per-run artifacts,
`rehearsal/EVIDENCE.md`, this report). E is not itself rehearsed and has
no rehearsal obligation — it proves P, and its files are outside the
EXECUTION_PACKAGE_SHA256 file list, so the package identity is unchanged
by E. Its full SHA is recorded in the final report accompanying this
document.

## 4. EXECUTION_PACKAGE_SHA256

`d9b2eaa66233240d79e008267ede0f4a883e124627b7994ba9c415a1f581ace1`
(printable by `python3 bin/build_repair_package.py package-sha`).

Definition (EXECUTION_PACKAGE.md): sha256 over the concatenation of
sha256sum-format lines `<file_sha256>  <relpath>\n` for the documented
SORTED file list:

- `../migrations/013_reconciliation_claim_hardening.sql`
- `13-repair-prep.sql`
- `bin/build_repair_package.py`
- `bin/test_builder_binding.py`
- `execution-window.md`
- `manifests/duplicate-endpoints.csv`
- `manifests/r6-review.csv`
- `manifests/stage1-unapproved-targets.csv`
- `manifests/stage2-approved-candidates.csv`
- `manifests/stage2-authorization-manifest-template.json`
- `manifests/stage2-immutable-basis.json`
- `manifests/stage2-rehearsal-authorization-manifest.json`
- `manifests/stage2-test-decisions.json`

Excluded (documented in EXECUTION_PACKAGE.md): rehearsal tooling,
extract/ queries, artifacts/ (generated outputs), SQL working copies,
and narrative/evidence/report files. The identity binds: every artifact
(embedded literal + P0b2 driver-GUC gate), every audit row's evidence,
the stage-1 receipt row, and every freeze record. Git HEAD is NOT bound
into any artifact byte; commits are used separately (P = execution
package, E = evidence-only descendant proving P; E is not rehearsed
itself and has no rehearsal obligation).

## 5. Migration 013 SHA

`D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93`
(recomputed — unchanged; 010/011/012 untouched; the migration is never
applied by this package).

## 6. DB-side Stage-1 receipt design

Prep (`13-repair-prep.sql`, idempotent/additive) creates
`public.repair_stage1_receipt`:

| Column | Content |
|---|---|
| `receipt_sha256` (PK) | sha256 over `(to_jsonb(row) - 'receipt_sha256')::text` — recomputes from the stored row (jsonb normalizes key order, so the stage-1 build_object rendering and the stage-2 row rendering are byte-identical) |
| `execution_package_sha256` | EXECUTION_PACKAGE_SHA256 (§4) |
| `artifact_sha256` | the stage-1 frozen artifact sha (driver GUC) |
| `operation_id` (UNIQUE) | the fixed stage-1 operation id |
| `environment_mode`, `project_ref` | REHEARSAL/PRODUCTION identity |
| `target_manifest_sha256` | the committed stage-1 manifest sha |
| `target_digest_sha256` | sha256 of the exact 154 target ids (comma-joined, match_id order) |
| `survivor_mapping_digest_sha256` | sha256 of `match_id:survivor` pairs (comma-joined, match_id order) |
| `audit_digest_sha256` | sha256 of `jsonb_agg(to_jsonb(a) ORDER BY match_id)` over the 154 live repair audit rows |
| `postcondition_digest_sha256` | sha256 over the live superseded target + survivor-guard rows (role, ids, supersession fields, approval stamps) |
| `executed_at` | `now()` — database time, the same value as the audit rows' `action_at` |
| `db_identity` | `current_database()` |

An immutability trigger (`repair_stage1_receipt_immutable_v1`, ERRCODE
42806) blocks UPDATE and DELETE; UNIQUE(operation_id) blocks duplicate
rows. Stage 1 inserts the receipt INSIDE THE SAME TRANSACTION as the 154
supersessions and audit rows (P1b, apply mode only), and its
postconditions validate the receipt in BOTH modes (apply: just written;
noop rerun: written by the original apply — canonical hash recomputed,
bindings compared, digests recomputed). Stage 2 validates the actual
receipt row (P0d2, before the checkpoint revalidation): exactly one row,
canonical-hash recomputation, package/artifact/mode/project/manifest
binding equality, and the four digests INDEPENDENTLY RECOMPUTED FROM
LIVE STATE — any mismatch aborts with zero writes. The receipt export
(`extract/13-stage1-receipt.sql`) is operator evidence only; the freeze
command revalidates its derivable fields (consistency), never treating
it as authorization.

Rehearsal receipt (written by the P-rehearsal run): canonical sha256
`403fed84762b966f6dd6c040d218f998dd85c81e669690ddf6c245704aae92f1`,
executed_at `2026-08-17T17:01:15.010082+00:00` (database time); target
digest `16e5b864…`, survivor-mapping digest `c32c85bd…`, audit digest
`d09cdd68…`, postcondition digest `49e8a888…` (full values in the export
`artifacts/stage1-receipt-REHEARSAL-e6e5663f2ee5.json`).

## 7. Fake-proof rejection

The `stage1-proof` subcommand and the schema-v2 proof are REMOVED — a
caller-created JSON can no longer mint authorization. Two layers reject
forgeries:

- Builder level (B23): arbitrary fabricated stage-1 proof JSON (any
  schema) is refused by `load_stage1_receipt` (missing receipt fields);
  a receipt export whose DERIVABLE fields (package sha, artifact sha +
  byte-identity, operation id, mode/project, manifest sha, target digest,
  survivor-mapping digest, executed_at, db identity) differ from the
  builder's independent recomputation is refused (B18–B22).
- Execution level (G20 — the Codex exploit retested): a forged export
  whose derivable fields are ALL correct is accepted by the freeze (by
  design — evidence consistency, not authorization) and REJECTED BY THE
  DATABASE: the stage-2 artifact aborts with `STOP: expected exactly one
  stage-1 execution receipt, found 0 — … a caller-fabricated stage-1
  proof JSON is not an authorization root`, zero writes, full-state
  digest identical.
- Receipt tamper (G21): UPDATE/DELETE refused by the immutability
  trigger (42806), duplicate INSERT refused by UNIQUE(operation_id) —
  rollback-only, zero changes, the single receipt row intact.

## 8. G1–G18 full-state parity

Every G1–G18 case now asserts BEFORE_DIGEST == AFTER_DIGEST over the
deterministic 11-table digest (`rehearsal/state-digest.sh`, UTC + ISO
datestyle pinned). G8 digests the TARGET database (`postgres`, the local
dev DB) before/after the refused rehearsal-artifact run; G9 digests the
scratch DB before/after the refused production-artifact run. Both are
now full-digest proofs — the count-only exception is eliminated.
Result: G1–G7, G9–G21 — 20/20 digest-identical on the scratch DB; G8 —
digest-identical on the target `postgres` database. The full 21-case
suite (G1–G21) passed with zero writes everywhere.

## 9. Package byte-regeneration verification

The committed 14a/14b working copies regenerate byte-identically from
committed inputs: 14a from the committed manifests/basis + package sha;
14b from the committed basis + the FIXED committed test authorization
manifest (`stage2-rehearsal-authorization-manifest.json`) + the 14a
working-copy sha + an empty stage-1 receipt placeholder (documented as a
pre-execution staging artifact — a real receipt can only exist in a
database after stage 1 runs). `verify` (package path) requires
byte-identity for both and reports `VERIFY OK` at P and E; the
per-run frozen artifacts are independently re-proven with
`verify --artifact` against their freeze records and bound committed
inputs. The clean-clone test (B28) clones the committed HEAD and runs
`verify` + the full builder suite + `verify --artifact` on every
committed freeze record (inputs located by recorded sha) — all green at
P and E. No documentation workarounds: the committed executable SQL is
generated, and it regenerates.

## 10. Scratch rehearsal

Rehearsed the exact tree of P (`5db350fe899508fb039128513780d768644ada9d`,
clean working tree, HEAD verified inside the rehearsal wrapper) on the
local scratch restore: restore parity PASS; stage 1 apply — 154
superseded, 154 audit rows, execution receipt `403fed84…` written in the
same transaction, all postconditions passed; stage 1 rerun — verified
no-op with receipt revalidation; executed rehearsal authorization
manifest signed strictly after the receipt's executed_at (sha
`faa7b5ed…`); stage 2 freeze + `VERIFY OK`; stage 2 apply — receipt
validated with digests recomputed from live state, 98 superseded, 98
audit rows; stage 2 rerun — no-op; stage 1 after stage 2 — no-op; final
state 573 total / 252 superseded / 321 live / 0 duplicate live-auto / 252
repair audit rows / 1 receipt row; migration-013 compatibility on the
freshly repaired state — applied cleanly (Z2 passed, 0 duplicate
live-auto, post-013 invariants 573/252/0). Drift 5/5; authorization
G1–G21 21/21 (incl. G19 missing package GUC, G20 forged receipt
rejected database-side, G21 receipt tamper immutability). Full per-run
evidence: `rehearsal/EVIDENCE.md`.

## 11. Tests/build

- `npm run test:unit`: 498 passed (20 skipped), 0 failed.
- `npm run test:local-db`: 191 passed (8 skipped), 0 failed.
- `npm run typecheck`: clean. `npm run build`: clean.
- Fresh local `supabase db reset` 001→013: clean apply, no errors.
- `bin/test_builder_binding.py`: 29 passed, 0 failed (B1–B28, incl.
  B23 arbitrary fabricated-proof rejection, B27 EXECUTION_PACKAGE_SHA256
  determinism + file-list coverage, B28 clean-clone).
- Package-level `verify`: `VERIFY OK` at P and E; `verify --artifact`
  for both committed frozen artifacts: `VERIFY OK`.
- Stage-1 drift injections: 5/5 PASS. Authorization/identity/failure
  injections: 21/21 PASS (G1–G21).

## 12. Remaining risks

- The PRODUCTION identity gate binds database name + server version +
  the session GUC; the connection HOST is operator-verified (runbook
  step 3). A production artifact could, in principle, run against
  another PostgreSQL-17 database named `postgres` with the GUCs set —
  there is no database-side secret or hostname binding in Supabase
  Postgres ("where feasible"; no secrets embedded).
- The stage-2 receipt validation's canonical-hash recomputation relies
  on PostgreSQL jsonb key-ordering normalization (stable within PG 17;
  rehearsal and production are both PG 17, and the receipt is written
  and validated on the same server).
- The stage-2 artifact validates the receipt and recomputes the stage-1
  state BEFORE its own apply, but stage-1's own noop rerun validates the
  receipt in its postconditions — an operator could in principle DELETE
  the receipt (immutability trigger blocks UPDATE/DELETE — only a
  superuser could drop the trigger itself), which would make every
  rerun and stage 2 abort (fail closed).
- R5 endpoints legitimately end with zero live rows; the
  endpoint-liveness postcondition is scoped to R3/R6 (documented in the
  SQL).

## 13. Exact next gate

Final GO/NO-GO review of this package at commit P (§2) with the evidence
commit E (§3): run `bin/build_repair_package.py package-sha` (§4),
`bin/build_repair_package.py verify --auth-manifest
manifests/stage2-rehearsal-authorization-manifest.json` (VERIFY OK),
`bin/test_builder_binding.py` (29/29 incl. clean-clone), and read
`rehearsal/EVIDENCE.md`. Production execution, migration 013 application,
deployment, and unfreeze remain separately authorized future operations —
this package performs none of them.
