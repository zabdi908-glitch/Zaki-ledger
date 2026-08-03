# Group 0: Performance & Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reconciliation review flow feel instant — optimistic approvals, capped section rendering, and web-vitals visibility.

**Architecture:** The app is Next.js 15 (App Router) + React 19 in `zakiledger/`. Route-level code splitting, gzip compression, and `next/link` prefetching are already provided by Next.js — do NOT add a service worker, Redis, or react-window. The real wins here are: (1) the review page refetches the entire statement after every approve/reject (`await load()`), which makes approvals feel slow; (2) only the "ready" section caps rendered rows (`READY_VISIBLE_CAP`) — other sections render every row; (3) zero performance visibility.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, inline styles via `zakiledger/lib/shell-theme.ts`.

## Global Constraints

- All work happens inside `zakiledger/` (the deployed app). Never touch the untracked `frontend/`/`backend/` scaffold.
- Run all commands from `zakiledger/` (`npm run check` = typecheck + vitest).
- No new runtime dependencies.
- Commit directly to `main` (solo repo).
- Match existing code style: inline style objects from `shell-theme.ts`, JSDoc comments explaining *why*, not *what*.

---

### Task 1: Optimistic approval state (pure function + tests)

**Files:**
- Create: `zakiledger/lib/review-optimistic.ts`
- Test: `zakiledger/tests/review-optimistic.test.ts`

**Interfaces:**
- Consumes: `ReviewData`-shaped object `{ bankTransactions, qbTransactions, matches, unmatchedBank, unmatchedQb }` using types from `zakiledger/lib/reconciliation-schema.ts`.
- Produces: `applyApprovals(data, matchIds: string[], approvedAt: string): ReviewData` and `applyRejection(data, matchId: string): ReviewData` — pure, non-mutating. Task 2 imports both.

- [ ] **Step 1: Write the failing tests**

```typescript
// zakiledger/tests/review-optimistic.test.ts
import { describe, expect, it } from "vitest";
import { applyApprovals, applyRejection } from "../lib/review-optimistic";
import type { ReconciliationMatch } from "../lib/reconciliation-schema";

function match(id: string, bankId: string): ReconciliationMatch {
  return {
    id, statementId: "s1", bankTransactionId: bankId, qbTransactionId: `qb-${id}`,
    confidence: 0.98, matchReason: "amount + date + merchant", flaggedLevel: "green",
    matchedBy: "auto", matchedAt: "2026-08-01T00:00:00Z", approvedBy: null, approvedAt: null,
  };
}

const data = {
  bankTransactions: [], qbTransactions: [],
  matches: [match("m1", "b1"), match("m2", "b2")],
  unmatchedBank: [], unmatchedQb: [],
};

describe("applyApprovals", () => {
  it("stamps approvedAt on the listed matches only", () => {
    const next = applyApprovals(data, ["m1"], "2026-08-01T12:00:00Z");
    expect(next.matches.find((m) => m.id === "m1")?.approvedAt).toBe("2026-08-01T12:00:00Z");
    expect(next.matches.find((m) => m.id === "m2")?.approvedAt).toBeNull();
  });
  it("does not mutate the input", () => {
    applyApprovals(data, ["m1"], "2026-08-01T12:00:00Z");
    expect(data.matches[0].approvedAt).toBeNull();
  });
});

describe("applyRejection", () => {
  it("removes the match and moves its bank transaction to unmatchedBank", () => {
    const next = applyRejection(data, "m1");
    expect(next.matches.map((m) => m.id)).toEqual(["m2"]);
    expect(next.unmatchedBank).toContain("b1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- review-optimistic` (from `zakiledger/`)
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// zakiledger/lib/review-optimistic.ts
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "./reconciliation-schema";

/**
 * Client-side mirrors of what the approve/reject endpoints do to the data,
 * so the review page can update instantly and only reconcile with the server
 * response in the background. Kept pure so a failed request can roll back by
 * restoring the previous object.
 */
export interface ReviewData {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  unmatchedBank: string[];
  unmatchedQb: string[];
}

export function applyApprovals(data: ReviewData, matchIds: string[], approvedAt: string): ReviewData {
  const ids = new Set(matchIds);
  return {
    ...data,
    matches: data.matches.map((m) => (ids.has(m.id) ? { ...m, approvedAt } : m)),
  };
}

