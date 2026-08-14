# Reconciliation Correctness Hardening Report

Date: 2026-08-14. Scope: candidate selection, one-to-one assignment, scope, confidence explanations. No production changes made.

## 1. Verdict

**READY FOR ADVERSARIAL STAGING**

All four proven defects fixed locally, 24/24 hardening tests green, typecheck + build clean. Production data contains pre-existing violations that need a separate, explicit repair plan — not touched here.

## 2. Proven root cause

Four defects, each reproduced by a failing test before implementation:

1. **No evidence floor.** `matchTransactions` accepted any candidate with score > 0. A QB row posted within 5 days of a bank row earned 15-35 points on date alone (no amount, no merchant signal) and was persisted as a red match. Reproduced: Amazon grabbed `4FB-CANONICAL-TEST`-era QB rows and Parking Meter at 35 in the known-answer fixture; live-test simulation welded Northstar to `4FB-CANONICAL-TEST A` at 35.
2. **Already-matched QB rows remained eligible.** `computeAndPersistMatches` excluded already-matched *bank* rows but never already-matched *QB* rows. Approved and unapproved live matches did not consume their QB row across statements/re-runs. Reproduced: second statement reused an approved QB row.
3. **Order dependence on ties.** Candidate sort was score-only; V8 stable sort resolved ties by bank input order. Reproduced: swapping bank input order flipped the winner of an equal-evidence contest.
4. **Explanation layer lied.** `plainEnglishReason` stripped the `(partial)`/`(pending)` qualifiers (its regex was a no-op replace), so `merchant (partial)` rendered as "merchant all match"; `factorBreakdown` credited max points per factor, showing 40/35/25 (=100%) for an 85% match.

Greedy ordering itself was **not** the live root cause — matcher-level R2/R3 passed before the fix when the correct QB row was present. The live cascade was: junk 35-point match persisted early (QB-009 not yet in pool) → bank row frozen by `ignoreDuplicates` upsert → late-arriving QB-009 stolen by Amazon at 15.

## 3. Source call graph

```
runNightlyMatch (lib/nightly-match.ts:33)
→ computeAndPersistMatches (lib/reconciliation-store.ts:722)
  → listBankTransactions (store:473, RPC list_statement_bank_transactions_v1, migration 008:452)
  → listQbTransactionsForPeriod (store:640)  [user_id + posted_date ±5d; now + client/ledger scope]
  → listMatchedQbIds (store, new)            [excludes QB ids with any live match row]
  → matchTransactions (lib/reconciliation-matching.ts:151)
    → scorePair (matching:93) → fuzzyMerchantSimilarity (matching:60)
    → evidence-floor filter + deterministic sort + greedy claim
  → generateAuditMemos (lib/audit-memo-generator.ts)
  → upsert reconciliation_matches (store, onConflict bank_transaction_id,statement_id)
→ UI: match-card.tsx + app/(app)/reconciliation/review/page.tsx:628
  → plainEnglishReason / factorBreakdown (lib/reconciliation-insights.ts:58/175)
DB guard: match_qb_same_client_v1 trigger (migration 012:281) rejects cross-client matches
```

## 4. Invariants adopted

Documented in `docs/RECONCILIATION_MATCHING_INVARIANTS.md`: A one-to-one, B approved-match immunity, C strongest-evidence-wins (deliberately NOT max-weight bipartite — it can sacrifice a 100-point pair to unlock two weak ones, the opposite of accounting safety), D order independence, E minimum evidence floor (amount-or-merchant signal required), F amount safety (existing 1%/£0.01 tolerance, unchanged), G scope (client + ledger book + padded date window), H explanation truthfulness.

## 5. Files changed

