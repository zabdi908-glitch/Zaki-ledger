# Group D: Smart Dashboard & Workflow Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vague "N need review ⚠" with a per-section breakdown + progress + time estimate on the upload screen, and give the review screen a live session summary with undo.

**Architecture:** The breakdown reuses `buildReviewRows` (`lib/reconciliation-insights.ts`) — the same section assignment the review board shows, so numbers always agree between screens. A pure `summarizeSections` helper feeds both. Undo is a real store operation (`unapproveMatches` clearing `approved_at`), not a UI trick. Clicking a breakdown line deep-links to `/reconciliation/review?statementId=…&section=…`; ReviewBoard collapses the other sections on arrival.

**Tech Stack:** Next.js 15, React 19, TypeScript, Supabase, Vitest.

**Dependency note:** Standalone. If Group B's decision log exists, the rejected count comes from it; otherwise rejected actions are counted client-side for the session only (both paths specified below).

## Global Constraints

- All work happens inside `zakiledger/`. `npm run check` before every commit.
- No new runtime dependencies.
- Time estimate formula (fixed, so tests are deterministic): `ready * 5 + other_open * 25` seconds, presented rounded up to whole minutes ("Est. ~4 min to review & approve"; under 1 minute → "under a minute").
- Copy: encouraging, specific, never "Potential Issues: 30" as a headline.

---

### Task 1: Section summary helper (pure)

**Files:**
- Create: `zakiledger/lib/review-summary.ts`
- Test: `zakiledger/tests/review-summary.test.ts`

**Interfaces:**
- Consumes: the output of `buildReviewRows` (array of `{ id, row: ReviewRow, matchId }`), `ReviewSectionKey` from `components/review/ReviewBoard`.
- Produces (Tasks 2–3 consume):
  - `summarizeSections(rows: { row: { section: ReviewSectionKey } }[]): { counts: Map<ReviewSectionKey, number>; total: number; ready: number; readyPct: number }`
  - `estimateReviewSeconds(summary: { ready: number; total: number }): number` (formula above)
  - `formatEstimate(seconds: number): string`

- [x] **Step 1: Failing tests**

```typescript
// zakiledger/tests/review-summary.test.ts
import { describe, expect, it } from "vitest";
import { estimateReviewSeconds, formatEstimate, summarizeSections } from "../lib/review-summary";

const row = (section: string) => ({ row: { section } }) as never;

describe("summarizeSections", () => {
  it("counts per section and computes ready percentage", () => {
    const s = summarizeSections([row("ready"), row("ready"), row("issue"), row("duplicate")]);
    expect(s.counts.get("ready")).toBe(2);
    expect(s.counts.get("duplicate")).toBe(1);
    expect(s.total).toBe(4);
    expect(s.readyPct).toBe(50);
  });
  it("empty input gives zero percent, not NaN", () => {
    expect(summarizeSections([]).readyPct).toBe(0);
  });
});

describe("estimate", () => {
  it("5s per ready item, 25s per other open item", () => {
    expect(estimateReviewSeconds({ ready: 10, total: 14 })).toBe(10 * 5 + 4 * 25);
  });
  it("formats to whole minutes, rounding up", () => {
    expect(formatEstimate(150)).toBe("Est. ~3 min to review & approve");
    expect(formatEstimate(40)).toBe("Est. under a minute to review & approve");
  });
});
```

- [x] **Step 2: Run → FAIL**, then implement:

```typescript
// zakiledger/lib/review-summary.ts
import type { ReviewSectionKey } from "@/components/review/ReviewBoard";

/** One source of truth for "how much work is left" — both the upload screen's
 * breakdown and the review screen's summary read from here, so the numbers an
 * accountant sees never disagree between screens. */
export function summarizeSections(rows: { row: { section: ReviewSectionKey } }[]) {
  const counts = new Map<ReviewSectionKey, number>();
  for (const r of rows) counts.set(r.row.section, (counts.get(r.row.section) ?? 0) + 1);
  const total = rows.length;
  const ready = counts.get("ready") ?? 0;
  return { counts, total, ready, readyPct: total === 0 ? 0 : Math.round((ready / total) * 100) };
}

export function estimateReviewSeconds(s: { ready: number; total: number }): number {
  return s.ready * 5 + (s.total - s.ready) * 25;
}

export function formatEstimate(seconds: number): string {
  if (seconds < 60) return "Est. under a minute to review & approve";
  return `Est. ~${Math.ceil(seconds / 60)} min to review & approve`;
}
```

- [x] **Step 3: Run tests** → PASS; `npm run check` → PASS.

- [x] **Step 4: Commit**

```bash
git add zakiledger/lib/review-summary.ts zakiledger/tests/review-summary.test.ts
git commit -m "feat: pure section-summary and review-time-estimate helpers"
```

---

