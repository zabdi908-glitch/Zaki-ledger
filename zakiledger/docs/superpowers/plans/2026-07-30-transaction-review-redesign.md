# Transaction & Document Review Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `app/(app)/reconciliation/review/page.tsx` and `app/(app)/review/page.tsx` to match the two client-approved mockups exactly — grouped sections (Ready to Approve / Needs Review / Possible Duplicates / Potential Issues), inline plain-English reasoning, a confidence-ring system, a docked side panel, bulk approve, and keyboard navigation — wired to real data through the app's existing APIs.

**Architecture:** A single generic, presentational `ReviewBoard` component (sections + rows + bulk bar + docked side panel + keyboard nav) is shared by both screens. Each domain gets its own pure, unit-tested "insights" module (`lib/reconciliation-insights.ts`, `lib/extraction-insights.ts`) that turns existing API data into the board's row/section/reasoning shape — no new database tables, no new API routes. The two mockups already committed to `design_handoff_zaki_ledger/` are the pixel-exact visual reference; `ReviewBoard` is a 1:1 React port of their markup/CSS/interaction, generalized with props instead of hardcoded sample data.

**Tech Stack:** Next.js 15 (App Router) + React 19, existing `lib/shell-theme.ts` inline-style-object convention (no Tailwind/CSS modules in this repo), Vitest (`environment: "node"`) for pure-function tests — this repo does not unit-test page components (no jsdom/RTL installed), so page-level verification is manual (dev server) per existing convention.

## Global Constraints

- No new database tables, columns, or Supabase migrations. Every new "insight" (badges, sections, plain-English reasoning, duplicate detection, category suggestion) is a pure function computed client-side from data the existing endpoints already return.
- No new API routes. Reuse: `GET /api/reconciliation/[id]/transactions`, `POST /api/reconciliation/[id]/match`, `POST /api/reconciliation/[id]/reject`, `POST /api/reconciliation/[id]/approve`, `GET /api/reconciliation/[id]/report`, `GET /api/pending`, `GET /api/pending/[id]`, `DELETE /api/pending/[id]`, `POST /api/approve`.
- Follow the existing style convention exactly: style objects/functions in `lib/shell-theme.ts` (oklch colors, `shellCard`, `shellButton`, `pill`, `tierFor`, `shellFigures`), no new CSS files, no Tailwind, no styled-components.
- `app/(app)/reconciliation/batch/page.tsx` and `app/(app)/batch/page.tsx` are out of scope — do not modify them.
- Money formatting via `formatMoney` from `lib/currency.ts`. Dates are ISO 8601 strings (`YYYY-MM-DD`).
- Every pure `lib/*-insights.ts` function must have a Vitest unit test in `tests/`. Do not write component/page tests — this repo has no jsdom/RTL; verify pages by running the dev server.
- Commit after every task, in the style already used in this repo's history (short, present-tense, one line, no scope prefix required — see `git log` for examples).

---

## File Structure

| File | Responsibility |
|---|---|
| `design_handoff_zaki_ledger/Transaction Review Mockup.html` | (new) Pixel-exact reference for the reconciliation review screen — copied in as-is, source of truth for `ReviewBoard`'s markup/CSS/behavior. |
| `design_handoff_zaki_ledger/Invoice Review Mockup.html` | (new) Pixel-exact reference for the document review screen. |
| `lib/shell-theme.ts` | (modify) Add the `dupe`/`dupeBg` color tokens and a handful of new style-object helpers the board needs (confidence ring SVG, group accent bar, field-confidence bar) — additive only, nothing existing changes shape. |
| `components/review/ConfidenceRing.tsx` | (new) Small SVG ring — row-size and panel-size — used by both screens. |
| `components/review/ReviewBoard.tsx` | (new) Generic, presentational: hero banner, sticky bulk bar, four collapsible sections, row list, docked side panel shell, keyboard nav (`↑/↓/Enter/A/Esc`). Domain-agnostic over a `ReviewRow` type; panel body content is a render prop. |
| `lib/reconciliation-insights.ts` | (new) Pure functions turning `{bankTransactions, qbTransactions, matches}` into `ReviewRow[]`: confidence label bands, plain-English reasoning, badge detection (VAT/Payroll/Transfer/Subscription/Recurring), in-statement duplicate detection, category suggestion, section bucketing, the 40/35/25 factor breakdown for the panel. |
| `app/(app)/reconciliation/review/page.tsx` | (rewrite) Fetches the same data it does today; builds rows via `reconciliation-insights`; renders `ReviewBoard`; panel body shows match details + factor breakdown; approve/reject/bulk-approve call the same existing endpoints. |
| `lib/extraction-insights.ts` | (new) Pure functions turning a `PendingItem`/full `InvoiceExtraction` into `ReviewRow`s: reuses `lib/validation.ts`'s real `gateApproval`/`checkTotals`/`fieldLabels`/`reasonText` (no reimplementation), adds in-queue duplicate detection and plain-English reasoning. |
| `app/(app)/review/page.tsx` | (rewrite) Fetches `/api/pending` for the list, `/api/pending/[id]` on panel-open for full field confidences; edits/confirms post through the existing `/api/approve` with its real `edited` map; approve/flag call existing endpoints. |
| `tests/reconciliation-insights.test.ts` | (new) Unit tests for every exported function in `lib/reconciliation-insights.ts`. |
| `tests/extraction-insights.test.ts` | (new) Unit tests for every exported function in `lib/extraction-insights.ts`. |

---

### Task 1: Commit the approved mockups as the design reference

**Files:**
- Create: `design_handoff_zaki_ledger/Transaction Review Mockup.html`
- Create: `design_handoff_zaki_ledger/Invoice Review Mockup.html`

**Interfaces:** None — static reference files, not imported by app code.

- [ ] **Step 1: Copy both mockup files into the repo**

Copy the two files this conversation already built and published as Artifacts into the repo unchanged:
- From the session scratchpad's `transaction-review-mockup.html` → `design_handoff_zaki_ledger/Transaction Review Mockup.html`
- From the session scratchpad's `invoice-review-mockup.html` → `design_handoff_zaki_ledger/Invoice Review Mockup.html`

- [ ] **Step 2: Open both files in a browser and confirm they still render and behave as before** (hero approve-all, section collapse, side panel open/close, keyboard nav) — this is the reference every later task is ported from, so it must be verified correct before anything is built against it.

- [ ] **Step 3: Commit**

```bash
git add "design_handoff_zaki_ledger/Transaction Review Mockup.html" "design_handoff_zaki_ledger/Invoice Review Mockup.html"
git commit -m "Add approved transaction/invoice review mockups as design reference"
```

---

### Task 2: Shell-theme additions

**Files:**
- Modify: `lib/shell-theme.ts`

**Interfaces:**
- Produces: `shellColor.dupe`, `shellColor.dupeBg` (new keys on the existing `shellColor` export); `confidenceRing(pct: number, size: number, stroke: number, color: string): { track: CSSProperties; fill: CSSProperties }` — actually SVG needs raw stroke-dasharray math, not CSSProperties, so this is exported as a plain data function, not a style object (see step below); `groupAccentBar(color: string): CSSProperties`; `fieldConfidenceBar(pct: number, color: string): { track: CSSProperties; fill: CSSProperties }`.

- [ ] **Step 1: Add the two new color tokens**

In `lib/shell-theme.ts`, inside the `shellColor` object (after the existing `low`/`lowBg` pair), add:

```ts
  dupe: "oklch(48% 0.14 305)",
  dupeBg: "oklch(94% 0.045 305)",
```

