# Session note — 2026-07-27 · Phase 2, slice 1: Receipts

**Scope:** auto-detection + receipt schema + reuse of the Phase 1+3 trust machinery.
**Explicitly parked (not started):** bulk approve, multi-page receipts.
**State:** working tree modified, **not committed**.

---

## Status at session start

No Phase 2 work existed. Clean tree at `daaf5fb` (Phase 1+3 docs); no document-type
detection, no receipt schema, nothing broken.

**Correction to the brief:** there is no 79-test regression suite in this repo — no test
runner, no test files, and `package.json` has only `dev/build/start/typecheck`. Nothing
has been deleted; it appears never to have existed here. What ran instead is described
under *Testing* below. Worth deciding whether to stand up a real runner (vitest) before
Phase 2 grows, since receipts have just doubled the branching in the gate.

---

## What shipped

### 1. Auto-detection — one pipeline, not two
`documentType: { value: "invoice" | "receipt", confidence }` is now a field on
`InvoiceExtractionSchema`, classified by the **same** vision call that reads the fields.
No separate detection request, no second pipeline, no extra cost. The system prompt
teaches the invoice/receipt distinction (payment terms and a due date vs. a card/auth
line and "thank you") and instructs the model to lower `documentType` confidence when
genuinely ambiguous. The detected type + its confidence is shown as a badge on the
review screen, because the type changes which fields are required.

### 2. Receipt schema — same fields, receipt semantics
Deliberately **not** a new schema. The same field keys carry receipt meanings, so every
downstream ledger, index and calibration path is shared:

| Field | Invoice | Receipt |
|---|---|---|
| `supplierName` | Supplier | **Merchant** (label only — same key, same storage) |
| `invoiceNumber` | required | **optional**, often absent |
| `tax` | itemised | often not stated → new `taxItemized` flag |

New `taxItemized: boolean` records whether the document actually broke out a tax figure.
UK receipts often print a VAT *number* without a VAT *amount* — the prompt is explicit
that this is still `false`, and that tax must never be back-calculated.

**Missing itemised tax degrades gracefully, as required:**
- `arithmeticMismatch` / the live totals check are **skipped**, not failed — "0 + 0 ≠ 12.40"
  is a property of the document, and flagging it would train the user to ignore the check.
- `tax` drops out of the Important tier, so there's no warning about a field the document
  never had.
- The field renders greyed with a `— not stated` chip and a plain explanatory note instead
  of a red "⚠ check" the human can never satisfy. Still editable if they know the figure.

### 3. Trust machinery — reused, not rebuilt

- **Merchant memory / calibration:** untouched. It keys on `supplierName`, which for a
  receipt holds the merchant, so the same curve applies with no code change. Verified
  accruing 0.88 → 0.94 → 0.97 → 0.985 → 0.99 across five approvals of one merchant.
- **Confidence gating:** same `gateApproval`, same three tiers, same 0.8/0.6 thresholds.
  Only *membership* varies, via `CRITICAL_FIELDS_BY_TYPE` — a receipt drops
  `invoiceNumber` from Critical, since gating on it would permanently block a good
  receipt on a field that was never printed. `gateApproval(confidences)` with no context
  still behaves exactly as before for any existing caller.
- **Duplicate detection:** same two checkpoints (upload-time + approve-time), same
  warn-never-block contract, same audit logging. Only the *identity predicate* is
  extended: an invoice is still supplier + number; a receipt is **merchant + date +
  total**, because a receipt usually has no number and the existing check would silently
  never fire. Both go through one `findDuplicateDocument(type, …)` entry point so the two
  checkpoints can't drift apart.

### 4. Bug found and fixed during testing
The messy receipt recorded **5** confirmations, two of them for `subtotal: 0` and
`tax: 0` — fields the receipt never stated. The approve route already skipped empty
values ("nothing detected isn't something to gain trust in") but a numeric `0`
stringifies to `"0"` and slipped through. Left alone this would build a per-merchant
track record out of *absences*, and calibration would later inflate a genuinely uncertain
tax read on the strength of it — the exact silent-false-confidence failure the design
exists to prevent. Confirmations now also require `confidence > 0`. Correct count is 3
(date, currency, total).

