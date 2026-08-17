# Historical Repair Authorization-Binding Hardening Report

Final hardening of the 013-pre historical repair execution package
(`supabase/repair-013-pre/`), addressing the independent-review blocker:
the stage-2 builder previously accepted an authorization manifest that could
reverse a retirement target and its intended survivor while preserving
counts. The accountant's authorization is now bound to the immutable
committed classification.

Scope: execution-package authorization and reproducibility defects only.
Production was not modified, no repair SQL ran against production, migration
013 was not applied, nothing was deployed, main was not merged, and no bank
rows were re-matched. The 107-endpoint accounting classification is
unchanged (Stage-1 CSV and duplicate-endpoint inventory SHA-identical to the
reviewed release; migration 013 SHA unchanged).

## 1. Verdict

**REPAIR PACKAGE READY FOR FINAL INDEPENDENT REVIEW** — contingent on the
evidence-binding commit recording the final package commit SHA (§2, §17).

## 2. New artifact identity

Package commit: `4540346c46b40c46cec257ec21be265cf0c1c92a`
(`feat: bind stage-2 authorization to the immutable committed basis
(013-pre)`), plus the evidence-binding commit that records this SHA.
Base: `7fd608b5283411f17ad30e042d4427d55bd6027e` (not amended).

Key hashes (full evidence: `rehearsal/EVIDENCE.md`):

- Stage-1 SQL `14a-stage1-unapproved-repair.sql`:
  `a91123dbdb8def4634163699a7c0701879c70dd9919c6c41b5d43f8b1f21903d`
- Stage-2 SQL `14b-stage2-approved-repair.sql`:
  `847463baf847e0b6f37fa080f27a62bad143382b784223eb68b9741b2af835aa`
- Committed basis `manifests/stage2-immutable-basis.json`:
  `751d9b04ac3695da82821af311a20de7b45fd8bcfd7633f4cd4eb813793bf271`
- Rehearsal authorization manifest (committed):
  `940e9021d7a67a1ad4892e9712c35af0848fe85924a4a693baee01149e0bf7c4`
- Frozen rehearsal stage-1 artifact identity:
  `6e36e7ad0b0b61385b2fffe604a0a8b2a0fbd8fc9f40a65dc9493b1dcfafbff1`
- Frozen rehearsal stage-2 artifact identity:
  `cabe2952cfda9849a377942ea7c2db93f81d437c7be9f8e43bb1048299b7ce3f`

## 3. Migration 013 SHA

`D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93`
(unchanged; 010/011/012 untouched).

## 4. Immutable candidate basis

`manifests/stage2-immutable-basis.json` (189 rows, SHA-locked) commits, per
row: `match_id`, role (`candidate`/`survivor_guard`), QB/bank/statement ids,
tenant/user/client/book ids, `practice_id`, amounts, dates, description
SHA-256 fingerprints, `approved_at`/`approved_by`/`confidence`, `class`,
`reason`, `action`, `evidence_summary`, and — the authorization contract —
`permitted_survivor_match_ids` and `permitted_decisions`.

