# Bank Reconciliation Detectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversal, refund, split payment, multi-part payment, and merchant similarity detection to reduce review time and categorize transactions into actionable sections.

**Architecture:** Extend `reconciliation-insights.ts` with five detector functions that analyze bank transactions and QB matches for patterns. Each detector returns structured evidence. Update `ReviewRow` interface to store detection results. Update `sectionFor()` routing logic to place transactions into refunds/reversals/splits/transfers/recurring/ready/review/issue sections based on detection. Update `buildReviewRows()` to call all detectors and populate new fields.

**Tech Stack:** TypeScript, existing `fuzzyMerchantSimilarity` from reconciliation-matching.ts, existing ReviewBoard section routing.

## Global Constraints

- All accountant-facing copy must avoid technical terms (no Levenshtein, fuzzy ratio, etc.)
- Confidence scores: 99% exact duplicate, 90% refund pair, 85% strong merchant similarity, 60% weak merchant similarity
- All detectors run synchronously on bank transaction arrays (no DB queries or async operations)
- Existing ReviewBoard UI already supports section routing — no UI refactoring needed
- Test all features in browser before committing

---

## File Structure

**Files to modify:**
- `zakiledger/lib/reconciliation-insights.ts` — add detectors, update ReviewRow, extend sectionFor()
- `zakiledger/app/(app)/reconciliation/review/page.tsx` — verify sections config includes new types

**Files to create:**
- None — all logic lives in existing files

**Test coverage:**
- Browser test: upload CSV, verify each detection type appears in correct section
- Verify buttons work (approve, flag, compare, open detail panel)
- Verify confidence badges render correctly

---

## Task 1: Add Reversal Detection

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `BankTransaction[]`
- Produces: function `detectReversals(bank: BankTransaction[]): Map<string, BankTransaction>` — maps transaction ID to its reversal partner

**Details:**
Reversals are pairs of transactions with:
- Opposite amounts (one positive, one negative, same absolute value)
- Matching reference (same substring in description/merchant within word boundaries, case-insensitive)
- Within 30 days of each other

Return a Map where key = transaction ID, value = its reversal partner. Only include pairs where both exist.

- [ ] **Step 1: Add reversal detector function**

Add this after `detectDuplicates()` in `reconciliation-insights.ts`:

```typescript
/** Detect reversals: opposite amounts + matching reference + close dates. */
export function detectReversals(bank: BankTransaction[]): Map<string, BankTransaction> {
  const result = new Map<string, BankTransaction>();
  
  // Extract invoice reference from description/merchant
  function getReference(t: BankTransaction): string | null {
    const text = `${t.merchant ?? ""} ${t.description ?? ""}`.toUpperCase();
    const match = text.match(/(?:INV|REF|ORDER|ID)[_-]?(\d+)/);
    return match ? match[1] : null;
  }

  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];

      // Opposite amounts (one positive, one negative)
      const oppositeAmounts = Math.abs(a.amount + b.amount) < 0.005;
      if (!oppositeAmounts) continue;

      // Matching reference
      const refA = getReference(a);
      const refB = getReference(b);
      const matchingRef = refA && refB && refA === refB;
      if (!matchingRef) continue;

      // Within 30 days
      const daysApart = Math.abs(Date.parse(a.transactionDate) - Date.parse(b.transactionDate)) / (1000 * 60 * 60 * 24);
      const closeInTime = daysApart <= 30;
      if (!closeInTime) continue;

      result.set(a.id, b);
      result.set(b.id, a);
    }
  }

  return result;
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds with no errors in reconciliation-insights.ts

---

## Task 2: Add Refund Detection

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `BankTransaction[]`
- Produces: function `detectRefunds(bank: BankTransaction[]): Map<string, BankTransaction>` — maps refund ID to original charge

**Details:**
Refunds are pairs where:
- Merchant names are highly similar (>= 75% fuzzy match using token-based similarity)
- Amounts match exactly (within 1 penny)
- Refund occurs 1-90 days after original charge (refund comes after)
- Original is debit (amount < 0), refund is credit (amount > 0)

Return a Map where key = refund transaction ID, value = original charge ID.

- [ ] **Step 1: Add refund detector function**

Add this after `detectReversals()`:

```typescript
/** Detect refunds: similar merchant + matching amount + correct polarity + timeframe. */
export function detectRefunds(bank: BankTransaction[]): Map<string, BankTransaction> {
  const result = new Map<string, BankTransaction>();

  for (let i = 0; i < bank.length; i++) {
    for (let j = 0; j < bank.length; j++) {
      if (i === j) continue;

      const charge = bank[i];
      const refund = bank[j];

      // Charge is debit (negative), refund is credit (positive)
      if (charge.amount >= 0 || refund.amount <= 0) continue;

      // Amounts match
      if (Math.abs(Math.abs(charge.amount) - Math.abs(refund.amount)) > 0.01) continue;

      // Merchant similarity >= 75%
      const similarity = fuzzyMerchantSimilarity(charge.merchant ?? charge.description, refund.merchant ?? refund.description);
      if (similarity < 0.75) continue;

      // Refund within 1-90 days after charge
      const chargeDate = Date.parse(charge.transactionDate);
      const refundDate = Date.parse(refund.transactionDate);
      const daysDiff = (refundDate - chargeDate) / (1000 * 60 * 60 * 24);
      if (daysDiff < 1 || daysDiff > 90) continue;

      result.set(refund.id, charge);
    }
  }

  return result;
}
```

Import `fuzzyMerchantSimilarity` at top of file:

```typescript
import { fuzzyMerchantSimilarity } from "./reconciliation-matching";
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 3: Add Split Payment Detection

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `BankTransaction[]`
- Produces: function `detectSplitPayments(bank: BankTransaction[]): Map<string, string[]>` — maps shared reference to all transaction IDs sharing it