### Task 2: Smart breakdown on the upload screen

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/page.tsx` (the `stage === "matched"` card, ~line 195)

**Interfaces:**
- Consumes: `buildReviewRows` from `lib/reconciliation-insights.ts`, Task 1 helpers, the `SECTIONS` config copy (import the section titles/colors — export `SECTIONS` from the review page is not possible across route files, so move the `SECTIONS` array into `zakiledger/lib/review-sections.ts` and import it from both pages).
- Produces: `zakiledger/lib/review-sections.ts` exporting `SECTIONS: ReviewSectionConfig[]` (moved verbatim from `review/page.tsx`, which now imports it). Task 3 also imports it.

- [x] **Step 1: Extract `SECTIONS` to `lib/review-sections.ts`**

Move the array + its imports (`shellColor`, `ReviewSectionConfig` type) into the new file; update `review/page.tsx` to import it. `npm run check` → PASS before continuing.

- [x] **Step 2: Build the breakdown in `refreshMatchCounts`**

The upload page already fetches the full transactions payload in `refreshMatchCounts`. Extend it: run the same open-rows filtering the review page's `board` memo does (copy those ~10 lines: unapproved matches + unmatchedBank → `buildReviewRows`), then `summarizeSections`. Store `summary` and `counts` in new state.

- [x] **Step 3: Replace the matched-card contents**

```tsx
<div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
  {transactionCount} transactions imported
</div>
<div style={{ ...progressTrack(), marginBottom: 6 }}>
  <div style={progressFill(summary.readyPct)} />
</div>
<div style={{ fontSize: 13, color: shellColor.inkSoft, marginBottom: 16 }}>
  {summary.readyPct}% ready to approve · {formatEstimate(estimateReviewSeconds(summary))}
</div>
{SECTIONS.filter((s) => (summary.counts.get(s.key) ?? 0) > 0).map((s) => (
  <button
    key={s.key}
    onClick={() => router.push(`/reconciliation/review?statementId=${statementId}&section=${s.key}`)}
    style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "10px 12px",
             background: "transparent", border: "none", borderLeft: `3px solid ${s.accentColor}`,
             marginBottom: 6, cursor: "pointer", fontSize: 14, textAlign: "left" }}
  >
    <span>{s.title}</span>
    <b style={shellFigures}>{summary.counts.get(s.key)}</b>
  </button>
))}
<button style={{ ...shellButton("primary", "lg"), marginTop: 14 }}
        onClick={() => router.push(`/reconciliation/review?statementId=${statementId}`)}>
  Review matches
