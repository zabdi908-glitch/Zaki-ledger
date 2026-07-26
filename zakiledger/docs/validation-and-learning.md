# Validation & Learning Model (Phase 1 + 3)

How Zaki Ledger turns a raw invoice into a human-approved, posted bill — and how
it gets more confident over time. This is the reference for the pilot; it maps
each behaviour to the code that implements it.

## The pipeline

```
upload → /api/extract → review screen → /api/approve → draft bill (Xero/QBO)
             │                │                │
        confidence +     gating, arithmetic,   corrections + confirmations
        calibration      confirm-as-is,        (the learning ledger)
        + supplier       duplicate warning
        memory
```

- **`/api/extract`** (`app/api/extract/route.ts`) — runs vision extraction
  (real Claude when `ANTHROPIC_API_KEY` is set, otherwise a demo sample), then
  calibrates each field's confidence from this supplier's track record and
  attaches supplier-memory + a duplicate check.
- **Review screen** (`app/page.tsx`) — every field shows a confidence chip; the
  human edits, confirms, or is gated. Nothing is saved until Approve.
- **`/api/approve`** (`app/api/approve/route.ts`) — persists the approved
  invoice, records the learning signals, re-checks for duplicates on the final
  values, and posts a draft bill to whichever platform is connected.

## Confidence: scored, then calibrated

Each field carries a model confidence (0–1). On its own that's a per-read
estimate that never improves. Calibration folds in a **track record**:

- **Confirmation ledger** — every field approved *unchanged* is recorded as a
  confirmation (`recordConfirmation`), keyed by supplier + field. Every field
  *changed* is a correction (`recordCorrection`). Both are append-only.
- **Calibration curve** (`lib/calibration.ts`): `calibrated = raw + (1-raw)·(1−0.5ⁿ)`
  where `n` = confirmations for this supplier+field, capped at **0.99**. Each
  confirmation closes half the remaining gap to certainty (1 → +0.14, 2 → +0.21…).
- **Established-trust floor** — once a supplier+field has **≥4** confirmations,
  a single noisy low read can't drop the shown confidence below the high-water
  mark already earned (`FLOOR_MIN_CONFIRMATIONS`).
- **Reset on correction** — confirmations only count *since the last correction*
  for that field (`confirmationStatsForSupplier`). An edit means the system was
  wrong, so trust rebuilds from scratch.
- Calibration is keyed on **supplier + field**, not value — so a supplier's
  invoice-number *style* trends up even though each invoice number is unique.

**Supplier memory** — the same stats surface in the UI as
`🧠 Seen N× before from this supplier · confidence X%` per field
(`supplierMemory` in the extract response).

## Approval gating (three tiers)

`gateApproval` (`lib/validation.ts`) classifies the extraction, evaluated in order:

| Tier | Fields | Threshold | Result |
|------|--------|-----------|--------|
| Critical | supplierName, invoiceNumber, invoiceDate, total | < 80% | **blocked** — Approve hidden |
| Important | tax, currency | < 60% | **review** — button reads "Approve anyway" |
| — | otherwise | — | **ready** — normal "✓ Approve" |

The gate reads **effective** confidence, not raw. A field becomes verified (→100%,
clears the gate) two ways (`effectiveConfidence`):

1. **Edit** — change the value to something new and non-empty (records a correction).
2. **Confirm-as-is** — affirm the value without changing it (records a confirmation).

Confirm-as-is exists to break a deadlock: a *correct-but-low-confidence* field
(e.g. an invoice number the model reads right but timidly) could otherwise only
be unlocked by editing it — which recorded a correction and reset calibration, so
the field was stuck in a permanent edit-reset loop and never earned trust. The
"✓ Confirm this is correct" button unlocks the gate *and* feeds calibration.
A field cleared to **blank** never verifies, by either path.

## Arithmetic validation

`checkTotals` (`lib/validation.ts`) checks `subtotal + tax = total` within a
±0.01 tolerance, live as the human edits. Shows ✓ or a ❌ with expected-vs-found.
It warns; it never blocks. Runs alongside the confidence gate.

## Duplicate detection

Scoped to **supplier + invoice number** (a corrected-resend of the same invoice
is intentionally out of scope). Checked at two points against
`findDuplicateInvoice`:

- **Upload-time** (`/api/extract`) — early warning on the *raw* extracted value.
- **Approve-time** (`/api/approve`) — on the *final human-approved* value. This
  catches the case the upload check misses: the raw extraction misreads the
  number, the human corrects it, and the corrected value matches an existing
  invoice.

Either way it **warns, never blocks** — the UI shows a card with **Proceed
anyway** / **Discard**; `proceedDuplicate` carries the human's choice. Every
check is logged as `[duplicate-check] …` (audit trail).

## Accounting integrations

After approval, `postApprovedBill` (`lib/accounting.ts`) posts a **draft** bill
to whichever platform is connected (**Xero first**, then QuickBooks):

- **Xero** (`lib/xero.ts`) — ACCPAY invoice, `Status: DRAFT`, contact by supplier
  name, extracted line items. Scope `accounting.invoices offline_access`
  (granular scopes for post-2026 Xero apps).
- **QuickBooks** (`lib/quickbooks.ts`) — Bill entity; finds/creates the vendor by
  name, books the total as a single expense line on the first Expense account.
  **DueDate = bill date + 30 days** (ignores the invoice's own terms) so it never
  lands as "Overdue"; the bill date falls back to today if the invoice date is
  unparseable. Sandbox by default (`QUICKBOOKS_ENVIRONMENT=production` for live).

Both do **OAuth 2.0** with automatic token refresh (access tokens are short-lived;
the rotating refresh token is stored). Connect via the home-page buttons or
`/api/{xero,quickbooks}/connect`; status is read from `/api/connections`.

**Known cross-platform differences (expected):** Xero itemises line items and
gets no due date from us; QuickBooks posts one summary line at the total and gets
the +30-day due date.

## Persistence

Everything falls back to an **in-memory** store when Supabase isn't configured,
so the app runs end-to-end keyless — but in-memory state resets on process
restart (e.g. a Render free-tier cold start), which drops OAuth connections and
the learning ledger. **Configure Supabase for durable persistence.**

Tables (`db/schema.sql`): `invoices`, `corrections`, `confirmations`
(with a `confidence` column for the trust floor), `oauth_connections`. Run
`db/schema.sql` against the project; it's idempotent (`create table if not
exists`), but an existing `confirmations` table needs the column added manually:
`alter table confirmations add column if not exists confidence numeric(4,3);`

## Environment variables

| Var | Purpose |
|-----|---------|
| `ANTHROPIC_API_KEY` | Real extraction (absent → demo sample) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Durable persistence (absent → in-memory) |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Xero OAuth |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | QuickBooks OAuth |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` (default) or `production` |
| `RENDER_EXTERNAL_URL` / `APP_URL` | Base URL for OAuth redirect URIs (Render sets the former automatically) |

OAuth redirect URIs to register with each provider:
`{base}/api/xero/callback` and `{base}/api/quickbooks/callback`.
