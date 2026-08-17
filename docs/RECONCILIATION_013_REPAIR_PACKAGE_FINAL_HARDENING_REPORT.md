# Historical Repair Execution-Integrity Hardening Report

Final execution-integrity hardening of the 013-pre historical repair
execution package (`supabase/repair-013-pre/`), addressing the
independent-review verdict: **REPAIR PACKAGE BLOCKED** on ten
execution-integrity blockers. This report records how each blocker was
resolved and the full rehearsal evidence for the final package.

Scope: execution-package integrity and reproducibility defects only. The
ACCEPTED accounting classification, the candidate/survivor authorization
binding, the Stage-1/Stage-2 split, the Stage-2 decision model, and the R6
human-review model are unchanged and were NOT redesigned. Production was
not modified, no repair SQL ran against production, migration 013 was not
applied, nothing was deployed, main was not merged, and no bank rows were
re-matched. The 107-endpoint classification is unchanged; migration 013's
SHA is unchanged.

## 1. Verdict

**REPAIR PACKAGE READY FOR FINAL INDEPENDENT REVIEW.**

The ten blockers are resolved and proven by committed rehearsal evidence
(`rehearsal/EVIDENCE.md`) and builder-level tests (27/27). Production
execution remains gated on a separately authorized repair window
(`execution-window.md`); migration 013 application, app deployment, and
unfreeze remain separately authorized future operations.

## 2. Binding identity

Rehearsed tree: `4d6ba9a707c69413d88cd5d320002249aef7b658` (the package
commit whose working tree was rehearsed; the evidence commit recording this
SHA follows immediately and its full SHA is recorded in the final report).

Key hashes (full evidence: `rehearsal/EVIDENCE.md`):

- Stage-1 SQL working copy (`14a-stage1-unapproved-repair.sql`):
  `3eaa5525befa134502eda1200f521a48aadb2ad900d3909442029215c321af35`
- Stage-2 SQL working copy (`14b-stage2-approved-repair.sql`):
  `e42d775cc6e24d0515041246a96724a70977ecfbdac7728d22c5eb61f2247a51`
- Frozen rehearsal stage-1 artifact:
  `6f8170082db14cd221e568bf9b0f5fa9d8ba529120359c1a19c59ea86200f24a`
  (identity `6e36e7ad0b0b61385b2fffe604a0a8b2a0fbd8fc9f40a65dc9493b1dcfafbff1`)
- Frozen rehearsal stage-2 artifact:
  `f3d1b68f8dc045be8f1a860bb5abc2070446537d18eec7fd6e5b9ef778e404f3`
  (identity `8ad61d4d6d5e19156bd7d4591f9925b407e83ba941c1c4dee1197da5702a086e`)
- Stage-1 freeze record (`artifacts/freeze-14a-…-c182b4a64148.json`):
  `2e78f065489aa78c4ce8be127af62a15cc7b1457fb8d8d1a2e088564366a79db`
- Stage-2 freeze record (`artifacts/freeze-14b-…-c9807b7e4c05.json`):
  `1333ca8edd1d3e176eda3ab15d698a1ecde32928b1c3fa75b08ae40b68ab986a`
  (binds `authorization_manifest_sha256` `c9807b7e…`,
  `stage1_artifact_sha256` `6f817008…`,
  `stage1_execution_proof_sha256` `fb6a3ffd…`)
- Committed basis `manifests/stage2-immutable-basis.json`:
  `751d9b04ac3695da82821af311a20de7b45fd8bcfd7633f4cd4eb813793bf271`
- Executed rehearsal authorization manifest (post-stage-1, committed under
  `artifacts/`): `c9807b7e4c053539707969c9195d123dee2608a51ae436f0065d1b05a16e27e8`
- Stage-1 execution proof (schema v2):
  `fb6a3ffda3ff5bf1f60934cdfc787395729334b539e9e3722cf25767ca911489`
  (`APPLIED`, stage-1 postcondition digest
  `414f2a2450f2c3babde8b750252fcc5199082f137ba69339a9e36b5dd8e5dd81`,
  audit digest
  `d17f409dc2674cf35dd174619bbce4c9a7a4ea46d671cdd6638143bbc5731ff3`)
- `manifests/manifest-identities.json`:
  `e4c7ecc565c292d8320f798b05baacbb017f8ec5bf10c34330e0f8a2666caf9b`

## 3. Migration 013 SHA

`D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93`
(recomputed 2026-08-17 — unchanged; 010/011/012 untouched).

## 4. Blocker resolution