</button>
```

Keep the existing accounting-transactions card below untouched. Approved-count line (`matchedCount`) can stay above the progress bar as "{matchedCount} already approved" when > 0.

- [x] **Step 4: Verify** → `npm run check`; `npm run dev`: upload statement + accounting CSV → breakdown lists only non-empty sections, clicking one navigates with `&section=`.

- [x] **Step 5: Commit**

```bash
git add zakiledger/lib/review-sections.ts "zakiledger/app/(app)/reconciliation/page.tsx" "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: smart section breakdown with progress and time estimate on upload screen"
```

---

### Task 3: Deep-link focus on the review screen

**Files:**
- Modify: `zakiledger/components/review/ReviewBoard.tsx` (add `initialFocusSection?: ReviewSectionKey` prop)
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (read `?section=` and pass it)

**Interfaces:**
- Consumes: `collapsed` state already in ReviewBoard (~line 119).
- Produces: nothing further.

- [x] **Step 1: Implement the prop**

In ReviewBoard, initialise collapsed state from the prop:

```typescript
const [collapsed, setCollapsed] = useState<Set<ReviewSectionKey>>(() =>
  initialFocusSection
    ? new Set(sections.map((s) => s.key).filter((k) => k !== initialFocusSection))
    : new Set(),
);
```

(Replace the existing `useState(new Set())` initialiser; everything else unchanged — the user can still expand the rest.)

In the review page: `const focusSection = useSearchParams().get("section") as ReviewSectionKey | null;` (same `useSearchParams` call already imported) and pass `initialFocusSection={focusSection ?? undefined}` to `<ReviewBoard>`.

- [x] **Step 2: Verify** → `npm run check`; `npm run dev`: arriving via a breakdown click shows only that section expanded.

- [x] **Step 3: Commit**

```bash
git add zakiledger/components/review/ReviewBoard.tsx "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: section deep-link focus from dashboard breakdown"
```

---

### Task 4: Undo approvals (store + route)

**Files:**
- Modify: `zakiledger/lib/reconciliation-store.ts` (new `unapproveMatches`, placed next to `approveMatches` ~line 646)
- Create: `zakiledger/app/api/reconciliation/[id]/unapprove/route.ts`
- Test: extend `zakiledger/tests/reconciliation-store.test.ts`

**Interfaces:**
- Consumes: existing store internals — read `approveMatches` first and mirror its structure (memory branch + Supabase branch + audit-log entry).
- Produces: `unapproveMatches(userId: string, statementId: string, matchIds: string[]): Promise<number>` (returns how many were reverted); `POST /api/reconciliation/[id]/unapprove` body `{ matchIds: string[] }` → `{ reverted: number }`. Task 5 consumes the route.

- [x] **Step 1: Failing test**

Add to `tests/reconciliation-store.test.ts`, following its existing setup helpers for creating a statement + matches + approving them:

```typescript
it("unapproveMatches clears approval and returns the count", async () => {
  // ...use the file's existing helpers to create + approve a match, then:
  const reverted = await unapproveMatches(userId, statementId, [matchId]);
  expect(reverted).toBe(1);
  const matches = await listMatchesForStatement(userId, statementId);
  expect(matches.find((m) => m.id === matchId)?.approvedAt).toBeNull();
  expect(matches.find((m) => m.id === matchId)?.approvedBy).toBeNull();
});
```

- [x] **Step 2: Run → FAIL, then implement**

Memory branch: find the user's matches by id within the statement, set `approvedAt = null; approvedBy = null`, append an audit entry `{ action: "unapprove", … }` mirroring how `approveMatches` writes its audit rows. Supabase branch: `update reconciliation_matches set approved_at = null, approved_by = null where …` scoped by `user_id`, `statement_id`, and `id in (…)`, plus the same audit insert `approveMatches` performs. Return the count updated. **The spec's "undo must revert DB state, not just UI" is this task.**

- [x] **Step 3: Create the route** mirroring `[id]/approve/route.ts` (auth, Zod body `{ matchIds: z.array(z.string()).min(1) }`, call store, return `{ reverted }`).

- [x] **Step 4: Run** `npm run check` → PASS. **Commit**

```bash
git add zakiledger/lib/reconciliation-store.ts "zakiledger/app/api/reconciliation/[id]/unapprove/route.ts" zakiledger/tests/reconciliation-store.test.ts
git commit -m "feat: unapprove store operation and endpoint - real DB undo"
```

---

### Task 5: Session summary panel with undo + CSV export

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Interfaces:**
- Consumes: `POST .../unapprove` (Task 4), `summarizeSections` (Task 1), the page's existing `boardApprove`/`rejectOne`.
- Produces: nothing further.

- [x] **Step 1: Track session actions**

Add state:

```typescript
type SessionAction = { at: string; kind: "approve" | "reject"; matchIds: string[]; label: string };
const [sessionActions, setSessionActions] = useState<SessionAction[]>([]);
```

Push one entry in `boardApprove` after a successful POST (`label: \`Approved ${matchIds.length} match(es)\``) and in `rejectOne` (`label` naming the row's merchant). Keep the full list; only the last 5 approve-actions are undoable.

- [x] **Step 2: Render the summary card**

Above `<ReviewBoard>` (below the progress bar), a `shellCard` with a 4-column grid (reuse the `ReportStat` component already in this file):

- **Approved** — `approvedThisSession` = sum of approve-action matchIds
- **Rejected** — count of reject actions
- **Still open** — `openBanks.length`
- **Ready to approve** — `summarizeSections(rows-by-section input).ready` (build from `board.rows` mapped to `{ row }`)

Below the grid, the last 5 actions as timestamped lines (`new Date(a.at).toLocaleTimeString("en-GB")` + label), each approve-action with an **Undo** button: POST `/api/reconciliation/${statementId}/unapprove` with its `matchIds`; on success remove the action from state and `await load()` (a full refetch is correct here — undo is rare and must reflect server truth), `showToast("Approval undone")`.

- [x] **Step 3: CSV export**

"Export session (CSV)" button (`shellButton("outline", "sm")` in the card header):

```typescript
function exportSessionCsv() {
  const rows = [["time", "action", "detail"], ...sessionActions.map((a) => [a.at, a.kind, a.label])];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `reconciliation-session-${statementId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
```

- [x] **Step 4: Ready-to-post gate**

The existing "Generate reconciliation report" button already only renders when `openBanks.length === 0` — that is the spec's "post button conditional logic". Add above it, when open count is 0: a `pill(shellColor.high, shellColor.highBg)` reading "Ready to post — all transactions reviewed".

- [x] **Step 5: Verify** → `npm run check`; `npm run dev`: approve a few, counts tick up live, Undo restores the row into the board, CSV downloads with the actions.

- [x] **Step 6: Commit**

```bash
git add "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: session summary with undo and CSV export on review screen"
```

---

## Self-review notes

- Task order: 1 → 2 → 3 (breakdown chain), 4 → 5 (undo chain). The two chains are independent of each other.
- Numbers agree across screens by construction: both call `buildReviewRows` + `summarizeSections`.
- Rejected count is session-local here; when Group B's `listDecisionsForStatement` exists, swap the "Rejected" stat to read from it (one-line change, noted for the implementer — do it only if Group B is already merged).
- Undo of *rejections* is out of scope: `rejectMatch` feeds an immutable audit trail (see its docstring) and reinstating a rejected match is a product decision, not a plumbing one.

## Implementation status (2026-08-02)

All 5 tasks shipped, TDD throughout, `npm run check` green after every
commit (278 tests). Matches the plan as written, no deviations. Task 4's
`unapproveMatches` clears `approved_at`/`approved_by` and writes a new
`match_unapproved` audit-log entry rather than touching the original
`match_approved` one — consistent with the existing "audit log is append
only" rule (that rule governs the log, not whether a match's live status
can transition). No schema migration needed: the audit log's `action`
column is free text, no enum constraint.
