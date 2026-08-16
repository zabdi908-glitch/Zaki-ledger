# Historical Reconciliation Repair Package Hardening Report

Hardening of the 013-pre historical repair **execution package**, per the
independent review of the accepted classification
(`docs/RECONCILIATION_HISTORICAL_REPAIR_DESIGN_REPORT.md`). The 107-endpoint
classification is accepted and was NOT redone; this task made the approved
repair separately authorizable and fail-closed. Executed 2026-08-17 on branch
`fix/reconciliation-candidate-hardening`.

Nothing here ran against production. No production data was modified, no
repair SQL executed against production, migration 013 was not applied to
production, nothing was deployed, nothing was merged to `main`.

---

## 1. Verdict

**REPAIR PACKAGE READY FOR INDEPENDENT RE-REVIEW**

All ten blockers from the independent review are addressed, the split package
is rehearsed end-to-end on a faithful scratch restore of the production
snapshot (stage 1 → rerun no-op → stage 2 under a clearly marked TEST
authorization manifest → rerun no-op → migration 013 applies cleanly), five
deliberate drift/failure injections each abort with zero partial changes, and
the full validation suite (unit, local-DB, typecheck, build, fresh reset
001→013) is green. The package is NOT authorized for production execution —
that is a separate gate.

## 2. Artifact identity

```
supabase/repair-013-pre/
  13-repair-prep.sql                        prep (supersession columns + audit-evidence
                                            immutability, identical DDL to 013 Z1/Z1b)
  14a-stage1-unapproved-repair.sql          STAGE 1 (generated, exact-ID, manifest-bound)
  14b-stage2-approved-repair.sql            STAGE 2 (generated from the REHEARSAL-ONLY
                                            test authorization manifest)
  manifests/                                duplicate-endpoints.csv,
                                            stage1-unapproved-targets.csv,
                                            stage2-approved-candidates.csv,
                                            r6-review.csv,
                                            stage2-authorization-manifest-template.csv,
                                            stage2-test-authorization-manifest.csv,
                                            manifest-identities.json (SHA-256 registry)
  bin/build_repair_package.py               deterministic builder/verifier (manifests |
                                            sql | verify)
  authorization-manifest-schema.md          stage-2 authorization semantics
  r6-review-packet.md                       R6 human-review evidence + decisions
  execution-window.md                       writer exclusion, backup/restore drill,
                                            production-window sequence
  rehearsal/                                restore-scratch.sh, parity-check.sql,
                                            run-stages.sh, drift-tests.sh, EVIDENCE.md
supabase/migrations/013_reconciliation_claim_hardening.sql   + Z1b immutability
zakiledger/tests/repair-audit-evidence-immutability.test.ts  + 013 Z1b regression suite
```

The old all-in-one `14-repair-op.sql` was removed (replaced by the two stage
files; git history retains it). `supabase/config.toml` is gitignored as
explicitly local-only state.

## 3. Exact manifest hashes

(SHA-256, recorded in `manifests/manifest-identities.json` and re-verified by
`bin/build_repair_package.py verify`.)

| Manifest | Rows | SHA-256 |
|---|---|---|
| duplicate-endpoints.csv | 107 | `73aea8a2452d894264952c60bdb09421bd5140d6afd664ba4f0d86cc9d55a402` |
| stage1-unapproved-targets.csv | 255 (154 targets + 101 survivor guards) | `c182b4a64148ad697a9a4e7561f3ea38aa14f9193ca790beee9dfafa1c6b61fb` |
| stage2-approved-candidates.csv | 98 | `0e8bccc1f683a6a3a59c7200586b7a102a9bfd00ddb5a17b6982afb912c66486` |
| r6-review.csv | 4 | `5c1603aa30d3b546ffde12435d116b4dc5efbebee4dd0ab556a9900a1ec33ff0` |
| stage2-authorization-manifest-template.csv | 189 (decisions EMPTY) | `93909c1996ff949fb50d95c16daa5f6598444c8fe5f5f2149aad5255448711a5` |
| stage2-test-authorization-manifest.csv | 189 (**REHEARSAL ONLY**) | `0ff013d452e4893d018fe9bea79b49a5ecc91a85f738812fd70528c1df273dd2` |

Every row carries match/QB/bank/statement ids, tenant/user/client/book
identifiers, approval stamps, confidence, matched_by, bank and QB amounts,
dates, descriptions, normalized-description SHA-256 fingerprints
(NFKC + lowercase + whitespace-collapse; builder-asserted ASCII so the SQL
`lower(regexp_replace(...))` preimage is identical), intended survivor where
deterministic, class, and proposed reason.

## 4. Stage-1 design