- 102 decision-permitted candidates: 93 R3 approved non-exact rows (fixed
  survivor = the endpoint's exact-amount row), 1 R5 test row (no survivor),
  and **both** members of each of the 4 R6 pairs (permitted survivor = the
  other member).
- 87 survivor guards (R3 exact rows): never decision-permitted — candidate
  ↔ survivor reversal is rejected by the builder (verified by test B1, the
  review's exact sample pair).
- Regenerated only by `manifests` from the accepted snapshot;
  `verify` proves the committed basis is byte-identical to a regeneration.

## 5. Authorization manifest semantics

The manifest is decision-only JSON:
`match_id, decision (RETIRE|DO_NOT_REPAIR), accountant_identity,
confirmation_timestamp, note`. The builder enforces:

- every decision references a decision-permitted committed-basis row
  (unknown ids rejected — arbitrary replacement impossible);
- decisions outside the row's permitted set rejected;
- survivor, reason, action, class, QB/bank ids, fingerprints come from the
  basis — the manifest has no field for them and **unknown keys are
  rejected** (verified by B3/B4/B12);
- at most one member of an R6 pair retires (B6);
- `basis_sha256` must equal the committed basis SHA (B11).

## 6. Rehearsal/production barrier

`environment_mode = REHEARSAL | PRODUCTION` is bound into the manifest, the
generated SQL (a hard in-transaction identity gate executed before any lock
or write), the audit evidence, the freeze record, and the artifact identity
hash (`sha256(operation ids | mode | manifest/basis hashes | proof | stage-1
artifact | project ref)`).

- REHEARSAL artifacts execute only against `current_database() =
  'repair_drill'` (verified G8: refuses the local dev database identity).
- PRODUCTION artifacts execute only against database `postgres` on
  PostgreSQL 17 with the session GUC `zaki.repair_project_ref =
  'fqvekbzwghjurkcawpgg'` (verified G9: refuses the scratch identity).
- PRODUCTION builds require `--project-ref fqvekbzwghjurkcawpgg` and refuse
  REHEARSAL manifests (B8/B9). No secrets are embedded.

## 7. R6 authorization boundary

Both members of every R6 pair are decision-permitted candidates with the
partner as the permitted survivor; the earliest-upload proposal exists only
in `r6-review.csv`/`r6-review-packet.md` — no default executable decision.
Every stage-2 freeze requires the stage-1 execution proof, and every
decision's `confirmation_timestamp` must not predate the proof's
`executed_at` (B10). R6 decisions therefore cannot exist as executable
choices before the stage-1 checkpoint; an R6 side swap is a legal,
basis-validated choice (B5).

## 8. Stage-2 build/freeze process

`freeze --stage 2` requires `--auth-manifest` + `--stage1-artifact` +
`--stage1-execution-proof`; it validates decisions against the committed
basis and the proof, writes the exact SQL to a unique immutable path
(overwrite refused — B15), and records SHA-256 + identity + all binding
hashes in a freeze record. `verify --artifact <freeze.json>` independently
re-proves the frozen bytes before execution; the runner executes only a
hash-verified artifact. The committed `14a/14b` are REHEARSAL working
copies; production uses frozen window artifacts.

## 9. Exact drift coverage

Added to the generated SQL (both stages):

- `client_entities` row identity: table locked ACCESS EXCLUSIVE; every
  manifest row verifies the tenant row exists, is `active`, `archived_at IS
  NULL`, and `practice_id` matches (G1/G2).
- Stage-1 targets: `approved_by IS NULL` in addition to `approved_at`
  (G3), and complete clean supersession pre-state
  (`superseded_at/superseded_by_match_id/supersede_reason/
  supersede_operation_id` all NULL) (G4); same for stage-2 candidates in
  apply mode.
- Stage 1 identity-checks **all** committed-basis candidate rows (102)
  protecting the affected endpoints — not only the 101 survivor guards —
  accepting a candidate as pristine or stage-2-superseded only with the
  basis reason/survivor and audit row.

## 10. Full audit idempotency

A same-operation audit row counts as DONE only if its stored evidence is
byte-exact: `action`, `action_by` (stage 1 system actor / stage 2 the
accountant), `action_at = superseded_at`, `previous_state`,
`resulting_state`, `evidence` (stage, class, reason, survivor, approval
stamps, manifest/basis/proof/artifact hashes, environment mode, artifact
identity, accountant identity/timestamp/decision/note). Altered evidence
makes the row neither live nor done — the dispatcher aborts as partial
state (G5/G7) — and postcondition 3b/4 re-verifies byte-exactness on every
rerun. `SET LOCAL TIME ZONE 'UTC'` makes the comparisons session-
independent.

## 11. Stage-2 substitution/failure tests

`bin/test_builder_binding.py` (18/18 pass, no database): reversal (B1),
candidate replacement (B2), identity smuggling (B3/B4), R6 swap legality
(B5), both-retire (B6), missing `--auth-manifest` (B7), rehearsal manifest
in PRODUCTION (B8), wrong project identity (B9), pre-checkpoint R6 decision
(B10), wrong basis sha (B11), legacy CSV manifest (B12), missing/wrong
stage-1 proof (B13/B14), freeze immutability (B15), gates/binding in SQL
(B16), determinism (B17).

`rehearsal/authorization-drift-tests.sh` (9/9 pass): practice_id drift,
client_entities drift, approved_by drift, stale supersession fields, audit
evidence mismatch, partial stage-2 completion, failure after supersession
before audit insert, rehearsal-artifact-vs-wrong-identity, production-
artifact-vs-wrong-identity — every case fails closed with zero partial
changes.

## 12. Reproducibility tooling

The read-only extraction queries that produced the snapshot are committed
under `repair-013-pre/extract/` (with capture README; the guarded wrapper
`supabase/prod-readonly-query.sh` fixes the target to production and
prepends a read-only guard). No customer dumps are committed. The auth
bootstrap dependency is replaced by a sanitized generator
(`rehearsal/make-local-auth-bootstrap.sh`, local stack only). `verify`
re-proves snapshot provenance hashes and basis byte-identity against the
captured files.

## 13. Rehearsal evidence

`rehearsal/EVIDENCE.md` is regenerated and binds the package commit SHA,
migration 013 SHA, stage SQL SHAs (working copies + frozen artifacts),
manifest hashes, dump hashes, freeze records, proof, and executed
rehearsal manifest. Committed artifacts under `repair-013-pre/artifacts/`
include both frozen SQL files, freeze records, the stage-1 execution proof,
and the executed rehearsal authorization manifest.

## 14. Restore tooling

`restore-scratch.sh` no longer hardcodes dated dump filenames: explicit
`--schema-dump` / `--data-dump` (with documented defaults) and optional
`--schema-sha256` / `--data-sha256` hash verification before restore.

## 15. Repair-only runbook

`execution-window.md` rewritten as REPAIR ONLY: 18 steps ending at
"STOP" after the final-repair-state verification. Migration 013
application, app deployment, and unfreeze are explicitly separate,
separately authorized operations and are absent from the runbook.
`rehearsal/run-stages.sh` (which chained prep → stage 1 → stage 2 →
migration 013) is deleted and replaced by the hash-verified frozen-artifact
runner `run-stage.sh`, the rehearsal-only `rehearsal-chain.sh` (no migration
step; mechanical rehearsal-only barriers: local container + `repair_drill`
only), and the separate rehearsal-only `run-migration-013.sh`. There is no
production-capable chaining wrapper.

## 16. Validation results

- `npm run test:unit`: **498 passed** (20 skipped), 0 failed.
- `npm run test:local-db`: **191 passed** (8 skipped), 0 failed.
- `npm run typecheck`: clean. `npm run build`: clean.
- Fresh local reset 001→013: clean.
- Full scratch rehearsal (repeated after reset): restore parity PASS; stage
  1 apply 154 + byte-exact no-op rerun; checkpoint; stage 2 apply 98 +
  byte-exact no-op rerun; stage-1-after-stage-2 no-op; final state 573 total
  / 252 superseded / 321 live / 0 duplicate live-auto / 252 repair audit
  rows; migration-013 compatibility check PASS.
- Candidate/survivor reversal (the review's exact sample pair): **builder
  rejects** (B1).
- Missing `--auth-manifest`: **hard failure** (B7).
- Rehearsal artifact against non-rehearsal identity: **hard failure** (G8);
  production artifact against wrong identity: **hard failure** (G9).

## 17. New commit SHA

`4540346c46b40c46cec257ec21be265cf0c1c92a` — the package corrections commit
(this report ships with it; this section and EVIDENCE.md §0 are filled by
the immediately following evidence-binding commit). `7fd608b` was not
amended; the working tree ends clean.

## 18. Remaining risks

- The PRODUCTION identity gate binds database name + server version + the
  session GUC; the connection HOST (`db.fqvekbzwghjurkcawpgg.supabase.co`)
  is operator-verified (runbook step 2). A production artifact could, in
  principle, run against another PostgreSQL-17 database named `postgres`
  with the GUC set — there is no database-side secret or hostname binding
  in Supabase Postgres ("where feasible"; no secrets embedded).
- Supersession `action_at`/`superseded_at` equality relies on the two being
  written in one transaction (`now()` = transaction timestamp) — verified
  in rehearsal; any divergence fails closed.
- R5 endpoints legitimately end with zero live rows; the endpoint-liveness
  postcondition is therefore scoped to R3/R6 (documented in the SQL).
- The rehearsal order check for R6 decisions is exercised via per-run
  manifests; the committed test manifest carries fixed pre-dated test
  timestamps and is REHEARSAL-locked.

## 19. Exact next gate

Independent final review of this package against the commit recorded in
§17, with `bin/build_repair_package.py verify` (must print `VERIFY OK`),
`bin/test_builder_binding.py` (18/18), and `rehearsal/` evidence. Production
execution, migration 013, deployment, and unfreeze remain separately
authorized future operations — this package performs none of them.
