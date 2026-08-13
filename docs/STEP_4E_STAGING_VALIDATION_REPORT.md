# Step 4E — Adversarial Staging Validation Report

Date: 2026-08-13
Production candidate: Supabase project `fqvekbzwghjurkcawpgg` ("zaki", eu-central-1)
Staging: disposable local Supabase PostgreSQL 17 container (`supabase_db_Zaki-ledger`)
Migration 012 SHA-256: `A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE`

## 1. Verdict

**STEP 4E FAILED — PRODUCTION NOT AUTHORIZED**

One HIGH defect blocks production authorization (Section 16, DEFECT-1): the freeze-capable application (current working tree) is not backward compatible with the 011 schema — every reconciliation write path resolves the canonical tenant through 012-only RPCs, so the 4B deployment sequence Stage A ("freeze-capable app deployed against 011, flag OFF, normal behavior works") cannot pass. The migration artifact itself (012) passed every adversarial gate. No production write occurred.

## 2. Frozen artifact verification

| Migration | Expected SHA-256 | Measured | Result |
|---|---|---|---|
| 010_additive_canonical_financial_foundation | `AD609305B040063A0C6186C9E3460F8BB886CE8429A1D03D8F48F6D17907902D` | match (recomputed at Phase 0 and Phase 14) | PASS |
| 011_default_canonical_tenant_bootstrap | `84138BB49A51474C2B7EFDC110780A37AD293A7A5A0E63A2618480DA926D7418` | match (both recomputes) | PASS |
| 012_reconciliation_canonical_tenant_spine | `A7E25FA3A5AEA4B54BC68F2DF181445982AA4290548975DE2F2374EB2465A2FE` | match (recomputed 4×: Phase 0, Phase 5, Stage C, Phase 14) | PASS |

Git state: branch `agent/step3-canonical-foundation`, HEAD `dd0d7abfd749401d0cc635b636a33941b8049241`. Migrations 011 and 012 are untracked in the working tree (no committed baseline, therefore no git-diff check possible); hash verification is the binding control. Recommendation: commit the frozen artifacts before Step 4F.

## 3. Production read-only snapshot

Server: postgres 17.6, database `postgres`, role `postgres`.

Migration ledger: `001,002,003,004,005,006,007,008,009,010,011` — 012 absent. Matches expectation.

Counts:

| Table | Rows |
|---|---|
| bank_statements | 7 |
| bank_statement_transaction_observations | 628 |
| bank_transactions | 628 |
| qb_transactions | 422 |
| reconciliation_matches | 558 |
| reconciliation_reports | 5 |
| reconciliation_decisions | 216 |
| reconciliation_audit_log | 408 |
| invoices | 1 |
| invoice_matches | 0 |
| confirmations | 7 |
| practices | 2 |
| practice_memberships | 2 |
| client_entities | 2 |
| ledger_books | 2 |
| default_tenant_identities | 2 |
| canonical_audit_ledger | 8 |

Auth/classifier (exact 011 predicate `confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous,false)=false`):

| Class | Count |
|---|---|
| auth users total | 2 |
| eligible | 2 |
| eligible + registry exists | 2 |
| eligible + registry missing | 0 |
| ineligible | 0 |
| anonymous | 0 |
| deleted | 0 |
| confirmed | 2 |
| incomplete registry rows | 0 |
| registry rows with missing auth user | 0 |
| users in all seven spine sets | 1 (decisions set has 1 of 2 users) |
| rows belonging to ineligible users (any table) | 0 |
| NULL user_id rows in spine tables | 0 |

Relationship-integrity preflight (read-only): **zero** violations in all 16 checks — child/parent user mismatches, cross-statement matches, match↔QB user mismatch, orphan decisions, orphan audit rows, missing statement/txn parents, and canonical columns (D13 = 0 columns present, as expected pre-012). No production BLOCKER shapes.

## 4. Backup artifacts

Directory: `production-backup-pre-012-20260813-064553/`

| File | Size | SHA-256 |
|---|---|---|
| schema.sql | 281,782 B | `9d515e25101c98e4a9557d9b466b54d3446f448a3eb65b0676be7d6f0a0ae653` |
| data.sql | 1,013,449 B | `2876d743159a9242e837d383f6fabec484838e5c4521fab052d375aa0c20b86c` |
| migration-schema.sql | 1,437 B | `4d6de31c567d1b91c245438179dfcd4dd06373ef1b36dd9b2e4be3b2686372b4` |
| migration-data.sql | 254,943 B | `8816666b4bada3dcbebcdf3815b282c2a6121864311bfef0d48b93a8c363fb16` |
| roles.sql (supplementary) | 431 B | `0decd601faa70260a3a31e8ce63208cc4a4c1f99921bc6f3ed4faf1cd980da3a` |

