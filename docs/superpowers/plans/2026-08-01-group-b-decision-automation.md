# Group B: Decision Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn detection into resolution: every flagged finding carries a suggested action with an accept button, every merchant gets a suggested GL category that learns from approvals, and similar rows can be bulk-approved through a preview modal.

**Architecture:** Three layers. (1) A pure suggestion layer: hardcoded UK merchant→category table (`lib/merchant-categories.ts`) and suggested-action strings added to the existing detection builders in `lib/reconciliation-insights.ts`. (2) A persistence layer: two new tables (`reconciliation_decisions`, `user_merchant_preferences`) behind `lib/decision-store.ts`, following the Supabase-or-in-memory pattern of `lib/reconciliation-store.ts`. (3) UI: the review panel renders the suggestion block; approve/reject routes record decisions server-side; ReviewBoard gains per-section bulk buttons with a preview modal.

**Tech Stack:** Next.js 15, React 19, TypeScript, Zod v4 (`zod/v4` import), Supabase, Vitest.

## Global Constraints

- All work happens inside `zakiledger/`. Run `npm run check` before every commit.
- No new runtime dependencies. No calls to external AI APIs for categorisation — hardcoded table only (spec note 1; the GPT fallback belongs to a later phase).
- SQL follows `zakiledger/db/schema.sql` conventions: lowercase, `create table if not exists`, `user_id uuid not null references auth.users(id)`, `create index if not exists <table>_user_idx on <table> (user_id, …)`.
- Store modules follow the `lib/reconciliation-store.ts` pattern: Supabase when configured via `getSupabase()` from `lib/supabase.ts`, else in-memory arrays on `globalThis`.
- Learning confidence increases only after **3+** approvals (spec note 5).
- Copy is accountant-friendly British English ("Uncategorised").

---

### Task 1: UK merchant → category table

**Files:**
- Create: `zakiledger/lib/merchant-categories.ts`
- Test: `zakiledger/tests/merchant-categories.test.ts`

**Interfaces:**
- Produces: `suggestMerchantCategory(name: string | null): { category: string; confidencePct: number } | null` and `GL_CATEGORIES: string[]` (the override-dropdown list). Tasks 5 and 6 consume both.

- [ ] **Step 1: Write the failing tests**

```typescript
// zakiledger/tests/merchant-categories.test.ts
import { describe, expect, it } from "vitest";
import { suggestMerchantCategory, GL_CATEGORIES } from "../lib/merchant-categories";

describe("suggestMerchantCategory", () => {
  it("matches common UK merchants case-insensitively inside longer strings", () => {
    expect(suggestMerchantCategory("GOOGLE WORKSPACE GB-LON")).toEqual({ category: "Software & SaaS", confidencePct: 96 });
    expect(suggestMerchantCategory("SHELL PETROL 4471 LEEDS")).toEqual({ category: "Motor Expenses", confidencePct: 94 });
    expect(suggestMerchantCategory("HMRC VAT PAYMENT")).toEqual({ category: "VAT Control Account", confidencePct: 98 });
    expect(suggestMerchantCategory("WISE TRANSFER 8841")).toEqual({ category: "Transfer", confidencePct: 99 });
  });
  it("returns null for unknown merchants and null input", () => {
    expect(suggestMerchantCategory("BOB'S ARTISAN LLAMA FARM")).toBeNull();
    expect(suggestMerchantCategory(null)).toBeNull();
  });
  it("prefers the more specific rule when patterns overlap", () => {
    // AMAZON WEB SERVICES is SaaS, plain AMAZON is Office Supplies
    expect(suggestMerchantCategory("AMAZON WEB SERVICES")).toEqual({ category: "Software & SaaS", confidencePct: 96 });
    expect(suggestMerchantCategory("AMAZON BUSINESS EU")).toEqual({ category: "Office Supplies", confidencePct: 92 });
  });
  it("every rule's category appears in GL_CATEGORIES", () => {
    expect(GL_CATEGORIES).toContain("Software & SaaS");
    expect(GL_CATEGORIES).toContain("Motor Expenses");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- merchant-categories` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// zakiledger/lib/merchant-categories.ts
