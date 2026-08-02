# Per-Field Confidence Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overall-average confidence gate with per-field reasoning and a critical-field (merchant/date/amount) gate, per [docs/superpowers/specs/2026-08-02-per-field-confidence-gate-design.md](../specs/2026-08-02-per-field-confidence-gate-design.md).

**Architecture:** Extend the `extracted_items` table with 6 reason columns + `needs_review`. Extend the OpenAI extraction prompt to emit a reason per field. Extract the gate decision into a small pure function (`computeReviewStatus`) so it's unit-testable without hitting OpenAI/Supabase, then wire it into the `/upload` route. Update frontend types and the Upload.tsx summary tally to read the new gate instead of `overall_confidence` buckets.

**Tech Stack:** Node/Express/TypeScript backend (NodeNext module resolution — relative imports need `.js` extensions even in `.ts` source, e.g. `'../lib/supabase.js'`), Vitest for backend unit tests (new — backend has no test runner yet), React/TypeScript frontend, Supabase/Postgres.

## Global Constraints

- Backend relative imports use explicit `.js` extensions (NodeNext resolution) — see `backend/src/routes/documents.ts:3-6` for the existing pattern.
- Do not touch the `reason` column or its usage — it stays as a legacy field, per design doc scope.
- Do not change Claude-fallback auto-apply behavior (`backend/src/lib/claude.ts`, `validateLowConfidence`) — out of scope per design doc.
- `overall_confidence` keeps being computed and stored; it just stops driving `status`/`needs_review`.

---

### Task 1: Migration — add per-field reason columns + `needs_review`

**Files:**
- Create: `supabase/migrations/002_per_field_reasoning.sql`

**Interfaces:**
- Produces: columns `merchant_confidence_reason`, `invoice_number_confidence_reason`, `date_confidence_reason`, `amount_confidence_reason`, `tax_confidence_reason`, `category_confidence_reason` (all `TEXT`, nullable) and `needs_review` (`BOOLEAN DEFAULT FALSE`) on `public.extracted_items`. Later tasks (3, 4, 5) write to and read these exact names.

- [ ] **Step 1: Write the migration file**

```sql
-- Zaki Ledger — Per-field confidence reasoning + critical-field review gate
-- Run this in Supabase SQL Editor after 001_initial_schema.sql

ALTER TABLE public.extracted_items
  ADD COLUMN IF NOT EXISTS merchant_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS date_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS amount_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS tax_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS category_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_extracted_items_needs_review
  ON public.extracted_items(user_id, needs_review);
```

- [ ] **Step 2: Verify column names match the design doc exactly**

Compare against `docs/superpowers/specs/2026-08-02-per-field-confidence-gate-design.md` section "1. Schema" — all 7 new columns must match name-for-name (this file has no live DB connection to apply against in this environment; the user applies it manually in the Supabase SQL Editor).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/002_per_field_reasoning.sql
git commit -m "feat: add per-field confidence reason columns + needs_review gate"
```

---

### Task 2: Pure gate function with unit tests

**Files:**
- Create: `backend/src/lib/confidenceGate.ts`
- Test: `backend/src/lib/confidenceGate.test.ts`
- Modify: `backend/package.json` (add `vitest` devDependency + `test` script)
- Create: `backend/vitest.config.ts`

**Interfaces:**
- Produces: `computeReviewStatus(critical: { merchant: number; date: number; amount: number }): { needsReview: boolean; status: 'approved' | 'pending' }`. Task 4 imports this by name from `../lib/confidenceGate.js`.

- [ ] **Step 1: Add vitest to backend**

Modify `backend/package.json`:
- add `"test": "vitest run"` to `"scripts"`
- add `"vitest": "^2.1.0"` to `"devDependencies"`

- [ ] **Step 2: Create `backend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
```

- [ ] **Step 3: Write the failing test**

Create `backend/src/lib/confidenceGate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeReviewStatus } from './confidenceGate.js';

