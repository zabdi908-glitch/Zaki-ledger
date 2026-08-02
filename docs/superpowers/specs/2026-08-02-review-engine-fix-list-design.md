# Review Engine Fix List — Design

**Source:** An experienced accountant's review of the live Review Matches screen, delivered
as a 14-item fix list across four priorities (see the fix list in the originating
conversation for full item text). This spec turns that list into sequenced,
independently-shippable groups.

## Context

The repo already has four groups of prior planning (`docs/superpowers/plans/2026-08-01-group-*.md`):
Group 0 (performance), Group A (blockers), Group B (decision automation) are **fully shipped**
(every task's files/commits exist). Group C (invoice matching) and Group D (dashboard
summary) were **planned but never built** — no `lib/invoice-matching.ts`,
`lib/ledger-impact.ts`, `lib/review-summary.ts`, etc. exist yet.

The accountant's fix list therefore lands on three different kinds of ground:

1. **Live bugs in shipped code** (items 1, 2, 3, 4, 8) — the scoring engine
   (`lib/reconciliation-matching.ts`), pattern detectors (`lib/reconciliation-detectors.ts`),
   and review-copy layer (`lib/reconciliation-insights.ts`) that Groups 0/A/B built on top of.
2. **Gaps in already-shipped Group B work** (items 5, 6, 7, 11, 12) — the merchant-category
   table, recurring/refund detection, decision-store, and bulk-approve modal all exist;
   the fix list asks for more coverage or tighter behavior, not new subsystems.
3. **Unbuilt Group C/D work** (items 9, 10, 13, 14) — the accountant is asking for panels
   and a dashboard that were speced in 2026-08-01 but never implemented. Nothing here
   conflicts with Group C/D's design; it resurrects them.

## Root causes found during investigation

- **Item 1 (Ready queue showing "Review recommended"/80%/87%)**: `sectionFor` in
  `reconciliation-insights.ts` already excludes `reversal`/`refund`/`split` detection kinds
  from the "ready" section via early return, but not `merchant` (Related Merchant). A
  transaction can score green (≥95, e.g. via amount+date alone) while also carrying a
  low-confidence merchant-link hint (70-87%, from `MERCHANT_LINK_THRESHOLD`/
  `MERCHANT_STRONG_THRESHOLD`). `buildReviewRows` then displays that merchant-link's own
  (lower) confidence and label on a row sitting in "ready" — reproducing the bug exactly.
  Fix is one added early-return case, not a rework of the bucketing logic.
- **Item 2 (Duplicate/Split/Recurring shown together)**: `buildReviewRows` unconditionally
  `badges.unshift("Duplicate")` whenever `detectDuplicates` matches, independent of whatever
  `found` detection (e.g. a split-group) already claimed the row, and `detectBadges` adds
  "Recurring" independently of both. Three badges can legitimately co-occur today.
- **Item 3 (Related Merchant noise)**: `merchantProfile`'s "brand" token is the first
  significant token ≥3 chars. Generic transactional nouns ("client", "payment"-family) are
  only partially in `NOISE_TOKENS`, so two unrelated lines like "CLIENT PAYMENT INV-3003" and
  "CLIENT PAYMENT INV-3010" both resolve to brand `"client"` and false-match at high
  similarity. This is a token-noise gap, not a similarity-algorithm problem — the algorithm
  already correctly separates real examples (Adobe Creative Cloud / Adobe Systems Ireland,
  Amazon Marketplace / Amazon EU) per existing passing tests.
