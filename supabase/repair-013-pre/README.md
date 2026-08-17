# Historical Repair Execution Package — 013 Pre-Dedup (AUTHORIZATION-BINDING HARDENED)

These files form the **execution package** for retiring the 252 accidental
duplicate live-auto reconciliation claims in production
(`fqvekbzwghjurkcawpgg`), per the accepted classification in
`docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md`. They are NOT
migrations and must never be applied by `supabase db push` (which is why they
live outside `supabase/migrations/`). Nothing here runs against production
without an explicitly authorized repair window (see `execution-window.md`).

**The classification is accepted; this package hardens the execution.** The
accountant's stage-2 authorization is a *decision over* the committed
immutable basis (`manifests/stage2-immutable-basis.json`) — the manifest
cannot redefine candidate, survivor, class, reason, action, or any
accounting identity. The package is under final independent review and is
not authorized for production use.

## Package layout

```
repair-013-pre/
  13-repair-prep.sql                prep: supersession columns + audit-evidence
                                    immutability (identical DDL to 013 Z1/Z1b)
  14a-stage1-unapproved-repair.sql  STAGE 1 — supersedes EXACTLY the 154
                                    unapproved rows in the stage-1 manifest
                                    (REHEARSAL-mode working copy)
  14b-stage2-approved-repair.sql    STAGE 2 — supersedes only the rows whose
                                    committed-basis candidates carry a signed
                                    RETIRE decision (REHEARSAL-mode working
                                    copy, bound to the committed rehearsal
                                    authorization manifest)
  manifests/
    duplicate-endpoints.csv                107 endpoints (exact identity set)
    stage1-unapproved-targets.csv          154 targets + 101 survivor guards
    stage2-immutable-basis.json            THE COMMITTED AUTHORIZATION BASIS:
                                           189 rows (102 decision-permitted
                                           candidates incl. both R6 pair
                                           members, 87 survivor guards) with
                                           permitted survivor/decision sets
    stage2-approved-candidates.csv         102-candidate inventory (evidence +
                                           permitted sets, no decisions)
    r6-review.csv                          4 R6 endpoints (human decision input)
    stage2-test-decisions.json             the fixed 98 REHEARSAL test choices
    stage2-authorization-manifest-template.json  empty decisions, REHEARSAL mode
    stage2-rehearsal-authorization-manifest.json REHEARSAL ONLY — 98 test
                                           decisions, test identity/timestamp
    manifest-identities.json               SHA-256 registry + snapshot
                                           provenance + accepted counts
  bin/
    build_repair_package.py        deterministic builder/verifier/freezer
    test_builder_binding.py        builder-level authorization-binding
                                   failure/substitution tests (no DB)
  extract/                         committed read-only production capture
                                   queries (see extract/README.md)
  authorization-manifest-schema.md committed basis + decision-only manifest
  r6-review-packet.md              R6 human review evidence + decisions
  execution-window.md              REPAIR-ONLY production runbook (18 steps;
                                   no migration/deploy/unfreeze)
  artifacts/                       committed rehearsal evidence: frozen stage
                                   artifacts + freeze records + stage-1
                                   execution proof + executed rehearsal
                                   authorization manifest
  rehearsal/                       drivers + evidence (sanitized)
    restore-scratch.sh             scratch restore (explicit dump paths +
                                   hash verification)
    run-stage.sh                   hash-verified frozen-artifact runner
    rehearsal-chain.sh             REHEARSAL-ONLY chain: prep -> freeze/verify/
                                   execute stage 1 -> checkpoint -> sign
                                   manifest -> freeze/verify/execute stage 2
                                   -> reruns (NO migration 013)
    run-migration-013.sh           REHEARSAL-ONLY separate migration check
    drift-tests.sh                 5 stage-1 drift injections (abort + zero
                                   partial changes)
    authorization-drift-tests.sh   9 authorization/identity/failure cases
    parity-check.sql               restore parity assertions
    make-local-auth-bootstrap.sh   local auth-schema bootstrap generator
    EVIDENCE.md                    committed rehearsal evidence
```

## Key properties

- **Immutable authorization basis.** All stage-2 accounting identity — match/
  QB/bank/statement ids, tenant/user/client/book, practice id, amounts,
  dates, fingerprints, approval stamps, class, reason, action, and the
  PERMITTED survivor and decision sets — is committed in
  `stage2-immutable-basis.json` and SHA-locked. The accountant cannot change
  any of it.
- **Decision-only authorization manifest.** The manifest contains only
  `match_id + decision + accountant identity + confirmation timestamp +
  note`. Unknown keys, unknown match ids, guard-row decisions,
  both-members-retire on an R6 pair, decisions outside the permitted set,
  and confirmation timestamps before the recorded stage-1 execution are all
  rejected by the builder. Counts are never sufficient.