`14a` is one transaction: shared advisory lock (`0x5A414B49`) → ACCESS
EXCLUSIVE table locks in controlled-writer order → manifest load (exact rows
embedded; integrity-count asserts) → **dispatcher** (all-154-live → apply;
all-154-already-this-operation → verified no-op; anything else → abort) →
**exact drift preconditions** (§8) → supersede exactly the 154 manifest
targets (deterministic match-id order) + one audit row each → **exact
postconditions** (§5) → COMMIT. Fixed operation id
`0a1a1a01-4a5e-4b1a-8c01-013000000001`.

## 5. Stage-1 postcondition

Asserted with set identity, not counts alone: superseded set == the 154
manifest targets exactly (both directions); every target carries the stage-1
operation id, its manifest reason, and its manifest survivor; the repair
audit rows for the operation map 1:1 onto the targets (both directions, no
duplicates); all 101 intended survivors still live/approved/stamp-identical;
no row superseded by stage 1 was approved (and, in apply mode, zero approved
rows superseded at all); no DELETE (573 total); 154 superseded / 419 live /
91 duplicate endpoints (exact set) / 154 repair audits. Then COMMIT and STOP.

## 6. Stage-2 authorization design

`14b` executes a row iff its exact `match_id` is present in the authorization
manifest with `authorization_status = APPROVED_FOR_RETIREMENT` **and**
`accountant_decision = RETIRE`, with non-empty `accountant_identity` and
`confirmation_timestamp`. All other candidates are asserted untouched and
live. The stage-1 completion precondition is exact (all 154 stage-1 ids
superseded with the stage-1 operation id + audit rows). Survivor guards (87
R3 exact rows + 4 R6 keep rows) must stay live/approved/fingerprint-identical.
Fewer than 98 authorized rows is supported (exact postconditions computed
from the authorized subset); migration 013 then remains blocked — never
forced. The committed `14b` is bound to the TEST manifest's SHA-256 and
cannot run in production; the window regenerates it from the signed manifest
(see `authorization-manifest-schema.md`, `execution-window.md` §3 step 4).

## 7. R6 human-review package

`r6-review.csv` + `r6-review-packet.md` present the 4 endpoints (QB id, both
approved match ids, bank transactions, statements, upload timestamps/
provenance, amounts, dates, descriptions, confidence, approval audit ids,
recommendation "likely duplicate import / keep earliest", and empty
`KEEP_MATCH_ID` / `RETIRE_MATCH_ID` / `DO_NOT_REPAIR` decision fields). The
executable stage-2 manifest stays incomplete until a human supplies the
decisions; nothing auto-retires R6 on earliest-upload.

## 8. Exact drift protection

Every manifest row is validated against live DB state before any write:
existence; approval state (targets: stage 1 unapproved / stage 2 exact
`approved_at`+`approved_by` stamps); superseded state (mode-aware); QB/bank/
statement endpoints; user/client/ledger-book; confidence; matched_by;
matched_at; flagged_level; bank/QB amount and date; merchant; raw
descriptions; and recomputed SHA-256 description fingerprints via
`extensions.digest`. Duplicate-endpoint sets are compared in both directions
(no unexpected new endpoints; none missing). Apply-mode population guards:
357 live-auto rows / 203 approved rows on the 107 endpoints, 409 approved
globally, 0 manual, 573 total. Aggregate counts remain secondary.

## 9. Writer exclusion/locking

Both stages take `pg_advisory_xact_lock(0x5A414B49)` then ACCESS EXCLUSIVE
table locks on bank_statements → bank_transactions → qb_transactions →
reconciliation_matches → reconciliation_audit_log — the controlled writers'
natural order, making deadlock impossible for controlled paths — plus
UUID-ordered row locks on targets. This excludes app writers, stale app
instances, direct service-role calls, and background workers at the database
level. Superuser console sessions are not excludable by locks, so verified
writer quiescence (freeze env re-verified, deployed commit includes
`ebeed9d`, no active reconciliation writers) is a hard stop condition before
the window. Full analysis: `execution-window.md` §1.

## 10. Audit evidence

Each supersession writes one `reconciliation_audit_log` row:
`operation_id` (stage operation), `action = match_repair_superseded`,
`action_by` = `zaki-repair-stage1-system` (stage 1) or the confirming
accountant's identity from the manifest (stage 2 — the system never makes
stage-2 judgements; enforced in SQL postconditions), `previous_state` /
`resulting_state` capturing the full transition, and `evidence` = stage,
class, reason, old match id, survivor match id, previous approval
timestamp/approver/confidence, and the manifest SHA-256(s). Action timestamp
= `action_at`.

## 11. Audit immutability