- **Item 8 (Transfer scoring 0-40%)**: transfers usually have no accounting-side entry at
  all, so their displayed confidence is `matchPct` (0, since there's no match) rather than a
  transfer-specific signal. Reversal/refund/split/duplicate all get their own detector-derived
  confidence (85-99%) independent of QB matching; Transfer is only a regex badge today, not a
  detector, so it never gets that treatment.

## Decisions from clarifying discussion

- **Ready-queue gate**: "unresolved warning" = a `merchant` (Related Merchant) detection
  only. Transfer and Recurring badges continue to qualify for Ready when the underlying
  match scores green — this preserves the existing shipped test/comment
  ("a recurring subscription that reconciles cleanly should not be pulled out of the bulk
  approve queue just for being recurring") and is consistent with item 8's intent (transfers
  should be *confidently and quickly* approvable, not pulled into manual review).
- **Confidence layering**: `scorePair`/`matchTransactions` remain pure (amount/date/merchant
  only, no DB access) — this is an explicit existing design constraint, not incidental.
  Historical-approval/invoice-match/recurring-supplier signals are folded in as a *display*
  adjustment in the insights layer (mirrors how `suggestCategory` already layers
  `MerchantPreference` on top of the raw match). Section routing (`sectionFor`) keys off the
  raw match score, unchanged — only the shown confidence/evidence text is adjusted. This
  keeps Group E's blast radius to two files and keeps every existing matching-engine test
  valid unmodified.
- **Bulk actions (#12)**: cross-cutting "approve all Software expenses" grouping is
  deferred past this pass. The existing per-section bulk-approve-with-preview-modal
  (Group B Task 7) stays as the only bulk mechanism until Group E ships and stabilizes.

## Sequencing: four groups

### Group E — Engine Integrity (Priority 1, do first)

The shared-engine group. All six items touch `reconciliation-matching.ts`,
`reconciliation-detectors.ts`, and/or `reconciliation-insights.ts` — sequenced so each step
is independently testable/committable and later steps build on cleaner data from earlier
ones:

1. **Merchant-link noise fix** (#3) — extend noise-token stripping / reference-token
   exclusion in `reconciliation-detectors.ts` so generic transactional nouns never become
   the "brand" token. Tests: `tests/reconciliation-detectors.test.ts`.
2. **Single-classification badges** (#2, UI half) — resolve one classification per row
   (mirroring `sectionFor`'s existing priority order: duplicate > reversal > refund > split
   > merchant > transfer > recurring) instead of independently unshifting every applicable
   badge. Tests: `tests/reconciliation-insights.test.ts`.
3. **Duplicate detection tightening** (#2, core) — add transaction-type, money-in/out
   direction, reference, and `BankTransaction.transactionId` agreement to `detectDuplicates`;
   require multiple strong-field matches, not just name+amount+date. Tests:
   `tests/reconciliation-detectors.test.ts`.
4. **Ready-queue gate** (#1) — add `detectionKind === "merchant"` as an early-return case in
   `sectionFor`, routing to "review". Tests: `tests/reconciliation-insights.test.ts`.
5. **Transfer as a first-class detector** (#8) — promote the regex Transfer badge into a
   real detection (own 85-99% confidence, suggested action), following the
   reversal/refund/split pattern in `buildDetections`. Tests: both detector and insights
   test files.
6. **Confidence layering** (#4) — new pure module (e.g. `lib/confidence-adjustments.ts`)
   taking a match plus `MerchantPreference[]`/decision history and producing an adjusted
   display confidence + evidence strings; wired into `buildReviewRows` without touching
   `match.confidence` or `sectionFor`. Tests: new dedicated test file.

### Group F — Categories & Recurring (Priority 2, low risk)

- **#5**: expand `merchant-categories.ts`'s `RULES` table (Office Depot, Stripe Fee/PayPal
  Fee → Merchant Fees, Bank Charges, etc.) — pure additive, no existing behavior changes.
- **#6**: tighten recurring detection onto Group E's detector pattern (same merchant, same
  direction, similar amount, repeated over time) instead of the current
  any-merchant-appears-twice badge.
- **#7**: gap-check refund pairing against the fix list's exact wording — `refundDetection`
  already links both transactions, shows net effect, and has a suggested action; verify
  nothing more is needed rather than rebuilding.

### Group G — Explainability (Priority 3)

- **#9**: ledger-impact panel — resurrects the never-built Group C Task 5
  (`lib/ledger-impact.ts`) standalone, without needing Group C's invoice-matching Tasks 1-4.
- **#10**: reshape `ReconciliationPanelBody`'s generic reasoning block into the structured
  AI Recommendation panel, consuming Group E's adjusted confidence + evidence.
- **#11**: extend `decision-store.ts` to log VAT treatment, invoice-match, transfer, and
  duplicate decisions on top of what Group B already logs (merchant→category, approve/reject).
- **#14**: copy-only pass ensuring every panel answers what/why/confidence/effect-of-approval/
  accounting-entries — rides on #9/#10/#11, no new logic.

### Group H — Bulk & Dashboard (deferred)

- **#12**: cross-cutting bulk actions by category/type.
- **#13**: review dashboard summary — resurrects the never-built Group D Tasks 1-3 (summary
  + progress + time estimate); Group D's undo/CSV-export (Tasks 4-5) stay out of scope unless
  separately requested.

Group F/G/H all depend on Group E shipping and stabilizing first (they consume its detector
pattern, confidence layer, or badge/section resolution). F, G, and H are independent of each
other.

## Testing approach

Test-driven throughout, per existing repo convention: every sub-item gets a failing test in
its existing test file (`reconciliation-matching.test.ts`, `reconciliation-detectors.test.ts`,
`reconciliation-insights.test.ts`) before implementation, plus new test files for genuinely
new modules (confidence-adjustments, ledger-impact). `npm run check` must stay green after
every commit within Group E — existing tests encode confirmed intended behavior (e.g. the
Transfer/Recurring-stays-in-Ready test) and must not be weakened to pass.

## Out of scope for this spec

- Group C's invoice-matching Tasks 1-4 (reference extraction, invoice-match persistence,
  suggestion card) — item 9 only needs Task 5's pure impact function, not the invoice side.
- Group D's undo/CSV-export (Tasks 4-5) — not requested by the fix list.
- Cross-cutting bulk actions (#12) — explicitly deferred.

## Self-review notes

- Placeholder scan: none found — every group lists concrete files/tests.
- Consistency: Group E's ordering (E1→E6) matches the dependency reasoning above; no group
  references a file another group hasn't yet created.
- Scope: this spec covers all four groups at design level but only Group E is taken to a
  detailed task-by-task plan next (matches the existing repo convention of one plan doc per
  group, written when that group's turn comes).
- Ambiguity: the "unresolved warning" and confidence-layering questions that were ambiguous
  in the accountant's fix list are resolved above with explicit reasoning, not left as TBD.