/**
 * Hardcoded UK merchant knowledge base — fast, free, explainable. First rule
 * to match wins, so more specific patterns must sit above broader ones
 * (AMAZON WEB above AMAZON). Confidence is per-rule: how unambiguous that
 * merchant string is about the spend category, not how sure the regex is.
 */
interface Rule {
  pattern: RegExp;
  category: string;
  confidencePct: number;
}

const RULES: Rule[] = [
  { pattern: /amazon web|aws\b/i, category: "Software & SaaS", confidencePct: 96 },
  { pattern: /google workspace|google gsuite|microsoft 365|msft.*365|adobe|zoom\.us|slack|notion|dropbox|figma|github|atlassian/i, category: "Software & SaaS", confidencePct: 96 },
  { pattern: /hmrc.*vat|vat.*hmrc/i, category: "VAT Control Account", confidencePct: 98 },
  { pattern: /hmrc.*paye|hmrc.*ni\b/i, category: "PAYE/NI Liability", confidencePct: 97 },
  { pattern: /\bshell\b|\bbp\b|esso|texaco|petrol|\bfuel\b/i, category: "Motor Expenses", confidencePct: 94 },
  { pattern: /\btesco\b|sainsbury|asda|morrisons|aldi|\blidl\b|waitrose/i, category: "Subsistence", confidencePct: 85 },
  { pattern: /wise transfer|transferwise|revolut.*transfer|\bxfer\b/i, category: "Transfer", confidencePct: 99 },
  { pattern: /amazon/i, category: "Office Supplies", confidencePct: 92 },
  { pattern: /trainline|\btfl\b|national rail|uber\b|bolt\b|addison lee/i, category: "Travel", confidencePct: 93 },
  { pattern: /pret a manger|costa coffee|starbucks|greggs|deliveroo|just eat/i, category: "Meals", confidencePct: 90 },
  { pattern: /british gas|edf energy|octopus energy|thames water|severn trent/i, category: "Utilities", confidencePct: 96 },
  { pattern: /vodafone|\bee\b|o2\b|three\.co|virgin media|\bbt\b/i, category: "Telephone & Internet", confidencePct: 93 },
  { pattern: /screwfix|b&q|wickes|toolstation|travis perkins/i, category: "Materials", confidencePct: 92 },
];

/** Dropdown list for manual override. Superset of the rules' categories plus
 * the extraction pipeline's GL list (lib/schema.ts) so both flows agree. */
export const GL_CATEGORIES: string[] = [
  "Software & SaaS", "Travel", "Meals", "Office Supplies", "Materials", "Rent",
  "Utilities", "Fuel", "Motor Expenses", "Merchandise", "Professional Services",
  "Subsistence", "Telephone & Internet", "Transfer", "VAT Control Account",
  "PAYE/NI Liability", "Uncategorised",
];

