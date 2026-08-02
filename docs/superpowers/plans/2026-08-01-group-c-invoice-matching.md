# Group C: Invoice Matching & Accounting Impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect bank transactions to the invoices Zaki has already extracted (reference-number and fuzzy matching), and show every matched/categorised transaction's ledger impact in accountant language.

**Architecture:** The invoice side lives in `lib/store.ts` (`StoredInvoiceSummary`: id, supplierName, invoiceNumber, invoiceDate, total, status). The bank side lives in `lib/reconciliation-store.ts`. Matching is a pure module (`lib/invoice-matching.ts`) run server-side inside the transactions endpoint; confirmed matches persist to a new `invoice_matches` table behind `lib/invoice-match-store.ts` (Supabase-or-memory pattern). Impact preview is another pure module (`lib/ledger-impact.ts`) rendered in the review panel.

**Tech Stack:** Next.js 15, React 19, TypeScript, Zod v4, Supabase, Vitest.

## Global Constraints

- All work happens inside `zakiledger/`. `npm run check` passes before every commit.
- No new runtime dependencies.
- SQL follows `db/schema.sql` conventions (`create table if not exists`, `user_id uuid not null references auth.users(id)`, `_user_idx` indexes).
- Fuzzy window: amount exact (±0.01), date within **±3 days**, supplier-name token overlap.
- Marking invoices paid inside QB/Xero is **out of scope** — `lib/xero.ts`/`lib/quickbooks.ts` only implement draft-bill creation today. The match persists locally and the impact card says what posting *will* do.
- Copy is accountant-friendly British English; GL names not codes.

---

### Task 1: Invoice-reference extraction + matcher (pure)

**Files:**
- Create: `zakiledger/lib/invoice-matching.ts`
- Test: `zakiledger/tests/invoice-matching.test.ts`

**Interfaces:**
- Consumes: `BankTransaction` from `lib/reconciliation-schema.ts`, `StoredInvoiceSummary` from `lib/store.ts`.
- Produces (Tasks 2–3 consume):
  - `extractInvoiceRefs(text: string): string[]` — normalised refs like `"INV-2044"`, `"2044"`.
  - `matchInvoices(bank: BankTransaction[], invoices: StoredInvoiceSummary[]): InvoiceSuggestion[]` where `InvoiceSuggestion = { bankTransactionId: string; invoiceId: string; invoiceNumber: string; supplierName: string; total: number | null; confidencePct: number; matchedBy: "reference" | "amount_date"; reason: string }`.

- [x] **Step 1: Write the failing tests**

