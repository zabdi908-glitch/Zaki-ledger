# Historical Repair Execution Package — 013 Pre-Dedup (HARDENED, DESIGN UNDER REVIEW)

These files form the **execution package** for retiring the 252 accidental
duplicate live-auto reconciliation claims in production
(`fqvekbzwghjurkcawpgg`), per the accepted classification in
`docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md`. They are NOT
migrations and must never be applied by `supabase db push` (which is why they
live outside `supabase/migrations/`). Nothing here runs against production
without an explicitly authorized repair window (see `execution-window.md`).

**The classification is accepted; this package hardens the execution.** The
package is under independent re-review and is not authorized for production
use.

## Package layout

```
repair-013-pre/
  13-repair-prep.sql                prep: supersession columns + audit-evidence
                                    immutability (identical DDL to 013 Z1/Z1b)
  14a-stage1-unapproved-repair.sql  STAGE 1 — supersedes EXACTLY the 154
                                    unapproved rows in the stage-1 manifest
  14b-stage2-approved-repair.sql    STAGE 2 — supersedes only rows the signed
                                    authorization manifest marks
                                    APPROVED_FOR_RETIREMENT (committed version
                                    is bound to the REHEARSAL-ONLY test
                                    manifest and MUST NOT run in production)
  manifests/
    duplicate-endpoints.csv                107 endpoints (exact identity set)
    stage1-unapproved-targets.csv          154 targets + 101 survivor guards
    stage2-approved-candidates.csv         98 candidates (no decisions)
    r6-review.csv                          4 R6 endpoints (human decision input)
    stage2-authorization-manifest-template.csv   template — decisions EMPTY
    stage2-test-authorization-manifest.csv REHEARSAL ONLY — test identity,
                                           all 98 APPROVED_FOR_RETIREMENT
    manifest-identities.json               SHA-256 registry + snapshot
                                           provenance + accepted counts
  bin/build_repair_package.py       deterministic builder/verifier (see below)
  authorization-manifest-schema.md  stage-2 authorization semantics
  r6-review-packet.md               R6 human review evidence + decisions
  execution-window.md               writer exclusion, backup/restore drill,
                                    production-window sequence
  rehearsal/                        committed rehearsal evidence (sanitized)
```

## Key properties

- **Split stages.** Stage 1 (system actor, 154 unapproved rows) and Stage 2
  (accountant-authorized, up to 98 approved rows) are separate executable
  artifacts with an explicit COMMIT/authorization boundary between them.
  Stage 1 never touches an approved row.
- **Exact-ID, manifest-bound.** Each stage embeds its manifest's exact row
  identities (match/QB/bank/statement/tenant/client/book ids, amounts,
  dates, normalized-description SHA-256 fingerprints, intended survivors).
  Any drift — including a substitution, a re-approval, an amount change, a
  survivor change, or an unexpected new duplicate endpoint — aborts the
  whole transaction with zero partial changes.
- **Hash-locked.** Every manifest has a recorded SHA-256
  (`manifest-identities.json`); the SQL embeds the manifest hash it was
  generated from; `bin/build_repair_package.py verify` re-proves hashes,
  classification counts, and SQL binding, and checks the SQL is byte-identical
  to a fresh regeneration.
- **Semantic idempotency.** Re-running a stage after success proves every
  target already carries the stage's fixed operation id with correct
  reason/survivor and audit row, then commits as a verified no-op. Rows
  superseded by any other operation id abort.
- **Writer exclusion.** Both stages take ACCESS EXCLUSIVE table locks in the
  controlled writers' natural order plus row locks; the environment freeze
  remains a verified precondition, never the only exclusion
  (`execution-window.md` §1).
- **Audit evidence.** Every supersession writes one audit row with
  operation id, stage, class, reason, survivor, previous approval stamps,
  previous/resulting state, and manifest hashes. Stage-1 rows carry the
  system repair identity; stage-2 rows carry the confirming accountant's
  identity — the system never makes stage-2 judgements. The new audit
  evidence columns are immutable to UPDATE for every role (013 Z1b, mirrored
  in the prep).
- **No DELETEs. No aggregation-only drift checks.** Counts remain secondary
  assertions; the primary checks are exact set identities.
- **R6 has no default executable decision** — see
  `r6-review-packet.md` and `authorization-manifest-schema.md` §4.

## Rebuild / verify

```bash
# regenerate manifests from the accepted snapshot inventories
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design manifests

# regenerate both stage SQL files (stage 2 from the committed TEST manifest)
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design sql

# regenerate stage 2 from a signed authorization manifest (production window)
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design sql \
  --auth-manifest <signed-manifest.csv>

# prove hashes, classification, and SQL binding (exit 0 = consistent)
python3 bin/build_repair_package.py --snapshot-dir /tmp/zaki-repair-design verify
```

The snapshot inventories live in `/tmp/zaki-repair-design/` (production
snapshot 2026-08-16, read-only capture; their hashes are recorded in
`manifest-identities.json`). They are NOT committed (production data) — the
committed manifests are the reviewable identity artifacts.

## Rehearsal status

Rehearsed end-to-end on a faithful scratch restore of the production dumps:
stage 1 applies 154 and reruns as a no-op; stage 2 (TEST manifest) applies 98
and reruns as a no-op; migration 013 then applies cleanly; five drift/failure
injections each abort with zero partial changes. Evidence:
`rehearsal/EVIDENCE.md`.