**Details:**
Split payments are groups of 2+ transactions sharing:
- Same invoice/reference in description
- Same merchant
- All same sign (all debits or all credits)
- Total group amount > 500 (indicates meaningful invoice split, not noise)

Return a Map where key = reference ID (e.g., "INV-1001"), value = array of transaction IDs in that group. Only include groups with 2+ transactions.

- [ ] **Step 1: Add split payment detector function**

Add this after `detectRefunds()`:

```typescript
/** Detect split payments: same reference + same merchant + 2+ transactions. */
export function detectSplitPayments(bank: BankTransaction[]): Map<string, string[]> {
  function getReference(t: BankTransaction): string | null {
    const text = `${t.merchant ?? ""} ${t.description ?? ""}`.toUpperCase();
    const match = text.match(/(?:INV|REF|ORDER|ID)[_-]?(\d+)/);
    return match ? match[1] : null;
  }

  function isSameSign(amounts: number[]): boolean {
    return amounts.every((a) => a < 0) || amounts.every((a) => a > 0);
  }

  // Group by reference + merchant
  const groups = new Map<string, BankTransaction[]>();
  for (const t of bank) {
    const ref = getReference(t);
    if (!ref) continue;
    const key = `${ref}|${normalizeMerchant(t)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  // Filter to 2+ transactions, same sign, total > 500
  const result = new Map<string, string[]>();
  for (const [key, txns] of groups) {
    if (txns.length < 2) continue;
    const amounts = txns.map((t) => t.amount);
    if (!isSameSign(amounts)) continue;
    const total = Math.abs(amounts.reduce((a, b) => a + b, 0));
    if (total < 500) continue;
    const ref = key.split("|")[0];
    result.set(ref, txns.map((t) => t.id));
  }

  return result;
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 4: Add Multi-Part Payment Detection

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `BankTransaction[]`
- Produces: function `detectMultiPartPayments(bank: BankTransaction[]): Map<string, string[]>` — maps shared reference to all transaction IDs

**Details:**
Multi-part payments are the same as split payments (2+ transactions with same reference). This detector exists for semantic clarity in the codebase — accountants see "Split Payment" and "Multi-Part Payment" as equivalent groupings from the UI.

Return a Map where key = reference ID, value = array of transaction IDs. Same logic as split payments.

- [ ] **Step 1: Add multi-part payment detector as alias**

Add this after `detectSplitPayments()`:

```typescript
/** Alias for split payment detection — same logic, named for accountant clarity. */
export function detectMultiPartPayments(bank: BankTransaction[]): Map<string, string[]> {
  return detectSplitPayments(bank);
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 5: Extend ReviewRow Interface & Add Detection Results Type

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `ReconciliationMatch`, `BankTransaction`
- Produces: Updated `ReviewRow` interface with detection fields

**Details:**
Add fields to `ReviewRow` to carry detection results:
- `detectionType?: string` — "reversal" | "refund" | "split" | "similar-merchant" (null if undetected)
- `relatedTransaction?: BankTransaction` — for reversals/refunds, the partner transaction
- `relatedTransactions?: BankTransaction[]` — for splits, all transactions in the group
- `merchantSimilarityScore?: number` — 0-1 for similar merchant detections
- `detectionReason?: string` — plain-English explanation

This is stored in the ReviewRow passed to ReviewBoard so the panel can render full evidence.

- [ ] **Step 1: Extend ReviewRow in type imports**

At the top of reconciliation-insights.ts, import ReviewRow:

```typescript
import type { ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";
```

Then find the ReviewRow interface definition (currently in ReviewBoard.tsx) and create a local extension. Actually, check if it's already imported and used — it should be. Verify the import is present.

- [ ] **Step 2: Add detection result fields to the object built in buildReviewRows()**

In the `buildReviewRows()` function, find this section:

```typescript
const row: ReviewRow = {
  id: bank.id,
  section: sectionFor(match, isDuplicate),
  // ... existing fields
};
```

We'll add detection fields in Task 7 when we actually detect them. For now, just verify ReviewRow is properly imported.

- [ ] **Step 3: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 6: Add Similar Merchant Detection

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: `BankTransaction[]`
- Produces: function `detectSimilarMerchants(bank: BankTransaction[]): Map<string, {score: number, partner: BankTransaction}>` — maps transaction ID to similar partner with score

**Details:**
Similar merchants are pairs of bank transactions where:
- Merchant names are highly similar (>= 85% using token-based fuzzy match)
- NOT already detected as duplicates (same amount/merchant/date within 1 day)
- NOT already detected as reversals

Return a Map where key = first transaction ID, value = {score, partner}. Score ranges 0-1. Only include pairs with score >= 0.75 to avoid noise.

- [ ] **Step 1: Add similar merchant detector**

Add this after `detectMultiPartPayments()`:

```typescript
/** Detect similar merchant names (85%+ match). */
export function detectSimilarMerchants(bank: BankTransaction[], reversals: Map<string, BankTransaction>, dupes: Map<string, BankTransaction>): Map<string, { score: number; partner: BankTransaction }> {
  const result = new Map<string, { score: number; partner: BankTransaction }>();

  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];

      // Skip if already a duplicate or reversal
      if (dupes.has(a.id) || reversals.has(a.id)) continue;

      const similarity = fuzzyMerchantSimilarity(a.merchant ?? a.description, b.merchant ?? b.description);
      if (similarity < 0.75 || similarity > 0.99) continue; // Skip near-perfect matches (those are likely dupes)

      // Store the better score
      if (!result.has(a.id) || result.get(a.id)!.score < similarity) {
        result.set(a.id, { score: similarity, partner: b });
      }
    }
  }

  return result;
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 7: Update sectionFor() to Route New Detection Types

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: detection types (reversal, refund, split, similar-merchant)
- Produces: Updated `sectionFor()` function signature and logic