```typescript
// zakiledger/tests/invoice-matching.test.ts
import { describe, expect, it } from "vitest";
import { extractInvoiceRefs, matchInvoices } from "../lib/invoice-matching";
import type { BankTransaction } from "../lib/reconciliation-schema";
import type { StoredInvoiceSummary } from "../lib/store";

function bank(over: Partial<BankTransaction>): BankTransaction {
  return {
    id: "b1", statementId: "s1", transactionDate: "2026-07-15", postedDate: null,
    merchant: null, description: null, amount: -1800, currency: "GBP",
    transactionId: null, memo: null, ...over,
  };
}
function invoice(over: Partial<StoredInvoiceSummary>): StoredInvoiceSummary {
  return {
    id: "i1", documentType: "invoice", supplierName: "Acme Ltd", invoiceNumber: "INV-2044",
    invoiceDate: "2026-07-14", total: 1800, status: "approved", createdAt: "2026-07-14T00:00:00Z", ...over,
  };
}

describe("extractInvoiceRefs", () => {
  it("finds INV-style and hash refs, normalised to upper case", () => {
    expect(extractInvoiceRefs("CLIENT PAYMENT inv-2044 £1,800")).toContain("INV-2044");
    expect(extractInvoiceRefs("PAYMENT #7731 THANKS")).toContain("7731");
  });
  it("returns [] when nothing looks like a reference", () => {
    expect(extractInvoiceRefs("TESCO STORES 2044 LEEDS")).toEqual([]); // bare numbers without INV/# are not refs
  });
});

describe("matchInvoices", () => {
  it("matches by reference + amount at 99%", () => {
    const [m] = matchInvoices([bank({ description: "CLIENT PAYMENT INV-2044" })], [invoice({})]);
    expect(m).toMatchObject({ invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    expect(m.reason).toMatch(/reference/i);
  });
  it("falls back to amount + date window + supplier overlap", () => {
    const [m] = matchInvoices(
      [bank({ description: "ACME LTD PAYMENT", transactionDate: "2026-07-16" })],
      [invoice({})],
    );
    expect(m).toMatchObject({ invoiceId: "i1", matchedBy: "amount_date" });
    expect(m.confidencePct).toBeGreaterThanOrEqual(80);
    expect(m.confidencePct).toBeLessThan(99);
  });
  it("does not match outside the ±3 day window without a reference", () => {
    expect(matchInvoices(
      [bank({ description: "ACME LTD PAYMENT", transactionDate: "2026-07-25" })],
      [invoice({})],
    )).toEqual([]);
  });
  it("amount must agree in magnitude for both directions of signage", () => {
    // bank amount is signed (negative = money in per review page convention);
    // invoice totals are positive — compare absolute values.
    expect(matchInvoices([bank({ description: "INV-2044", amount: 1800 })], [invoice({})])).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run to verify failure** → `npm run test -- invoice-matching` → FAIL.

- [x] **Step 3: Implement**

```typescript
// zakiledger/lib/invoice-matching.ts
import type { BankTransaction } from "./reconciliation-schema";
import type { StoredInvoiceSummary } from "./store";

/**
 * Bank line -> extracted invoice matching. Two tiers: a quoted reference plus
 * the right amount is as close to certain as bookkeeping gets (99); an
 * amount + date + supplier-name coincidence is strong but visibly weaker.
 * Signage: bank amounts are signed, invoice totals are positive — magnitude
 * is what has to agree.
 */
export interface InvoiceSuggestion {
  bankTransactionId: string;
  invoiceId: string;
  invoiceNumber: string;
  supplierName: string;
  total: number | null;
  confidencePct: number;
  matchedBy: "reference" | "amount_date";
  reason: string;
}

const REF_RE = /\b(?:INV|INVOICE)[-\s#]?(\d{2,8})\b|#(\d{2,8})\b/gi;

export function extractInvoiceRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    if (m[1]) refs.push(`INV-${m[1]}`, m[1]);
    else if (m[2]) refs.push(m[2]);
  }
  return [...new Set(refs.map((r) => r.toUpperCase()))];
}

/** "acme ltd" vs "ACME LIMITED PAYMENT" -> shared-token ratio in [0,1]. */
function nameOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const ta = tok(a), tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const DAY = 86_400_000;
const DATE_WINDOW_DAYS = 3;