### 5. Schema/DB
`invoices` gains `document_type text not null default 'invoice'` plus an idempotent
`alter table … add column if not exists` for existing deployments (pre-receipt rows are
invoices, so the default is correct) and a partial index on
`(lower(supplier_name), invoice_date, total) where document_type = 'receipt'`.

---

## Testing

No regression suite exists, so this was: `tsc --noEmit` clean, plus two purpose-written
smoke passes against the real code and a running dev server.

- **Gate/validation logic — 22 checks, all passing** (against the real exported
  functions, via `tsx`). Covers invoice behaviour unchanged, both unlock paths
  (edit + confirm-as-is), clean receipt ready, and the key case below.
- **End-to-end HTTP flow — 19 checks, all passing** against `npm run dev`: extract →
  confidence/memory → approve → duplicate → proceed-anyway, for all three documents.

**The explicit question — does a receipt missing an invoice number still gate and approve
correctly? Yes.** The messy sample blocks on its genuinely smudged merchant name (0.61),
*not* on the absent number; `invoiceNumber` never appears among the blocking reasons; once
the merchant is corrected the receipt is `ready` and approves. The control assertion
confirms the same document under invoice rules *would* be permanently blocked — which is
what the per-type Critical set exists to prevent.

Both scripts live in the session scratchpad, not the repo.

**Not covered:** real vision extraction. `ANTHROPIC_API_KEY` isn't set locally, so every
run used demo samples — meaning **the detection prompt itself is untested against real
documents.** Three samples exist (`invoice`, clean `receipt`, `messy-till-receipt`) and
demo mode picks between them by filename. This is the biggest open risk in the slice.

---

## Rough / known gaps

1. **Detection accuracy is unverified.** Needs a run against real receipts with a live
   key before any pilot sees it. Ambiguous cases (a paid invoice marked "PAID", a pro
   forma) are exactly where it'll be shakiest.
2. **Naming debt:** `supplier_name` in the DB and `supplierName` in code now hold a
   merchant for receipts. Deliberate — renaming to `counterparty_name` would touch
   `invoices`, `corrections`, `confirmations` and every query, for no behaviour change.
   Worth doing before multi-tenancy, not now.
3. **`findDuplicateInvoice` is not type-scoped.** An invoice could in principle match a
   stored receipt that happens to share a supplier + number. Left as-is so Phase 1
   behaviour is byte-identical; the receipt path *is* scoped.
4. **Two identical same-day purchases** (two identical coffees) will flag as a duplicate.
   Correct as a warning — the human waves it through — but it will be the first false
   positive a pilot user hits.
5. **Receipts post as draft bills**, same as invoices, with the line description switched
   to "Receipt …". Arguably a receipt should be a spend-money transaction in Xero; not in
   scope today and untested against a live org.
6. **Demo filename routing** (`receipt`/`messy` in the name) is a demo-mode-only affordance.
   Harmless, but it is UI-visible in the demo banner.

---

## For the full regression pass (after bulk approve + multi-page land)

Fold these in as cases:

- Receipt with **no number** → not blocked; approves; posts with no `DocNumber`/`InvoiceNumber`.
- Receipt with **no itemised VAT** → arithmetic check skipped, no tax warning, tax/subtotal
  render as "not stated".
- **Confirmation ledger must never record zero-confidence or empty fields** (the bug above) —
  assert the count, since this is silent when wrong.
- Receipt duplicate on **merchant + date + total**; and the *negative* case — same merchant
  and date, different total → not flagged.
- **Approve-time** receipt duplicate after the human corrects the merchant name (upload-time
  legitimately misses this; it's the whole reason the second checkpoint exists).
- `gateApproval` with **no context argument** still applies invoice rules (legacy callers).
- Same document judged under both type rulesets — the control that proves the per-type
  Critical set is doing real work.
- Detection confidence **below threshold** — no behaviour is defined for a low-confidence
  *type* decision yet. Currently a coin-flip type silently picks a ruleset. Worth deciding:
  should a sub-0.8 `documentType` prompt the human to confirm the type before review?
