# Reconciliation Hardening — Defect Remediation Report

Branch: `fix/reconciliation-candidate-hardening` (atomicity correction based on
`c912e0b378eb781e78441f6980ccc48dfc381218`).
Design doc: `docs/RECONCILIATION_DEFECT_REMEDIATION_DESIGN.md`.
Date: 2026-08-16. Scope: DESIGN + IMPLEMENTATION + LOCAL VALIDATION only.
No production access, no production repair, no edits to 010/011/012, and no
merge to `main`.

## 1. Verdict

**ARTIFACT FROZEN — READY FOR PRODUCTION PREFLIGHT**

## 2. Root-cause confirmation

- **D1 (confirmed, reproduced)**: The one-QB-row invariant was enforced only
  by a pre-read (`listMatchedQbIds`) feeding an exclusion set; the schema had
  no QB-side uniqueness (only `UNIQUE(bank_transaction_id, statement_id)`).
  Reproduction: two concurrent `computeAndPersistMatches` workers both read
  "free" and both persisted — regression test observed 2 live claims where 1
  was required ("expected 2 to be 1").
- **D2 (confirmed, reproduced)**: The exclusion set included every live match
  (auto or manual, approved or not) and was permanent while the row lived;
  re-scoring a reserved QB row was an explicit non-goal in the invariants
  doc. Reproduction: a 60-point unapproved auto suggestion reserved its QB
  row and a later 100-point exact candidate scored zero matches.
- **D3 (confirmed, empirical)**: Migrations 001–012 relied on Supabase
  base-image default privileges for the four reconciliation tables plus
  `user_merchant_preferences`; the current local base
  (`supabase/postgres:17.6.1.147`) no longer materializes those defaults and
  migrations 008/009 only reset the four ingestion tables. After a fresh
  `supabase db reset`, `service_role`/`authenticated` held no DML at all on
  the reconciliation tables — every store operation failed. This is a
  missing repository migration requirement (1) triggered by a base change
  (2); not a harness artifact.
- **D4 (confirmed, reproduced)**: Approved-match protection existed only in
  application code (`rejectMatch` checks `approved_at`; `createManualMatch`
  upsert overwrites approved rows). Raw UPDATE/DELETE/repoint of an approved
  row through PostgREST succeeded pre-013.
- **D5 (confirmed by inspection)**: `reconciliation_matches` carries no
  `ledger_book_id`; the 012 same-client trigger checks the client only, so a
  same-client/different-book match could be written.
- **D6 (confirmed, reproduced)**: `createManualMatch` looked the QB row up in
  the statement period ± `DATE_PENDING_DAYS`; a QB row 40 days after the
  period was "not found" for a human override.

## 3. Design decisions

See `docs/RECONCILIATION_DEFECT_REMEDIATION_DESIGN.md` for the full design.
Key decisions:

- D1: partial unique index
  `uk_matches_auto_live_qb ON (qb_transaction_id) WHERE matched_by='auto'
  AND qb_transaction_id IS NOT NULL AND superseded_at IS NULL`, plus an
  atomic persist RPC (`persist_auto_matches_v1`) doing lock-scan → claim
  resolution → insert with per-item unique-violation capture. No new
  discriminator column — `matched_by` is the existing canonical origin
  field.
- D2: reservation classes (approved/manual/green-auto reserve;
  sub-green unapproved auto does not) + deterministic supersession rule
  (new score ≥ 95 AND delta ≥ 20 points; never touches approved rows;
  equal candidates never supersede). Superseded rows are preserved with
  `superseded_at` / `superseded_by_match_id` / `supersede_reason` /
  `supersede_operation_id` and an audit event `match_superseded` with
  old/new scores. Manual decisions sweep live unapproved auto claims on the
  same QB row (`supersede_auto_claims_v1`, reason `manual_override`).
- D3: explicit REVOKE + GRANT lineage in 013 restoring the documented ACL
  contract (service_role full store surface; authenticated ALL+RLS on
  matches/reports/decisions, SELECT-only on the audit log; anon nothing).
