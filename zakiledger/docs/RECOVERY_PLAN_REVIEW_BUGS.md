# Recovery Plan — Review Page Bugs (Zaki Ledger)

> **Created:** 2026-08-02 (late night session)
> **Status:** INVESTIGATION COMPLETE — FIXES NOT YET STARTED
> **Read this first before doing anything.** This file is the single source of truth
> for the current state, the confirmed bugs (with evidence), and the exact edits needed.

---

## 1. How to pick up where we left off

1. Start the dev server: `cd zakiledger && npm run dev` (port 3000).
2. Check the working tree: `git status` / `git diff` — there are **no code edits yet**,
   only new Playwright scripts under `zakiledger/scripts/`.
3. Run the safety net: `npm run check` (typecheck + lint + 297 tests). All pass.
4. Read `components/review/ReviewBoard.tsx` **before** editing — the last session was
   interrupted right at that read. It has the `ReviewSectionConfig`, row actions,
   bulk bar, and `BulkApprovalPreviewModal` hooks that fixes 1–3 extend.

### Useful scripts (already on disk, all use the real user's credentials)
- `scripts/playwright-explore.mjs` — logs in, seeds demo batch, dumps review page state.
- `scripts/playwright-interact.mjs` — flush + seed + edit/approve/flag interaction tests.
- `scripts/playwright-precise.mjs` — precise approve + edit-approves tests.
- `scripts/playwright-flagtest.mjs` — flag button behaviour test.
- `scripts/playwright-batchtest.mjs` — batch page reject test.
- Screenshots land in `scripts/shots/`.