export function suggestMerchantCategory(name: string | null): { category: string; confidencePct: number } | null {
  if (!name) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(name)) return { category: rule.category, confidencePct: rule.confidencePct };
  }
  return null;
}
```

- [ ] **Step 4: Run tests** → `npm run test -- merchant-categories` → PASS.

- [ ] **Step 5: Commit**

```bash
git add zakiledger/lib/merchant-categories.ts zakiledger/tests/merchant-categories.test.ts
git commit -m "feat: hardcoded UK merchant-to-category suggestion table"
```

---

### Task 2: Decision + preference persistence

**Files:**
- Create: `zakiledger/lib/decision-store.ts`
- Modify: `zakiledger/db/schema.sql` (append the two tables at the end, after the reconciliation section)
- Test: `zakiledger/tests/decision-store.test.ts`

**Interfaces:**
- Produces (all exported from `decision-store.ts`, Tasks 3, 4, 6 and Group D consume):
  - `recordDecision(userId: string, d: DecisionInput): Promise<void>` where `DecisionInput = { statementId: string; matchId: string | null; bankTransactionId: string; decisionType: "approve" | "reject" | "accept_suggestion" | "category_set"; merchantName: string | null; suggestedCategory: string | null; userChoiceCategory: string | null }`
  - `listDecisionsForStatement(userId: string, statementId: string): Promise<Decision[]>` where `Decision = DecisionInput & { id: string; createdAt: string }`
  - `bumpMerchantPreference(userId: string, merchantName: string, category: string): Promise<void>` (upsert; increments `approvalCount`, stamps `lastApproved`)
  - `getMerchantPreferences(userId: string): Promise<MerchantPreference[]>` where `MerchantPreference = { merchantName: string; category: string; approvalCount: number; lastApproved: string }`
  - `setMerchantDefault(userId: string, merchantName: string, category: string): Promise<void>` (upsert with `approvalCount` forced to 3 so it immediately counts as learned)

- [ ] **Step 1: Append SQL to `db/schema.sql`**

```sql
-- ============================= Phase 3, Group B =============================
-- Decision automation: every approve/reject/categorise the user makes, and
-- the per-user merchant -> category preferences learned from them.

create table if not exists reconciliation_decisions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id),
  statement_id          uuid not null,
  match_id              uuid,          -- null when the decision is about an unmatched line
  bank_transaction_id   uuid not null,
  decision_type         text not null, -- 'approve' | 'reject' | 'accept_suggestion' | 'category_set'
  merchant_name         text,
  suggested_category    text,
  user_choice_category  text,
  created_at            timestamptz not null default now()
);

create index if not exists reconciliation_decisions_user_idx
  on reconciliation_decisions (user_id, statement_id);

create table if not exists user_merchant_preferences (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  merchant_name   text not null,     -- normalised: trimmed, lowercased
  category        text not null,
  approval_count  int  not null default 0,
  last_approved   timestamptz,
  unique (user_id, merchant_name)
);

create index if not exists user_merchant_preferences_user_idx
  on user_merchant_preferences (user_id, merchant_name);
```

- [ ] **Step 2: Write failing store tests**

The in-memory fallback is what tests exercise (same as `tests/reconciliation-store.test.ts` — no Supabase in CI). Follow that file's setup pattern (it clears/uses the `globalThis` store between tests; copy its beforeEach approach).

```typescript
// zakiledger/tests/decision-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpMerchantPreference, getMerchantPreferences, listDecisionsForStatement,
  recordDecision, setMerchantDefault, __clearDecisionMemForTests,
} from "../lib/decision-store";

const U = "user-1";

beforeEach(() => __clearDecisionMemForTests());

describe("decision log", () => {
  it("records and lists decisions scoped by user and statement", async () => {
    await recordDecision(U, {
      statementId: "s1", matchId: "m1", bankTransactionId: "b1",
      decisionType: "approve", merchantName: "SHELL", suggestedCategory: "Motor Expenses", userChoiceCategory: null,
    });
    await recordDecision("other-user", {
      statementId: "s1", matchId: "m2", bankTransactionId: "b2",
      decisionType: "reject", merchantName: null, suggestedCategory: null, userChoiceCategory: null,
    });
    const mine = await listDecisionsForStatement(U, "s1");
    expect(mine).toHaveLength(1);
    expect(mine[0].decisionType).toBe("approve");
  });
});