- D4: DB guard trigger `reconciliation_match_approved_guard` (function
  `reconciliation_match_guard_v1`) — approved rows immutable to raw
  UPDATE/DELETE/repoint; superseded rows immutable (maintenance deletes only
  for direct admin sessions via `session_user`); supersession columns
  writable only under one-shot private transaction capabilities. Controlled correction path:
  `unapprove_reconciliation_matches_v1` (service_role-only, ownership-checked,
  audited, idempotent).
- D5: same-ledger-book alignment trigger (`match_book_alignment`); no new
  column (the book is derivable from both endpoints; see §11).
- D6: manual override searches the full tenant client/book pool (no date
  window); all tenant/client/book boundaries remain enforced at write time.
- M: manual and automatic paths share deterministic endpoint-row locks
  (bank UUID order, then QB UUID order). `create_manual_match_v1` owns manual
  validation, eligible automatic resolution, manual persistence, and audit
  evidence in one transaction. Automatic approval fails closed on an
  inconsistent live manual relationship for the same QB endpoint.

## 4. Accounting-model compatibility

D1 does not destroy legitimate many:1 / 1:many / partial / allocation
semantics because the exclusive index covers **exactly** the automatic 1:1
claim class:

- `matched_by = 'auto'` excludes every manual row — a human can still link
  any number of bank rows to one QB row (verified by test 13: two live
  manual rows on one QB row), and 1:many/partial/allocation semantics live
  in the canonical `financial_relationships` / `financial_allocations`
  layer, which 013 does not touch.
- `superseded_at IS NULL` keeps historical evidence rows outside the class.
- Approval does not change `matched_by`, so approving an auto claim keeps it
  exclusive (correct — approval must not open a second claim).
- Two tenants can never collide on the index: a QB row is tenant-owned and
  the 012 composite FKs + same-client trigger make cross-tenant references
  impossible.

## 5. Files changed

- `supabase/migrations/013_reconciliation_claim_hardening.sql` (new)
- `zakiledger/lib/reconciliation-matching.ts` (claim-class helpers +
  deterministic supersession constants)
- `zakiledger/lib/reconciliation-schema.ts` (supersession fields on
  `ReconciliationMatch`)
- `zakiledger/lib/reconciliation-schema-capability.ts` (013 claim-guard
  probe, same deterministic PGRST202 pattern as the 012 probe)
- `zakiledger/lib/reconciliation-store.ts` (reservation classes, two-pass
  resolution, persist/sweep/unapprove RPC paths, D4 refusal in manual
  override, D6 pool widening, superseded-row filtering in
  approve/reject/unapprove, row mapping)
- `zakiledger/tests/reconciliation-supersession-rule.test.ts` (new, 15 pure
  rule tests)
- `zakiledger/tests/reconciliation-defect-regression.test.ts` (25
  DB-gated regression tests — the 13 mandatory tests)
- `zakiledger/tests/reconciliation-manual-auto-atomicity.test.ts` (new, 11
  DB-gated invariant-M concurrency/rollback tests)
- `zakiledger/tests/migration-013-contract.test.ts` (26 structural
  contract tests)
- `zakiledger/tests/reconciliation-hardening.test.ts`,
  `zakiledger/tests/reconciliation-insights.test.ts`,
  `zakiledger/tests/review-optimistic.test.ts` (fixtures extended with the
  new fields — no behavior change)
