# Group A: Critical Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock Francisco's pilot: the accounting connection (Xero/QuickBooks/CSV) is visible through the whole reconciliation flow, approving with no accounting data gives clear guidance instead of a dead end, and the detail panel stays on screen while scrolling.

**Architecture:** Reality check against the spec — this app has no per-import "QB/Xero selector"; the connection is a per-user OAuth link surfaced by `/api/auth/xero/status` and `/api/auth/quickbooks/status`, with CSV import as fallback. "Selector persistence" therefore becomes a persistent **connection chip** across the flow. The spec's approve/reject/bulk buttons already work (commit 2bcf873 "Fix dead approve buttons"); what's missing is the guard when zero accounting entries exist. The spec's "two-column scroll context" is mostly built (ReviewBoard's side panel + mobile full-screen CSS at <980px); what's missing is desktop stickiness.

**Tech Stack:** Next.js 15, React 19, TypeScript, Vitest, `shell-theme.ts` inline styles.

## Global Constraints

- All work happens inside `zakiledger/`. Never touch the untracked `frontend/`/`backend/` scaffold.
- Run all commands from `zakiledger/`; `npm run check` must pass before every commit.
- No new runtime dependencies.
- Commit directly to `main` (solo repo).
- All user-facing copy is accountant-friendly British English (matches existing copy: "Uncategorised", "£").

---

### Task 1: Connection chip visible across the reconciliation flow

**Files:**
- Create: `zakiledger/components/ConnectionChip.tsx`
- Modify: `zakiledger/app/(app)/reconciliation/page.tsx` (render chip under the `<h1>`; replace its inline provider-status `useEffect` with the shared hook)
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx` (render chip under the `<h1>`)

**Interfaces:**
- Consumes: `GET /api/auth/xero/status` and `GET /api/auth/quickbooks/status`, both returning `{ connected: boolean }`.
- Produces: `ConnectionChip` (default export, no props) and named export `useConnectedProvider(): "xero" | "quickbooks" | null | "loading"` — Task 2 reuses the hook.

- [ ] **Step 1: Write the component**

```tsx
// zakiledger/components/ConnectionChip.tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pill, shellColor } from "@/lib/shell-theme";

export type ConnectedProvider = "xero" | "quickbooks" | null | "loading";

/**
 * One answer to "where will this post?", shown on every reconciliation
 * screen. The status endpoints are cheap (a store lookup), so each mount
 * fetches fresh rather than sharing state across pages.
 */
export function useConnectedProvider(): ConnectedProvider {
  const [provider, setProvider] = useState<ConnectedProvider>("loading");
  useEffect(() => {
    Promise.all([
      fetch("/api/auth/xero/status").then((r) => (r.ok ? r.json() : { connected: false })),
      fetch("/api/auth/quickbooks/status").then((r) => (r.ok ? r.json() : { connected: false })),
    ])
      .then(([xero, qbo]) => setProvider(xero.connected ? "xero" : qbo.connected ? "quickbooks" : null))
      .catch(() => setProvider(null));
  }, []);
  return provider;
}