| File | Change |
|---|---|
| `zakiledger/lib/reconciliation-matching.ts` | Evidence floor (`hasEvidenceSignal`), deterministic sort key (score, bankId, qbId), doc comments |
| `zakiledger/lib/reconciliation-store.ts` | `QbPeriodScope` param on `listQbTransactionsForPeriod`; new `listMatchedQbIds`; `computeAndPersistMatches` excludes consumed QB rows + applies canonical-012 tenant scope |
| `zakiledger/lib/reconciliation-insights.ts` | Truthful `plainEnglishReason` ("merchant partially matches", "date is close (pending clearance)"); `factorBreakdown` credits partial weights (10/15) from engine constants |
| `zakiledger/tests/reconciliation-hardening.test.ts` | New: 24 tests (R1-R12 + adversarial 1-9 + two-phase live simulation) |
| `docs/RECONCILIATION_MATCHING_INVARIANTS.md` | New: invariants A-H with mechanisms |
| `supabase/hardening-prod-readonly-scan.sql` | New: SELECT-only production impact scan |

No migrations touched. No production writes.

## 6. Assignment algorithm before vs after

**Before:** all score>0 pairs → candidates; sort by score only; greedy claim with first-come ties (bank input order).

**After:** candidates require amount or merchant signal; sort by (score desc, bankId asc, qbId asc); greedy claim unchanged. Still O(n²) scoring + O(n log n) sort — pilot scale fine. Max-weight bipartite considered and rejected per invariant C.

## 7. Candidate-scope changes

Auto-matching pool now excludes: (a) QB rows already consumed by any live match row for the user (approved or not; `rejectMatch` frees the row again), (b) on canonical-012 stores, QB rows outside the resolved `client_entity_id` + `ledger_book_id`, (c) date-only candidates with no amount/merchant signal. Manual match lookup intentionally unchanged so a human can override anything.

## 8. Known-answer fixture results

| Bank | Expected | Actual (post-fix) |
|---|---|---|
| ACME OFFICE SUPPLIES -125.40 | QB-001 Acme | QB-001, 100, green ✓ |
| UBER TRIP 8392 -24.80 | QB-002 Uber, date-shifted | QB-002, 85, yellow ✓ |
| STRIPE PAYOUT 48391 +950 | QB-003 Stripe | QB-003, 85, yellow ✓ |
| ADOBE *CREATIVE CLOUD -54.99 | QB-004 Adobe | QB-004, 100, green ✓ |
| TESCO STORES 4421 -63.17 | review, not auto-approved | QB-005, 45, red review ✓ |
| BRITISH TELECOM -89.50 | QB-006 BT | QB-006, 75, yellow ✓ |
| TRAINLINE -42.60 | QB-007 Trainline | QB-007, 100, green ✓ |
| AMAZON EU SARL -78.25 | unmatched | unmatched ✓ |
| CLIENT PAYMENT NORTHSTAR LTD +1200 | QB-009 Northstar | QB-009, 100, green ✓ |
| COFFEE SHOP CENTRAL -6.45 | QB-010 Coffee | QB-010, 100, green ✓ |
| SOFTWARE SUBSCRIPTION XYZ -35.00 | review, amount mismatch | QB-011, 60, red review ✓ |
| INSURANCE PREMIUM -210.00 | QB-012 Insurance | QB-012, 100, green ✓ |
| Parking Meter -12.00 (QB-only) | unmatched QB | unmatched ✓ |
| 4FB-CANONICAL-TEST A/B | never matched | unmatched ✓ |

All asserted by `tests/reconciliation-hardening.test.ts` using the real matching functions.

## 9. Order-independence results

Full fixture: original / bank-reversed / amount-sorted / QB-reversed all produce identical assignments. Equal-evidence tie test: winner fixed by bankId, stable across input orders. R6b green.

## 10. QB reuse results

Within-run: Set-based claim, one QB per run (R4/R5). Across statements: approved QB row no longer reusable (R8a), unapproved live auto match also consumes (R8b), rejected match frees QB (adversarial 8). All green at store level (in-memory fallback).

## 11. Approved-match exclusion results

`listMatchedQbIds` reads every live `reconciliation_matches` row for the user (auto or manual, approved or not) and excludes those QB ids from auto-matching. Store tests prove both approved and unapproved cases. Rejection deletes the row, restoring eligibility.

## 12. Confidence/explanation results