- `zakiledger/tests/reconciliation-store-compat.test.ts` (mock now pins the
  013 claim-guard capability to pre-013 — that matrix's scope)
- `zakiledger/tests/migration-012-tenant-isolation.test.ts` (cross-tenant QB
  attack regex accepts either guard's rejection message; the rejection
  contract itself is unchanged)
- `docs/RECONCILIATION_DEFECT_REMEDIATION_DESIGN.md` (new)
- `docs/RECONCILIATION_MATCHING_INVARIANTS.md` (invariant A amended to the
  013 mechanism; frozen-match-upgrade non-goal retired for unapproved
  sub-green auto rows)

## 6. Migration 013

- **Filename**: `supabase/migrations/013_reconciliation_claim_hardening.sql`
- **SHA-256**: `42b12ebb4cee9057161c376b6873630407d7479b32e2407acec2446a02b2527a`
- **Purpose**: D1 exclusive auto claim + D2 supersession evidence + D3 grant
  lineage + D4 approved-match DB immutability + D5 book alignment + invariant
  M manual/automatic serialization and manual audit atomicity.
- **Grants/revokes**: REVOKE ALL FROM PUBLIC/anon/authenticated/service_role
  on `reconciliation_matches`, `reconciliation_reports`,
  `reconciliation_decisions`, `reconciliation_audit_log`,
  `user_merchant_preferences`; GRANT SELECT/INSERT/UPDATE/DELETE to
  service_role on the four reconciliation tables; same to authenticated on
  matches/reports/decisions; SELECT-only for authenticated on the audit log;
  SELECT/INSERT/UPDATE on `user_merchant_preferences` to both. Manual,
  automatic, sweep, correction, and service-approval RPCs are service-role
  only; the authenticated approval RPC is authenticated-only.
- **Constraints/triggers/functions**: `uk_matches_auto_live_qb` partial
  unique index; `fk_matches_superseded_by` (DEFERRABLE INITIALLY DEFERRED,
  ON DELETE SET NULL); guard trigger `reconciliation_match_approved_guard`;
  `match_book_alignment` trigger; functions `reconciliation_match_guard_v1`,
  `match_book_alignment_v1`, private bank/QB endpoint lock helpers,
  `persist_auto_matches_v1`, `create_manual_match_v1`,
  `supersede_auto_claims_v1`, `unapprove_reconciliation_matches_v1`, and the
  controlled approval functions; C1–C5 end-of-migration invariant
  assertions; `NOTIFY pgrst` reload.
- **Rollback/recovery**: all DDL is additive and re-runnable (idempotent
  REVOKE/GRANT, IF NOT EXISTS, CREATE OR REPLACE). Recovery = restore the
  pre-013 snapshot; in place, the index can be dropped, grants re-revoked,
  triggers dropped, and the new columns left unused (nullable). Approved
  rows are recoverable only through the controlled unapprove RPC (audited);
  superseded rows are maintenance-deletable only by direct admin sessions.
- **Apply-time guard**: Z2 raises with a diagnosable count + sample QB ids if
  a database already holds duplicate live auto claims (a reviewed dedup is
  then required before the index can build). Fresh/local databases pass
  through.

## 7. Concurrency implementation

`persist_auto_matches_v1` locks all distinct bank rows and then all distinct
QB rows in UUID order before reading relationships. Per item it scans live
manual/auto holders of the locked QB row → deterministic resolution (manual
holder → `blocked`; approved holder → `blocked`; green holder → `blocked`;
sub-green unapproved holder → rule check → supersede (audited) or
`blocked`; no holder → insert) → `INSERT ... ON CONFLICT
(bank_transaction_id, statement_id) DO NOTHING`, with per-item
`unique_violation` capture classifying index conflicts on
`uk_matches_auto_live_qb` as `conflicted` (message-text match). The partial
unique index is the final backstop. Results are returned as
`{inserted, superseded, conflicted, blocked, operation_id}`; the app maps
conflicted/blocked proposals back to the unmatched pool. Retry is
idempotent by construction. `create_manual_match_v1` uses the same lock order,
so an empty relationship set is still serialized through the stable QB row.
Its automatic resolution, manual write, and audit inserts commit once.

## 8. Temporal stronger-evidence implementation

Reservation classes (`reservesQbClaim`): approved rows, manual rows, green
auto rows reserve; sub-green unapproved auto rows never reserve. The store
scores them anyway and hands proposals to the RPC, which applies the
deterministic rule (new ≥ 95, delta ≥ 20, old unapproved auto) under row
locks. Superseded rows keep all original fields plus the four supersession
columns; the audit log records `match_superseded` with old/new confidence,
actor, and timestamp; nothing is deleted or rewritten. Canonical-013 manual
decisions run entirely inside `create_manual_match_v1`; the older sweep RPC is
retained as a service-only compatibility surface and now participates in the
same QB serialization mechanism. The same constants exist in TS and SQL,
kept in lock-step by the rule test suite.

## 9. Approved-match DB protection

Guard trigger (BEFORE UPDATE OR DELETE): approved rows — no DELETE, no
UPDATE except the one-shot-capability unapprove transition (approval columns
only, cleared to NULL); superseded rows — no UPDATE ever, no DELETE from
application roles; supersession columns — one-shot-capability-gated. Controlled path:
`unapprove_reconciliation_matches_v1` (ownership-checked, audited,
idempotent); the app's `unapproveMatches` uses it on canonical-013 schemas
and the legacy path otherwise; `createManualMatch` refuses approved rows
with a controlled error instead of hitting the trigger. Before an automatic
row is approved, the approval core holds the same endpoint lock and fails
closed if a live manual relationship exists for that QB endpoint; it never
repairs historical inconsistency automatically.

## 10. Privilege lineage

See §2 D3 and §6. Proven end-to-end: fresh `supabase db reset` from
migrations 001–013 with zero manual grants → full DB-gated suites pass,
including the complete store round-trip and the authenticated surfaces. The
tenant-isolation suite re-proves authenticated gained no privileged access
(audit DML denied, cross-tenant reads/mutations fail closed, forged stamps
rejected).

## 11. Ledger-book decision

Same-client multiple books legitimately exist; one QB observation belongs to
exactly one ledger book; a match's book is derivable from both endpoints.
Decision: **no new column** (duplicated derivable state; the 012 pattern
derives book through the statement FK), plus the `match_book_alignment`
trigger rejecting cross-book matches on new writes (NULL-book legacy rows
skipped, historical rows never re-validated). Implemented in 013.

## 12. Manual override decision

**Manual override intentionally searches outside ±5 days.** The window is a
matching heuristic, not an accounting boundary. `createManualMatch` now
searches the full tenant client/book pool on canonical-012 (full user pool
pre-012). Tenant/client/book/authorization boundaries are still enforced at
write time by the 012 composite FKs, the same-client trigger, and the new
book-alignment trigger.

## 13. Tests added

- `tests/reconciliation-supersession-rule.test.ts` — 15 pure tests of the
  deterministic rule (floors, delta boundaries, equal candidates, fp-noise
  guard, constant lock-step).
- `tests/reconciliation-defect-regression.test.ts` — 25 DB-gated tests: all
  13 mandatory tests plus boundary cases (green-holder reservation,
  sub-green floor, manual sweep, superseded-row immutability, index-level
  rejection, manual-override refusal, stale AUTO/manual race).
- `tests/reconciliation-manual-auto-atomicity.test.ts` — 11 DB-gated tests
  covering both start orders (three repeats each), two AUTO plus one MANUAL
  (three repeats), weak override, approved-auto protection, manual many:1,
  three rollback boundaries, deterministic retry, and approval fail-closed.
- `tests/migration-013-contract.test.ts` — 26 structural contract tests
  (columns, partial index + exact predicate, no global QB unique index,
  triggers, shared lock calls, RPC ACLs, and preserved 012 invariants).
- Test-first evidence: rule suite 15/15 red; 013 contract 13/19 red;
  regression suite 17–20/24 red with the D1 race literally reproduced
  ("expected 2 to be 1") and D2 weak-blocking reproduced — all before
  the original implementation. For the atomicity correction, the new suite
  was run before migration/store changes: 6/11 failed, including manual-first
  non-serialization, approved-auto displacement, non-atomic audit failure,
  missing retry audit, and unsafe automatic approval; the stale AUTO/manual
  regression separately failed with one unexpected live AUTO row.

## 14. Local Supabase fresh-reset proof

`supabase db reset` (migrations 001–013, base `postgres:17.6.1.147`, CLI
2.114.0) with **zero manual grants or harness patches**. Post-reset grant
inspection matches the 013 contract exactly (service_role full DML;
authenticated ALL+RLS / audit SELECT-only; anon nothing). The complete local
DB matrix passes **182/182**, with 8 intentional schema-compatibility skips:
defect regression 25, invariant-M atomicity 11, approval control 20, direct
manual attacks 7, migration-012 contract 62, migration-013 contract 26,
tenant isolation 23, and the 8 applicable schema-compatibility cases.

## 15. Regression results

Required command results: `npm run test:unit` **491 passed, 11 intentionally
skipped**; `npm run test:local-db` **182 passed, 8 intentionally skipped**;
`npm run typecheck` clean; `npm run build` succeeds. Reconciliation-relevant
suites are green: hardening 24/24, matching 12/12, store 5/5, store-compat
17/17, insights 47/47, detectors 30/30, nightly 11/11, tenant isolation
23/23, user isolation 6/6, migration 008–013 contracts
(8+4+10+6+62+26), capability 8/8, decision suites 6/6,
supersession-rule 15/15, defect-regression 25/25, invariant-M atomicity
11/11, approval control 20/20, and manual override attacks 7/7.

## 16. Known-answer result

PASS — hardening suite 24/24: the 12-row known-answer fixture assignment
matrix (Amazon unmatched, Northstar→QB-009, Coffee→QB-010, Tesco/Software
review-level, 4FB rows never displace in-scope candidates), the two-phase
late-arriving-QB cascade, R6 order-permutation invariance, R6b tie
determinism, and the adversarial matcher cases.

## 17. Concurrency result

PASS — automatic-vs-automatic still produces exactly one live auto claim and
the partial index rejects a direct duplicate. AUTO-first/MANUAL-second,
MANUAL-first/AUTO-second, and two-AUTO-plus-one-MANUAL interleavings were each
run three times using real local transactions and deterministic gates. Every
case converged to the protected manual final state with zero live automatic
claims; the manual-first cases proved AUTO waited behind the shared QB lock.

## 18. Tenant/client/book security

- Tenant: 012 composite FKs + write-guard triggers + same-client trigger all
  re-verified (tenant-isolation 23/23); authenticated gains nothing from the
  013 grants (audit DML denied, cross-tenant invisible, forged IDs
  rejected).
- Client: matches are stamped and FK-bound to the statement's client;
  client stamp immutable (012).
- Book: new 013 book-alignment trigger rejects cross-book matches;
  same-client/different-book attack now fails 23514.

## 19. Remaining risks

1. The invoice-side tables (`invoices`, `corrections`, `confirmations`,
   `pending_documents`, `oauth_connections`) have the same privilege-lineage
   gap on the new base — recommend a follow-up migration mirroring 013's Z4.
2. Green unapproved auto rows reserve their QB row by design; release is by
   human reject/override only (documented, deterministic).
3. Historical manual/automatic coexistence is not repaired automatically;
   automatic approval fails closed until an operator performs a reviewed
   correction.
4. Production apply of 013 requires the Z2 duplicate-live-auto-claim check
   to pass; if historical duplicates exist the apply fails loudly and a
   reviewed dedup must precede it.
5. `supabase/config.toml` remains an untracked local file (pre-existing;
   not part of this change set).

## 20. Exact next gate

Production preflight planning for migration 013: verify the recorded SHA-256,
run the Z2 historical duplicate/protected-state diagnostics, take the required
backup, define the freeze/rollback window, and obtain explicit operator
authorization. No hosted environment was accessed and `main` was not merged.
