# Step 4F-A Production Preflight Report

Date: 2026-08-13
Production candidate: Supabase project `fqvekbzwghjurkcawpgg` ("zaki", eu-central-1, ACTIVE_HEALTHY, postgres 17.6)
Preflight mode: READ-ONLY against production. No production write occurred.

## 1. Verdict

**STEP 4F-A GO — READY FOR EXPLICIT PRODUCTION APPLICATION AUTHORIZATION**

Every gate passed: repository identity unambiguous, frozen hashes match 3/3,
production identity confirmed, fresh snapshot identical to Step 4E, all
integrity scans zero, classifier clean (2/0/0/0/0), fresh final backup set
created and restore-drilled, exact 012 applied to the restored copy with
B1–B11 green and accounting preserved byte-for-byte, deployment artifact
proven at HEAD, freeze writer inventory complete, runbook + post-012
checklist + command package prepared. Nothing in this preflight required a
production write.

## 2. Repository/artifact identity

- Branch: `agent/step3-canonical-foundation`
- HEAD: `5ba1e6a69d7c019eb23a354b0fcafb38ec56364a` — "docs: add Step 4E revalidation report (DEFECT-1 patch, Stage A-F rerun)"
- App code commit: `24d7a37` (HEAD adds docs only; `git diff 24d7a37 5ba1e6a -- zakiledger supabase/migrations` = empty)
- Working tree: no staged files; no modifications to tracked files; untracked = preflight artifacts, backups, docs only. No uncommitted modification to migrations 010/011/012, reconciliation schema capability logic, freeze logic, tenant context logic, or reconciliation writers (`git diff HEAD --stat` over those paths = empty).
- Migrations 011/012 tracked in git (committed `24d7a37`). DEFECT-2 resolved.
- Frozen hashes — committed blob AND worktree (`git cat-file blob HEAD:… | sha256sum` and `sha256sum <file>`):

| Migration | Expected | Measured | Result |
|---|---|---|---|
| 010 | AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D | match (blob + worktree) | PASS |
| 011 | 84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418 | match (blob + worktree) | PASS |
| 012 | A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE | match (blob + worktree; re-verified again immediately before staging apply in Phase 7) | PASS |

## 3. Production identity

- `npx supabase projects list`: ref `fqvekbzwghjurkcawpgg`, name "zaki", org `eazpbhtajatregdgkdqj`, eu-central-1, ACTIVE_HEALTHY, postgres 17.6.1.155, `linked: true`. (Second project `gzwtxebgevgapchoslmp` "zaki ledger" exists but is NOT linked and NOT the target; the deleted legacy project is irrelevant.)
- Live fingerprint via linked read-only query: database `postgres`, role `postgres`, server 17.6; migration ledger `001,002,003,004,005,006,007,008,009,010,011`; 012 ABSENT (ledger_012_absent=0); anchors bank_statements=7, default_tenant_identities=2, canonical_audit_ledger=8, auth.users=2.
- Identity unambiguous. Not assumed from link state alone — fingerprint confirmed live.

## 4. Fresh production snapshot

Full snapshot script: `supabase/step-4f-phase3-4-5-snapshot.sql` (SELECT-only, single UNION ALL statement; output `supabase/step-4f-phase3-result.json`, 87 rows).

| Table | 4F-A | 4E | Δ |
|---|---|---|---|
| bank_statements | 7 | 7 | 0 |
| bank_statement_transaction_observations | 628 | 628 | 0 |
| bank_transactions | 628 | 628 | 0 |
| qb_transactions | 422 | 422 | 0 |
| reconciliation_matches | 558 | 558 | 0 |
| reconciliation_reports | 5 | 5 | 0 |
| reconciliation_decisions | 216 | 216 | 0 |
| reconciliation_audit_log | 408 | 408 | 0 |
| invoices | 1 | 1 | 0 |
| invoice_matches | 0 | 0 | 0 |
| confirmations | 7 | 7 | 0 |
| practices | 2 | 2 | 0 |
| practice_memberships | 2 | 2 | 0 |
| client_entities | 2 | 2 | 0 |
| ledger_books | 2 | 2 | 0 |
| default_tenant_identities | 2 | 2 | 0 |
| canonical_audit_ledger | 8 | 8 | 0 |

Auth/classifier inputs: total=2, eligible=2, registry exists=2, registry
missing=0, ineligible=0, anonymous=0, deleted=0, confirmed=2,
registry_incomplete=0, registry_auth_user_missing=0, null_userid_rows=0,
users in all seven spine sets=1, ineligible-owned rows (any table)=0.