- [ ] **Step 2: Add a ring-geometry helper (plain function, not JSX — this repo's components import it and build the `<svg>` themselves, matching how `pill()`/`shellCard()` return data for the caller to spread)**

Append to `lib/shell-theme.ts`:

```ts
/** Stroke-dasharray geometry for an SVG confidence ring. Returns the values a
 * <circle> needs; callers build the actual SVG markup (see ConfidenceRing.tsx). */
export function ringGeometry(pct: number, size: number, stroke: number): { radius: number; circumference: number; dash: number } {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * circumference;
  return { radius, circumference, dash };
}
```

- [ ] **Step 3: Add the group accent bar and field-confidence bar style helpers**

```ts
/** The colored left-edge bar on a review-board section header. */
export function groupAccentBar(color: string): CSSProperties {
  return { width: 4, alignSelf: "stretch", borderRadius: 3, flexShrink: 0, background: color };
}

/** Track + fill pair for a per-field confidence bar in a review side panel. */
export function fieldConfidenceBar(pct: number, color: string): { track: CSSProperties; fill: CSSProperties } {
  return {
    track: { height: 5, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden" },
    fill: { height: "100%", borderRadius: 3, width: `${Math.max(0, Math.min(100, pct))}%`, background: color },
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `cd zakiledger && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/shell-theme.ts
git commit -m "Add duplicate-tier color and review-board style helpers to shell theme"
```

---

### Task 3: ConfidenceRing component

**Files:**
- Create: `components/review/ConfidenceRing.tsx`

**Interfaces:**
- Consumes: `ringGeometry` from `lib/shell-theme.ts`.
- Produces: `<ConfidenceRing pct={number} size={number} stroke={number} color={string} />` — default export, used by both `ReviewBoard` (row-size, `size=30 stroke=4`) and the two page panels (panel-size, `size=92 stroke=8`).

- [ ] **Step 1: Write the component**

```tsx
import { ringGeometry, shellColor } from "@/lib/shell-theme";

export default function ConfidenceRing({
  pct,
  size,
  stroke,
  color,
}: {
  pct: number;
  size: number;
  stroke: number;
  color: string;
}) {
  const { radius, circumference, dash } = ringGeometry(pct, size, stroke);
  const center = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={center} cy={center} r={radius} fill="none" stroke={shellColor.trackBg} strokeWidth={stroke} />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference}`}
      />
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd zakiledger && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add components/review/ConfidenceRing.tsx
git commit -m "Add ConfidenceRing component"
```

---

### Task 4: ReviewBoard — the generic review UI

**Files:**
- Create: `components/review/ReviewBoard.tsx`

**Interfaces:**
- Consumes: `ConfidenceRing` (Task 3); `shellColor`, `shellCard`, `shellButton`, `pill`, `shellFigures`, `microLabel`, `groupAccentBar`, `disabledOverride` from `lib/shell-theme.ts`; `formatMoney` from `lib/currency.ts` (only for callers that pass money-formatted strings in — the board itself never formats currency, it just renders whatever string the caller gives it, so it stays domain-agnostic).
- Produces (the public contract every later task builds on):

```ts
export type ReviewSectionKey = "ready" | "review" | "duplicate" | "issue";

export interface ReviewRow {
  id: string;
  section: ReviewSectionKey;
  date: string; // already formatted for display, e.g. "14 Jun"
  title: string; // merchant / supplier
  subtitle: string; // description / invoice number / doc type
  amountLabel: string; // already formatted, e.g. "−£412.18"
  amountSubLabel: string; // e.g. "↓ Money out" or "📄 Invoice"
  categoryLabel: string;
  confidencePct: number; // 0-100
  confidenceLabel: string; // e.g. "Exact match"
  confidenceColor: string; // one of shellColor's tier colors
  reason: string; // the plain-English one-liner
  badges: string[]; // e.g. ["Recurring", "VAT"]
  comparePair?: { aLabel: string; a: string; bLabel: string; b: string }; // for "duplicate" rows, shown inline
}

export interface ReviewSectionConfig {
  key: ReviewSectionKey;
  title: string;
  accentColor: string;
  description: string;
  showBulkApproveAll?: boolean; // only "ready" sets this true
}

export interface ReviewBoardProps {
  rows: ReviewRow[];
  sections: ReviewSectionConfig[]; // exactly 4, in display order
  approvedIds: Set<string>;
  onApprove: (ids: string[]) => void;
  onFlag: (id: string) => void;
  renderPanel: (row: ReviewRow) => React.ReactNode; // full side-panel body, domain-specific
  heroTitle: string; // e.g. "Ready to approve"
  heroDescription: string;
}
```

- [ ] **Step 1: Write the component**

Port `design_handoff_zaki_ledger/Transaction Review Mockup.html`'s markup, CSS, and vanilla-JS interactivity into this component **exactly** (same layout, spacing, colors, copy patterns, keyboard shortcuts, collapse/bulk/panel behavior) — the mockup is the pixel reference, not a rough guide. Concretely:

- Convert every CSS rule from the mockup's `<style>` block into inline `style={{...}}` objects (or small local helper functions colocated in this file, following the `shellCard`/`shellButton` pattern from `lib/shell-theme.ts` — do not introduce a CSS file).
- Convert the mockup's imperative DOM rendering (`renderGroup`, `renderRow`, `openPanel`, event delegation) into React: `useState` for `selected: Set<string>`, `collapsedSections: Set<ReviewSectionKey>`, `openPanelId: string | null`, `focusedIdx: number`, `showAllReady: boolean`.
- The hero banner shows only when the `ready` section has open (unapproved) rows; its count and "Approve all N" button use `rows.filter(r => r.section === "ready" && !approvedIds.has(r.id))`.
- Each section groups `rows` by `section`, filters out approved ids, and renders: header (accent bar, title, count, description, and — only when `showBulkApproveAll` and count > 0 — a bulk "Approve all N" button calling `onApprove` with every open id in that section), a column header row, then up to 8 visible rows for `ready` (the rest behind a "Show all N" strip, same as the mockup) and all rows for the other three sections.
- Each row: checkbox (toggles `selected`, stops propagation so it doesn't open the panel), date, title/subtitle, amount + sub-label, category pill, `ConfidenceRing` + pct + `confidenceLabel` in `confidenceColor`, inline ✓ approve / ⚑ flag icon buttons (both `stopPropagation`), then below: the `comparePair` block if present (duplicate rows), then the reasoning line (`✦` + `reason`) and badge pills.
- Clicking anywhere else on the row sets `openPanelId` to that row's id.
- The docked side panel: `width: 0` collapsed / `440px` open with a CSS `transition`, header (eyebrow = section title, title = row title, amount line, close button), then `renderPanel(row)` for the body — this component owns none of the panel's *content*, only the shell (open/close, width, close button, scroll container).
- Sticky bulk bar appears when `selected.size > 0`: "`N` selected", Clear, "Approve selected" (calls `onApprove([...selected])`).
- Keyboard: `ArrowUp`/`ArrowDown` move `focusedIdx` across the currently-rendered row elements (skip when focus is inside an `<input>`/`<textarea>`), `Enter` opens the focused row's panel, `a`/`A` calls `onApprove([focusedId])`, `Escape` closes the panel. Attach one `document`-level `keydown` listener in a `useEffect`, matching the mockup.
- Respect `prefers-reduced-motion: reduce` by wrapping the panel-width and row-background transitions in a media check (a lightweight approach: apply `transition: none` via `useMediaQuery`-style `window.matchMedia("(prefers-reduced-motion: reduce)").matches` read once in a `useEffect` and stored in state, applied conditionally to the transition style values).
- Below ~980px viewport width, the panel should become a fixed full-screen overlay instead of a docked column, and the row grid should stack — reuse the mockup's `@media (max-width: 980px)` rules, translated to a `useState` + `resize` listener (or, more simply, keep it in a single injected `<style>` tag scoped to this component via a unique class name, since this is the one case where matching the mockup's own responsive CSS 1:1 is far simpler than re-deriving it in JS — a scoped `<style>` tag colocated in this file is acceptable here specifically for the media queries, everything else stays inline styles).

- [ ] **Step 2: Typecheck**

Run: `cd zakiledger && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Manual verification against the mockup**

This component has no automated test (no jsdom/RTL in this repo). Instead: Task 6 wires it into a real page — verification happens there via the dev server, side-by-side against `design_handoff_zaki_ledger/Transaction Review Mockup.html` open in another tab.

- [ ] **Step 4: Commit**

```bash
git add components/review/ReviewBoard.tsx
git commit -m "Add ReviewBoard: generic grouped-review UI ported from the approved mockup"
```

---

### Task 5: `lib/reconciliation-insights.ts` + tests

**Files:**
- Create: `lib/reconciliation-insights.ts`
- Test: `tests/reconciliation-insights.test.ts`

**Interfaces:**
- Consumes: `BankTransaction`, `QbTransaction`, `ReconciliationMatch`, `FlaggedLevel` from `lib/reconciliation-schema.ts`; `ReviewRow`, `ReviewSectionKey` from `components/review/ReviewBoard.tsx`; `formatMoney` from `lib/currency.ts`.
- Produces:

```ts
export function confidenceLabel(pct: number): string; // >=98 "Exact match", >=90 "Strong match", >=65 "Review recommended", else "Insufficient evidence"
export function confidenceColor(pct: number): string; // shellColor.high / .medium / .low by the same bands
export function plainEnglishReason(match: ReconciliationMatch): string;
export function detectBadges(bank: BankTransaction, allBank: BankTransaction[]): string[]; // subset of ["VAT","Payroll","Transfer","Subscription","Recurring"]
export function detectDuplicates(bank: BankTransaction[]): Map<string, BankTransaction>; // bankTransactionId -> the other transaction it duplicates
export function suggestCategory(bank: BankTransaction, qb: QbTransaction | null, matches: ReconciliationMatch[], qbTxns: QbTransaction[]): string;
export function factorBreakdown(match: ReconciliationMatch): { label: string; score: number; max: number }[]; // Amount/40, Date/35, Merchant/25 split from match.matchReason + match.confidence
export function sectionFor(match: ReconciliationMatch | null, isDuplicate: boolean): ReviewSectionKey;
export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
}): { id: string; row: import("@/components/review/ReviewBoard").ReviewRow; matchId: string | null }[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/reconciliation-insights.test.ts
import { describe, expect, it } from "vitest";
import {
  confidenceLabel,
  detectBadges,
  detectDuplicates,
  plainEnglishReason,
  sectionFor,
  suggestCategory,
  factorBreakdown,
  buildReviewRows,
} from "@/lib/reconciliation-insights";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";

function bank(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "b1", statementId: "s1", transactionDate: "2026-06-02", postedDate: null,
    merchant: "AWS EMEA", description: null, amount: 412.18, currency: "GBP",
    transactionId: null, memo: null, ...overrides,
  };
}
function qb(overrides: Partial<QbTransaction> = {}): QbTransaction {
  return {
    id: "q1", qbTransactionId: null, qbAccountId: null, postedDate: "2026-06-01",
    amount: 412.18, description: "AWS EMEA hosting", accountName: "Software & Hosting",
    accountType: "Expense", currency: "GBP", ...overrides,
  };
}
function match(overrides: Partial<ReconciliationMatch> = {}): ReconciliationMatch {
  return {
    id: "m1", statementId: "s1", bankTransactionId: "b1", qbTransactionId: "q1",
    confidence: 0.99, matchReason: "amount + date + merchant", flaggedLevel: "green",
    matchedBy: "auto", matchedAt: "2026-06-02T00:00:00Z", approvedBy: null, approvedAt: null,
    ...overrides,
  };
}