Warnings: pg_dump emitted `hint: Consider using a full dump instead of a --data-only dump to avoid this problem.` on the data-only dump. Classification: benign — the hint concerns standalone data-only restores without schema; this backup set restores schema first. Recorded, not suppressed. Older validated backups were not overwritten.

## 5. Restore verification

Restore into the disposable local container: dropped `public` + `supabase_migrations`, truncated `auth.users CASCADE`, restored schema.sql → data.sql → migration table DDL → migration-data.sql (`COPY 11`).

- Ledger: exactly 001–011, 012 absent.
- Full Phase 1 snapshot re-run on staging: **74-line diff = identical** to production (counts, classifier, integrity checks, shapes).
- Accounting aggregates (sums of bank/QB amounts, statement opening/closing sums + per-row detail, report balances/variance/matched/unmatched, decisions by type, matches confidence sum + flagged counts, invoice totals, confirmation confidence sums, audit action counts + confidence delta): **identical** production vs staging.

## 6. Migration 012 staging apply

Command: `cat supabase/migrations/012_reconciliation_canonical_tenant_spine.sql | docker exec -i supabase_db_Zaki-ledger psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f -` (SHA re-verified immediately before apply; also applied again during Phase 11 Stage C and Phase 12 Case 2 with identical results).

| Apply | Start (UTC) | Finish (UTC) | Duration | Result |
|---|---|---|---|---|
| #1 | 06:04:02 | 06:04:09 | 7 s | COMMIT, clean |
| #2 (Stage C) | 06:54:08 | 06:54:12 | 4 s | COMMIT, clean |
| #3 (Case 2) | ~07:02 | ~07:02 | ~4 s | COMMIT, clean |

Output highlights: `NOTICE: Migration 012 Z2: bootstrapped 0 eligible users missing registry` (expected — both production users are eligible with complete registries; zero bootstrap noise). Backfills: `UPDATE 7 / 628 / 422 / 558 / 5 / 216 / 408` (statements, bank txns, QB, matches, reports, decisions, audit). No other notices, no warnings. Migration ledger recorded 012 (`reconciliation_canonical_tenant_spine`, statements stored) the same way prior steps recorded 010/011 after direct container application.

B1–B11: all 11 embedded assertion blocks executed with zero exceptions. All-or-nothing behavior proven in Phase 12 Case 1 (injected failure → full rollback, ledger remained 011, no canonical columns, all 7 statements intact).

## 7. Real-data backfill verification (post-012 staging)

All checks zero/clean:

- bank_statements client/book stamps match registry exactly (0 mismatches, 0 NULL).
- qb_transactions client/book stamps match registry (0 / 0).
- bank_transactions inherit parent statement client (0 mismatches, 0 NULL).
- matches, reports, decisions inherit statement client (0 mismatches each).
- audit rows: 0 NULL user_id, 0 NULL client_entity_id, 0 mismatches vs parent match (user or client).
- Bootstrap: 0 eligible users missing registry (nothing to bootstrap); `canonical_audit_ledger` still 8 rows (unchanged); 0 rows with `bootstrap_version='012'` — zero audit noise.
- Guard objects: 7 write-guard triggers, 11 immutability triggers, 12 composite FKs, 4 parent unique indexes. Audit authenticated DML grants: 0; anon grants: 0.

## 8. Accounting preservation

Aggregate script re-run post-012 on staging: **identical** to pre-012 staging and to production (all deterministic sums and grouped counts). Canonical stamp columns added; accounting values unchanged.

## 9. Contract test results

SQL suites against staging (psql, outputs saved in `production-backup-pre-012-20260813-064553/staging-tmp/contract-*.txt`):

| Suite | PASS checks | FAIL |
|---|---|---|
| 012-contract-structural | 63 | 0 |
| 012-contract-behavior | 36 | 0 |
| 012-contract-behavior-extras | 8 | 0 |
| 012-behavior-simple (R1–R14, immutability, QB, audit) | 27 | 0 |
| 012-structural-simple (Z1/Z5/Z6/Z8/Z9/Z12/Z10/Z7 — "ALL STRUCTURAL TESTS PASSED") | 9 sections | 0 |
| 012-tenant-isolation | 9 | 0 |
| 012-classifier-backfill | 32 | 0 |
| 011_default_tenant_contract | `011_DEFAULT_TENANT_CONTRACT_OK` | 0 |

TS suites against staging (`vitest --config vitest.local.config.ts`):