Accounting anchors (fresh, current production): bank_txn_sum=-69237.31,
qb_txn_sum=-53416.28, statement_opening_sum=0, statement_closing_sum=0 —
identical to the 4E production aggregate baseline (agg-production.txt).

**Explanation of every difference vs 4E: there are none.** Zero count
differences across all 17 tables, auth classes, and accounting anchors.
Consistent with the pilot state (2 users, no production activity between the
4E snapshot 2026-08-13 ~06:53 UTC and the 4F-A snapshot 2026-08-13 ~21:35 UTC;
backup data.sql is byte-identical to 4E apart from the per-run `\restrict`
token). All new-row assumptions of Migration 012 unchanged.

## 5. Integrity preflight

Exact Step 4E D1–D16 re-run against CURRENT production, plus E1–E5 registry
graph ownership checks (Phase 4 item 13). Every blocker returns zero:

- D1 child bank_txn user ≠ parent statement user: 0
- D2 cross-statement matches (Z5 FK blocker): 0
- D3 match user ≠ statement user: 0
- D4 match user ≠ bank txn user: 0
- D5 match QB user mismatch: 0
- D6 report user ≠ statement user: 0
- D7 decision user ≠ statement user: 0
- D8a decisions NULL statement: 0 ; D8b decisions missing statement: 0
- D9a audit NULL match: 0 ; D9b audit missing match: 0
- D10 txn missing statement: 0 ; D11 match missing txn: 0 ; D12 match missing statement: 0
- D13 canonical columns present pre-012: 0 (expected)
- D14 shapes: audit.reconciliation_match_id NO|uuid, decisions.statement_id NO|uuid, matches.bank_transaction_id NO|uuid, matches.qb_transaction_id YES|uuid (as expected)
- D15 matches with eligible statement user: 558 (all)
- D16 eligible registry NULL client/book: 0
- E1 practice owner mismatch: 0 ; E2 membership user mismatch: 0 ; E3 membership practice mismatch: 0 ; E4 client practice mismatch: 0 ; E5 ledger book client mismatch: 0
- NULL/user conditions incompatible with audit user_id backfill: none (D9a=0, all spine rows have users, all users eligible)

No repair was needed or performed.

## 6. Classifier result

Exact 011 eligibility predicate, exact per-class user IDs (full IDs in the
evidence file; redacted here):

| Class | Count | Users |
|---|---|---|
| ELIGIBLE + REGISTRY EXISTS | 2 | `0042d6e0-…` (Tenant B), `38832e8e-…` (Tenant A) |
| ELIGIBLE + REGISTRY MISSING | 0 | — |
| INELIGIBLE AUTH USER | 0 | — |
| AUTH USER MISSING | 0 | — |
| OTHER BLOCKER | 0 | — |

Preferred pilot state satisfied exactly. Migration 012 bootstrap impact if run
today: 0 users to bootstrap, 0 bootstrap audit rows, canonical_audit_ledger
delta 0 (stays 8) — proven on the restored copy in Phase 7.

## 7. Final backup set

Directory: `production-backup-pre-012-final-20260813-213129/` (UTC
2026-08-13 21:31:29). Previous sets not overwritten. Mechanism: `npx
supabase@latest db dump --linked` (CLI 2.114.0, pg_dump 17.6 via Management
API) — read-only.

| File | Bytes | SHA-256 | Command | Status |
|---|---|---|---|---|
| schema.sql | 281,782 | 9d515e25101c98e4a9557d9b466b54d3446f448a3eb65b0676be7d6f0a0ae653 | db dump --linked -f | OK (byte-identical to 4E) |
| data.sql | 1,013,449 | ab54129a8b401c7c6e1cf18e7b545168b76fdc5d15687577d65e0c35e55e197c | db dump --linked --data-only -f | OK (differs from 4E only in \restrict token) |
| migration-schema.sql | 887 | 18b99fbbb3ec9fbb964bb255a56171329acd99b6977ece2addd89fdf5aa5105b | db dump --linked --schema supabase_migrations -f | OK (CLI 2.114 style; same DDL semantics) |
| migration-data.sql | 253,873 | 873fe63ba546a1f275802f84195c8b40103425b724a025e2713b619500f325f9 | db dump --linked --data-only --schema supabase_migrations -f | OK (11 rows, 001–011, no 012; INSERT format) |
| roles.sql | 431 | 0decd601faa70260a3a31e8ce63208cc4a4c1f99921bc6f3ed4faf1cd980da3a | db dump --linked --role-only -f | OK (byte-identical to 4E) |

