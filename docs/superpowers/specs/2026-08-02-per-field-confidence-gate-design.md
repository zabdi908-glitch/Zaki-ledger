# Per-Field Confidence Reasoning + Gate — Design

Sub-project of [INVOICE_EXTRACTION_REBUILD_SPEC.md](../../../INVOICE_EXTRACTION_REBUILD_SPEC.md), scoped to the `backend/` + `frontend/` + `supabase/` rebuild stack (Express + React + Supabase), which replaces the `zakiledger/` Next.js monolith.

## Problem

The current extraction pipeline (`backend/src/lib/openai.ts`, `backend/src/routes/documents.ts`) scores each field's confidence but only stores one global `reason` string, and gates auto-approval on `overall_confidence` — an average across all 6 scored fields (merchant, invoice_number, date, amount, tax, category). This lets a strong tax/category score mask a shaky merchant/amount, or a weak tax/category score block an otherwise-solid extraction. The spec calls for per-field reasoning shown to the user, and a display/approval gate based specifically on the three critical fields (merchant, date, amount).

## Scope

In scope:
- Per-field confidence reason text for all 6 scored fields
- New `needs_review` gate based on merchant/date/amount only
- Auto-approve rule switched from overall-average to per-critical-field threshold
- Frontend surfacing of the above (badges already generic; Upload.tsx tally logic updated)

Out of scope (deferred to later sub-projects):
- Claude-fallback picker UI (showing OpenAI vs Claude alternatives to the user) — auto-apply behavior is unchanged for now
- Duplicate detection
- Manual review `/batch` click-to-edit page
- Export to QB/Xero/CSV
- New extraction fields (line_items, payment_terms, currency, customer_po_number)
- TIFF support

## Design

### 1. Schema (new migration `supabase/migrations/002_per_field_reasoning.sql`)

Add to `public.extracted_items`:
```sql
ALTER TABLE public.extracted_items
  ADD COLUMN merchant_confidence_reason TEXT,
  ADD COLUMN invoice_number_confidence_reason TEXT,
  ADD COLUMN date_confidence_reason TEXT,
  ADD COLUMN amount_confidence_reason TEXT,
  ADD COLUMN tax_confidence_reason TEXT,
  ADD COLUMN category_confidence_reason TEXT,
  ADD COLUMN needs_review BOOLEAN DEFAULT FALSE;

CREATE INDEX idx_extracted_items_needs_review ON public.extracted_items(user_id, needs_review);
```

The existing `reason` column stays as-is (legacy overall-extraction note); it is not removed since other code may reference it, but new code should populate the per-field reasons instead.

### 2. Extraction prompt (`backend/src/lib/openai.ts`)

`SYSTEM_PROMPT` is extended so every field returns both a confidence score and a reason string, always populated (not only below 70% — the spec's own high-confidence examples include a reason, e.g. "Standard date format, clearly printed"). Response shape:

```json
{
  "merchant": "...", "merchant_confidence": 95, "merchant_confidence_reason": "...",
  "invoice_number": "...", "invoice_number_confidence": 88, "invoice_number_confidence_reason": "...",
  "transaction_date": "2026-07-24", "date_confidence": 99, "date_confidence_reason": "...",
  "amount": 184.32, "amount_confidence": 97, "amount_confidence_reason": "...",
  "tax_amount": 0, "tax_confidence": 60, "tax_confidence_reason": "...",
  "category": "Office Supplies", "category_confidence": 82, "category_confidence_reason": "...",
  "overall_confidence": 92,
  "reason": null
}
```

`ExtractionResult` interface in the same file gains the 6 new `*_confidence_reason: string` fields. Both `extractDocument` and `extractFromText` share the one prompt, so both get the change for free.

### 3. Gate logic (`backend/src/routes/documents.ts`, in the `/upload` handler, after the Claude fallback merge into `finalExtraction`)

```ts
const critical = [finalExtraction.merchant_confidence, finalExtraction.date_confidence, finalExtraction.amount_confidence];
const needs_review = critical.some(c => c < 70);
const status = critical.every(c => c >= 95) ? 'approved' : 'pending';
```

`overall_confidence` is still computed and stored (still useful for dashboard sorting/avg stats) but no longer drives `status` or `needs_review`. The insert into `extracted_items` gains `needs_review`, plus the 6 reason columns from `finalExtraction`.

Claude fallback (`validateLowConfidence`) behavior is unchanged: still triggers when any field is <70%, still auto-applies corrections into `finalExtraction` before the gate check runs.

### 4. Frontend

- `frontend/src/types/index.ts`: `ExtractedItem` gains the 6 `*_confidence_reason: string` fields and `needs_review: boolean`.
- `frontend/src/pages/Upload.tsx`: the high/medium/low tally (lines 43-45) switches from `overall_confidence` bucket thresholds to reading `status === 'approved'` (high), `status !== 'approved' && !needs_review` (medium), `needs_review` (low) — so the summary matches the new gate instead of the old average.
- `frontend/src/components/ConfidenceBadge.tsx`: unchanged. It's a generic %-badge already reusable per-field; no field-specific logic lives in it.

## Testing

- Unit test the gate function (extract it as a small pure function, e.g. `computeReviewStatus(critical: number[])`, so it's testable without hitting OpenAI/Supabase).
- Manual: upload a real high-confidence invoice (all fields clear) → expect `approved`, `needs_review=false`. Upload a low-quality/damaged one → expect `pending`, `needs_review=true`, all 6 reason fields populated and readable.