describe('computeReviewStatus', () => {
  it('flags needs_review when merchant confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 65, date: 99, amount: 97 });
    expect(result.needsReview).toBe(true);
  });

  it('flags needs_review when date confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 90, date: 60, amount: 97 });
    expect(result.needsReview).toBe(true);
  });

  it('flags needs_review when amount confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 90, date: 99, amount: 50 });
    expect(result.needsReview).toBe(true);
  });

  it('does not flag needs_review when all three are 70 or above', () => {
    const result = computeReviewStatus({ merchant: 70, date: 70, amount: 70 });
    expect(result.needsReview).toBe(false);
  });

  it('sets status approved only when all three are 95 or above', () => {
    const result = computeReviewStatus({ merchant: 95, date: 95, amount: 95 });
    expect(result.status).toBe('approved');
  });

  it('sets status pending when any of the three is below 95', () => {
    const result = computeReviewStatus({ merchant: 94, date: 99, amount: 99 });
    expect(result.status).toBe('pending');
    expect(result.needsReview).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd backend && npm install && npm test`
Expected: FAIL — `confidenceGate.ts` does not exist yet (module not found).

- [ ] **Step 5: Write the implementation**

Create `backend/src/lib/confidenceGate.ts`:

```ts
export interface CriticalConfidence {
  merchant: number;
  date: number;
  amount: number;
}

export interface ReviewGateResult {
  needsReview: boolean;
  status: 'approved' | 'pending';
}

export function computeReviewStatus(critical: CriticalConfidence): ReviewGateResult {
  const values = [critical.merchant, critical.date, critical.amount];
  const needsReview = values.some((c) => c < 70);
  const status: ReviewGateResult['status'] = values.every((c) => c >= 95) ? 'approved' : 'pending';
  return { needsReview, status };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS — all 6 tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json backend/vitest.config.ts backend/src/lib/confidenceGate.ts backend/src/lib/confidenceGate.test.ts backend/package-lock.json
git commit -m "feat: pure computeReviewStatus gate function with unit tests"
```

---

### Task 3: Per-field reasons in the OpenAI extraction prompt

**Files:**
- Modify: `backend/src/lib/openai.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExtractionResult` interface gains `merchant_confidence_reason`, `invoice_number_confidence_reason`, `date_confidence_reason`, `amount_confidence_reason`, `tax_confidence_reason`, `category_confidence_reason` (all `string`). Task 4 reads these off the object returned by `extractDocument`/`extractFromText`.

- [ ] **Step 1: Update the `ExtractionResult` interface**

In `backend/src/lib/openai.ts`, replace the interface (currently lines 7-16) with:

```ts
export interface ExtractionResult {
  merchant: string; merchant_confidence: number; merchant_confidence_reason: string;
  invoice_number: string; invoice_number_confidence: number; invoice_number_confidence_reason: string;
  transaction_date: string; date_confidence: number; date_confidence_reason: string;
  amount: number; amount_confidence: number; amount_confidence_reason: string;
  tax_amount: number; tax_confidence: number; tax_confidence_reason: string;
  category: string; category_confidence: number; category_confidence_reason: string;
  overall_confidence: number;
  reason: string | null;
}
```

- [ ] **Step 2: Update `SYSTEM_PROMPT`**

Replace the prompt (currently lines 18-40) with:

```ts
const SYSTEM_PROMPT = `You are an expert accounting document parser. Extract these fields from the provided document image or text:
- merchant: the vendor/merchant name
- invoice_number: the invoice or receipt number
- transaction_date: ISO date (YYYY-MM-DD)
- amount: total amount as number
- tax_amount: tax/VAT amount as number (0 if not visible)
- category: best GL category from [Software & SaaS, Travel, Meals, Office Supplies, Materials, Rent, Utilities, Fuel, Merchandise, Professional Services, Uncategorized]

For every field, also give a confidence score (0-100) AND a one-sentence reason for that score — always populated, even at high confidence (e.g. "Standard date format, clearly printed" or "Handwritten, difficult to read").

Return ONLY valid JSON with these exact keys:
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

Set overall_confidence as the average of all field confidences.
Be precise. Do not guess dates or amounts. Do not guess text on damaged or illegible documents — lower the confidence and say so in the reason instead.`;
```

- [ ] **Step 3: Verify the file still compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors from `openai.ts`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/lib/openai.ts
git commit -m "feat: per-field confidence reasons in extraction prompt"
```

---

### Task 4: Wire the gate into the upload route

**Files:**
- Modify: `backend/src/routes/documents.ts:32-71`

**Interfaces:**
- Consumes: `computeReviewStatus` from `../lib/confidenceGate.js` (Task 2); the 6 `*_confidence_reason` fields on `ExtractionResult` (Task 3).
- Produces: `extracted_items` rows now include `needs_review` and the 6 reason columns.

- [ ] **Step 1: Import the gate function**

In `backend/src/routes/documents.ts`, add to the imports at the top:

```ts
import { computeReviewStatus } from '../lib/confidenceGate.js';
```

- [ ] **Step 2: Replace the status computation**

Currently (lines 32-46) the Claude fallback runs, then the insert (lines 49-71) sets `status: finalExtraction.overall_confidence >= 95 ? 'approved' : 'pending'` and has no `needs_review` or per-field reason columns. Replace the insert block so that right before the `supabase.from('extracted_items').insert(...)` call, this runs:

```ts
const { needsReview, status } = computeReviewStatus({
  merchant: finalExtraction.merchant_confidence,
  date: finalExtraction.date_confidence,
  amount: finalExtraction.amount_confidence
});
```

Then update the insert payload to:

```ts
const { data: item, error: itemErr } = await supabase
  .from('extracted_items')
  .insert({
    user_id: userId,
    document_id: doc.id,
    merchant: finalExtraction.merchant,
    merchant_confidence: finalExtraction.merchant_confidence,
    merchant_confidence_reason: finalExtraction.merchant_confidence_reason,
    invoice_number: finalExtraction.invoice_number,
    invoice_number_confidence: finalExtraction.invoice_number_confidence,
    invoice_number_confidence_reason: finalExtraction.invoice_number_confidence_reason,
    transaction_date: finalExtraction.transaction_date,
    date_confidence: finalExtraction.date_confidence,
    date_confidence_reason: finalExtraction.date_confidence_reason,
    amount: finalExtraction.amount,
    amount_confidence: finalExtraction.amount_confidence,
    amount_confidence_reason: finalExtraction.amount_confidence_reason,
    tax_amount: finalExtraction.tax_amount,
    tax_confidence: finalExtraction.tax_confidence,
    tax_confidence_reason: finalExtraction.tax_confidence_reason,
    category: finalExtraction.category,
    category_confidence: finalExtraction.category_confidence,
    category_confidence_reason: finalExtraction.category_confidence_reason,
    overall_confidence: finalExtraction.overall_confidence,
    reason: finalExtraction.reason,
    needs_review: needsReview,
    status
  })
  .select()
  .single();
if (itemErr) throw itemErr;
```

Note: `finalExtraction` is a merge of `extraction` (OpenAI's result) with any Claude corrections (`{ ...extraction, ...validated.corrections }`, line 44) — if Claude only corrects a subset of fields, the untouched fields (including their `_confidence_reason`) still come from the original `extraction` object, so no field is ever missing a reason.

- [ ] **Step 3: Verify the file still compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors from `documents.ts`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/documents.ts
git commit -m "feat: wire critical-field confidence gate into upload route"
```

---

### Task 5: Frontend types + Upload.tsx summary tally

**Files:**
- Modify: `frontend/src/types/index.ts:1-19`
- Modify: `frontend/src/pages/Upload.tsx:43-45`

**Interfaces:**
- Consumes: the `needs_review` and 6 `*_confidence_reason` fields now present on API responses from `/documents/upload` and `/documents/items` (Task 4).

- [ ] **Step 1: Update `ExtractedItem`**

In `frontend/src/types/index.ts`, replace the `ExtractedItem` interface (lines 1-19) with:

```ts
export interface ExtractedItem {
  id: string;
  merchant: string;
  merchant_confidence: number;
  merchant_confidence_reason: string;
  invoice_number: string;
  invoice_number_confidence: number;
  invoice_number_confidence_reason: string;
  transaction_date: string;
  date_confidence: number;
  date_confidence_reason: string;
  amount: number;
  amount_confidence: number;
  amount_confidence_reason: string;
  tax_amount: number;
  tax_confidence: number;
  tax_confidence_reason: string;
  category: string;
  category_confidence: number;
  category_confidence_reason: string;
  overall_confidence: number;
  reason: string | null;
  needs_review: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'posted';
  created_at: string;
}
```

- [ ] **Step 2: Update the Upload.tsx tally**

In `frontend/src/pages/Upload.tsx`, replace lines 43-45:

```ts
const highCount = result?.items?.filter((i: any) => i.overall_confidence >= 95).length || 0;
const mediumCount = result?.items?.filter((i: any) => i.overall_confidence >= 70 && i.overall_confidence < 95).length || 0;
const lowCount = result?.items?.filter((i: any) => i.overall_confidence < 70).length || 0;
```

with:

```ts
const highCount = result?.items?.filter((i: any) => i.status === 'approved').length || 0;
const mediumCount = result?.items?.filter((i: any) => i.status !== 'approved' && !i.needs_review).length || 0;
const lowCount = result?.items?.filter((i: any) => i.needs_review).length || 0;
```

- [ ] **Step 3: Verify the frontend still builds**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/pages/Upload.tsx
git commit -m "feat: surface needs_review gate in frontend types and upload summary"
```

---

### Task 6: Push

- [ ] **Step 1: Push all commits from this plan to origin**

Run: `git push origin main`
Expected: fast-forward push succeeds, no conflicts.