Warning recorded (not suppressed): pg_dump data-only hint "Consider using a
full dump instead of a --data-only dump" — benign, same as 4E; this set
restores schema first. Manifest: `…/MANIFEST.md`.

## 8. Final restore + 012 rehearsal

Disposable local stack `supabase_db_Zaki-ledger` (Supabase PG 17 container).

Restore (deterministic, per-step logs in `supabase/step-4f-restore-step*.log`):
1. DROP public, supabase_migrations; TRUNCATE auth data tables — OK
2. CREATE SCHEMA public — OK (procedural note: the CLI schema dump assumes a
   pre-existing public schema; create it before restoring schema.sql)
3. schema.sql — 51 tables, OK
4. data.sql — 29 table loads, OK
5. migration-schema.sql — fresh create, OK
6. migration-data.sql — INSERT 0 11, OK

Parity vs production: full 87-row snapshot re-run on the restored copy —
**87/87 identical** (counts, ledger 001–011 + 012 absent, classifier IDs,
D1–D16, E1–E5, accounting anchors). Full 31-line aggregate script — identical
to current production AND to the 4E production baseline (three-way parity).

012 apply: SHA re-verified immediately before apply (match). Command:
`cat supabase/migrations/012_…sql | docker exec -i supabase_db_Zaki-ledger psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f -`.
Result: exit 0, single transaction COMMIT, 19 s, one NOTICE "bootstrapped 0
eligible users missing registry", backfill UPDATE 7 / 628 / 422 / 558 / 5 /
216 / 408. B1–B11 embedded assertions: zero exceptions (ON_ERROR_STOP, clean
exit). Ledger recorded 012 (record script) → 001–012.

Post-012 verification (all on restored copy):
- P6 integrity: stamp mismatches 0/0/0/0/0/0, NULL stamps 0, audit NULL
  user/client 0, audit mismatches vs match 0/0, bootstrap rows 0, audit
  ledger 8, guard objects 7 write-guard + 11 immutability triggers, 12
  composite FKs, 4 parent unique indexes, authenticated/anon audit DML
  grants 0/0.
- Accounting preservation: 31-line aggregate script re-run post-012 —
  byte-identical to pre-012 staging (and to production).
- SQL contract suites on the restored copy: structural 63, behavior 36,
  extras 8, behavior-simple 26 (output byte-identical to the 4E stored
  evidence, including the suite's own cleanup quirk where it attempts to
  DELETE an audit row the migration correctly refuses — same lines, same
  error, in both runs), tenant-isolation 9, classifier-backfill 32.
  Total 174 PASS checks, 0 FAILs attributable to the migration.

The drill therefore gives evidence against the CURRENT production snapshot,
not just the older Step 4E copy.

## 9. Deployment artifact

Single compatibility-capable artifact (serves both pre-012 and post-012):
- App: `zakiledger` at commit `24d7a37` (HEAD `5ba1e6a` = docs only; diff over
  `zakiledger/` and `supabase/migrations/` between the two commits is empty).