describe("merchant preferences", () => {
  it("bump upserts and increments, normalising the merchant name", async () => {
    await bumpMerchantPreference(U, "  SHELL Petrol  ", "Motor Expenses");
    await bumpMerchantPreference(U, "shell petrol", "Motor Expenses");
    const prefs = await getMerchantPreferences(U);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ merchantName: "shell petrol", category: "Motor Expenses", approvalCount: 2 });
  });
  it("a category change resets the count to 1 for the new category", async () => {
    await bumpMerchantPreference(U, "amazon", "Office Supplies");
    await bumpMerchantPreference(U, "amazon", "Software & SaaS");
    const prefs = await getMerchantPreferences(U);
    expect(prefs[0]).toMatchObject({ category: "Software & SaaS", approvalCount: 1 });
  });
  it("setMerchantDefault jumps straight to learned (count 3)", async () => {
    await setMerchantDefault(U, "wise transfer", "Transfer");
    const prefs = await getMerchantPreferences(U);
    expect(prefs[0].approvalCount).toBe(3);
  });
});
```

- [ ] **Step 3: Run to verify failure** → `npm run test -- decision-store` → FAIL.

- [ ] **Step 4: Implement the store**

Follow `lib/reconciliation-store.ts` structure exactly: `getSupabase()` null-check picks memory vs Postgres; snake_case row mappers; memory arrays on `globalThis.__zakiLedgerDecisions ??= { decisions: [], preferences: [] }`. Export `__clearDecisionMemForTests()` that empties both arrays (check how existing tests reset memory — if `tests/reconciliation-store.test.ts` resets differently, mirror that instead). Normalise merchant names with `name.trim().toLowerCase()`. Supabase paths: `insert` for decisions; for preferences use `select` by `(user_id, merchant_name)` then `insert`/`update` (the same read-then-write pattern the codebase already uses; do not introduce `upsert` unless `reconciliation-store.ts` already uses it).

- [ ] **Step 5: Run tests** → PASS. Then `npm run check` → PASS.

- [ ] **Step 6: Commit**

```bash
git add zakiledger/lib/decision-store.ts zakiledger/tests/decision-store.test.ts zakiledger/db/schema.sql
git commit -m "feat: decision log and learned merchant preferences store"
```

---

### Task 3: Record decisions server-side in approve/reject routes

**Files:**
- Modify: `zakiledger/app/api/reconciliation/[id]/approve/route.ts`
- Modify: `zakiledger/app/api/reconciliation/[id]/reject/route.ts`

**Interfaces:**
- Consumes: `recordDecision`, `bumpMerchantPreference` (Task 2); existing route auth/user resolution (read each route first — reuse exactly how it gets `userId` and calls `approveMatches`/`rejectMatch`).
- Produces: decision rows created as a side effect of every approve/reject. The approve route also accepts an optional `categories?: Record<string, string>` body field (matchId → category the UI showed) so preferences learn the right category.

- [ ] **Step 1: Extend the approve route**

After the existing `approveMatches(...)` call succeeds, for each approved match id: look up the match and its bank transaction (`listMatchesForStatement` + `listBankTransactions` from `lib/reconciliation-store.ts` — both already exported), then:

```typescript
await recordDecision(userId, {
  statementId, matchId, bankTransactionId: match.bankTransactionId,
  decisionType: "approve",
  merchantName: bank?.merchant ?? bank?.description ?? null,
  suggestedCategory: categories?.[matchId] ?? null,
  userChoiceCategory: null,
});
const merchant = bank?.merchant ?? bank?.description;
const category = categories?.[matchId];
if (merchant && category && category !== "Uncategorised") {
  await bumpMerchantPreference(userId, merchant, category);
}
```

Wrap the whole logging block in `try/catch` with a `console.warn` — a decision-log failure must never fail the approval itself.

- [ ] **Step 2: Extend the reject route**

Same pattern after `rejectMatch(...)`: record with `decisionType: "reject"`, no preference bump (a rejection says the match was wrong, not that the category was).

- [ ] **Step 3: Verify**

Run: `npm run check` → PASS (existing route tests in `tests/` must stay green — the logging is additive and non-throwing).

- [ ] **Step 4: Commit**

```bash
git add "zakiledger/app/api/reconciliation/[id]/approve/route.ts" "zakiledger/app/api/reconciliation/[id]/reject/route.ts"
git commit -m "feat: log every approve/reject decision and learn merchant categories"
```

---

### Task 4: Preferences + decisions API for the UI

**Files:**
- Create: `zakiledger/app/api/reconciliation/preferences/route.ts`

**Interfaces:**
- Consumes: `getMerchantPreferences`, `setMerchantDefault` (Task 2); user resolution copied from an existing authenticated route (read `app/api/reconciliation/latest/route.ts` and mirror its auth pattern exactly).
- Produces: `GET /api/reconciliation/preferences` → `{ preferences: MerchantPreference[] }`; `POST` with `{ merchantName, category }` → sets a default. Tasks 5/6 and Group D consume the GET.

- [ ] **Step 1: Implement both handlers**

GET returns the user's preferences. POST validates body with Zod (`z.object({ merchantName: z.string().min(1), category: z.string().min(1) })` — import from `"zod/v4"` to match `reconciliation-schema.ts`), calls `setMerchantDefault`, returns `{ ok: true }`. Unauthenticated → 401, matching whatever the mirrored route does.

- [ ] **Step 2: Verify** → `npm run check` → PASS.

- [ ] **Step 3: Commit**

```bash
git add zakiledger/app/api/reconciliation/preferences/route.ts
git commit -m "feat: merchant-preferences API (list + set default)"
```

---

### Task 5: Suggested-action block on every detection

**Files:**
- Modify: `zakiledger/components/review/ReviewBoard.tsx` (add `suggestedAction` to `ReviewDetection`, ~line 34)
- Modify: `zakiledger/lib/reconciliation-insights.ts` (populate it in each detection builder)
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (render it in `ReconciliationPanelBody`)
- Test: extend `zakiledger/tests/reconciliation-insights.test.ts`

**Interfaces:**
- Produces: `ReviewDetection.suggestedAction?: { text: string; kind: "approve" | "reject" | "review" }`. `kind` decides which existing handler the Accept button fires.

- [ ] **Step 1: Extend the type**

In `ReviewBoard.tsx`'s `ReviewDetection` interface add:

```typescript
/** What the accountant should DO about this finding, not just what it is. */
suggestedAction?: { text: string; kind: "approve" | "reject" | "review" };
```

- [ ] **Step 2: Write failing tests for the copy**

Add to `tests/reconciliation-insights.test.ts` (match its existing fixture helpers for building `BankTransaction`s):

```typescript
it("duplicate detection suggests rejecting the second transaction", () => {
  // two identical txns one day apart -> both rows get a duplicate detection
  const rows = buildReviewRows({ bankTransactions: [dupeA, dupeB], qbTransactions: [], matches: [] });
  const det = rows[0].row.detection;
  expect(det?.suggestedAction?.kind).toBe("reject");
  expect(det?.suggestedAction?.text).toMatch(/second transaction|likely.*duplicate/i);
});
it("reversal detection suggests approving both as nil net effect", () => {
  const rows = buildReviewRows({ bankTransactions: [revA, revB], qbTransactions: [], matches: [] });
  expect(rows[0].row.detection?.suggestedAction?.kind).toBe("approve");
});
```

(Reuse or adapt the file's existing duplicate/reversal fixtures — it already tests these detections, so fixtures exist.)

- [ ] **Step 3: Run to verify failure**, then populate each builder in `reconciliation-insights.ts`:

- `duplicateDetection`: `{ text: "Reject the second transaction — it looks like the same charge processed twice.", kind: "reject" }`
- `reversalDetection`: `{ text: "Approve both — they cancel out, net effect on the books is nil.", kind: "approve" }`
- `refundDetection`: `{ text: "Confirm the pair, then approve both charge and refund.", kind: "approve" }`
- `splitDetection`: incoming → `{ text: "Approve all parts as one invoice settled in instalments.", kind: "approve" }`; outgoing → same text with "one bill paid in instalments".
- `merchantDetection`: `{ text: "Confirm these are the same business before categorising.", kind: "review" }`

- [ ] **Step 4: Render in the panel**

In `ReconciliationPanelBody` (review/page.tsx), inside the existing `row.detection` block after the detection lines, add:

```tsx
{row.detection.suggestedAction && (
  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${shellColor.cardBorder}` }}>
    <div style={{ fontSize: 12, fontWeight: 700, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
      Suggested action
    </div>
    <div style={{ fontSize: 13.5, marginBottom: 10 }}>{row.detection.suggestedAction.text}</div>
    {row.detection.suggestedAction.kind !== "review" && (
      <button
        style={shellButton(row.detection.suggestedAction.kind === "approve" ? "success" : "dangerOutline", "sm")}
        onClick={row.detection.suggestedAction.kind === "approve" ? onApprove : onReject}
        disabled={!match}
      >
        Accept suggestion
      </button>
    )}
  </div>
)}
```

The button reuses `onApprove`/`onReject` already passed into the panel — accepted suggestions flow through the same decision-logging routes from Task 3, satisfying "store user decision for learning".

- [ ] **Step 5: Run** `npm run check` → PASS. **Commit**

```bash
git add zakiledger/components/review/ReviewBoard.tsx zakiledger/lib/reconciliation-insights.ts "zakiledger/app/(app)/reconciliation/review/page.tsx" zakiledger/tests/reconciliation-insights.test.ts
git commit -m "feat: suggested action with accept button on every detection"
```

---

### Task 6: Learned + hardcoded category suggestions in rows

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts` (`suggestCategory`, ~line 116, and `buildReviewRows` to accept preferences)
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (fetch preferences alongside transactions; pass into `buildReviewRows`)
- Test: extend `zakiledger/tests/reconciliation-insights.test.ts`

**Interfaces:**
- Consumes: `suggestMerchantCategory` (Task 1), `GET /api/reconciliation/preferences` (Task 4), `MerchantPreference` type (Task 2).
- Produces: `buildReviewRows` gains an optional `preferences?: MerchantPreference[]` field on its input object. Category resolution order becomes: learned preference (3+ approvals) → matched QB account name → statement-local majority → hardcoded table → "Uncategorised". `ReviewRow.categoryLabel` carries the learning tag, e.g. `"Motor Expenses (learned from 4 approvals)"`.

- [ ] **Step 1: Write failing tests**

```typescript
it("prefers a learned preference with 3+ approvals over the hardcoded table", () => {
  const rows = buildReviewRows({
    bankTransactions: [txn({ merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
    preferences: [{ merchantName: "shell 4471", category: "Fuel", approvalCount: 4, lastApproved: "2026-07-01" }],
  });
  expect(rows[0].row.categoryLabel).toBe("Fuel (learned from 4 approvals)");
});
it("falls back to the hardcoded UK table below 3 approvals", () => {
  const rows = buildReviewRows({
    bankTransactions: [txn({ merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
    preferences: [{ merchantName: "shell 4471", category: "Fuel", approvalCount: 2, lastApproved: "2026-07-01" }],
  });
  expect(rows[0].row.categoryLabel).toBe("Motor Expenses (94% suggested)");
});
```

- [ ] **Step 2: Implement**

In `suggestCategory`, add two parameters (`preferences: Map<string, MerchantPreference>` keyed by normalised merchant name) and apply the resolution order above. In `buildReviewRows`, build that map once from the new input field and thread it through. Learned label: `${category} (learned from ${approvalCount} approvals)`; hardcoded label: `${category} (${confidencePct}% suggested)`; QB-derived and majority-derived labels stay as the bare name (existing behaviour).

In the review page's `load()`, fetch preferences in parallel with transactions (`Promise.all`) and stash them in state; include them in the `board` memo's `buildReviewRows` call.

- [ ] **Step 3: One-click override**

In `ReconciliationPanelBody`, replace the read-only `KV label="Suggested category"` with a `<select>` of `GL_CATEGORIES` (Task 1) defaulting to the row's bare category (strip the parenthetical tag). On change: `POST /api/reconciliation/preferences` with `{ merchantName: bank.merchant ?? bank.description, category }` (this is the "set as default for this merchant" — `setMerchantDefault` forces count 3, so it sticks immediately), then `showToast("Default category saved for this merchant")`.

- [ ] **Step 4: Run** `npm run check` → PASS. **Commit**

```bash
git add zakiledger/lib/reconciliation-insights.ts "zakiledger/app/(app)/reconciliation/review/page.tsx" zakiledger/tests/reconciliation-insights.test.ts
git commit -m "feat: learned and hardcoded category suggestions with one-click default"
```

---

### Task 7: Per-section bulk approval with preview modal

**Files:**
- Modify: `zakiledger/components/review/ReviewBoard.tsx`

**Interfaces:**
- Consumes: existing `approve(ids)` helper, `rowsBySection`, `ReviewSectionConfig`.
- Produces: sections with `bulkApprovable: true` in their config render an "Approve all N" button that opens a preview modal. Add `bulkApprovable?: boolean` to `ReviewSectionConfig`; the review page sets it on `ready`, `reversal`, `refund`, `split`, `recurring` (sections whose suggested action is approve).

- [ ] **Step 1: Add modal state and component inside ReviewBoard**

```tsx
const [bulkPreview, setBulkPreview] = useState<{ section: ReviewSectionConfig; deselected: Set<string> } | null>(null);
```

Section header (in `SectionBlock`, next to the collapse control): when `sec.bulkApprovable` and the section has 2+ approvable rows, render `Approve all {n}` (`shellButton("success", "sm")`) that calls `setBulkPreview({ section: sec, deselected: new Set() })`. Only count rows with `approvable !== false` — rows with no match cannot be approved.

Modal (rendered at ReviewBoard root when `bulkPreview` is set): fixed overlay (`position: fixed, inset: 0, zIndex: 40, background: "rgba(15,23,42,.45)"`), centered card (`shellCard`, maxWidth 520, maxHeight "80vh", overflowY auto) listing each approvable row of that section with a checkbox (checked unless in `deselected`), showing `row.title`, `row.date`, `row.amountLabel`. Footer: `Cancel` (outline) and `Approve N transactions` (success) where N = approvable − deselected; confirm calls `approve(selectedIds)` and closes the modal. Escape key closes (extend the existing `onKeyDown` handler: if `bulkPreview` is set, Escape clears it before falling through to `closePanel`).

- [ ] **Step 2: Wire section configs**

In `review/page.tsx`'s `SECTIONS`, add `bulkApprovable: true` to `ready`, `reversal`, `refund`, `split`, `recurring`. The existing hero "approve all" for `ready` stays — the section-level button is what adds the preview-with-deselect path the spec asks for.

- [ ] **Step 3: Verify**

`npm run check` → PASS. `npm run dev`: a statement with 2+ refunds shows "Approve all 2" on the Refunds header; the modal lists both; deselecting one and confirming approves only the other (row vanishes optimistically via Group 0 Task 2 if already shipped, else via refetch).

- [ ] **Step 4: Commit**

```bash
git add zakiledger/components/review/ReviewBoard.tsx "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: per-section bulk approval with preview modal and deselect"
```

---

## Self-review notes

- Task order matters: 1 → 2 → 3 → 4 → 5 → 6 → 7 (5 only needs 3 for logging semantics; 6 needs 1, 2, 4; 7 is UI-only but reads nicest last).
- Spec's "weekly category-update suggestions" is deliberately dropped — no scheduler exists in this app; revisit when there is one.
- Learning threshold of 3 is enforced in `suggestCategory` (Task 6) and seeded by `setMerchantDefault` (Task 2) — consistent.
- `reconciliation_decisions.match_id` is nullable by design: category-set decisions on unmatched rows still log.