**Credentials (for Playwright only — the user's real account):**
- Email: `zabdi908@gmail.com` / Password: `Zakaleno254`
- Login flow: `POST /api/auth/login` → redirect. Session cookie `sb-gzwtxebgevgapchoslmp-auth-token`.
- `/api/pending/demo` seeds 5 demo docs (only works when `ANTHROPIC_API_KEY` is NOT set).
- The in-memory store lives on `globalThis` and **persists across hot reloads but not
  across a server restart**. To reset: restart dev server, or flush via
  `DELETE /api/pending/[id]` for each pending doc.

---

## 2. Environment facts (verified)

- Real app: Next.js 15.5.20 App Router, React 19, TS, Zod v4 (`zod/v4`).
- `.env.local`: `SUPABASE_URL` + `SUPABASE_ANON_KEY` set; **NO** `SUPABASE_SERVICE_ROLE_KEY`
  → auth is real Supabase, data store is in-memory fallback.
- Auth: real Supabase (`lib/supabase-server.ts`). Data: in-memory (`lib/store.ts` via `globalThis`).
- **Do NOT change the confidence thresholds** in `lib/validation.ts`
  (`CRITICAL_THRESHOLD = 0.8`, `IMPORTANT_THRESHOLD = 0.6`). User was explicit.

### The parallel "rebuild" (still NOT wired into the real app — cleanup undecided)
Commit `e1eab00` added `backend/`, `frontend/`, `supabase/migrations/001_initial_schema.sql`
— a separate Express + Vite + Supabase scaffold that is **not** connected to the real
Next.js app. Real app is intact. User has NOT decided whether to delete it. Ask before deleting.

---

## 3. Confirmed bugs (all verified live via Playwright + server logs)

### Bug 1 — Flag is a stub
- **Evidence:** Clicked ⚑ on a row → no Flagged section appears, no row moves, nothing persists.
- **Code:** `app/(app)/review/page.tsx` → `flag()` only calls
  `showToast("...flagged for a second look")`.

### Bug 2 — No delete/reject on Review & Edit
- **Evidence:** `/review` per-row buttons are exactly `✓` and `⚑`. No Reject/Delete/Discard.
- **Contrast:** `/batch` HAS per-row Reject + bulk "Reject selected" (works, wired to
  `DELETE /api/pending/[id]` which exists and works: 200 deleted / 404 not found / 409 already-resolved).

### Bug 3 — "Ready to Approve" section is not honest
- **Evidence:** Shinjuku JPY receipt (93% overall) sits in "Ready to Approve" with copy
  "Safe to approve as a batch." Approving it returns `{"status":"duplicate"}` in the demo
  (and would fail to post in a real Xero/QBO setup — unpostable currency).
- **Root cause:** `lib/extraction-insights.ts` → `buildQueueRow()` fabricates
  `perField = { every field: overallConfidence }` because `/api/pending` only returns
  `overallConfidence`. Consequences:
  - A doc with unpostable currency passes the confidence gate → lands in "Ready".
  - Reason text is wrong: Corner Cafe row shows "Merchant low confidence (78%) Receipt
    date low confidence (78%) Total low confidence (78%)" but real per-field values are
    merchant 61%, date 86%, total 95%.

### Bug 4 — Editing approves too eagerly (likely the "can't edit / approve does nothing" confusion)
- **Evidence:** Opened blocked Corner Cafe doc, edited ONLY the merchant name →
  the whole doc was immediately approved + removed from the queue.
- **Root cause:** `POST /api/approve` (`app/api/approve/route.ts`) **never re-runs the
  confidence gate**. It trusts the client. Editing one gating field approves the doc even
  if other fields are still low-confidence. The client `editField()` also sends the approve
  unconditionally. So a doc with two low-confidence fields + a one-field edit silently posts.

### Bug 5 — Cold-start makes pages appear frozen (UX/ops, not logic)
- **Evidence (server log):** first compile of `/review` took 24s, `/api/pending` 16s,
  `/api/pending/demo` 10s. Page sits on "Loading…" for 10–25+ s after a fresh server.
- After everything is compiled the same pages load in ~1.4s.

---

## 4. Fix plan (in priority order)

### Fix 1 — Real Flag section
- **File(s):** `app/(app)/review/page.tsx`, `components/review/ReviewBoard.tsx`
- **Behaviour:** clicking ⚑ moves the row into a new "Flagged" section; toggle unflags;
  flagged rows can still be approved or rejected from there.
- **Mechanics (suggested):**
  - Add client state `flaggedIds: Set<string>` in `review/page.tsx`.
  - `flag(id)` toggles membership (no API needed — review-session concern; persistence is a
    later enhancement).
  - Add a `flagged` entry to `SECTIONS` (accent color `shellColor.medium`, showBulkApproveAll false).
  - `buildQueueRow`/section assignment must map flagged → `flagged` section.
  - ReviewBoard likely needs to accept flagged rows and render the section.

### Fix 2 — Reject/Delete on Review & Edit
- **File(s):** `app/(app)/review/page.tsx`, `components/review/ReviewBoard.tsx`
- **Behaviour:** per-row Reject + bulk "Reject selected" on `/review`, wired to the existing
  `DELETE /api/pending/[id]`.
- **Mechanics (suggested):**
  - Add `async function reject(ids: string[])` in `review/page.tsx` that calls
    `DELETE /api/pending/${id}` for each, removes from `items`/`approvedIds`, toasts.
  - Add a per-row reject button (danger style) and a bulk "Reject selected" in the bulk bar.
  - ReviewBoard needs an `onReject`-style prop (check its current props first).
  - Mirror the `/batch` page's existing reject UX for consistency.

### Fix 3 — Honest "Ready to Approve" (do NOT change thresholds)
- **File(s):** `app/api/pending/route.ts`, `lib/extraction-insights.ts`
- **Behaviour:** the list-row gate and reason text must reflect REAL per-field confidence
  and approve-time preconditions, so "Ready to Approve" means "can genuinely post".
- **Mechanics (suggested):**
  - Extend `GET /api/pending` to return per-field confidence (the full `extraction` is already
    stored server-side; the comment in the route says it's trimmed "to save bandwidth" — that
    tradeoff is what caused this bug).
  - Update `PendingListItem` type + `buildQueueRow()` to use real per-field confidence.
  - Add the approve-time preconditions (currency support, arithmetic) into the gate used by
    the list — OR compute the gate server-side and return a `section`/`gate` field per doc.
  - Fix `plainEnglishGateReason` so reason text uses real per-field confidence.

### Fix 4 — Server-side gate enforcement on approve
- **File(s):** `app/api/approve/route.ts`, possibly `lib/validation.ts`
- **Behaviour:** `POST /api/approve` re-runs `gateApproval` on the FINAL (edited) values and
  refuses with a clear "blocked on these fields" response when critical fields are still low.
- **Mechanics (suggested):**
  - After computing final values, build a per-field confidence map (edited fields → 1,
    unchanged → original confidence) and run `gateApproval`.
  - If not `ready`, return `{ status: "blocked", reasons: [...] }` (NOT a 500, NOT approved).
  - Update the client `approve()`/`editField()` in `review/page.tsx` to handle `blocked`
    by showing which fields still need attention.
  - Keep the duplicate check BEFORE the gate (a duplicate should still warn first).

### Fix 5 — Loading UX (optional, low priority)
- Add a timeout/error state so a slow first load shows "Still loading…" instead of an
  endless spinner. Pure client-side in `review/page.tsx` (and siblings if quick).

---

## 5. Verification checklist (after each fix)

1. `npm run check` — typecheck + lint + all 297 tests must stay green.
2. Restart dev server to clear the in-memory store, then run:
   - `scripts/playwright-flagtest.mjs` → ⚑ must now show a Flagged section and move the row.
   - `scripts/playwright-batchtest.mjs` → /review must now have Reject.
   - `scripts/playwright-precise.mjs` → editing one field on a blocked doc must NOT approve
     if other fields still gate (Bug 4 fix); Shinjuku must not sit in "Ready to Approve" (Bug 3 fix).
3. Manually (or via a new Playwright script): approve all 4 "Ready" docs as a batch → only the
   genuinely postable ones approve; the rest explain why.

---

## 6. User constraints & preferences (IMPORTANT)

- **Do NOT change the 80%/60% confidence thresholds.** Make the sections/copy honest instead.
- User's original three complaints: (a) "can't edit, approving does nothing", (b) flag does
  nothing, (c) no delete/reject on review page, (d) "Ready to Approve" showing docs at ~86%.
- User is in **recovery mode** — they exhausted their weekly Claude usage after an overnight
  "rebuild" that produced the parallel scaffold (see §2). Keep changes surgical and verified.
- The parallel scaffold cleanup (`backend/`, `frontend/`, `supabase/migrations/001_initial_schema.sql`)
  is still an open question — ASK the user before touching it.

---

## 7. Current file map (key files, all read and verified this session)

- `app/(app)/review/page.tsx` — Review & Edit page (client). Contains `flag()` stub,
  `approve()`, `editField()`, `SECTIONS` config, `ExtractionPanelBody`.
- `components/review/ReviewBoard.tsx` — reusable board. **NOT yet re-read after this session
  started fixing — read first.** Has sections, bulk actions, `BulkApprovalPreviewModal`.
- `app/api/pending/route.ts` — GET list (trimmed; only overallConfidence).
- `app/api/pending/[id]/route.ts` — GET detail (full extraction) + DELETE (works).
- `app/api/pending/demo/route.ts` — POST seeds 5 demo docs (demo-mode only).
- `app/api/approve/route.ts` — POST approve. **No gate re-run (Bug 4 root cause).**
- `app/api/approve/bulk/route.ts` — bulk approve (uses `lib/bulk-approve.ts`).
- `lib/store.ts` — in-memory fallback on `globalThis`; `savePendingDocument`,
  `listPendingDocuments`, `getPendingDocument`, `deletePendingDocument` all work.
- `lib/extraction-insights.ts` — `buildQueueRow()` (fabricates per-field from overall —
  Bug 3 root cause), `detectQueueDuplicates()`, `sectionForGate()`.
- `lib/validation.ts` — `gateApproval()`, thresholds. **DO NOT change thresholds.**
- `lib/demo.ts` — sample extractions + `sampleBulkBatch()` (5 docs).
- `lib/auth.ts` — `requireUser()` (slow session refresh ~1.4s — contributes to Bug 5).
- `lib/supabase.ts` / `lib/supabase-server.ts` — client selection (in-memory vs Supabase).
- `middleware.ts` — page-level auth gate (login/signup exempt).
- `tests/` — 297 tests across store, bulk-approve, queue-degradation, user-isolation, etc.

---

*End of plan. When the user returns: say "ready to continue", re-read ReviewBoard.tsx,
start with Fix 1 + Fix 2, run the verification checklist, then Fix 3 + Fix 4.*