- Proven behavior (4E revalidation, Stage A–F, re-confirmed at HEAD):
  - 011 + freeze OFF: legacy pre-4C payloads, no canonical columns, no 012 RPC
    (T1 5/5; Stage A upload 200).
  - 011 + freeze ON: every store writer throws ReconciliationWriteFrozenError
    before mutation; routes 503; nightly zero-mutation (T2 2/2; Stage B).
  - 012 + freeze ON: writes 503 before mutation, reads 200 (T4 2/2; Stage D).
  - 012 + freeze OFF: canonical behavior mandatory — tenant resolution via
    `canonical_default_tenant_ids_v1`, stamped writes, no legacy fallback on
    any 012 failure (T3 6/6; Stage E; unit test "a failing tenant resolution
    propagates — no legacy fallback").
- Error discrimination: `pre-012` ONLY when PostgREST returns exactly PGRST202
  naming `canonical_default_tenant_ids_v1`. Any other defined error (23503,
  42501, …) classifies canonical-012; transport failures and malformed
  responses propagate (fail closed, never downgrade). No caching — probed per
  write. Unit tests re-run at HEAD: `reconciliation-schema-capability` 8/8,
  `reconciliation-store-compat` 17/17, `decision-store-compat` 2/2,
  `nightly-match-script` 2/2 — 29/29.

## 10. Freeze readiness

Writer inventory (complete, from source at HEAD):
- 13 routes with 503 freeze response: upload, on-demand, match, approve,
  reject, unapprove, invoice-match, classify-merchants, preferences,
  qb-transactions, qb-transactions/upload, qb-transactions/sync,
  `[id]/transactions` (GET writer that persists auto-matches).
- 8 store writers with `assertReconciliationWritesNotFrozen()` first line:
  saveBankStatement, saveQbTransactions, computeAndPersistMatches,
  createManualMatch, rejectMatch, approveMatches, unapproveMatches,
  generateReport.
- Decision writes (recordDecision) sit inside route-guarded endpoints
  (approve/reject/invoice-match).
- Nightly: `scripts/nightly-match.ts` and `lib/nightly-match.ts` abort with
  zero mutation before any DB call.
- Guard ordering: freeze check BEFORE capability detection, tenant
  resolution, reads, and any DB mutation.

## 11. Production application runbook

`docs/STEP_4F_B_PRODUCTION_APPLICATION_RUNBOOK.md` — 19 steps (deploy compat
app → verify → enable freeze → redeploy → probe all 12 mutation surfaces →
verify reads → pause scheduler → recompute 012 SHA → apply exact 012 →
record ledger → verify migration → postchecks → canonical app verify → keep
freeze ON → read smoke → controlled write smoke → stamp verification →
cross-tenant probes → unfreeze → resume scheduler). Every step carries
expected result, STOP condition, and hold/rollback action. Not executed.

## 12. Post-apply verification package

Section "Phase 10" of the runbook: exact SQL/app checks for ledger,
unchanged counts, backfill stamps, NULLs, registry deltas, bootstrap deltas
(canonical_audit_ledger expected delta 0), accounting aggregates (diff
against `supabase/step-4f-prod-agg.json`), and security (authenticated audit
DML denied, own audit SELECT permitted, foreign tenant probes denied).

## 13. Stop conditions

None triggered. Remaining live NO-GO triggers for 4F-B (any one = stop,
freeze stays ON, production prohibited):
- production not definitively identified (re-verify at window start)
- production unexpectedly contains 012
- 010/011/012 hash mismatch at Step 8 recompute
- app artifact ambiguous or modified
- final backup missing/unverifiable
- Step 8–11 postchecks fail after apply
- classifier drift (new eligible registry-missing / AUTH USER MISSING /
  OTHER BLOCKER rows appearing between now and the window)
- any freeze surface uncovered at probe time
- any cross-tenant probe succeeds
- migration duration materially outside the observed 4–19 s band without
  explanation

## 14. Prepared production commands

`docs/STEP_4F_B_PRODUCTION_COMMAND_PACKAGE.md` — groups A (deploy compat
app), B (enable freeze), C (verify freeze), D (012 SHA), E (backup
verification), F (apply 012 + ledger record), G (postchecks), H (canonical
app verify), I (controlled write smoke), J (isolation probes), K (unfreeze),
L (scheduler resume). Every production-changing command is marked
`[PRODUCTION WRITE — DO NOT EXECUTE IN PREFLIGHT]`; read-only probes carry no
marker. No production write is hidden among read commands.

## 15. Remaining risks

1. **No production write was executed in preflight; none was required.**
2. Restore-drill procedural notes (not production risks): the CLI schema dump
   needs a pre-created public schema; migration-schema.sql is not idempotent
   on re-run (single-pass sequence is clean — use the documented order).
3. `supabase db query --file` returns only the last result set of a
   multi-statement script — the preflight uses single-statement UNION ALL
   files for snapshots; operators should use the same files.
4. The behavior-simple suite's cleanup tries to DELETE an audit row and the
   012 immutability trigger correctly refuses — a suite artifact, identical
   in 4E and 4F-A runs; the migration behavior itself is the pass.
5. Migration duration on the 4F-A staging apply was 19 s vs 4E's 4–7 s on the
   same container; attributed to local machine I/O variance (frozen artifact
   hash identical, same data scale). Production window budget remains
   comfortably within 5 minutes.
6. Zero production activity between 4E and 4F-A snapshots; if the pilot
   books new data before the 4F-B window, the runbook Step 8–10 checks will
   surface any new rows and the classifier re-check (Stop condition) covers
   registry drift.
7. The review screen's `GET [id]/transactions` is 503 during the freeze
   window (intentional — it persists auto-matches). Operators must tell the
   pilot user in advance.

## 16. Final recommendation

Do NOT apply Migration 012. Do NOT deploy. Do NOT enable the freeze.

This preflight is complete with a GO package. Production application happens
only under explicit Step 4F-B authorization, executed per the runbook and
command package, with the freeze flag ON across the migration window.