1. **B1 — exact Stage-1 revalidation (stage 2).** The stage-2 artifact
   embeds the FULL committed stage-1 manifest (255 rows) and revalidates
   EVERY stage-1 target against the exact committed stage-1 result:
   identity/value drift, original unapproved state, operation id, reason,
   survivor link, and byte-exact audit evidence (incl. the stage-1 artifact
   sha). Any drift aborts stage 2 with zero changes. Rehearsal cases
   G10–G14 inject post-checkpoint mutations (reason / survivor / operation
   id / approval identity / audit evidence) — stage 2 aborts, full-state
   digest identical.
2. **B2 — builder-bound stage-1 checkpoint proof.** The proof is
   builder-generated (`stage1-proof` subcommand, schema v2) and binds the
   package git sha, the frozen artifact sha + byte-identity regeneration,
   the committed manifest/basis hashes, the exact 154 target ids, survivor
   mappings, the postcondition digest, the audit digest, and the
   execution-log hash. Caller-created JSON is rejected unless every
   derivable field matches the builder's independent recomputation
   (B18–B21); what the proof does not prove (driver-recorded execution
   facts) is documented in `execution-window.md` §5 step 15.
3. **B3 — independent frozen-artifact verification.** `verify --artifact`
   REGENERATES the expected bytes into a temporary location and requires
   byte-identity + SHA-256 match with the freeze record. A coordinated
   modification of the SQL AND the freeze record fails (B25); a stale
   freeze-record sha fails (B26).
4. **B4 — frozen stage-2 artifact sha in immutable audit evidence.** Every
   stage-2 repair audit event carries `artifact_sha256` (the exact frozen
   stage-2 artifact sha, driver-supplied via the
   `zaki.repair_artifact_sha256` GUC, gate-checked P0b), plus
   `artifact_identity`, `stage2_basis_sha256`,
   `authorization_manifest_sha256`, `stage1_artifact_sha256`,
   `stage1_execution_proof_sha256`, accountant identity, confirmation
   timestamp, operation id, mode. The no-op/idempotency path compares the
   sha byte-exactly.
5. **B5 — finite timeouts before any blocking lock.** Every artifact sets
   `SET LOCAL lock_timeout='30s'` / `statement_timeout='120s'` (P0a)
   BEFORE the environment identity gate is executed first (P0.0) and any
   blocking lock; a timeout aborts the transaction (SQLSTATE 55P03 / 57014)
   and the runbook treats it as STOP, never a blind retry. Rehearsal: G16
   (held conflicting lock → 55P03, full-state digest identical, wait
   bounded), G17 (57014 + rollback semantics, zero changes).
6. **B6 — full state preservation.** `rehearsal/state-digest.sh` computes a
   deterministic JSON digest of all 11 relevant tables
   (`reconciliation_matches`, `reconciliation_audit_log`,
   `bank_transactions`, `qb_transactions`, `bank_statements`,
   `client_entities`, user/client/book rows, canonical tables). Every
   drift/failure case — the 5 stage-1 drift injections, G1–G18, including
   failure after a stage-2 UPDATE before its audit INSERT (G6) — proves
   zero partial changes by digest equality.
7. **B7 — reproducible evidence bound to final HEAD.** `rehearsal/EVIDENCE.md`
   records the package git sha, stage-1 SHA, stage-2 rehearsal SHA, basis
   SHA, auth manifest SHA, proof hash, freeze records, apply/noop outputs,
   parity output, migration-013 output, drift/failure suite results, and
   timeout results. No `/tmp` dependence for the committed record;
   production dumps are excluded (hashes only).
8. **B8 — no dated dump defaults.** `restore-scratch.sh` requires explicit
   `--schema-dump` / `--data-dump` (FAIL without them); the rehearsal
   drivers (`rehearsal-chain.sh`, `drift-tests.sh`,
   `authorization-drift-tests.sh`) require explicit `SCHEMA_DUMP` /
   `DATA_DUMP` env vars and fail closed otherwise.
9. **B9 — R6 packet documents the JSON format.** `r6-review-packet.md`
   removed the obsolete `--auth-manifest <signed.csv>` examples; it
   documents the decision-only JSON manifest the builder accepts and that
   there is NO CSV authorization format.
10. **B10 — repair-only runbook, 23 exact steps.** `execution-window.md`
    sequences: git SHA verification, artifact hashes, production identity,
    freeze-capable app, freeze on, quiescence, finite timeouts, fresh
    dumps, dump hashes, scratch restore, parity proof, prep, freeze/hash
    stage 1, stage-1 execution, full-state + checkpoint proof, **STOP**,
    accountant decisions incl. R6, build stage 2, regenerate/independently
    verify, hash/freeze record, execute the exact frozen stage-2, final
    verification, **STOP**. Migration 013, app deployment, and unfreeze are
    deliberately absent.