- `tests/migration-012-contract.test.ts` — 62 passed
- `tests/migration-012-tenant-isolation.test.ts` — 23 passed
- `tests/migration-011-contract.test.ts` — 6 passed

**Total: 184 SQL PASS checks + 91 TS tests, zero failures.** No mandatory test skipped. (`012-local-acl-baseline.sql` was intentionally not run: staging restored real production grants from the backup, so the local baseline shim was unnecessary.)

## 10. Tenant isolation attack matrix (real copied tenants)

Tenant A = `38832e8e-...` (zabdi908@gmail.com), Tenant B = `0042d6e0-...` (zabdi4549@gmail.com). Suite: `supabase/step-4e-phase8-attacks.sql`. **23/23 PASS.**

| Attack | Expected | Actual |
|---|---|---|
| R1/R2 A reads B statement/txn | fail closed | grant-denied (009) |
| R3/R4/R6 A reads B match/report/audit | fail closed | RLS-filtered (0 rows) |
| R5 A reads B decision | fail closed | B has none; N/A verified |
| M1/M6 A mutates B statement/QB | fail closed | denied or 0 rows |
| M2/M3/M4 A mutates/approves/deletes B match | fail closed | RLS 0 rows |
| M5 A inserts txn on B statement | fail closed | denied |
| A1/A2/A3 direct audit INSERT/UPDATE/DELETE | fail closed | revoked (Z12) |
| S1 p_user_id=A + Client B | 23514 | 23514 |
| S2 p_user_id=A + Book B | 23514 | 23514 |
| S3 Client A + Book B (cross pair) | 23514 | 23514 |
| S4 no canonical IDs | 23502 | 23502 |
| S5 forged B statement id under A identity | rejected | rejected |
| V1/V2/V3 valid A→A ingest (statement + QB) | succeed, correct stamps | PASS, stamps = A registry |

## 11. Freeze compatibility test (old app / new DB)

Freeze-capable app (`ZAKI_RECONCILIATION_WRITE_FREEZE=1`) against migrated (012) staging:

- All 13 reconciliation writer routes returned **503 before any DB mutation** (upload, on-demand, match, approve, reject, unapprove, invoice-match, classify-merchants, preferences, qb-transactions, qb sync, qb upload, and `GET [id]/transactions` which persists auto-matches — gating correct per 4B freeze list "automatic matching that persists matches").
- Read-only routes operated normally: `latest` 200, `audit` 200.
- `report`/`dashboard` 404s in the probe were correct user isolation (probe used a foreign statement id).
- Stale/old-shape ingestion cannot write through 012: without canonical IDs the ingestion RPC raises 23502 (S4); without stamps the write-guard triggers raise 23502 (contract suites A10/A11).
- `scripts/nightly-match.ts` with freeze ON: prints `Reconciliation writes are frozen — nightly match aborted.` and performs **zero writes** (matches 560 → 560).

## 12. Canonical app smoke (4C app against migrated staging)

Read-only smoke (freeze ON): login 200; pages `/reconciliation`, `/upload`, `/settings`, `/review`, `/batch` all 200; API reads `latest`/`audit`/`transactions`/`dashboard` 200 (`report` 404 until first approval — expected).

Controlled write workflow (freeze OFF, real tenant A): bank CSV upload (statement `14abece1`, 2 txns) → QB CSV upload (2 imported) → matching (2 auto matches) → approve (report generated, `reportId 5e85fce2`, report GET 200) → reject (decision logged) → unapprove (audit logged) → invoice-match decision (`ok:true`).

Stamp verification on every new row: all carry A's registry `client_entity_id daa94c07-...` / `ledger_book_id e125b9e1-...`; audit rows carry `user_id` + `client_entity_id` with actions `match_approved`/`match_unapproved`; decisions stamped (`approve`, `reject`, `accept_suggestion`). Rejected match deletion left audit evidence preserved via SET NULL pointer (3 NULL-pointer audit rows from suite fixtures, all with intact user/client snapshots — design Section 14 behavior).

## 13. Deployment simulation (Stage A–F)

- **Stage A (011 DB, freeze-capable app, flag OFF): FAILED — DEFECT-1.** Upload returns `Canonical tenant context resolution failed: Could not find the function public.canonical_default_tenant_ids_v1` — the app requires 012 RPCs on all write paths, so it cannot operate against an 011 database. (The currently deployed production app at `main` predates canonical integration and works on 011 — live evidence — but it has no freeze gates.)
- Stage B (011 DB, freeze ON): writers 503, reads 200, nightly aborts. PASS.
- Stage C (012 apply, freeze ON): applied in 4 s, clean COMMIT, ledger 012. PASS.
- Stage D (canonical app, freeze ON): reads 200, writes 503. PASS.
- Stage E (controlled smoke write after flag OFF): statement `057048ab` created via upload, correct stamps. PASS.
- Stage F (unfreeze): upload resumed normal behavior (`statementId 057048ab`, 1 txn). PASS.