**Details:**
Update `sectionFor()` to accept an optional `detectionType` parameter and route transactions appropriately:

- Reversal → "review" (needs manual confirmation)
- Refund → "review" (needs verification)
- Split Payment / Multi-Part → "review" (needs grouping confirmation)
- Similar Merchant → "review" if score < 0.95, otherwise "ready"
- Transfer (existing badge) → "transfers" (new section)
- Recurring (existing badge) → "recurring" (new section)
- Duplicate (existing) → "duplicate"
- Green match (existing) → "ready"
- Yellow match (existing) → "review"
- Red match or no match → "issue"

- [ ] **Step 1: Replace sectionFor() function**

Find this function in reconciliation-insights.ts:

```typescript
export function sectionFor(match: ReconciliationMatch | null, isDuplicate: boolean): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (!match || !match.qbTransactionId) return "issue";
  if (match.flaggedLevel === "green") return "ready";
  if (match.flaggedLevel === "yellow") return "review";
  return "issue";
}
```

Replace it with:

```typescript
export function sectionFor(
  match: ReconciliationMatch | null,
  isDuplicate: boolean,
  detectionType?: string,
  badges?: string[],
): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (detectionType === "reversal") return "review";
  if (detectionType === "refund") return "review";
  if (detectionType === "split" || detectionType === "multi-part") return "review";
  if (badges?.includes("Transfer")) return "transfers";
  if (badges?.includes("Recurring")) return "recurring";
  if (!match || !match.qbTransactionId) return "issue";
  if (match.flaggedLevel === "green") return "ready";
  if (match.flaggedLevel === "yellow") return "review";
  return "issue";
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 8: Update buildReviewRows() to Call All Detectors

**Files:**
- Modify: `zakiledger/lib/reconciliation-insights.ts`

**Interfaces:**
- Consumes: bank transactions, QB transactions, existing matches
- Produces: ReviewRow[] with detection type, related transactions, and confidence scores

**Details:**
Update `buildReviewRows()` to:
1. Call all detectors (reversals, refunds, splits, similar merchants, existing duplicates)
2. Determine the highest-priority detection for each transaction
3. Populate detection fields in ReviewRow
4. Use detection to determine section via updated `sectionFor()`
5. Include plain-English reasons for each detection

- [ ] **Step 1: Rewrite buildReviewRows() to call all detectors**

Find the entire `buildReviewRows()` function and replace with:

```typescript
export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
}): { id: string; row: ReviewRow; matchId: string | null }[] {
  const dupes = detectDuplicates(data.bankTransactions);
  const reversals = detectReversals(data.bankTransactions);
  const refunds = detectRefunds(data.bankTransactions);
  const splits = detectSplitPayments(data.bankTransactions);
  const multiParts = detectMultiPartPayments(data.bankTransactions);
  const similarMerchants = detectSimilarMerchants(data.bankTransactions, reversals, dupes);

  // Build a map: transaction ID -> detection type + details
  const detectionMap = new Map<string, { type: string; reason: string; relatedTxn?: BankTransaction; relatedTxns?: BankTransaction[] }>();

  for (const [id, partner] of reversals) {
    const total = Math.abs(data.bankTransactions.find((t) => t.id === id)?.amount ?? 0);
    detectionMap.set(id, {
      type: "reversal",
      reason: `Reversal detected. Original: £${formatMoney(Math.abs(data.bankTransactions.find((t) => t.id === id)?.amount ?? 0), data.bankTransactions.find((t) => t.id === id)?.currency ?? "")}. Net effect: £0.00.`,
      relatedTxn: partner,
    });
  }

  for (const [id, charge] of refunds) {
    detectionMap.set(id, {
      type: "refund",
      reason: `Refund detected. Matches original charge from ${formatShortDate(charge.transactionDate)}.`,
      relatedTxn: charge,
    });
  }

  for (const [ref, txnIds] of splits) {
    for (const id of txnIds) {
      if (!detectionMap.has(id)) {
        const txns = txnIds.map((tid) => data.bankTransactions.find((t) => t.id === tid)).filter(Boolean) as BankTransaction[];
        detectionMap.set(id, {
          type: "split",
          reason: `Part of split payment for ${ref}. ${txns.length} transactions totaling £${formatMoney(Math.abs(txns.reduce((sum, t) => sum + t.amount, 0)), txns[0]?.currency ?? "")}.`,
          relatedTxns: txns,
        });
      }
    }
  }

  for (const [id, { score, partner }] of similarMerchants) {
    if (!detectionMap.has(id)) {
      const pct = Math.round(score * 100);
      detectionMap.set(id, {
        type: "similar-merchant",
        reason: `Supplier name is ${pct}% similar to another transaction.`,
        relatedTxn: partner,
      });
    }
  }

  return data.bankTransactions.map((bank) => {
    const match = data.matches.find((m) => m.bankTransactionId === bank.id) ?? null;
    const qb = match?.qbTransactionId ? data.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null : null;
    const isDuplicate = dupes.has(bank.id);
    const pct = match?.confidence ? Math.round(match.confidence * 100) : 0;
    const key = normalizeMerchant(bank);
    const sameMerchantMatches = key
      ? data.matches.filter((m) => {
          const otherBank = data.bankTransactions.find((b) => b.id === m.bankTransactionId);
          return otherBank ? normalizeMerchant(otherBank) === key : false;
        })
      : [];
    const category = suggestCategory(bank, qb, sameMerchantMatches, data.qbTransactions);
    const badges = detectBadges(bank, data.bankTransactions);
    const dupeOther = dupes.get(bank.id);
    const detection = detectionMap.get(bank.id);

    const row: ReviewRow = {
      id: bank.id,
      section: sectionFor(match, isDuplicate, detection?.type, badges),
      date: formatShortDate(bank.transactionDate),
      title: bank.merchant || bank.description || "(no description)",
      subtitle: qb?.description ?? (match ? "" : "No accounting entry found"),
      amountLabel: `${bank.amount < 0 ? "+" : "−"}${formatMoney(Math.abs(bank.amount), bank.currency)}`,
      amountSubLabel: bank.amount < 0 ? "↑ Money in" : "↓ Money out",
      categoryLabel: category,
      confidencePct: pct,
      confidenceLabel: confidenceLabel(pct),
      confidenceColor: confidenceColor(pct),
      reason: detection ? detection.reason : match ? plainEnglishReason(match) : "No accounting entry matches this transaction closely enough to suggest one.",
      badges,
      comparePair: dupeOther
        ? {
            aLabel: "This transaction",
            a: `${formatShortDate(bank.transactionDate)} · ${formatMoney(bank.amount, bank.currency)}`,
            bLabel: "Possible duplicate",
            b: `${formatShortDate(dupeOther.transactionDate)} · ${formatMoney(dupeOther.amount, dupeOther.currency)}`,
          }
        : undefined,
    };

    return { id: bank.id, row, matchId: match?.id ?? null };
  });
}
```

- [ ] **Step 2: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds, no errors in reconciliation-insights.ts

---

## Task 9: Update ReviewBoard Sections Config

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Interfaces:**
- Consumes: ReviewSectionConfig array
- Produces: Updated sections array with new section keys

**Details:**
The ReviewBoard already supports multiple sections. Update the page to define sections for: ready, review, duplicate, refunds, reversals, splits, transfers, recurring, issue.

- [ ] **Step 1: Find the sections config in review page**

Open `zakiledger/app/(app)/reconciliation/review/page.tsx` and find where `ReviewBoard` is being passed sections. Look for a line like:

```typescript
<ReviewBoard
  sections={[ ... ]}
  ...