- **Split stages.** Stage 1 (system actor, 154 unapproved rows) and Stage 2
  (accountant-authorized, up to 98 approved rows) are separate executable
  artifacts with an explicit COMMIT/authorization boundary between them.
  Stage 1 never touches an approved row; it identity-checks every survivor
  guard AND every committed-basis candidate that protects the affected
  endpoints.
- **R6 has no default executable decision.** Both members of each R6 pair
  are decision-permitted candidates with each other as the permitted
  survivor; the accountant selects a side (or neither). No automatic
  earliest-upload execution exists, and the stage-2 freeze requires the
  stage-1 execution proof — R6 decisions mechanically post-date the stage-1
  checkpoint.
- **Environment-mode barrier.** Every artifact carries
  `environment_mode = REHEARSAL | PRODUCTION`, bound into the SQL (a hard
  in-transaction identity gate executed before any lock or write), the audit
  evidence, the freeze record, and the artifact identity hash. REHEARSAL
  artifacts execute only against the scratch restore database `repair_drill`;
  PRODUCTION artifacts execute only against database `postgres` on
  PostgreSQL 17 with the session GUC `zaki.repair_project_ref =
  fqvekbzwghjurkcawpgg`. A rehearsal artifact can never run against
  production, and production rejects rehearsal manifests.
- **Fail closed on missing authorization.** `sql`, `freeze`, and `verify`
  have NO default authorization input: omitting `--auth-manifest` is a hard
  error.
- **Immutable frozen artifacts.** Execution uses the `freeze` subcommand:
  build from committed basis + signed decisions (+ stage-1 proof for stage
  2) → SHA-256 → freeze record → `verify --artifact` independently re-proves
  the frozen bytes → only that hash-verified file is executed. Overwrite is
  refused.
- **Exact-ID, basis-bound SQL.** Each stage embeds its manifest/basis rows
  and fails closed on any drift — including `client_entities` practice
  identity, stale supersession fields, `approved_by` drift, and unexpected
  duplicate-endpoint changes.
- **Semantic idempotency + full audit idempotency.** Re-running a stage
  after success proves every target already carries the stage's fixed
  operation id with correct reason/survivor AND a byte-exact audit row
  (action, actor, action_at, previous_state, resulting_state, evidence) —
  altered audit evidence aborts, never silently no-ops. Rows superseded by
  any other operation id abort.
- **Writer exclusion.** Both stages take ACCESS EXCLUSIVE table locks
  (statements → bank → qb → client_entities → matches → audit) plus row
  locks; the environment freeze remains a verified precondition, never the
  only exclusion.
- **No DELETEs. No aggregation-only drift checks.** Counts remain secondary
  assertions; the primary checks are exact set identities.

## Rebuild / verify / freeze

```bash
# regenerate the committed manifests from the accepted snapshot inventories
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design manifests

# regenerate the REHEARSAL working copies (explicit manifest REQUIRED)
python3 bin/build_repair_package.py sql \
  --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json

# prove hashes, classification, basis, and SQL binding (exit 0 = consistent)
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design verify \
  --auth-manifest manifests/stage2-rehearsal-authorization-manifest.json

# freeze an immutable stage artifact (rehearsal)
python3 bin/build_repair_package.py freeze --stage 1 \
  --environment-mode REHEARSAL --out-dir artifacts

# production window: stage 2 requires the signed manifest + the executed
# stage-1 artifact + its execution proof (see execution-window.md §5)
python3 bin/build_repair_package.py freeze --stage 2 \
  --environment-mode PRODUCTION --auth-manifest <signed.json> \
  --stage1-artifact <window-artifacts>/14a-*.sql \
  --stage1-execution-proof <proof.json> \
  --project-ref fqvekbzwghjurkcawpgg --out-dir <window-artifacts>

# independently re-prove a frozen artifact before execution
python3 bin/build_repair_package.py verify --artifact artifacts/freeze-14b-*.json

# builder-level authorization-binding tests (no database)
python3 bin/test_builder_binding.py
```

The snapshot inventories live in `/tmp/zaki-repair-design/` (production
snapshot 2026-08-16, read-only capture via `supabase/prod-readonly-query.sh`;
their hashes are recorded in `manifest-identities.json`). They are NOT
committed (production data) — the committed manifests are the reviewable
identity artifacts, and the capture queries are committed in `extract/`.

## Rehearsal status

Rehearsed end-to-end on a faithful scratch restore of the production dumps:

- restore parity (9/9 tables + reconciliation + canonical/audit) PASS;
- stage 1 applies 154 and reruns as a byte-exact no-op; stage 2 (rehearsal
  authorization manifest, signed post-stage-1) applies 98 and reruns as a
  byte-exact no-op; stage 1 after stage 2 verifies its own state;
- migration 013 then applies cleanly (separate rehearsal-only check);
- five stage-1 drift injections and nine authorization/identity/failure
  injections each abort with zero partial changes;
- builder-level binding tests (reversal, replacement, smuggling, missing
  manifest, mode barrier, R6 ordering, freeze immutability) all pass.

Evidence: `rehearsal/EVIDENCE.md`.