export default function ConnectionChip() {
  const provider = useConnectedProvider();
  if (provider === "loading") return null;
  const label =
    provider === "xero" ? "Connected to Xero" :
    provider === "quickbooks" ? "Connected to QuickBooks" :
    "No accounting connection — CSV import mode";
  const color = provider ? shellColor.high : shellColor.medium;
  const bg = provider ? shellColor.highBg : shellColor.trackBg;
  return (
    <div style={{ margin: "0 0 16px", display: "flex", alignItems: "center", gap: 10 }}>
      <span style={pill(color, bg)}>{label}</span>
      {!provider && (
        <Link href="/settings" style={{ fontSize: 12.5, color: shellColor.inkSoft }}>
          Connect in Settings →
        </Link>
      )}
    </div>
  );
}
```

Note: check `pill`, `shellColor.highBg`, `shellColor.trackBg` exist in `zakiledger/lib/shell-theme.ts` (they are used in `review/page.tsx` lines 351-353 with these exact names). If `/settings` is not the settings route path, read `zakiledger/components/AppShell.tsx` nav items for the correct href.

- [ ] **Step 2: Mount on both reconciliation pages**

In `reconciliation/page.tsx`: render `<ConnectionChip />` directly after `<p style={pageSubtitle}>…</p>`. Then delete the page's own `connectedProvider` state + `useEffect` (lines ~50-66) and replace with `const connectedProvider = useConnectedProviderValue();` where `useConnectedProviderValue` maps the hook: `const p = useConnectedProvider(); const connectedProvider = p === "loading" ? null : p;` — the rest of the page (`onSync`, sync button rendering) keeps working unchanged.

In `reconciliation/review/page.tsx`: render `<ConnectionChip />` after the reviewed-count `<p>` (~line 295) in the main return, and after the subtitle in the "no statement" early return so the chip shows even before upload.

- [ ] **Step 3: Verify**

Run: `npm run check` → PASS. Then `npm run dev`: both pages show the chip; with no OAuth connected it reads "No accounting connection — CSV import mode" with the Settings link.

- [ ] **Step 4: Commit**

```bash
git add zakiledger/components/ConnectionChip.tsx "zakiledger/app/(app)/reconciliation/page.tsx" "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: persistent accounting-connection chip across reconciliation flow"
```

---

### Task 2: Guard banner when no accounting entries exist

**Files:**
- Modify: `zakiledger/app/(app)/reconciliation/review/page.tsx`

**Interfaces:**
- Consumes: `review.qbTransactions` (already fetched), `useConnectedProvider` from Task 1.
- Produces: nothing for later tasks.

- [ ] **Step 1: Add the banner**

In the main return of `ReconciliationReviewPage`, before the `<ReviewBoard>` block, add:

```tsx
{review.qbTransactions.length === 0 && (
  <div style={shellCard({ padding: "16px 20px", marginBottom: 20, borderLeft: `3px solid ${shellColor.medium}` })}>
    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
      No accounting entries to match against
    </div>
    <p style={{ margin: 0, fontSize: 13.5, color: shellColor.inkSoft }}>
      Every transaction will sit in “Potential Issues” until there is something to reconcile it with.{" "}
      <Link href="/reconciliation" style={{ color: shellColor.ink, fontWeight: 600 }}>
        Sync from Xero/QuickBooks or import a CSV →
      </Link>
    </p>
  </div>
)}
```

Add `import Link from "next/link";` at the top. This is the spec's "Select a QB/Xero destination first" error, adapted: the blocking condition in this app is *no accounting data*, not *no selector choice*, and the fix lives on screen 1.

- [ ] **Step 2: Verify**

Run: `npm run check` → PASS. `npm run dev`: upload a bank statement, skip the accounting CSV import, open Review Matches — banner shows and links back. Import the accounting CSV — banner gone.

- [ ] **Step 3: Commit**

```bash
git add "zakiledger/app/(app)/reconciliation/review/page.tsx"
git commit -m "feat: guard banner on review page when no accounting entries imported"
```

---

### Task 3: Sticky detail panel on desktop

**Files:**
- Modify: `zakiledger/components/review/ReviewBoard.tsx` (the `<aside className="review-board-panel">` ~line 328)

**Interfaces:**
- Consumes: existing `PANEL_WIDTH` constant and the `<style>` block (~line 227) already handling mobile (`position: fixed; inset: 0` under 980px).
- Produces: nothing for later tasks.

- [ ] **Step 1: Make the aside sticky**

The panel currently scrolls away with the page on long statements — the exact "scroll context" complaint in the spec. Change the aside's style object to:

```tsx
style={{
  width: openPanelRow ? PANEL_WIDTH : 0,
  flexShrink: 0,
  overflow: "hidden",
  background: shellColor.paper,
  borderLeft: openPanelRow ? `1px solid ${shellColor.cardBorder}` : "none",
  transition: transition("width .22s ease"),
  position: "sticky",
  top: 0,
  alignSelf: "flex-start",
  maxHeight: "100vh",
}}
```

The inner `<div style={{ width: PANEL_WIDTH, height: "100%", overflowY: "auto", … }}>` already scrolls independently, so long panel content stays reachable. The mobile media query (`position: fixed`) overrides `sticky` below 980px — verify the `.review-board-panel` rule wins (it uses `!important` on width only; add `position: fixed !important;` to that rule if the inline sticky leaks through on mobile).

- [ ] **Step 2: Verify**

Run: `npm run check` → PASS. `npm run dev` with a statement long enough to scroll: open a row's panel, scroll the list — panel must stay pinned with its own scrollbar. Narrow the window under 980px — panel must go full-screen as before.

- [ ] **Step 3: Commit**

```bash
git add zakiledger/components/review/ReviewBoard.tsx
git commit -m "fix: pin review detail panel while the transaction list scrolls"
```

---

## Explicitly out of scope (and why)

- **Mid-workflow provider switching with confirmation** — switching means disconnecting one OAuth link and connecting another in Settings; matches are provider-agnostic rows in this schema, so nothing is lost. A confirm dialog adds nothing yet.
- **Reject on unmatched rows** — an unmatched row has no match to reject; the disabled state + `notApprovableReason` copy already explains this.
- **Category-specific bulk approval** — Group B Task 7 (bulk approval with preview modal) covers it.

## Self-review notes

- Task 2 imports nothing from Task 3; Tasks 1→2 share the hook. Execute 1 first, then 2 and 3 in either order.
- Spec's success criterion "can change selection without losing matched transactions" holds by construction: matches key on `statementId`, not provider.