/>
```

- [ ] **Step 2: Add new section configs**

Update the sections array to include:

```typescript
const sections: ReviewSectionConfig[] = [
  { key: "ready", title: "Ready to Approve", accentColor: "#10b981", description: "High-confidence matches ready for immediate approval.", showBulkApproveAll: true },
  { key: "review", title: "Needs Review", accentColor: "#f59e0b", description: "Matches requiring manual verification or flagged detections." },
  { key: "refunds", title: "Refunds", accentColor: "#8b5cf6", description: "Transactions detected as refunds paired with original charges." },
  { key: "reversals", title: "Reversals", accentColor: "#ec4899", description: "Transactions that cancel each other out." },
  { key: "splits", title: "Split Payments", accentColor: "#06b6d4", description: "Multiple transactions belonging to the same invoice or reference." },
  { key: "transfers", title: "Transfers", accentColor: "#14b8a6", description: "Transfers between accounts." },
  { key: "recurring", title: "Recurring Transactions", accentColor: "#a78bfa", description: "Regular subscription or recurring charges." },
  { key: "duplicate", title: "Possible Duplicates", accentColor: "#ef4444", description: "Duplicate charges likely from pre-authorization holds." },
  { key: "issue", title: "Potential Issues", accentColor: "#6b7280", description: "Unmatched or low-confidence transactions needing attention." },
];
```

However, check the current ReviewBoard type definition — it may only support certain section keys. Look at the ReviewSectionKey type:

In `ReviewBoard.tsx`:
```typescript
export type ReviewSectionKey = "ready" | "review" | "duplicate" | "issue";
```

We need to update this to include the new types.

- [ ] **Step 3: Update ReviewSectionKey in ReviewBoard.tsx**

Open `zakiledger/components/review/ReviewBoard.tsx` and find the line:

```typescript
export type ReviewSectionKey = "ready" | "review" | "duplicate" | "issue";
```

Replace it with:

```typescript
export type ReviewSectionKey = "ready" | "review" | "duplicate" | "issue" | "refunds" | "reversals" | "splits" | "transfers" | "recurring";
```

- [ ] **Step 4: Run the app and verify no TypeScript errors**

```bash
npm run build
```

Expected: Build succeeds

---

## Task 10: Browser Test All Features

**Files:**
- No code changes — testing only

**Test Checklist:**
- [ ] Start dev server: `npm run dev`
- [ ] Navigate to Reconciliation > Review
- [ ] Upload test CSV with:
  - A reversal pair (e.g., CLIENT PAYMENT INV-1003 +1750, CLIENT PAYMENT INV-1003 -1750)
  - A refund pair (e.g., AMAZON -50, REFUND AMAZON +50)
  - A split payment group (e.g., CLIENT INV-1001 +1000, CLIENT INV-1001 +500)
  - A duplicate pair (same merchant, amount, date within 1 day)
  - A recurring transaction (same merchant 3+ times)
  - A transfer (contains "transfer" in description)
- [ ] Verify Reversals section appears and shows reversal pair
- [ ] Verify Refunds section appears and shows refund pair
- [ ] Verify Splits section appears and groups transactions
- [ ] Verify Transfers section appears
- [ ] Verify Recurring section appears
- [ ] Verify Duplicates section shows duplicate pair with "Possible duplicate" label
- [ ] Click on a reversal transaction → side panel opens with reason "Reversal detected..."
- [ ] Click on a refund transaction → side panel opens with reason "Refund detected..."
- [ ] Verify "Approve" button works (moves transaction out of section)
- [ ] Verify "Flag" button works (marks for manual review)
- [ ] Verify confidence badges render with correct color (green, yellow, red)
- [ ] Verify all section headers show transaction counts
- [ ] Verify collapsed/expanded state persists for sections
- [ ] Upload a CSV with no matches → verify "Potential Issues" section shows all unmatched

---

## Task 11: Final Commit

**Files:**
- Modified: `zakiledger/lib/reconciliation-insights.ts`
- Modified: `zakiledger/components/review/ReviewBoard.tsx`
- Modified: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Details:**
Create a single commit with all detector additions and section routing.

- [ ] **Step 1: Stage all changes**

```bash
git add zakiledger/lib/reconciliation-insights.ts zakiledger/components/review/ReviewBoard.tsx zakiledger/app/\(app\)/reconciliation/review/page.tsx
```

- [ ] **Step 2: Create commit**

```bash
git commit -m "feat: add transaction detectors (reversals, refunds, splits, merchant similarity) and review category routing"
```

- [ ] **Step 3: Push to main**

```bash
git push origin main
```

- [ ] **Step 4: Verify deployment**

Check Render dashboard to confirm app is building and deploying.

---

## Success Criteria

✅ All 9 detectors run without errors
✅ Reversals appear in "Reversals" section with plain-English reason
✅ Refunds appear in "Refunds" section with plain-English reason  
✅ Split payments appear in "Splits" section grouped by reference
✅ Similar merchants flagged with similarity score
✅ Badges (Transfer, Recurring, Payroll, VAT, Subscription) route to correct sections
✅ Duplicates continue to work (appear in "Duplicates" section)
✅ All buttons (Approve, Flag, Compare, Detail Panel) work
✅ Confidence scores 0-100 render with correct colors
✅ No console errors or TypeScript warnings
✅ Committed and pushed to main