Migration 013 gained **Z1b**: trigger
`audit_log_repair_evidence_immutable` blocking UPDATE of `operation_id`,
`previous_state`, `resulting_state`, `evidence` for every role (mirroring
012's model; INSERT-only), plus a C2b end-of-migration assertion. The prep
installs the identical trigger so protection exists from prep time (including
a stage-1 → stage-2 interim). New regression suite
`zakiledger/tests/repair-audit-evidence-immutability.test.ts` (9 tests):
service-role and direct-postgres UPDATE attacks on all four columns fail
42806, legacy 012 protections intact, seeded row survives unchanged.

## 12. Idempotency

Semantic, keyed on exact operation identity: a re-run proves every target
already carries the stage's fixed operation id with correct reason/survivor
and a matching audit row, verifies survivors and no-approved-touched
invariants, then commits as a no-op. Rows superseded by any other operation
id abort. Stage 1 rerun after stage 2 verifies its own operation state
without claiming stage-2 state. Counts are never an idempotency key.

## 13. Backup/restore runbook

`execution-window.md` §2–§3: fresh freeze-time schema + data dumps, SHA-256,
scratch restore prerequisites (extensions/vault schemas, realtime
publication, Supabase auth schema containing the snapshot's user identity
anchors, `supabase_admin`), 9/9 parity + reconciliation parity + canonical/
audit parity + restore-usability proof, then the exact 11-step window
sequence. Old rehearsal dumps never substitute.

## 14. Rehearsal evidence

Committed in `supabase/repair-013-pre/rehearsal/EVIDENCE.md`: dump hashes,
manifest hashes, restore parity output, per-step stage outputs (stage 1
apply 154 / rerun no-op; stage 2 TEST-manifest apply 98 / rerun no-op;
stage 1 after stage 2 own-state no-op), migration-013 post-repair output
(Z2 passed, C1–C5/C2b passed), final state 573/252/321/0/252 with per-
operation verification. The test authorization manifest is marked
REHEARSAL-ONLY and cannot be used in production.

## 15. Failure/drift tests

Five deliberate mutations on fresh restores — (1) approve a stage-1 target,
(2) change a target's bank amount, (3) substitute a target's QB endpoint,
(4) create a new duplicate live-auto endpoint, (5) supersede an intended
survivor — each aborted stage 1 with the expected diagnosis and **zero
partial changes** (0 repair-superseded rows, 0 repair audit rows after every
abort). Driver: `rehearsal/drift-tests.sh`.

## 16. Migration 013 SHA

| Version | SHA-256 |
|---|---|
| Pre-hardening (unchanged 013) | `42B12EBB4CEE9057161C376B6873630407D7479B32E2407ACEC2446A02B2527A` |
| Hardened (Z1b + C2b) | `D9086AD51B3CB9F5796C6F06F5B0BEC338D3BB485C1F1F4C996A0D52C1B2CD93` |

The preflight report's hash table was updated with the hardened row.
Migrations 010/011/012 untouched.

## 17. Test/typecheck/build results

| Command | Result |
|---|---|
| `npm run test:unit` | 53 files, 498 passed, 20 skipped |
| `npm run test:local-db` | 9 files, 191 passed, 8 skipped (fresh reset 001→013; includes the new Z1b suite) |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `bin/build_repair_package.py verify` | VERIFY OK (hashes, classification, SQL binding, byte-identical regeneration) |

Fresh local reset 001→013 applies cleanly with the hardened migration.

## 18. Clean artifact status

Committed: final manifests, split stage SQL, authorization schema/template +
TEST manifest, R6 packet, invariant/audit changes, deterministic
builder/verifier, rehearsal scripts + sanitized evidence, runbook, final
reports, Z1b tests. Not committed: secrets, production dumps, credentials,
logs, `supabase/config.toml` (now gitignored as explicitly local-only).
Working tree clean after commit.

## 19. Remaining risks

1. **Superuser console sessions** are outside any lock's reach — mitigated
   only by quiescence verification and window discipline (hard stop if not
   verifiable).
2. **Snapshot staleness**: the manifests bind to the 2026-08-16 snapshot;
   the window's fresh dumps + exact drift preconditions are the defense, and
   any production change since the snapshot aborts the run (fail-closed,
   requiring re-inventory).
3. **Partial stage-2 authorization** leaves migration 013 blocked by design;
   the runbook requires unfreezing safely with a fresh backup in that case.
4. **R6 as two real movements** would need post-013 manual representation —
   documented in the review packet; nothing executes without the human
   decision.
5. Freeze env state on Render and the deployed commit must be re-verified at
   window time (unchanged from the preflight risk register).

## 20. Exact next gate

1. Independent re-review of this package (manifests + hashes, 14a/14b, 013
   Z1b diff, rehearsal evidence).
2. Separate authorization of the production repair window and of the
   accountant's stage-2 authorization manifest.
3. At the window: freeze → fresh backup/drill → `verify` → regenerate stage 2
   from the signed manifest → stage 1 (+ rerun proof) → report gate → stage 2
   (+ rerun proof) → migration gate (013 only at 0 duplicate endpoints) →
   post-apply checklist → deploy hardening app → unfreeze.

STOP. Production was NOT repaired. Migration 013 was NOT applied to
production. Nothing was deployed. Nothing was merged to `main`.