export function matchInvoices(bank: BankTransaction[], invoices: StoredInvoiceSummary[]): InvoiceSuggestion[] {
  const out: InvoiceSuggestion[] = [];
  const claimed = new Set<string>(); // one bank line per invoice
  for (const b of bank) {
    const text = `${b.merchant ?? ""} ${b.description ?? ""} ${b.memo ?? ""}`;
    const refs = new Set(extractInvoiceRefs(text));
    let best: InvoiceSuggestion | null = null;
    for (const inv of invoices) {
      if (claimed.has(inv.id) || inv.total === null) continue;
      if (Math.abs(Math.abs(b.amount) - Math.abs(inv.total)) > 0.01) continue;
      const invRefs = extractInvoiceRefs(inv.invoiceNumber);
      const refHit = inv.invoiceNumber && (refs.has(inv.invoiceNumber.toUpperCase()) || invRefs.some((r) => refs.has(r)));
      if (refHit) {
        best = {
          bankTransactionId: b.id, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
          supplierName: inv.supplierName, total: inv.total, confidencePct: 99, matchedBy: "reference",
          reason: `Exact match: reference ${inv.invoiceNumber} quoted on the bank line, amount agrees.`,
        };
        break; // a reference hit beats any fuzzy candidate
      }
      if (!inv.invoiceDate) continue;
      const gapDays = Math.abs(Date.parse(b.transactionDate) - Date.parse(inv.invoiceDate)) / DAY;
      if (gapDays > DATE_WINDOW_DAYS) continue;
      const overlap = nameOverlap(inv.supplierName, text);
      if (overlap < 0.5) continue;
      const pct = Math.round(80 + overlap * 10 + (DATE_WINDOW_DAYS - gapDays)); // 80–93
      if (!best || pct > best.confidencePct) {
        best = {
          bankTransactionId: b.id, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
          supplierName: inv.supplierName, total: inv.total, confidencePct: pct, matchedBy: "amount_date",
          reason: `Amount matches ${inv.supplierName}'s invoice ${inv.invoiceNumber}, dated within ${DATE_WINDOW_DAYS} days.`,
        };
      }
    }
    if (best) {
      claimed.add(best.invoiceId);
      out.push(best);
    }
  }
  return out;
}
```

- [x] **Step 4: Run tests** → PASS. Adjust `REF_RE`/thresholds only if a test exposes a real gap — never weaken a test to pass.

- [x] **Step 5: Commit**

```bash
git add zakiledger/lib/invoice-matching.ts zakiledger/tests/invoice-matching.test.ts
git commit -m "feat: pure invoice-reference extraction and bank-to-invoice matcher"
```

---

### Task 2: Persist confirmed invoice matches

**Files:**
- Create: `zakiledger/lib/invoice-match-store.ts`
- Modify: `zakiledger/db/schema.sql` (append after Group B's tables)
- Test: `zakiledger/tests/invoice-match-store.test.ts`

**Interfaces:**
- Produces (Task 3 consumes):
  - `saveInvoiceMatch(userId: string, m: { bankTransactionId: string; invoiceId: string; confidencePct: number; matchedBy: "reference" | "amount_date" }): Promise<string>` (returns id; status starts `"matched"`)
  - `listInvoiceMatches(userId: string, bankTransactionIds: string[]): Promise<StoredInvoiceMatch[]>` where `StoredInvoiceMatch = { id: string; bankTransactionId: string; invoiceId: string; confidencePct: number; matchedBy: string; status: string; createdAt: string }`
  - `__clearInvoiceMatchMemForTests(): void`

- [x] **Step 1: Append SQL**

```sql
-- ============================= Phase 3, Group C =============================
-- Confirmed bank-line -> extracted-invoice matches.

create table if not exists invoice_matches (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id),
  bank_transaction_id   uuid not null,
  invoice_id            uuid not null,
  confidence_pct        int not null,
  matched_by            text not null, -- 'reference' | 'amount_date'
  status                text not null default 'matched', -- 'matched' | 'rejected'
  created_at            timestamptz not null default now(),
  unique (user_id, bank_transaction_id)
);

create index if not exists invoice_matches_user_idx
  on invoice_matches (user_id, bank_transaction_id);
```

- [x] **Step 2: Failing tests**

```typescript
// zakiledger/tests/invoice-match-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { listInvoiceMatches, saveInvoiceMatch, __clearInvoiceMatchMemForTests } from "../lib/invoice-match-store";

beforeEach(() => __clearInvoiceMatchMemForTests());

