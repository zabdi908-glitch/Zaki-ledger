# Reconciliation Matching Invariants

Adopted 2026-08-14 as the correctness contract for the bank->QB auto-matching
pipeline. Each invariant is either already enforced, or enforced by the
hardening change described under "Mechanism".

| # | Invariant | Mechanism |
|---|-----------|-----------|
| A | **One-to-one.** A QB transaction may belong to at most one live reconciliation match at a time, across statements. | Auto-matching excludes QB ids that already appear in any live `reconciliation_matches` row for the user. `rejectMatch` deletes the row, which frees the QB row again. |
| B | **Approved-match immunity.** A QB row used by an approved match is never eligible for a new automatic match. Approved matches are immutable (`rejectMatch` refuses them), so exclusion follows from A. | Same exclusion as A — approved rows are live rows. |
| C | **Strongest evidence wins.** A weak speculative match must never consume a QB row that has a materially stronger candidate elsewhere. | Candidates are claimed in descending score order (global sort, then greedy claim). Deliberately NOT maximum-weight bipartite matching: max-weight can sacrifice a 100-point pair to unlock two weaker pairs, which is the opposite of accounting safety. Fewer, stronger matches beat more, weaker matches. |
| D | **Order independence.** Same candidate graph, same assignment, regardless of bank input order. | Full deterministic sort key: `score desc, bankId asc, qbId asc`. Ties no longer resolve by input position. |
| E | **Minimum evidence floor.** A candidate with no amount signal and no merchant signal (date proximity only) is not evidence of an accounting match and is never proposed/persisted. | `matchTransactions` drops candidates whose reasons contain neither `amount` nor a `merchant*` reason. |
| F | **Amount safety.** Gross amount/sign mismatch earns no amount credit (existing 1% / £0.01 tolerance, unchanged), and can never reach green without a human. | Unchanged scoring; verified by regression tests (Tesco, Software, sign-mismatch cases). |
| G | **Scope.** Only QB rows relevant to the user, canonical client entity, and canonical ledger book participate in auto-matching, inside the statement's ±5-day padded window. | Canonical-012 stores: `listQbTransactionsForPeriod` gains optional client/ledger-book filters; `computeAndPersistMatches` passes the resolved tenant context. Manual override intentionally bypasses scope so a human can fix anything. Pre-012 stores keep legacy behavior. |
| H | **Explanation truthfulness.** UI copy and factor breakdowns must reflect the actual scoring factors and partial scores. | `plainEnglishReason` renders full factor phrases (`merchant partially matches`, `date is close (pending clearance)`); `factorBreakdown` credits partial weights (10 for partial merchant, 15 for pending date) instead of max weights. |

## Non-goals

- Maximizing match count. Fewer matches with honest review flags is the goal.
- Re-scoring bank rows that already carry a live match (frozen-match upgrade is
  a separate, explicitly scoped task; the floor rule prevents junk matches from
  ever freezing in the first place).
- Retuning similarity thresholds or score weights (no arbitrary threshold
  changes without production evidence).
- Touching migrations 010/011/012, production data, or tenant-isolation
  triggers.

## Known production consequences (read-only classification, no repair here)

Rows persisted before this change may include: QB reuse across statements, and
date-only junk matches (e.g. `4FB-CANONICAL-TEST` rows). Those are data-repair
candidates classified in the production impact scan — not touched by this work.