## 14. Stop/rollback simulation

- **Case 1 — freeze works, 012 apply fails:** corrupted temp copy of 012 (failure injected at end; the frozen artifact itself was never modified) applied with ON_ERROR_STOP → error raised, transaction **fully rolled back**: ledger stayed 001–011, zero canonical columns, all 7 statements intact, frozen app kept returning 503 on writes / 200 on reads. PASS.
- **Case 2 — 012 applies, smoke fails:** with 012 applied and freeze still ON, all writers 503, reads 200, nightly aborts — no unfreeze path was taken; investigation proceeds before progression. Operator actions documented (do not unfreeze, do not progress, diagnose smoke failure first). PASS.
- **Case 3 — cross-tenant probe succeeds unexpectedly:** added a temporary permissive audit SELECT policy to simulate a leak; authenticated A saw B's 192 audit rows (detectable via the Phase 8 probe — immediate NO-GO trigger). Policy restored to `auth.uid() = user_id`; re-probe returned 0 rows. Stop condition documented: any probe success = NO-GO, freeze stays ON, production prohibited. PASS.

## 15. Performance/locking observations

On the production-shaped staging copy (628 bank txns, 558 matches, 422 QB, 408 audit rows — current pilot scale):

- Full 012 apply (backfill + 4 unique indexes + 10 composite FKs with immediate validation + 17 triggers/functions + 8 secondary indexes + ACL changes): **4–7 seconds** end to end across three applies.
- Largest single operations: the seven backfill UPDATEs (628/558/422 rows) — sub-second each; FK validation immediate inside the one transaction (no separate VALIDATE phase).
- No index-creation duration separable from the 4–7 s total (metadata-scale objects).
- Lock behavior: single transaction with DDL locks; because the freeze gates block all writers upstream, no lock contention was observable. Reads (MVCC) continued to return 200 throughout the frozen window.
- Operational verdict: sequence is trivially within a 5-minute controlled window at current pilot scale.

## 16. Defects

**DEFECT-1 — HIGH (BLOCKER for production authorization).**
- Object: `zakiledger/lib/tenant-context.ts` (`requireTenantContext` / `resolveTenantContextForUser`) as consumed by every reconciliation write path (`app/api/reconciliation/**`, `lib/reconciliation-store.ts` decision/approve paths).
- Reproduction: run current working tree against an 011-schema database with `ZAKI_RECONCILIATION_WRITE_FREEZE` unset; `POST /api/reconciliation/upload` → `Canonical tenant context resolution failed: Could not find the function public.canonical_default_tenant_ids_v1`.
- Impact: Step 4B deployment sequence Stage A (deploy freeze-capable app to 011 with flag OFF, normal behavior unchanged) cannot pass. The safe staged sequence (deploy app early → freeze → migrate → unfreeze) is unavailable; the only remaining path is an atomic app+012 ship inside one window with the old un-freezable app running during the migration, which 4B explicitly designed away from.
- Smallest safe correction: make canonical stamping conditional on 012 being present — e.g., feature-detect `canonical_default_tenant_ids_v1` (or check the migration ledger) and fall back to the pre-4C write path when absent; freeze gates remain unconditional. Re-run Phase 11 Stage A after the fix.

**DEFECT-2 — MEDIUM (process).** Migrations 011 and 012 are untracked in git. The frozen 012 has no committed baseline, so "git diff" cannot evidence non-modification; only SHA verification does. Recommend committing both before Step 4F, then re-verifying the SHAs after commit.

**Observation (no action).** `GET /api/reconciliation/[id]/transactions` returns 503 under freeze because it persists auto-matches. This matches the 4B freeze list and is intentional; operators should know the review screen is unavailable during the freeze window.

## 17. Production authorization recommendation

**Step 4F may NOT begin.**

Migration 012 is sound: it applied cleanly three times, preserved all accounting values, backfilled every row with correct canonical stamps, passed B1–B11, 184 SQL contract checks and 91 TS tests, and every tenant-isolation, audit-forgery, freeze, and rollback gate failed closed. Zero production writes occurred during this step.

However, DEFECT-1 breaks the deployment sequence the whole freeze design depends on (4B Stage A). Authorize Step 4F only after DEFECT-1 is corrected and Phase 11 Stage A re-run passes. The frozen Migration 012 artifact itself requires no change.

Do not perform Step 4F. Do not apply anything to production. Do not enable production freeze.