## 5. Authorization manifest semantics (unchanged)

Decision-only JSON: `match_id, decision (RETIRE|DO_NOT_REPAIR),
accountant_identity, confirmation_timestamp, note`. Unknown keys, unknown
match ids, guard-row decisions, decisions outside the permitted set,
both-members-retire on an R6 pair, and confirmation timestamps before the
recorded stage-1 execution are rejected (builder tests B1–B12). The
committed `stage2-rehearsal-authorization-manifest.json` carries fixed
pre-dated REHEARSAL test timestamps and is REHEARSAL-locked; the EXECUTED
rehearsal manifest is per-run stamped after the stage-1 proof and is the
manifest bound to the frozen stage-2 rehearsal artifact (see §2).

## 6. Rehearsal/production barrier (unchanged)

`environment_mode = REHEARSAL | PRODUCTION` is bound into the manifest, the
generated SQL (a hard in-transaction identity gate executed FIRST), the
audit evidence, the freeze record, and the artifact identity hash. G8
(rehearsal artifact vs the dev database) and G9 (production artifact vs the
scratch identity) fail closed.

## 7. R6 authorization boundary (unchanged)

Both members of every R6 pair are decision-permitted candidates with the
partner as the permitted survivor; no default executable decision exists.
Every stage-2 freeze requires the stage-1 execution proof, and every
decision's `confirmation_timestamp` must not predate the proof's
`executed_at` — R6 decisions mechanically post-date the stage-1 checkpoint.

## 8. Stage-2 build/freeze process (hardened)

`freeze --stage 2` requires `--auth-manifest` + `--stage1-artifact` +
`--stage1-execution-proof`; it revalidates every derivable field of the
proof and the frozen stage-1 artifact, validates decisions against the
committed basis, writes the exact SQL to a unique immutable path (overwrite
refused), and records SHA-256 + identity + all binding hashes in the freeze
record. `verify --artifact` independently REGENERATES the expected bytes
and requires byte-identity + SHA-256 match — a coordinated SQL+freeze-record
tamper fails (B25).

## 9. Exact drift coverage (unchanged + rehearsal-proven)

`client_entities` identity (G1/G2), `approved_by` (G3), clean supersession
pre-state (G4), and the stage-2 artifact's exact revalidation of all 154
stage-1 targets (G10–G14) plus the candidate/survivor substitution guard
(G15) — all abort with zero partial changes, proven by full-state digest
equality.

## 10. Full audit idempotency (unchanged)

A same-operation audit row counts as DONE only if its stored evidence is
byte-exact (G5/G7). Altered evidence makes the row neither live nor done —
the dispatcher aborts.

## 11. Substitution/failure tests

`bin/test_builder_binding.py` (27/27 pass, no database): reversal (B1),
candidate replacement (B2), identity smuggling (B3/B4), R6 swap legality
(B5), both-retire (B6), missing `--auth-manifest` (B7), rehearsal manifest
in PRODUCTION (B8), wrong project identity (B9), pre-checkpoint R6 decision
(B10), wrong basis sha (B11), legacy CSV manifest (B12), missing/wrong
stage-1 proof (B13/B14), proof tampering — survivor / target ids /
digests / git sha (B18–B21), coordinated artifact+proof tamper (B22),
schema-v1 proof rejection (B23), valid stage-2 freeze verification (B24),
coordinated SQL+freeze-record tamper fails (B25), stale freeze-record sha
fails (B26), freeze immutability / gates / determinism (B15–B17, B27).

`rehearsal/authorization-drift-tests.sh` (18/18 pass): G1–G9 (identity,
approval, supersession, audit, partial-completion, mode-barrier cases) plus
G10–G14 (post-checkpoint stage-1 reason / survivor / operation-id /
approval / audit-evidence drift — stage 2 aborts), G15 (candidate/
survivor substitution), G16 (held conflicting lock → 55P03), G17
(statement-timeout 57014 + rollback), G18 (missing artifact-sha GUC) —
every case fails closed with zero partial changes (full-state digest
equality).

`rehearsal/drift-tests.sh` (5/5 pass): stage-1 approval change, amount
change, substituted match, new duplicate endpoint, survivor change.

## 12. Reproducibility tooling (unchanged)

Read-only extraction queries committed under `repair-013-pre/extract/`;
guarded wrapper `supabase/prod-readonly-query.sh` fixes the target to
production and prepends a read-only guard. No customer dumps are
committed. The auth bootstrap dependency is replaced by a sanitized local
generator. `verify` re-proves snapshot provenance hashes and basis
byte-identity.