describe("invoice match store", () => {
  it("saves and lists scoped by user and bank transaction ids", async () => {
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    await saveInvoiceMatch("u2", { bankTransactionId: "b1", invoiceId: "i9", confidencePct: 90, matchedBy: "amount_date" });
    const mine = await listInvoiceMatches("u1", ["b1", "b2"]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ invoiceId: "i1", status: "matched" });
  });
  it("re-matching the same bank transaction replaces the earlier match", async () => {
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i2", confidencePct: 85, matchedBy: "amount_date" });
    const mine = await listInvoiceMatches("u1", ["b1"]);
    expect(mine).toHaveLength(1);
    expect(mine[0].invoiceId).toBe("i2");
  });
});
```

- [x] **Step 3: Run → FAIL, then implement** following the `lib/decision-store.ts` / `lib/reconciliation-store.ts` memory-or-Supabase pattern (`globalThis.__zakiLedgerInvoiceMatches ??= []`). Replace-on-rematch: delete any existing row for `(userId, bankTransactionId)` before insert (matches the SQL `unique` constraint).

- [x] **Step 4: Run tests** → PASS; `npm run check` → PASS.

- [x] **Step 5: Commit**

```bash
git add zakiledger/lib/invoice-match-store.ts zakiledger/tests/invoice-match-store.test.ts zakiledger/db/schema.sql
git commit -m "feat: invoice-match persistence with replace-on-rematch"
```

---

### Task 3: Suggestions in the transactions endpoint + confirm route

**Files:**
- Modify: `zakiledger/app/api/reconciliation/[id]/transactions/route.ts`
- Create: `zakiledger/app/api/reconciliation/[id]/invoice-match/route.ts`

**Interfaces:**
- Consumes: `matchInvoices` (Task 1), `saveInvoiceMatch`/`listInvoiceMatches` (Task 2), `listRecentApprovedInvoices(userId, limit)` from `lib/store.ts` (read its exact signature at line ~481 first — it returns invoice summaries; call with a generous limit, e.g. 500).
- Produces: transactions endpoint response gains two fields — `invoiceSuggestions: InvoiceSuggestion[]` (unconfirmed, computed fresh) and `invoiceMatches: StoredInvoiceMatch[]` (confirmed). `POST /api/reconciliation/[id]/invoice-match` with `{ bankTransactionId, invoiceId, confidencePct, matchedBy }` confirms one. Task 4 consumes both.

- [x] **Step 1: Extend the transactions route**

Read the route first; after it assembles bank transactions + matches, add:

```typescript
const invoices = await listRecentApprovedInvoices(userId, 500);
const confirmed = await listInvoiceMatches(userId, bankTransactions.map((b) => b.id));
const confirmedBankIds = new Set(confirmed.map((c) => c.bankTransactionId));
const invoiceSuggestions = matchInvoices(
  bankTransactions.filter((b) => !confirmedBankIds.has(b.id)),
  invoices,
);
```

Include both in the JSON response. If `listRecentApprovedInvoices` returns a shape other than `StoredInvoiceSummary[]` (verify!), map it into `StoredInvoiceSummary` before calling `matchInvoices`.

- [x] **Step 2: Create the confirm route**

Mirror the auth + params pattern of `app/api/reconciliation/[id]/approve/route.ts`. Validate body with Zod v4; call `saveInvoiceMatch`; also record it in the Group B decision log if that shipped (`recordDecision` with `decisionType: "approve"`, guarded by try/catch); return `{ ok: true, id }`.

- [x] **Step 3: Verify** → `npm run check` → PASS (existing transactions-route consumers ignore extra fields).

- [x] **Step 4: Commit**

```bash
git add "zakiledger/app/api/reconciliation/[id]/transactions/route.ts" "zakiledger/app/api/reconciliation/[id]/invoice-match/route.ts"
git commit -m "feat: invoice suggestions in transactions payload and confirm endpoint"
```

---

### Task 4: Possible-match card in the review panel

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Interfaces:**
- Consumes: `invoiceSuggestions` + `invoiceMatches` from the extended endpoint (extend the page's `ReviewData` type accordingly), `POST .../invoice-match` (Task 3).
- Produces: rows with a suggestion get an `"Invoice match"` badge (push onto `row.badges` after `buildReviewRows` returns, keyed by `bankTransactionId`).

- [x] **Step 1: Render the card**

In `ReconciliationPanelBody`, add props `suggestion?: InvoiceSuggestion` and `onMatchInvoice?: () => void`; render between "Transaction details" and "Suggested match":

```tsx
{suggestion && (
  <div style={{ marginBottom: 24 }}>
    <SectionLabel>💰 Possible invoice match</SectionLabel>
    <div style={{ background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
      <KV label="Invoice" value={suggestion.invoiceNumber} />
      <KV label="Customer" value={suggestion.supplierName} />
      <KV label="Amount" value={formatMoney(suggestion.total ?? 0, bank.currency)} />
      <KV label="Confidence" value={`${suggestion.confidencePct}%`} />
      <div style={{ fontSize: 12.5, color: shellColor.inkSoft, padding: "8px 0" }}>{suggestion.reason}</div>
      <button style={{ ...shellButton("success", "sm"), marginTop: 6 }} onClick={onMatchInvoice}>
        Match invoice
      </button>
    </div>
  </div>
)}
```

- [x] **Step 2: Wire the handler in the page**

Build `suggestionsByBankId` in the `board` memo. `onMatchInvoice`: POST to `/api/reconciliation/${statementId}/invoice-match`, on success optimistically move the suggestion into `invoiceMatches` in state (`setReview`), `showToast(\`Invoice ${suggestion.invoiceNumber} matched\`)`; on failure surface `setError`. Confirmed matches render the same card minus the button with a `pill(shellColor.high, shellColor.highBg)` reading "Matched".

- [x] **Step 3: Verify** → `npm run check`; `npm run dev` with an approved invoice whose number appears in an uploaded statement line → card shows, Match persists across reload.

- [x] **Step 4: Commit**

```bash
git add "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: possible-invoice-match card with confirm in review panel"
```

---

### Task 5: Ledger-impact preview (pure + panel render)

**Files:**
- Create: `zakiledger/lib/ledger-impact.ts`
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (render in `ReconciliationPanelBody`)
- Test: `zakiledger/tests/ledger-impact.test.ts`

**Interfaces:**
- Consumes: `BankTransaction`, category label (bare, tag stripped), optional `InvoiceSuggestion`/`StoredInvoiceMatch` + detection kind from the row.
- Produces: `ledgerImpact(input: { amount: number; currency: string | null; category: string; invoiceNumber?: string; supplierName?: string; detectionKind?: "reversal" | "refund" | "split" | "merchant" | null }): string[]` — 1-2 accountant-language lines.

- [x] **Step 1: Failing tests**

```typescript
// zakiledger/tests/ledger-impact.test.ts
import { describe, expect, it } from "vitest";
import { ledgerImpact } from "../lib/ledger-impact";

describe("ledgerImpact", () => {
  it("invoice payment reduces debtors and marks the invoice paid", () => {
    expect(ledgerImpact({ amount: -1800, currency: "GBP", category: "Uncategorised", invoiceNumber: "INV-2044", supplierName: "Acme Ltd" }))
      .toEqual(["Mark invoice INV-2044 as paid.", "Reduce Debtors (A/R): £1,800.00"]);
  });
  it("VAT payment reduces the VAT liability", () => {
    expect(ledgerImpact({ amount: 1240, currency: "GBP", category: "VAT Control Account" }))
      .toEqual(["Reduce VAT liability: £1,240.00"]);
  });
  it("plain expense increases its category", () => {
    expect(ledgerImpact({ amount: 450, currency: "GBP", category: "Software & SaaS" }))
      .toEqual(["Increase Software & SaaS: £450.00"]);
  });
  it("refund reverses the earlier charge", () => {
    expect(ledgerImpact({ amount: -300, currency: "GBP", category: "Merchandise", detectionKind: "refund" }))
      .toEqual(["Reverse earlier charge: £300.00 back to Merchandise"]);
  });
  it("reversal nets to nil", () => {
    expect(ledgerImpact({ amount: 500, currency: "GBP", category: "Uncategorised", detectionKind: "reversal" }))
      .toEqual(["No net ledger impact — the pair cancels out."]);
  });
});
```

- [x] **Step 2: Run → FAIL, then implement**

```typescript
// zakiledger/lib/ledger-impact.ts
import { formatMoney } from "./currency";

/**
 * The GL outcome of approving a line, in the language an accountant thinks
 * in. Deliberately rule-based and short: one or two sentences, GL names not
 * codes, magnitude only (the sign is already said in words).
 */
export function ledgerImpact(input: {
  amount: number;
  currency: string | null;
  category: string;
  invoiceNumber?: string;
  supplierName?: string;
  detectionKind?: "reversal" | "refund" | "split" | "merchant" | null;
}): string[] {
  const money = formatMoney(Math.abs(input.amount), input.currency);
  if (input.detectionKind === "reversal") return ["No net ledger impact — the pair cancels out."];
  if (input.detectionKind === "refund") return [`Reverse earlier charge: ${money} back to ${input.category}`];
  if (input.invoiceNumber) {
    return [`Mark invoice ${input.invoiceNumber} as paid.`, `Reduce Debtors (A/R): ${money}`];
  }
  if (input.category === "VAT Control Account") return [`Reduce VAT liability: ${money}`];
  if (input.category === "PAYE/NI Liability") return [`Reduce PAYE/NI liability: ${money}`];
  if (input.category === "Transfer") return ["Money moved between your own accounts — no profit-and-loss impact."];
  if (input.category === "Uncategorised") return ["Set a category to see the ledger impact."];
  return [`Increase ${input.category}: ${money}`];
}
```

(If Group B has not shipped, `"VAT Control Account"` etc. never occur as categories — the function still behaves, falling through to the expense line. No dependency.)

- [x] **Step 3: Render in the panel**

In `ReconciliationPanelBody`, after the "Suggested match" block:

```tsx
<div style={{ marginBottom: 24 }}>
  <SectionLabel>🎯 Ledger impact</SectionLabel>
  <div style={{ fontSize: 13.5, lineHeight: 1.6, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
    {ledgerImpact({
      amount: bank.amount,
      currency: bank.currency,
      category: row.categoryLabel.replace(/\s*\(.*\)$/, ""),
      invoiceNumber: suggestion?.invoiceNumber,
      supplierName: suggestion?.supplierName,
      detectionKind: (row.detection ? detectionKindOf(row) : null),
    }).map((line) => <div key={line}>{line}</div>)}
  </div>
</div>
```

`detectionKindOf`: the panel does not currently know the detection kind — thread it through by adding `kind?: DetectionKind` to `ReviewDetection` population in `lib/reconciliation-insights.ts` (each builder already knows its kind; copy it into the `detection` object it returns) and read `row.detection?.kind` here.

- [x] **Step 4: Run** `npm run check` → PASS. **Commit**

```bash
git add zakiledger/lib/ledger-impact.ts zakiledger/tests/ledger-impact.test.ts "zakiledger/app/(app)/reconciliation/review/page.tsx" zakiledger/lib/reconciliation-insights.ts
git commit -m "feat: ledger-impact preview in accountant language"
```

---

## Self-review notes

- Task order: 1 → 2 → 3 → 4; 5 is independent of 2-4 except the optional `suggestion` fields (render `undefined` fine before Task 4 ships).
- Spec's "mark invoice Paid in QB/Xero when posted" is scoped out (global constraint) — the provider libs have no payment API yet; the impact card states the intent so nothing is silently dropped.
- `matchInvoices` claims each invoice once (`claimed` set) — prevents one invoice matching two bank lines, the classic double-payment false positive.
- Verify `listRecentApprovedInvoices` actually returns `StoredInvoiceSummary`-compatible objects (Task 3 Step 1 says map if not) — this is the one integration seam not confirmed from source.

## Implementation status (2026-08-02)

All 5 tasks shipped, TDD throughout, `npm run check` green after every commit.
One deviation from the plan as written: `listRecentApprovedInvoices` turned
out to return only `{ supplierName, createdAt }` (the Dashboard activity-feed
shape), not a `StoredInvoiceSummary`-compatible object as this doc assumed —
confirmed the flagged risk above was real. Added a new
`listApprovedInvoicesForMatching(userId, limit)` to `lib/store.ts` instead,
mirroring the existing `mapSummaryRow`/`DUP_COLUMNS` pattern, returning the
full identity fields the matcher needs. Everything else matches the plan as
written.