export function applyRejection(data: ReviewData, matchId: string): ReviewData {
  const rejected = data.matches.find((m) => m.id === matchId);
  return {
    ...data,
    matches: data.matches.filter((m) => m.id !== matchId),
    unmatchedBank: rejected ? [...data.unmatchedBank, rejected.bankTransactionId] : data.unmatchedBank,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- review-optimistic`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add zakiledger/lib/review-optimistic.ts zakiledger/tests/review-optimistic.test.ts
git commit -m "feat: pure optimistic-update helpers for the review page"
```

---

### Task 2: Wire optimistic updates into the review page

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (the `boardApprove` ~line 215 and `rejectOne` ~line 200 functions, and the local `ReviewData` type at the top)

**Interfaces:**
- Consumes: `applyApprovals`, `applyRejection`, and the `ReviewData` type from Task 1 (delete the page's local duplicate `ReviewData` type and import it instead).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Replace refetch-after-write with optimistic update + rollback**

In `boardApprove`, after the `matchIds.length === 0` guard, replace the current "POST then `await load()`" pattern:

```typescript
const snapshot = review;
setReview((prev) => (prev ? applyApprovals(prev, matchIds, new Date().toISOString()) : prev));
showToast(`${matchIds.length} ${matchIds.length === 1 ? "match" : "matches"} approved`);
const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ matchesToApprove: matchIds }),
});
if (!res.ok) {
  const data = await res.json();
  setReview(snapshot); // roll back — the server refused
  setError(data.error ?? "Approve failed.");
}
```

Apply the same pattern to `rejectOne` with `applyRejection(prev, matchId)`. Remove the `await load()` calls from both. Keep `load` itself — the initial fetch still uses it.

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npm run check`
Expected: PASS. The board memo (`useMemo` on `review`) recomputes from the optimistic state, so approved rows disappear instantly.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, upload `zakiledger/tests/fixtures`-style CSV (or use the demo flow), approve a row — the row must vanish with no loading flash. Kill the network (DevTools offline) and approve — the row must come back and an error must show.

- [ ] **Step 4: Commit**

```bash
git add "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "perf: optimistic approve/reject on review page - no full refetch"
```

---

### Task 3: Cap rendered rows in every section (generalize READY_VISIBLE_CAP)

**Files:**
- Modify: `zakiledger/components/review/ReviewBoard.tsx` (state `showAllReady` ~line 121, `orderedVisibleIds` ~line 148, `SectionBlock` usage ~line 307)

**Interfaces:**
- Consumes: existing `ReviewSectionKey`, `READY_VISIBLE_CAP` constant already in the file.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Replace the ready-only boolean with a per-section set**

Replace `const [showAllReady, setShowAllReady] = useState(false);` with:

```typescript
const [expandedSections, setExpandedSections] = useState<Set<ReviewSectionKey>>(new Set());
```

In `orderedVisibleIds`, replace the ready-only slice with a uniform cap:

```typescript
const visible = expandedSections.has(sec.key) ? secRows : secRows.slice(0, READY_VISIBLE_CAP);
```

Thread `expandedSections`/`setExpandedSections` into `SectionBlock` in place of `showAllReady`/`setShowAllReady`, and update `SectionBlock`'s "show all" button (find where it reads `showAllReady`) to render for ANY section with more than `READY_VISIBLE_CAP` rows: label `Show all {rows.length}`, onClick adds `sec.key` to the set.

- [ ] **Step 2: Typecheck and test**

Run: `npm run check`
Expected: PASS. Nothing else imports `showAllReady` (it is local state), so no other call sites change.

- [ ] **Step 3: Commit**

```bash
git add zakiledger/components/review/ReviewBoard.tsx
git commit -m "perf: cap rendered rows per section with show-all expander"
```

---

### Task 4: Web-vitals reporting

**Files:**
- Create: `zakiledger/components/WebVitals.tsx`
- Create: `zakiledger/app/api/vitals/route.ts`
- Modify: `zakiledger/app/layout.tsx` (render `<WebVitals />` inside the body)

**Interfaces:**
- Consumes: `useReportWebVitals` from `next/web-vitals` (ships with Next 15, no new dependency).
- Produces: `POST /api/vitals` accepting `{ name, value, rating, path }`.

- [ ] **Step 1: Write the client reporter**

```tsx
// zakiledger/components/WebVitals.tsx
"use client";

import { useReportWebVitals } from "next/web-vitals";

/** Fire-and-forget vitals beacon. sendBeacon survives page navigation, which
 * is exactly when LCP/CLS values are finalized. */
export default function WebVitals() {
  useReportWebVitals((metric) => {
    const body = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      path: window.location.pathname,
    });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/vitals", body);
    else fetch("/api/vitals", { method: "POST", body, keepalive: true });
  });
  return null;
}
```

- [ ] **Step 2: Write the collector route**

```typescript
// zakiledger/app/api/vitals/route.ts
import { NextResponse } from "next/server";

/** Log-only for now: Render's log stream is the dashboard. A metric worse
 * than "good" is logged at warn so it stands out when scanning. */
export async function POST(req: Request) {
  try {
    const m = await req.json();
    const line = `[vitals] ${m.path} ${m.name}=${Math.round(m.value)} (${m.rating})`;
    if (m.rating === "good") console.log(line);
    else console.warn(line);
  } catch {
    /* malformed beacon — nothing to do */
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Mount it in the root layout**

In `zakiledger/app/layout.tsx`, import `WebVitals` and render `<WebVitals />` as the first child inside `<body>`.

- [ ] **Step 4: Verify**

Run: `npm run check`, then `npm run dev`, load any page, navigate away — server console must show `[vitals] ...` lines.

- [ ] **Step 5: Record the bundle baseline and commit**

Run: `npm run build` and note the "First Load JS" figures in the output (paste them into the commit body — this is the budget baseline for future regressions).

```bash
git add zakiledger/components/WebVitals.tsx zakiledger/app/api/vitals/route.ts zakiledger/app/layout.tsx
git commit -m "feat: web-vitals beacon and log-based collector"
```

---

## Explicitly out of scope (and why)

- **Service worker / offline mode** — Next.js App Router + Render free tier; a SW adds cache-invalidation bug surface for a pilot-stage product. Revisit post-pilot.
- **Redis caching** — no Redis on the Render free plan; the in-memory/Supabase store is the cache.
- **react-window virtualization** — Task 3's per-section cap achieves the same perceived result with zero dependencies.
- **Bundle-size CI budget** — record the baseline in Task 4 Step 5; wire CI enforcement only if a regression actually appears.

## Self-review notes

- Task 2 depends on Task 1's exports; Tasks 3 and 4 are independent of both and of each other.
- `applyRejection` mirrors `rejectMatch` server behavior (match removed, bank txn returns to unmatched pool) — if the server implementation differs (e.g. keeps a rejected row), verify against `lib/reconciliation-store.ts` `rejectMatch` before shipping and adjust the helper to match.