## 13. Rehearsal evidence

`rehearsal/EVIDENCE.md` is regenerated and binds the package git sha,
migration 013 SHA, stage SQL SHAs (working copies + frozen artifacts),
manifest hashes, dump hashes, freeze records, the schema-v2 proof, and the
executed rehearsal manifest. Committed artifacts under `repair-013-pre/artifacts/`
include both frozen SQL files, freeze records, the stage-1 execution proof,
and the executed rehearsal authorization manifest.

## 14. Restore tooling (hardened)

`restore-scratch.sh` requires explicit `--schema-dump` / `--data-dump` and
fails without them; optional `--schema-sha256` / `--data-sha256` verify
hashes before restore. The rehearsal drivers inherit the same
fail-closed requirement via explicit `SCHEMA_DUMP` / `DATA_DUMP` env vars.
No dated dump filenames remain anywhere in the tooling.

## 15. Repair-only runbook

`execution-window.md` is the REPAIR-ONLY runbook: 23 exact steps with
**STOP** after stage 1 (step 16, authorization checkpoint) and at the end
(step 23). §1.4 defines the finite timeout policy (30s/120s, SQLSTATE
55P03/57014, timeout = STOP), §1.5 the artifact-sha GUC binding, §2 the
hard stop conditions, §3 the mechanical environment-mode barrier, §4 the
fresh-dump backup/restore drill. Migration 013 application, app
deployment, and unfreeze are separate, separately authorized operations and
are absent.

## 16. Validation results

- `npm run test:unit`: **498 passed** (20 skipped), 0 failed.
- `npm run test:local-db`: **191 passed** (8 skipped), 0 failed.
- `npm run typecheck`: clean. `npm run build`: clean.
- Fresh local `supabase db reset` 001→013: clean apply, no errors.
- Full scratch rehearsal repeated on the final tree: restore parity PASS;
  stage 1 applies 154 + byte-exact no-op rerun; schema-v2 checkpoint proof;
  stage 2 (executed rehearsal manifest, post-proof timestamps) applies 98 +
  byte-exact no-op rerun; stage-1-after-stage-2 no-op; final state 573
  total / 252 superseded / 321 live / 0 duplicate live-auto / 252 repair
  audit rows; every audit row carries the exact frozen artifact sha256.
- Migration-013 compatibility check on the repaired copy: PASS.
- Stage-1 drift injections: 5/5 PASS. Authorization/identity/failure
  injections: 18/18 PASS (incl. G10–G14 post-checkpoint stage-1 drift,
  G15 substitution, G16 55P03, G17 57014, G18 missing GUC).
- Builder-level binding tests: **27 passed, 0 failed**.
- Independent verification of both committed frozen artifacts:
  `VERIFY OK` (byte-identical independent regeneration).

## 17. Commit identity

Rehearsed tree: `4d6ba9a707c69413d88cd5d320002249aef7b658`. The evidence
commit recording this SHA (this report + `rehearsal/EVIDENCE.md` +
regenerated artifacts) is the immediately following commit; its full SHA is
recorded in the final report. No commit was amended; the working tree ends
clean.

## 18. Remaining risks

- The PRODUCTION identity gate binds database name + server version + the
  session GUC; the connection HOST is operator-verified (runbook step 3).
  A production artifact could, in principle, run against another
  PostgreSQL-17 database named `postgres` with the GUC set — there is no
  database-side secret or hostname binding in Supabase Postgres ("where
  feasible"; no secrets embedded).
- The committed `stage2-rehearsal-authorization-manifest.json` carries
  fixed pre-dated test timestamps (REHEARSAL-locked by construction). The
  frozen rehearsal artifacts are bound to the per-run executed manifest —
  verification must use the executed manifest under `artifacts/`, not the
  fixed-timestamp test-decisions manifest.
- Supersession `action_at`/`superseded_at` equality relies on the two being
  written in one transaction — verified in rehearsal; any divergence fails
  closed.
- R5 endpoints legitimately end with zero live rows; the endpoint-liveness
  postcondition is scoped to R3/R6 (documented in the SQL).

## 19. Exact next gate

Independent final review of this package against the commit recorded in
§17, with `bin/build_repair_package.py verify` (must print `VERIFY OK`),
`bin/test_builder_binding.py` (27/27), and `rehearsal/EVIDENCE.md`.
Production execution, migration 013, deployment, and unfreeze remain
separately authorized future operations — this package performs none of
them.