- Stripe (85): reason now renders "Amount matches, date matches, and merchant partially matches." Breakdown 40/35/10 = 85, matching the stored confidence. Previously claimed full merchant match and showed 100 in the panel.
- Pending date: "date is close (pending clearance)" disclosed; breakdown credits 15, not 35.
- Score was not changed — explanation was made truthful (invariant H).

## 13. Tenant/canonical safety regression

- Canonical-012 stores: match writes still stamp `client_entity_id`; bank/QB writes still stamp both IDs; `match_qb_same_client_v1` and stamp-required triggers untouched.
- Migration 012 contract suite: 1 pre-existing failure (DB-dependent test needing local Auth/PostgREST stack) — fails identically on pre-change code.
- New scope filter is capability-gated: pre-012 stores keep legacy behavior.
- Mem store has no tenant stamps; scope is a documented no-op there (isolation is a Postgres-layer concern, covered by migration-012 tenant-isolation tests).

## 14. Static/build/full-test results

- `npm run typecheck`: clean.
- `npm run build`: green.
- `npx vitest run` (zakiledger): 468 passed, 8 failed, 101 skipped. All 8 failures are pre-existing on unchanged code (bulk-approve 6, batch-results 1, migration-011-contract 1 + migration-012 file-level), proven by stash-and-rerun.
- Insights perf test (600ms budget): fails at ~1.1-1.9s on this machine **on unchanged code** — machine-dependent, not caused by this change; threshold untouched.
- Hardening suite: 24/24 green. Existing reconciliation suites (matching 12, store 5, insights, compat 17, nightly): all green.

## 15. Production read-only impact scan

SELECT-only via linked pooler (TLS verified against Supabase pooler CA chain), 2026-08-14:

| Metric | Count |
|---|---|
| TOTAL_MATCHES | 573 |
| QB_REUSED_ACROSS_MATCHES | 107 |
| QB_SHARED_BY_APPROVED | 91 |
| UNAPPROVED_POINTING_AT_APPROVED_QB | 152 |
| MATCHES_green / yellow / red | 319 / 16 / 238 |
| VERY_LOW_CONFIDENCE_LT_40 | 88 |
| LOW_CONFIDENCE_LT_70 | 238 |
| UNAPPROVED_AUTO_MATCHES | 164 |
| MATCHES_ON_4FB_TEST_QB | 5 |
| 4FB_TEST_QB_ROWS_PRESENT | 2 |

**Classification: needs deterministic repair plan** (separate task). Reuse counts violate invariants A/B: 107 reused QB ids, 152 unapproved matches sitting on QB rows already approved elsewhere. 238 red matches need professional review. 4FB test rows NOT cleaned (per brief) — the repair plan must decide their disposition explicitly.

## 16. Remaining risks

- **Production data carries pre-existing violations.** Fix stops new ones; existing rows stay wrong until the repair plan runs. The 5 matches on 4FB test rows and the 152 unapproved-on-approved rows are the sharpest cases.
- **Greedy, not max-weight.** Documented and deliberate (invariant C), but equal-evidence ties now resolve by id order, which is arbitrary (deterministic, not optimal). Acceptable at pilot scale; revisit with real volume.
- **Frozen-match semantics unchanged.** A bank row with a live match is never re-scored, even when better QB data arrives later. Safe now that junk matches can't freeze (floor rule), but a legit upgrade path is future work.
- **Scope filter untested at unit level** (mem store lacks stamps); covered at DB level by migration-012 tests and the `match_qb_same_client_v1` trigger.
- **UI copy changed** — e2e Playwright specs that assert old reason strings (if any) need a staging pass.

## 17. Recommended next gate

1. **Adversarial staging run** on the staging project (`gzwtxebgevgapchoslmp`): deploy this change, re-run the live-test fixture end-to-end, plus permutation/reuse probes against a real Postgres.
2. Then a **production repair plan** (separate explicit task): reconcile the 107 reused QB ids, 152 unapproved-on-approved rows, 238 red matches, and dispose of the 4FB test rows.
3. Then a controlled production deploy (freeze-on, deploy, smoke, unfreeze — same protocol as Step 4F-B).

Do NOT deploy production from this report.