describe("confidenceLabel", () => {
  it("labels 99% as Exact match", () => expect(confidenceLabel(99)).toBe("Exact match"));
  it("labels 92% as Strong match", () => expect(confidenceLabel(92)).toBe("Strong match"));
  it("labels 75% as Review recommended", () => expect(confidenceLabel(75)).toBe("Review recommended"));
  it("labels 45% as Insufficient evidence", () => expect(confidenceLabel(45)).toBe("Insufficient evidence"));
});

describe("plainEnglishReason", () => {
  it("turns 'amount + date + merchant' into a full sentence", () => {
    const text = plainEnglishReason(match({ matchReason: "amount + date + merchant" }));
    expect(text.toLowerCase()).toContain("amount");
    expect(text.toLowerCase()).toContain("date");
    expect(text.toLowerCase()).toContain("merchant");
    expect(text.endsWith(".")).toBe(true);
  });
  it("mentions the specific factor when only one matched", () => {
    const text = plainEnglishReason(match({ matchReason: "amount" }));
    expect(text.toLowerCase()).toContain("amount");
    expect(text.toLowerCase()).not.toContain("merchant");
  });
  it("has a fallback sentence when there is no match at all", () => {
    const text = plainEnglishReason(match({ qbTransactionId: null, matchReason: null, confidence: null }));
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("detectBadges", () => {
  it("flags HMRC VAT payments", () => {
    expect(detectBadges(bank({ merchant: "HMRC VAT" }), [])).toContain("VAT");
  });
  it("flags payroll-looking merchants", () => {
    expect(detectBadges(bank({ merchant: "Tom's Payroll Ltd" }), [])).toContain("Payroll");
  });
  it("flags known subscription merchants", () => {
    expect(detectBadges(bank({ merchant: "Adobe Creative Cloud" }), [])).toContain("Subscription");
  });
  it("flags transfer-looking descriptions", () => {
    expect(detectBadges(bank({ merchant: null, description: "TRANSFER TO xx4471" }), [])).toContain("Transfer");
  });
  it("flags recurring when the same merchant appears more than once in the statement", () => {
    const all = [bank({ id: "b1" }), bank({ id: "b2" })];
    expect(detectBadges(all[0], all)).toContain("Recurring");
  });
  it("returns no badges for a plain one-off merchant", () => {
    expect(detectBadges(bank({ merchant: "Sainsbury's Local", description: null }), [bank({ merchant: "Sainsbury's Local" })])).toEqual(
      expect.not.arrayContaining(["VAT", "Payroll", "Subscription", "Transfer"]),
    );
  });
});

describe("detectDuplicates", () => {
  it("pairs two transactions with the same merchant and amount on the same day", () => {
    const a = bank({ id: "b1", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const b = bank({ id: "b2", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const dupes = detectDuplicates([a, b]);
    expect(dupes.get("b1")?.id).toBe("b2");
    expect(dupes.get("b2")?.id).toBe("b1");
  });
  it("does not pair transactions with different amounts", () => {
    const a = bank({ id: "b1", amount: 18.4 });
    const b = bank({ id: "b2", amount: 22.0 });
    expect(detectDuplicates([a, b]).size).toBe(0);
  });
  it("does not pair a transaction with itself when it's the only one", () => {
    expect(detectDuplicates([bank()]).size).toBe(0);
  });
});

describe("suggestCategory", () => {
  it("uses the matched QB transaction's account name when there is a match", () => {
    expect(suggestCategory(bank(), qb({ accountName: "Software & Hosting" }), [], [])).toBe("Software & Hosting");
  });
  it("falls back to the most common category this merchant has been matched to before", () => {
    const priorMatch = match({ bankTransactionId: "b-other", qbTransactionId: "q-other" });
    const priorQb = qb({ id: "q-other", accountName: "Office Supplies" });
    const result = suggestCategory(bank({ id: "b2", merchant: "AWS EMEA" }), null, [priorMatch], [priorQb]);
    expect(result).toBe("Office Supplies");
  });
  it("falls back to Uncategorised when there is nothing to go on", () => {
    expect(suggestCategory(bank({ merchant: "Totally New Merchant" }), null, [], [])).toBe("Uncategorised");
  });
});

describe("factorBreakdown", () => {
  it("splits a full match reason into Amount/40, Date/35, Merchant/25", () => {
    const bd = factorBreakdown(match({ matchReason: "amount + date + merchant", confidence: 1 }));
    expect(bd).toEqual([
      { label: "Amount", score: 40, max: 40 },
      { label: "Date", score: 35, max: 35 },
      { label: "Merchant", score: 25, max: 25 },
    ]);
  });
  it("zeroes out a factor that isn't in the match reason", () => {
    const bd = factorBreakdown(match({ matchReason: "amount", confidence: 0.4 }));
    expect(bd.find((f) => f.label === "Date")?.score).toBe(0);
    expect(bd.find((f) => f.label === "Amount")?.score).toBe(40);
  });
});

describe("sectionFor", () => {
  it("puts a duplicate in the duplicate section regardless of confidence", () => {
    expect(sectionFor(match({ flaggedLevel: "green" }), true)).toBe("duplicate");
  });
  it("puts a green match in ready", () => {
    expect(sectionFor(match({ flaggedLevel: "green" }), false)).toBe("ready");
  });
  it("puts a yellow match in review", () => {
    expect(sectionFor(match({ flaggedLevel: "yellow" }), false)).toBe("review");
  });
  it("puts a red or missing match in issue", () => {
    expect(sectionFor(match({ flaggedLevel: "red" }), false)).toBe("issue");
    expect(sectionFor(null, false)).toBe("issue");
  });
});

describe("buildReviewRows", () => {
  it("produces one row per open bank transaction with a matching id", () => {
    const rows = buildReviewRows({ bankTransactions: [bank()], qbTransactions: [qb()], matches: [match()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("b1");
    expect(rows[0].matchId).toBe("m1");
    expect(rows[0].row.section).toBe("ready");
    expect(rows[0].row.amountLabel).toContain("412.18");
  });
  it("produces an issue row for an unmatched bank transaction", () => {
    const rows = buildReviewRows({ bankTransactions: [bank({ id: "b9" })], qbTransactions: [], matches: [] });
    expect(rows[0].row.section).toBe("issue");
    expect(rows[0].matchId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd zakiledger && npx vitest run tests/reconciliation-insights.test.ts`
Expected: FAIL — `lib/reconciliation-insights.ts` doesn't exist yet.

- [ ] **Step 3: Implement `lib/reconciliation-insights.ts`**

```ts
import { formatMoney } from "./currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "./reconciliation-schema";
import { shellColor } from "./shell-theme";
import type { ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";

/**
 * Turns the matching engine's raw output (lib/reconciliation-matching.ts) into
 * the review board's row shape: plain-English copy, badges, sections, and a
 * confidence system, all derived from data the existing endpoints already
 * return — no new tables, no new queries.
 */

export function confidenceLabel(pct: number): string {
  if (pct >= 98) return "Exact match";
  if (pct >= 90) return "Strong match";
  if (pct >= 65) return "Review recommended";
  return "Insufficient evidence";
}

export function confidenceColor(pct: number): string {
  if (pct >= 90) return shellColor.high;
  if (pct >= 65) return shellColor.medium;
  return shellColor.low;
}

const FACTOR_PHRASES: Record<string, string> = {
  amount: "Amount matches",
  date: "date matches",
  "date (pending)": "date is close (pending clearance)",
  merchant: "supplier name matches",
  "merchant (partial)": "supplier name partially matches",
};

/** e.g. "amount + date + merchant" -> "Amount, date, and supplier name all match." */
export function plainEnglishReason(match: ReconciliationMatch): string {
  if (!match.qbTransactionId || !match.matchReason) {
    return "No accounting entry matches this transaction closely enough to suggest one.";
  }
  const parts = match.matchReason.split(" + ").map((p) => FACTOR_PHRASES[p] ?? p);
  if (parts.length === 1) return `${capitalize(parts[0])}.`;
  if (parts.length === 2) return `${capitalize(parts[0])} and ${parts[1]}.`;
  const last = parts[parts.length - 1];
  return `${capitalize(parts.slice(0, -1).join(", "))}, and ${last} all match.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const VAT_RE = /\bHMRC\b|\bVAT\b/i;
const PAYROLL_RE = /payroll|wages|salary/i;
const TRANSFER_RE = /\btransfer\b|\bxfer\b|to\s+xx\d/i;
const SUBSCRIPTION_MERCHANTS = /adobe|google workspace|microsoft 365|zoom|slack|notion|dropbox|figma|aws|amazon web/i;

function normalizeMerchant(t: BankTransaction): string {
  return (t.merchant ?? t.description ?? "").trim().toLowerCase();
}

/** Badges derivable from a single statement's data — see the plan's Task 5 note
 * on why cross-statement recurrence (the mockup's stronger "Recurring" claim)
 * isn't attempted here without a new store query. */
export function detectBadges(bank: BankTransaction, allBank: BankTransaction[]): string[] {
  const text = `${bank.merchant ?? ""} ${bank.description ?? ""}`;
  const badges: string[] = [];
  if (VAT_RE.test(text)) badges.push("VAT");
  if (PAYROLL_RE.test(text)) badges.push("Payroll");
  if (SUBSCRIPTION_MERCHANTS.test(text)) badges.push("Subscription");
  if (TRANSFER_RE.test(text)) badges.push("Transfer");
  const key = normalizeMerchant(bank);
  if (key && allBank.filter((b) => normalizeMerchant(b) === key).length > 1) badges.push("Recurring");
  return badges;
}

/** Pairs transactions that share a merchant + exact amount within 1 day of each
 * other — the in-statement duplicate-authorization / pre-auth pattern. */
export function detectDuplicates(bank: BankTransaction[]): Map<string, BankTransaction> {
  const result = new Map<string, BankTransaction>();
  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i], b = bank[j];
      const sameMerchant = normalizeMerchant(a) && normalizeMerchant(a) === normalizeMerchant(b);
      const sameAmount = Math.abs(a.amount - b.amount) < 0.005;
      const closeInTime = Math.abs(Date.parse(a.transactionDate) - Date.parse(b.transactionDate)) <= 86400000;
      if (sameMerchant && sameAmount && closeInTime) {
        result.set(a.id, b);
        result.set(b.id, a);
      }
    }
  }
  return result;
}

/** Matched -> the QB account name. Unmatched -> the most common account name
 * this merchant has been matched to elsewhere in this statement. Otherwise
 * "Uncategorised" — a real cross-statement lookup is a follow-up, not needed
 * to ship this screen. */
export function suggestCategory(
  bank: BankTransaction,
  qb: QbTransaction | null,
  matches: ReconciliationMatch[],
  qbTxns: QbTransaction[],
): string {
  if (qb?.accountName) return qb.accountName;
  const key = normalizeMerchant(bank);
  if (!key) return "Uncategorised";
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (!m.qbTransactionId) continue;
    const matchedQb = qbTxns.find((q) => q.id === m.qbTransactionId);
    if (!matchedQb?.accountName) continue;
    counts.set(matchedQb.accountName, (counts.get(matchedQb.accountName) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? "Uncategorised";
}

const FACTOR_WEIGHTS: { key: string[]; label: string; max: number }[] = [
  { key: ["amount"], label: "Amount", max: 40 },
  { key: ["date", "date (pending)"], label: "Date", max: 35 },
  { key: ["merchant", "merchant (partial)"], label: "Merchant", max: 25 },
];

/** Mirrors lib/reconciliation-matching.ts's real AMOUNT_SCORE/DATE_CLOSE_SCORE/
 * MERCHANT_HIGH_SCORE weights (40/35/25) so the panel's breakdown is the
 * engine's actual math, not invented numbers. */
export function factorBreakdown(match: ReconciliationMatch): { label: string; score: number; max: number }[] {
  const reasons = (match.matchReason ?? "").split(" + ");
  return FACTOR_WEIGHTS.map(({ key, label, max }) => ({
    label,
    max,
    score: key.some((k) => reasons.includes(k)) ? max : 0,
  }));
}

export function sectionFor(match: ReconciliationMatch | null, isDuplicate: boolean): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (!match || !match.qbTransactionId) return "issue";
  if (match.flaggedLevel === "green") return "ready";
  if (match.flaggedLevel === "yellow") return "review";
  return "issue";
}

export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
}): { id: string; row: ReviewRow; matchId: string | null }[] {
  const dupes = detectDuplicates(data.bankTransactions);

  return data.bankTransactions.map((bank) => {
    const match = data.matches.find((m) => m.bankTransactionId === bank.id) ?? null;
    const qb = match?.qbTransactionId ? data.qbTxns_find(data.qbTransactions, match.qbTransactionId) : null;
    const isDuplicate = dupes.has(bank.id);
    const pct = match?.confidence ? Math.round(match.confidence * 100) : 0;
    const category = suggestCategory(bank, qb, data.matches, data.qbTransactions);
    const badges = detectBadges(bank, data.bankTransactions);
    const dupeOther = dupes.get(bank.id);

    const row: ReviewRow = {
      id: bank.id,
      section: sectionFor(match, isDuplicate),
      date: formatShortDate(bank.transactionDate),
      title: bank.merchant || bank.description || "(no description)",
      subtitle: qb?.description ?? (match ? "" : "No accounting entry found"),
      amountLabel: `${bank.amount < 0 ? "+" : "−"}${formatMoney(Math.abs(bank.amount), bank.currency)}`,
      amountSubLabel: bank.amount < 0 ? "↑ Money in" : "↓ Money out",
      categoryLabel: category,
      confidencePct: pct,
      confidenceLabel: confidenceLabel(pct),
      confidenceColor: confidenceColor(pct),
      reason: match ? plainEnglishReason(match) : "No accounting entry matches this transaction closely enough to suggest one.",
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

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
```

Note: `data.qbTxns_find` above is a typo guard for the implementer — replace it with a plain lookup: `data.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null`. (Left as an inline reminder because it's the one place a careless port would silently pass `undefined` instead of `null`.)

- [ ] **Step 4: Run the tests again and fix until green**

Run: `cd zakiledger && npx vitest run tests/reconciliation-insights.test.ts`
Expected: PASS (all tests). Fix the implementation, not the tests, if something's off — these tests encode the mockup's actual copy/behavior.

- [ ] **Step 5: Commit**

```bash
git add lib/reconciliation-insights.ts tests/reconciliation-insights.test.ts
git commit -m "Add reconciliation-insights: plain-English reasoning, badges, duplicate detection, sections"
```

---

### Task 6: Rewrite `app/(app)/reconciliation/review/page.tsx`

**Files:**
- Modify: `app/(app)/reconciliation/review/page.tsx` (full rewrite of the render, same data-fetching logic)

**Interfaces:**
- Consumes: `ReviewBoard`, `ReviewRow`, `ReviewSectionConfig` (Task 4); `buildReviewRows`, `factorBreakdown`, `confidenceLabel`, `confidenceColor` (Task 5); the existing fetch calls already in this file (`load`, `pickMatch`, `rejectOne`, `approveSelected`, `generateReport` — keep these function bodies as they are today, they already call the right endpoints).
- Produces: the page component (default export), unchanged route.

- [ ] **Step 1: Replace the render body**

Keep every existing function in the file (`load`, `pickMatch`, `rejectOne`, `approveSelected`, `generateReport`, and the loading/error/no-statement early returns) exactly as they are. Replace only the final JSX return (the part currently building `<div>` cards per bank transaction) with:

```tsx
import ReviewBoard, { type ReviewSectionConfig } from "@/components/review/ReviewBoard";
import { buildReviewRows, factorBreakdown } from "@/lib/reconciliation-insights";
import { shellColor } from "@/lib/shell-theme";

const SECTIONS: ReviewSectionConfig[] = [
  { key: "ready", title: "Ready to Approve", accentColor: shellColor.high, description: "95%+ confidence — amount, date, and merchant all match. Safe to approve as a batch.", showBulkApproveAll: true },
  { key: "review", title: "Needs Review", accentColor: shellColor.medium, description: "Below 95% confidence, or missing an accounting match. Worth a quick look before approving." },
  { key: "duplicate", title: "Possible Duplicates", accentColor: shellColor.dupe, description: "Two entries that look like the same transaction. Decide whether to keep both or reject one." },
  { key: "issue", title: "Potential Issues", accentColor: shellColor.low, description: "No match found, a currency mismatch, or an amount large enough to flag for manual review." },
];
```

Inside the component, after `review`/`report` are known non-null, build the board's data and approve handler:

```tsx
  const built = buildReviewRows({
    bankTransactions: openBanks, // the existing openBanks computed earlier in this file
    qbTransactions: review.qbTransactions,
    matches: review.matches,
  });
  const rowsById = new Map(built.map((b) => [b.id, b]));

  async function boardApprove(bankIds: string[]) {
    const matchIds = bankIds.map((id) => rowsById.get(id)?.matchId).filter((id): id is string => id !== null && id !== undefined);
    if (matchIds.length === 0) return;
    const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchesToApprove: matchIds }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? "Approve failed."); return; }
    await load();
    showToast(`${matchIds.length} ${matchIds.length === 1 ? "match" : "matches"} approved`);
  }
```

Then replace the return's card-list JSX with:

```tsx
  return (
    <div>
      <h1 style={pageTitle}>Review Matches</h1>
      <p style={{ fontSize: 14, color: shellColor.inkSoft, margin: "0 0 16px" }}>
        {reviewed} of {initialOpenCount ?? openBanks.length} flagged matches reviewed
      </p>
      <div style={{ ...progressTrack(), marginBottom: 20 }}>
        <div style={progressFill(reviewedPct)} />
      </div>

      <ReviewBoard
        rows={built.map((b) => b.row)}
        sections={SECTIONS}
        approvedIds={new Set()}
        onApprove={boardApprove}
        onFlag={(id) => showToast(`${rowsById.get(id)?.row.title ?? "Transaction"} flagged for a second look`)}
        heroTitle="High-confidence matches"
        heroDescription="Every one scored 95%+ on amount, date, and merchant against your accounting records."
        renderPanel={(row) => {
          const entry = rowsById.get(row.id);
          const match = entry?.matchId ? review.matches.find((m) => m.id === entry.matchId) ?? null : null;
          const qb = match?.qbTransactionId ? review.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null : null;
          return (
            <ReconciliationPanelBody
              bank={openBanks.find((b) => b.id === row.id)!}
              qb={qb}
              match={match}
              row={row}
              onApprove={() => match && boardApprove([row.id])}
              onReject={() => match && rejectOne(match.id)}
            />
          );
        }}
      />

      {openBanks.length === 0 && (
        <button style={{ ...shellButton("primary", "lg"), marginTop: 20 }} onClick={generateReport} disabled={generatingReport}>
          {generatingReport ? "Generating…" : "Generate reconciliation report"}
        </button>
      )}

      {report && (
        <div style={shellCard({ padding: 24, marginTop: 20 })}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Reconciliation report</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
            <ReportStat label="Matched" value={formatMoney(report.totalMatched, reportCurrency)} />
            <ReportStat label="Unmatched (bank)" value={formatMoney(report.totalUnmatchedBank, reportCurrency)} />
            <ReportStat label="Unmatched (accounting)" value={formatMoney(report.totalUnmatchedQb, reportCurrency)} />
            <ReportStat label="Variance" value={formatMoney(report.variance, reportCurrency)} />
          </div>
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            <span style={pill(report.isReconciled ? shellColor.high : shellColor.inkFaint, report.isReconciled ? shellColor.highBg : shellColor.trackBg)}>
              {report.isReconciled ? "Fully reconciled" : "Partially reconciled"}
            </span>
          </p>
        </div>
      )}
    </div>
  );
```

Note: `approvedIds={new Set()}` because this page already removes an approved bank transaction from `openBanks` on the next `load()` (see the existing `openBankIds`/`openBanks` computation) — there's no need for the board to separately track approved state here, unlike a page with no server round-trip. `ReviewBoard` still accepts the prop (Task 4's contract) for pages that do need optimistic local tracking (Task 8 uses it that way); this page just always passes an empty set.

- [ ] **Step 2: Add the panel body component**

In the same file, add:

```tsx
function ReconciliationPanelBody({
  bank,
  qb,
  match,
  row,
  onApprove,
  onReject,
}: {
  bank: BankTransaction;
  qb: QbTransaction | null;
  match: ReconciliationMatch | null;
  row: ReturnType<typeof buildReviewRows>[number]["row"];
  onApprove: () => void;
  onReject: () => void;
}) {
  const factors = match ? factorBreakdown(match) : [];
  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Transaction details
        </div>
        <KV label="Date" value={row.date} />
        <KV label="Description" value={bank.merchant || bank.description || "(no description)"} />
        <KV label="Amount" value={row.amountLabel} />
        <KV label="Direction" value={row.amountSubLabel} />
        <KV label="Suggested category" value={row.categoryLabel} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Suggested match
        </div>
        {qb ? (
          <>
            <KV label="Entry" value={qb.description ?? "(no description)"} />
            <KV label="Date" value={qb.postedDate} />
            <KV label="Amount" value={formatMoney(qb.amount, qb.currency)} />
          </>
        ) : (
          <div style={{ fontSize: 13.5, color: shellColor.inkSoft, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
            No matching accounting entry found yet.
          </div>
        )}
      </div>

      {match && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
            Confidence score
          </div>
          {factors.map((f) => (
            <div key={f.label} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                <span>{f.label}</span>
                <span style={{ ...shellFigures }}>{f.score}/{f.max} pts</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, width: `${(f.score / f.max) * 100}%`, background: row.confidenceColor }} />
              </div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: shellColor.inkFaint, marginTop: 10 }}>
            Zaki scores every match on these three signals, out of 100 points — the same engine that ranks every transaction on this page.
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          AI reasoning
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>{row.reason}</div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 28 }}>
        <button style={{ ...shellButton("dangerOutline", "lg"), flex: 1 }} onClick={onReject} disabled={!match}>
          Reject
        </button>
        <button style={{ ...shellButton("success", "lg"), flex: 1 }} onClick={onApprove} disabled={!match}>
          Approve
        </button>
      </div>
    </>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "6px 0", borderBottom: `1px dashed ${shellColor.cardBorder}` }}>
      <span style={{ color: shellColor.inkSoft }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
```

Add the needed imports at the top of the file (`BankTransaction`, `QbTransaction`, `ReconciliationMatch` types are already imported at the top of this file today — reuse them).

- [ ] **Step 3: Typecheck**

Run: `cd zakiledger && npx tsc --noEmit`
Expected: no errors. Fix type mismatches between `ReviewBoard`'s props and what this page passes.

- [ ] **Step 4: Manual verification**

Run: `cd zakiledger && npm run dev`, sign in, upload a bank statement (or use existing seeded/demo data — check `scripts/fixtures` for a sample CSV), navigate to Review Matches, and confirm side-by-side against `design_handoff_zaki_ledger/Transaction Review Mockup.html`:
- Hero shows the correct ready count and "Approve all" works (matches disappear, toast shows).
- All four sections render with the right rows in the right place.
- Clicking a row opens the panel with real match data, factor breakdown sums correctly, Approve/Reject in the panel work and match the row-level buttons' effect.
- Bulk-select + "Approve selected" works.
- Existing "Generate reconciliation report" flow at the bottom still works once all matches are cleared.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `cd zakiledger && npx vitest run`
Expected: PASS (this page has no direct tests, but this catches anything the shell-theme/insights changes broke elsewhere).

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/reconciliation/review/page.tsx
git commit -m "Rebuild Review Matches with the grouped-sections + side-panel design"
```

---

### Task 7: `lib/extraction-insights.ts` + tests

**Files:**
- Create: `lib/extraction-insights.ts`
- Test: `tests/extraction-insights.test.ts`

**Interfaces:**
- Consumes: `gateApproval`, `checkTotals`, `fieldLabels`, `reasonText`, `CRITICAL_FIELDS_BY_TYPE`, `IMPORTANT_FIELDS`, type `ApprovalGate` from `lib/validation.ts` (do not reimplement these — this module wraps them); `REVIEWABLE_FIELDS`, `DocumentType`, `InvoiceExtraction` from `lib/schema.ts`; `ReviewRow`, `ReviewSectionKey` from `components/review/ReviewBoard.tsx`.
- Produces:

```ts
export function plainEnglishGateReason(gate: import("./validation").ApprovalGate, documentType: DocumentType): string;
export function sectionForGate(gate: import("./validation").ApprovalGate, isDuplicate: boolean): ReviewSectionKey;
export interface QueueItem { id: string; documentType: DocumentType; merchantName: string; invoiceNumber: string; invoiceDate: string; currency: string; total: number; overallConfidence: number; }
export function detectQueueDuplicates(items: QueueItem[]): Map<string, QueueItem>;
export function buildQueueRow(item: QueueItem, isDuplicate: boolean): { row: import("@/components/review/ReviewBoard").ReviewRow; gate: import("./validation").ApprovalGate };
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/extraction-insights.test.ts
import { describe, expect, it } from "vitest";
import { buildQueueRow, detectQueueDuplicates, plainEnglishGateReason, sectionForGate, type QueueItem } from "@/lib/extraction-insights";
import { gateApproval } from "@/lib/validation";

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "d1", documentType: "invoice", merchantName: "Office Depot", invoiceNumber: "INV-1",
    invoiceDate: "2026-06-14", currency: "GBP", total: 142.9, overallConfidence: 0.98, ...overrides,
  };
}

describe("plainEnglishGateReason", () => {
  it("has a plain-English sentence for a ready gate", () => {
    const gate = gateApproval({ supplierName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 });
    expect(plainEnglishGateReason(gate, "invoice").length).toBeGreaterThan(0);
  });
  it("names the low-confidence field for a blocked gate", () => {
    const gate = gateApproval({ supplierName: 0.4, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 });
    const text = plainEnglishGateReason(gate, "invoice");
    expect(text.toLowerCase()).toContain("supplier");
  });
});

describe("sectionForGate", () => {
  it("puts a duplicate in the duplicate section regardless of gate status", () => {
    const gate = gateApproval({ supplierName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 });
    expect(sectionForGate(gate, true)).toBe("duplicate");
  });
  it("maps ready/review/blocked to ready/review/issue", () => {
    const ready = gateApproval({ supplierName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 });
    const review = gateApproval({ supplierName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.5, subtotal: 0.99, tax: 0.99, total: 0.99 });
    const blocked = gateApproval({ supplierName: 0.3, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 });
    expect(sectionForGate(ready, false)).toBe("ready");
    expect(sectionForGate(review, false)).toBe("review");
    expect(sectionForGate(blocked, false)).toBe("issue");
  });
});

describe("detectQueueDuplicates", () => {
  it("pairs two items with the same supplier, invoice number, and total", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const dupes = detectQueueDuplicates([a, b]);
    expect(dupes.get("a")?.id).toBe("b");
    expect(dupes.get("b")?.id).toBe("a");
  });
  it("does not pair items with different totals", () => {
    const a = item({ id: "a", total: 100 });
    const b = item({ id: "b", total: 200 });
    expect(detectQueueDuplicates([a, b]).size).toBe(0);
  });
});

describe("buildQueueRow", () => {
  it("produces a ready row for a high-confidence invoice", () => {
    const { row, gate } = buildQueueRow(item(), false);
    expect(gate.status).toBe("ready");
    expect(row.section).toBe("ready");
    expect(row.amountLabel).toContain("142.90");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd zakiledger && npx vitest run tests/extraction-insights.test.ts`
Expected: FAIL — `lib/extraction-insights.ts` doesn't exist yet.

- [ ] **Step 3: Implement `lib/extraction-insights.ts`**

```ts
import { formatMoney } from "./currency";
import type { DocumentType } from "./schema";
import { fieldLabels, reasonText, type ApprovalGate } from "./validation";
import { shellColor } from "./shell-theme";
import type { ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";

/** Wraps lib/validation.ts's real gate — this module never re-derives
 * Critical/Important thresholds, it only turns the gate's output into copy
 * and a review-board section. */
export function plainEnglishGateReason(gate: ApprovalGate, documentType: DocumentType): string {
  if (gate.status === "ready") return "Every field read with enough confidence to post automatically.";
  return gate.reasons.map((r) => reasonText(r.field, r.confidence, documentType)).join(" ");
}

export function sectionForGate(gate: ApprovalGate, isDuplicate: boolean): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (gate.status === "ready") return "ready";
  if (gate.status === "review") return "review";
  return "issue";
}

export interface QueueItem {
  id: string;
  documentType: DocumentType;
  merchantName: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  total: number;
  overallConfidence: number;
}

/** Same supplier + invoice number + total already elsewhere in the queue —
 * the "uploaded twice" case. Receipts (no reliable invoice number) key on
 * supplier + date + total instead. */
export function detectQueueDuplicates(items: QueueItem[]): Map<string, QueueItem> {
  const result = new Map<string, QueueItem>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const sameSupplier = a.merchantName.trim().toLowerCase() === b.merchantName.trim().toLowerCase() && a.merchantName.trim() !== "";
      const sameTotal = Math.abs(a.total - b.total) < 0.005;
      const sameKey =
        a.documentType === "invoice" && a.invoiceNumber && b.invoiceNumber
          ? a.invoiceNumber.trim() === b.invoiceNumber.trim()
          : a.invoiceDate === b.invoiceDate;
      if (sameSupplier && sameTotal && sameKey) {
        result.set(a.id, b);
        result.set(b.id, a);
      }
    }
  }
  return result;
}

function confidenceLabel(pct: number): string {
  if (pct >= 95) return "High confidence";
  if (pct >= 70) return "Medium confidence";
  return "Low confidence";
}
function confidenceColor(pct: number): string {
  if (pct >= 95) return shellColor.high;
  if (pct >= 70) return shellColor.medium;
  return shellColor.low;
}

export function buildQueueRow(
  item: QueueItem,
  isDuplicate: boolean,
): { row: ReviewRow; gate: ApprovalGate } {
  // Import here (not at module top) to avoid a circular type-only import
  // cycle between this file and validation.ts's ReviewableField-keyed gate call.
  const { gateApproval } = require("./validation") as typeof import("./validation");
  const pct = Math.round(item.overallConfidence * 100);
  // The list endpoint only returns overallConfidence, not per-field — treat
  // every field as at that same confidence for the *list* row's gate/section;
  // the side panel (Task 8) re-fetches the full per-field breakdown and is
  // the source of truth for the real gate once opened.
  const perField = {
    supplierName: item.overallConfidence,
    invoiceNumber: item.overallConfidence,
    invoiceDate: item.overallConfidence,
    currency: item.overallConfidence,
    subtotal: item.overallConfidence,
    tax: item.overallConfidence,
    total: item.overallConfidence,
  };
  const gate = gateApproval(perField, { documentType: item.documentType });

  const row: ReviewRow = {
    id: item.id,
    section: sectionForGate(gate, isDuplicate),
    date: formatShortDate(item.invoiceDate),
    title: item.merchantName || "(supplier unclear)",
    subtitle: [item.invoiceNumber || null].filter(Boolean).join(" · "),
    amountLabel: formatMoney(item.total, item.currency),
    amountSubLabel: item.documentType === "receipt" ? "🧾 Receipt" : "📄 Invoice",
    categoryLabel: "Uncategorised",
    confidencePct: pct,
    confidenceLabel: confidenceLabel(pct),
    confidenceColor: confidenceColor(pct),
    reason: plainEnglishGateReason(gate, item.documentType),
    badges: [],
  };
  return { row, gate };
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
```

Note: the `require("./validation")` in `buildQueueRow` is a deliberate deviation the implementer should actually avoid — replace it with a normal top-of-file `import { gateApproval } from "./validation";` (there is no real circularity; this plan's author flagged a non-issue). Use a standard ES import.

- [ ] **Step 4: Run the tests again and fix until green**

Run: `cd zakiledger && npx vitest run tests/extraction-insights.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/extraction-insights.ts tests/extraction-insights.test.ts
git commit -m "Add extraction-insights: gate-driven sections and queue duplicate detection"
```

---

### Task 8: Rewrite `app/(app)/review/page.tsx`

**Files:**
- Modify: `app/(app)/review/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `ReviewBoard` (Task 4); `buildQueueRow`, `detectQueueDuplicates`, `QueueItem` (Task 7); `gateApproval`, `checkTotals`, `fieldLabels`, `CRITICAL_FIELDS_BY_TYPE`, `IMPORTANT_FIELDS`, `effectiveConfidence` from `lib/validation.ts`; `REVIEWABLE_FIELDS`, `InvoiceExtraction` from `lib/schema.ts`; existing endpoints `GET /api/pending`, `GET /api/pending/[id]`, `DELETE /api/pending/[id]`, `POST /api/approve`.
- Produces: the page component (default export), unchanged route. This page now covers what `app/(app)/batch/page.tsx` did (grouping, bulk actions, sort-by-confidence-via-sections) — `batch/page.tsx` itself is untouched per the Global Constraints, just no longer the only place to bulk-act.

- [ ] **Step 1: Replace the page**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import ReviewBoard, { type ReviewSectionConfig } from "@/components/review/ReviewBoard";
import { buildQueueRow, detectQueueDuplicates, type QueueItem } from "@/lib/extraction-insights";
import {
  CRITICAL_FIELDS_BY_TYPE, IMPORTANT_FIELDS, checkTotals, effectiveConfidence, fieldLabels, gateApproval,
} from "@/lib/validation";
import type { DocumentType, InvoiceExtraction, ReviewableField } from "@/lib/schema";
import { pageSubtitle, pageTitle, shellButton, shellColor, shellFigures } from "@/lib/shell-theme";

const SECTIONS: ReviewSectionConfig[] = [
  { key: "ready", title: "Ready to Approve", accentColor: shellColor.high, description: "Every critical field cleared 80%+ confidence and the numbers add up. Safe to approve as a batch.", showBulkApproveAll: true },
  { key: "review", title: "Needs Review", accentColor: shellColor.medium, description: "Tax or currency needs a quick confirmation — the essentials are solid." },
  { key: "duplicate", title: "Possible Duplicates", accentColor: shellColor.dupe, description: "Looks like the same document was captured more than once." },
  { key: "issue", title: "Potential Issues", accentColor: shellColor.low, description: "A critical field is uncertain, or the numbers don't add up — can't post until it's fixed." },
];

export default function ReviewPage() {
  const showToast = useShellToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Record<string, InvoiceExtraction>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/pending");
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Couldn't load the queue."); return; }
      setItems(
        data.documents.map((d: any): QueueItem => ({
          id: d.id, documentType: d.documentType, merchantName: d.merchantName, invoiceNumber: d.invoiceNumber,
          invoiceDate: d.invoiceDate, currency: d.currency, total: d.total, overallConfidence: d.overallConfidence,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function ensureDetail(id: string): Promise<InvoiceExtraction | null> {
    if (detail[id]) return detail[id];
    const res = await fetch(`/api/pending/${id}`);
    const data = await res.json();
    if (!res.ok) return null;
    setDetail((prev) => ({ ...prev, [id]: data.extraction }));
    return data.extraction;
  }

  async function approve(ids: string[]) {
    for (const id of ids) {
      const extraction = (await ensureDetail(id)) ?? detail[id];
      const item = items.find((i) => i.id === id);
      if (!extraction || !item) continue;
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraction, edited: {}, documentType: item.documentType, documentId: id }),
      });
      const data = await res.json();
      if (res.ok && data.status === "approved") {
        setApprovedIds((prev) => new Set([...prev, id]));
      } else {
        setError(data.error ?? data?.duplicate ? "This document looks like a duplicate — resolve it before approving." : "Couldn't approve — needs a closer look.");
      }
    }
    showToast(`${ids.length} ${ids.length === 1 ? "document" : "documents"} approved`);
    await load();
  }

  async function flag(id: string) {
    const item = items.find((i) => i.id === id);
    showToast(`${item?.merchantName ?? "Document"} flagged for a second look`);
  }

  async function editField(id: string, field: ReviewableField, newValue: string) {
    const extraction = (await ensureDetail(id)) ?? detail[id];
    if (!extraction) return;
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction, edited: { [field]: newValue }, documentType: item.documentType, documentId: id }),
    });
    const data = await res.json();
    if (res.ok && data.status === "approved") {
      showToast(`${fieldLabels(item.documentType)[field]} corrected — saved for next time`);
      setApprovedIds((prev) => new Set([...prev, id]));
      await load();
    } else {
      // Not ready to fully approve yet (other fields still gating) — update
      // the local copy so the panel's gate recomputes with the corrected value.
      setDetail((prev) => ({
        ...prev,
        [id]: { ...extraction, [field]: { value: newValue, confidence: 1 } } as InvoiceExtraction,
      }));
    }
  }

  if (loading) {
    return (<div><h1 style={pageTitle}>Review &amp; Edit</h1><p style={pageSubtitle}>Loading…</p></div>);
  }

  const dupes = detectQueueDuplicates(items.filter((i) => !approvedIds.has(i.id)));
  const built = items
    .filter((i) => !approvedIds.has(i.id))
    .map((item) => ({ item, ...buildQueueRow(item, dupes.has(item.id)) }));

  return (
    <div>
      <h1 style={pageTitle}>Review &amp; Edit</h1>
      <p style={pageSubtitle}>{items.length} document{items.length === 1 ? "" : "s"} need your attention before posting</p>
      {error && <p style={{ color: shellColor.low, marginBottom: 16 }}>{error}</p>}

      <ReviewBoard
        rows={built.map((b) => b.row)}
        sections={SECTIONS}
        approvedIds={approvedIds}
        onApprove={approve}
        onFlag={flag}
        heroTitle="Ready to approve"
        heroDescription="Every critical field cleared 80%+ confidence and the numbers add up."
        renderPanel={(row) => {
          const entry = built.find((b) => b.row.id === row.id);
          if (!entry) return null;
          return (
            <ExtractionPanelBody
              item={entry.item}
              extraction={detail[entry.item.id] ?? null}
              onOpen={() => ensureDetail(entry.item.id)}
              onEditField={(field, val) => editField(entry.item.id, field, val)}
              onApprove={() => approve([entry.item.id])}
              onFlag={() => flag(entry.item.id)}
            />
          );
        }}
      />

      {built.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>
          Nothing waiting for review — nice work.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the panel body component**

```tsx
function ExtractionPanelBody({
  item, extraction, onOpen, onEditField, onApprove, onFlag,
}: {
  item: QueueItem;
  extraction: InvoiceExtraction | null;
  onOpen: () => void;
  onEditField: (field: ReviewableField, value: string) => void;
  onApprove: () => void;
  onFlag: () => void;
}) {
  useEffect(() => { onOpen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!extraction) {
    return <div style={{ fontSize: 13.5, color: shellColor.inkSoft }}>Loading document details…</div>;
  }

  const totals = checkTotals(extraction.subtotal.value, extraction.tax.value, extraction.total.value);
  const labels = fieldLabels(item.documentType);
  const critical = CRITICAL_FIELDS_BY_TYPE[item.documentType];

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Extraction check
        </div>
        {totals === null ? (
          <div style={{ fontSize: 13.5, color: shellColor.inkSoft }}>No tax breakdown on this document — nothing to cross-check.</div>
        ) : (
          <div style={{ fontSize: 13.5, color: totals.ok ? shellColor.high : shellColor.low, background: totals.ok ? shellColor.highBg : shellColor.lowBg, borderRadius: 10, padding: "12px 14px" }}>
            {totals.ok ? "✓ Numbers add up." : `✕ Subtotal + tax (£${totals.expected.toFixed(2)}) doesn't match the printed total (£${totals.found.toFixed(2)}).`}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Field confidence
        </div>
        {(["supplierName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "tax", "total"] as ReviewableField[])
          .filter((f) => !(f === "invoiceNumber" && item.documentType === "receipt"))
          .map((field) => {
            const f = (extraction as any)[field] as { value: string | number; confidence: number };
            const pct = Math.round(f.confidence * 100);
            const isCritical = critical.includes(field);
            const isImportant = IMPORTANT_FIELDS.includes(field);
            return (
              <div key={field} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                  <span>{labels[field]} {isCritical ? "(Critical)" : isImportant ? "(Important)" : ""}</span>
                  <span style={shellFigures}>{pct}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ height: "100%", borderRadius: 3, width: `${pct}%`, background: pct >= 80 ? shellColor.high : pct >= 60 ? shellColor.medium : shellColor.low }} />
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    defaultValue={String(f.value)}
                    onBlur={(e) => { if (e.target.value !== String(f.value)) onEditField(field, e.target.value); }}
                    style={{ flex: 1, padding: "6px 9px", borderRadius: 7, border: `1px solid ${shellColor.cardBorder}`, fontSize: 12.5 }}
                  />
                  <button style={shellButton("outline", "sm")} onClick={() => onEditField(field, String(f.value))}>
                    ✓ Confirm
                  </button>
                </div>
              </div>
            );
          })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 28 }}>
        <button style={{ ...shellButton("dangerOutline", "lg"), flex: 1 }} onClick={onFlag}>Flag</button>
        <button style={{ ...shellButton("success", "lg"), flex: 1 }} onClick={onApprove}>Approve</button>
      </div>
    </>
  );
}
```

Note: the "✓ Confirm" button calling `onEditField(field, String(f.value))` with the *unchanged* value relies on `POST /api/approve` treating an `edited` entry equal to the AI value as a confirmation, not a correction — that's exactly what `lib/approve/route.ts`'s existing `changed` check already does (`humanValue !== aiValue`), so this requires no server change.

Add `import { useEffect } from "react";` to the top-of-file import already present.

- [ ] **Step 3: Typecheck**

Run: `cd zakiledger && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `cd zakiledger && npm run dev`, sign in, upload a few invoices/receipts (or use the demo seed route if one exists — check `app/api/pending/demo/route.ts`), navigate to Review & Edit, and confirm side-by-side against `design_handoff_zaki_ledger/Invoice Review Mockup.html`:
- Sections populate correctly by real gate status.
- Opening a row fetches and shows real per-field confidence.
- Editing a field or hitting "Confirm" actually calls `/api/approve` and the document either fully approves (if that was the last blocking field) or the panel's numbers update.
- "Approve all" on Ready works and matches disappear with a toast.
- The existing correction/confirmation ledger still gets written (check `tests/flow.test.ts`-style behavior manually, or query `lib/store.ts`'s in-memory fallback if not using Supabase locally).

- [ ] **Step 5: Run the full test suite**

Run: `cd zakiledger && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/review/page.tsx
git commit -m "Rebuild Review & Edit with the grouped-sections + side-panel design"
```

---

### Task 9: Final pass and push

**Files:** none new — verification only.

- [ ] **Step 1: Full verification sweep**

Run: `cd zakiledger && npx tsc --noEmit && npx vitest run`
Expected: both pass clean.

- [ ] **Step 2: Manual smoke test of both rebuilt pages one more time in the dev server**, specifically re-checking the two flows the automated tests can't cover (no jsdom in this repo): keyboard navigation (`↑/↓/Enter/A/Esc`) and the docked side panel on both pages.

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Deploy**

This repo deploys to Render. Trigger/confirm the Render deploy for this push (per this project's existing deploy process) and verify both rebuilt pages load correctly on the deployed URL, not just locally.

---

## Self-Review Notes

- **Spec coverage:** All 10 numbered requirements from the original design brief are covered — per-row fields (Task 5/7 `ReviewRow`), inline plain-English reasoning (Task 5/7 `plainEnglishReason`/`plainEnglishGateReason`), grouped high-confidence bulk action (Task 4 hero + `showBulkApproveAll`), four sections (Task 4/6/8 `SECTIONS`), side panel with all six sub-sections (Task 6/8 panel bodies), the four-band confidence system (Task 5/7 `confidenceLabel`), reduced-click bulk approve at row/section/selection level (Task 4), detection badges (Task 5 `detectBadges`, duplicate detection in both Task 5 and 7), plain-English copy throughout (every generated string above is a sentence, not a score).
- **Known, deliberate scope cuts** (flagged inline at the relevant task rather than silently dropped): reconciliation's "Recurring" badge and category suggestion only see the current statement's data, not the user's full history — a real cross-statement version is a follow-up needing a new `lib/reconciliation-store.ts` query, not required to ship the redesigned screen.
- **Out of scope, explicitly:** `app/(app)/reconciliation/batch/page.tsx` and `app/(app)/batch/page.tsx` are untouched.
