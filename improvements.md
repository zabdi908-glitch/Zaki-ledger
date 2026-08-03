# Zaki Ledger Phase 3 Improvements
**Bank Reconciliation — From Detection to Decision Automation**

---

## Executive Summary

Zaki Ledger currently excels at **detection** (flagging duplicates, transfers, issues) but lacks **resolution** (telling accountants what to do). This improvement suite transforms the product from a flagging system into a decision-automation system — shifting from "AI spotted things" to "AI did 90% of the bookkeeping, confirm the last 10%."

**Core Insight:** Accountants think in actions, not alerts. Suggested resolutions, auto-categorization, and bulk approval are the difference between a tool they use and a tool they recommend.

---

## Phase 0: Performance & Speed Optimization (FOUNDATION)

**Goal:** Make the app feel buttery smooth. Accountants should never feel friction. "The site should feel so smooth that accountants want to stay there all day."

### 0.1 Page Load & Navigation Speed
**Problem:** Current state feels sluggish. Dashboard → Bank Reconciliation takes 2–3 seconds. Filters lag. Scrolling is jerky.

**Requirements:**
- **Code splitting & lazy loading** — Split React bundles by route (reconciliation, dashboard, settings). Load only what's needed.
- **Optimize bundle size** — Audit npm packages, remove unused dependencies, use tree-shaking. Target < 250KB gzipped.
- **Service Worker caching** — Cache static assets, API responses (bank statement imports, QB/Xero metadata). Instant route transitions.
- **Route preloading** — Prefetch bundle for next likely page (e.g., if on dashboard, preload reconciliation bundle).
- **Image optimization** — Compress all PNGs/SVGs. Use WebP with fallbacks.
- **Database query optimization** — Add indexes on frequently queried fields (user_id, import_batch_id, status). Fetch only necessary columns.

**Success Criteria:**
- [ ] Dashboard loads in < 800ms (first paint)
- [ ] Route transitions feel instant (< 200ms perceived delay)
- [ ] Filter switching instant (no loading spinner)
- [ ] Scroll performance smooth (60 FPS, no jank)
- [ ] Bundle size < 250KB gzipped
- [ ] Service Worker caches 95% of requests on repeat visits

---

### 0.2 Real-Time UI Responsiveness
**Problem:** Buttons take 500ms+ to show feedback. Bulk approvals feel slow. List updates laggy.

**Requirements:**
- **Optimistic UI updates** — When user clicks "Approve", immediately update UI (remove from list or gray out). Post to backend in background.
- **Debounce filter input** — 300ms debounce on filter/search to avoid excessive re-renders.
- **Memoization of components** — Use React.memo() and useMemo() to prevent unnecessary re-renders. Profile with React DevTools.
- **Virtual scrolling** — For lists with 100+ items, render only visible rows. Use react-window or similar.
- **Instant feedback** — Button click → 50ms visual feedback (ripple, color change) before API call completes.

**Success Criteria:**
- [ ] Approve button instant visual feedback (< 50ms)
- [ ] Filter switch no loading spinner
- [ ] List with 1000+ items scrolls smoothly
- [ ] No slow component re-renders (profile with DevTools)
- [ ] Bulk approval of 20 txns feels instant

---

### 0.3 API Response Time Optimization
**Problem:** Backend queries slow. Reconciliation page loads data in serial (should be parallel).

**Requirements:**
- **Parallel API calls** — Fetch bank statements, QB/Xero data, suggested categories in parallel (Promise.all), not sequential.
- **Data pagination** — Load first 50 txns, then fetch next 50 on scroll (not all 500 at once).
- **Compress API responses** — Use gzip. Only return fields the UI needs (no nested QB/Xero objects).
- **Add Redis caching** — Cache QB/Xero account list, merchant categories, user preferences for 1 hour. Instant on repeat loads.
- **Reduce DB load** — Use database views for complex queries (e.g., suggested categories by merchant).

**Success Criteria:**
- [ ] Reconciliation page data loads in < 1 second (all parallel)
- [ ] API responses gzipped < 100KB
- [ ] QB/Xero account list loads from cache (< 50ms) on repeat
- [ ] Pagination works smoothly, no full-list loads

---

### 0.4 Mobile Performance
**Problem:** Mobile is slower than desktop. Accountants check app on phone during travel.

**Requirements:**
- **Mobile-first CSS** — Style mobile first, then add desktop breakpoints. Reduce CSS bloat.
- **Touch optimization** — Larger tap targets (48px+), no hover delays, fast tap feedback.
- **Network-aware loading** — Detect slow connections, reduce image quality, paginate more aggressively.
- **Offline support** — Cache last reconciliation import. Allow read-only offline mode.
- **Reduce animations on low-end devices** — Detect via prefers-reduced-motion.

**Success Criteria:**
- [ ] Mobile page loads in < 2 seconds (3G)
- [ ] Touch response instant (no 200ms delay)
- [ ] Works offline (read-only mode)
- [ ] Battery usage reasonable (tested with DevTools)

---

### 0.5 Monitoring & Alerts
**Problem:** No visibility into slow pages. Performance regressions go unnoticed.

**Requirements:**
- **Web Vitals tracking** — Monitor Core Web Vitals (LCP, FID, CLS) with tools like Sentry or Vercel Analytics.
- **Performance budgets** — Alert if bundle size exceeds 250KB, or if page load > 1 second.
- **Error tracking** — Log slow API calls (> 2 seconds) and failed requests.
- **User-facing feedback** — Show "⚡ Fast" or "⏳ Slow" badge on dashboard (based on their connection).

**Success Criteria:**
- [ ] Web Vitals tracked and logged
- [ ] Performance budget enforced (CI/CD)
- [ ] Slow API calls logged with stack trace
- [ ] Dashboard shows performance status

---

## Phase 1: Design & Infrastructure

**Design work required — see separate document: CLAUDE_DESIGN_PROMPT.md**

---

## Batch 1: Critical Blockers (Infrastructure)

**Goal:** Unlock Francisco's pilot testing. Fix immediate functionality gaps.

### 1.1 QB/Xero Selector Persistence
**Problem:** QB/Xero OAuth connection selector visible on upload, disappears on review page.

**Requirements:**
- QB/Xero selector must persist from upload through entire reconciliation workflow
- Display current selection in a sticky header or sidebar
- Allow user to switch QB/Xero account mid-workflow (with confirmation)
- Store selected connection in browser session state + DB (linked to import batch)
- If no connection selected when user tries to approve/post, show clear error: "Select a QB/Xero destination first"

**Success Criteria:**
- [ ] User uploads bank statement
- [ ] Selects QB/Xero destination
- [ ] Navigates to review page
- [ ] QB/Xero selector still visible
- [ ] Can change selection without losing matched transactions

---

### 1.2 Approve/Reject/Bulk Action Buttons
**Problem:** Buttons broken or missing. User cannot approve or reject reviewed transactions. No bulk approval option.

**Requirements:**
- Fix approve/reject buttons on individual transaction cards
- Add bulk approval button: "Approve All" (approves all ready-to-approve transactions)
- Add category-specific bulk approval: "Approve All [Category]" (e.g., "Approve All Duplicates", "Approve All Recurring")
- Each action should POST to backend with transaction IDs + user decision
- Show success/error feedback for each action
- After approval, remove approved txn from view or move to "Approved" section

**Success Criteria:**
- [ ] Approve button on single transaction works
- [ ] Reject button on single transaction works
- [ ] Bulk "Approve All" button works
- [ ] Category-specific bulk buttons work
- [ ] User sees confirmation (success toast or section move)

---

### 1.3 Two-Column Review UX (Scroll Context)
**Problem:** When user clicks a filter (e.g., "Potential Issues"), matched transaction pair details are separated. User must scroll up/down to see bank txn + QB/Xero match side-by-side.

**Requirements:**
- Implement sticky/fixed left column showing bank statement transaction (Merchant, Date, Amount, Direction, Reference)
- Right column shows filtered results (matches, potential issues, etc.)
- When user clicks an item on the right, left column updates to show that bank txn
- Both columns visible at all times without scrolling
- On mobile, implement stacked view or modal

**Success Criteria:**
- [ ] Left column sticky, doesn't scroll with filtered results
- [ ] Clicking a filter item updates left column instantly
- [ ] Date/Amount/Merchant visible on left without scrolling
- [ ] Mobile fallback (modal or tabs) works

---

## Batch 2: Suggested Actions & Decision Automation

**Goal:** Transform from detection to resolution. Make the product feel intelligent and save 80% of review time.

### 2.1 Suggested Resolution for Flagged Issues
**Problem:** Zaki flags duplicates and issues with just a confidence score. Accountant doesn't know what to do.

**Requirements:**
- For each flagged issue (Duplicate, Refund, Transfer, Potential Issue), generate a "Suggested Action" block:
  - **Reason:** Why Zaki thinks this is an issue (e.g., "Same date, amount, and reference")
  - **Suggested Action:** What the accountant should do (e.g., "Reject second transaction", "Match to invoice", "Categorize as refund")
  - **Confidence:** 95–99%
  - **Action Buttons:** [Accept Suggestion] [Keep Both / Reject / Review]
- Reasons must be specific, not generic (show actual matching fields)
- Store user decision (accept/reject) for learning (Batch 2.4)

**Example:**
```
⚠ Possible Duplicate

Reason:
- Same date (2026-07-15)
- Same amount (£450.00)
- Same reference (INV-2044)
- Both from ACME Ltd

Suggested Action:
Reject second transaction (likely bank processing error).

Confidence: 99%

[Accept Suggestion] [Review & Decide]
```

**Success Criteria:**
- [ ] Each flagged issue shows reason, action, confidence
- [ ] Reasons reference actual txn fields (date, amount, ref, merchant)
- [ ] Accept/reject buttons work
- [ ] User decision logged to DB

---

### 2.2 Suggested Category Mapping
**Problem:** Almost all transactions show "Uncategorised". Accountants don't want to manually categorise 100 txns.

**Requirements:**
- Build a merchant → GL category mapping table (or use hardcoded + ML fallback)
- When bank statement txn is imported, check if merchant matches known categories
- Show suggested category on transaction card: "Software & SaaS (96% confidence)"
- User can accept suggestion with one click or override with dropdown
- Store merchant → category mapping in DB for future learning (Batch 2.4)

**Merchant Examples:**
- GOOGLE WORKSPACE → Software & SaaS (96%)
- SHELL / TESCO / BP → Motor Expenses (94%)
- HMRC VAT PAYMENT → VAT Control Account (98%)
- AMAZON BUSINESS → Office Supplies (92%)
- WISE TRANSFER → Transfer (99%)

**Success Criteria:**
- [ ] Merchant lookup works for common UK merchants
- [ ] Confidence score shown
- [ ] One-click accept
- [ ] Override dropdown functional
- [ ] Mapping stored in DB

---

### 2.3 Bulk Approval with Smart Grouping
**Problem:** User must approve 30+ transactions one by one. No way to batch-approve similar items.

**Requirements:**
- Add bulk approval buttons above transaction list:
  - "Approve all [Category]" (e.g., "Approve all Software expenses")
  - "Approve all [Type]" (e.g., "Approve all recurring suppliers")
  - "Approve all invoice matches" (see Batch 3.1)
  - "Approve all ready to post" (all high-confidence, no issues)
- Each bulk button only shows if there are 2+ matching items
- Clicking bulk button shows a preview modal: "Approve 5 software expenses?" with list
- User can deselect individual items before confirming
- After approval, items move to "Approved" section (visible but grayed out)

**Success Criteria:**
- [ ] Bulk buttons appear dynamically based on txn types
- [ ] Preview modal works
- [ ] Individual deselect works in preview
- [ ] Approval logged for all selected items
- [ ] Approved items visible but separated

---

### 2.4 Learning from Previous Decisions
**Problem:** Same merchants tagged the same way every month. No learning or prediction.

**Requirements:**
- Log every merchant → category decision user makes
- Build a user preference table: merchant_id, category_id, approval_count, last_approved
- After 3 approvals of the same mapping, increase confidence: "Based on 3 previous approvals"
- Show learning confidence: "Software & SaaS (99% - based on 3 previous approvals)"
- Allow user to "set as default for this merchant" (one-click future approvals)
- Periodically (weekly?) suggest category updates to user based on their patterns

**Success Criteria:**
- [ ] User decision logged each time
- [ ] Confidence increases after 3+ approvals
- [ ] Learning label shown to user
- [ ] "Set as default" button works
- [ ] Future imports reflect learned preferences

---

## Batch 3: Invoice & Transaction Matching

**Goal:** Connect bank transactions to invoices. This is the biggest commercial opportunity — saves 4–6 hours/week per accountant.

### 3.1 Invoice Matching (Bank Txn ↔ Invoice)
**Problem:** Bank transaction says "CLIENT PAYMENT INV-2044 £1,800". Zaki doesn't connect it to the extracted invoice.

**Requirements:**
- When bank statement is imported, scan merchant name + amount for invoice references (INV-XXXX, #XXXX, etc.)
- Query extracted invoices table for matching invoice_id + amount
- Show "Possible Match" card if match found:
  - Invoice: INV-2044
  - Amount: £1,800
  - Customer: Acme Ltd
  - Confidence: 99%
  - [Match Invoice] button
- If no invoice reference in merchant name, use fuzzy matching on amount + date window (±3 days) + merchant name
- Store matched pair in reconciliation table
- Mark invoice as "Paid" in QB/Xero when posted

**Example Match:**
```
💰 Possible Match

Invoice:
INV-2044

Customer:
Acme Ltd

Amount:
£1,800

Date:
2026-07-15

Confidence:
99%

Reason:
Exact match: Reference number + amount + date within 1 day

[Match Invoice] [Review]
```

**Success Criteria:**
- [ ] Reference number extraction from merchant name works (INV-XXXX, #XXXX)
- [ ] Invoice lookup by invoice_id + amount works
- [ ] Fuzzy matching on amount/date/merchant works
- [ ] Match card shows all relevant info
- [ ] Match button posts to QB/Xero (mark invoice paid)
- [ ] Matched status visible in QB/Xero

---

### 3.2 Accounting Impact Preview
**Problem:** Accountants think in GL impact, not bank transactions. Show them the ledger outcome.

**Requirements:**
- For each matched/categorised transaction, calculate and show accounting impact:
  - VAT payment? Show "Reduce VAT Liability: £1,240"
  - Invoice payment? Show "Mark Invoice INV-2044 as Paid. Reduce Debtors: £1,800"
  - Expense? Show "Increase [Expense Category]: £450"
  - Refund? Show "Reverse sale to ACME Ltd: £300"
- Impact cards should appear next to suggested category/action
- Use QB/Xero GL structure (fetch from account codes)
- Show impact in clear, accountant-friendly language

**Example Impact:**
```
🎯 Suggested Impact

Mark Invoice INV-2044 as Paid
Reduce Debtors (A/R): £1,800

Confidence: 99%
```

**Success Criteria:**
- [ ] Impact calculated based on category + transaction type
- [ ] GL account names used (not codes)
- [ ] Debtors/Creditors/Liability impacts shown
- [ ] Impact language is non-technical

---

## Batch 4: Dashboard & Workflow Summary

**Goal:** Give accountants visibility into the entire reconciliation at a glance. Make progress feel real.

### 4.1 Smart Import Dashboard
**Problem:** Showing "Potential Issues: 30" is scary and vague. Accountant doesn't know how much work is actually left.

**Requirements:**
- Replace generic issue count with breakdown:
  ```
  37 Transactions Imported
  
  ✅ 22 Ready to Approve (auto-categorized, no issues)
  🔍 8 Need Review (flagged issues, low confidence)
  ⚠️ 2 Refunds (suggested rejection)
  📋 1 Duplicate (suggested merge)
  🔄 1 Transfer (suggested skip)
  ❌ 3 Uncategorized (need category)
  ```
- Each section is clickable → filters to that subset
- Progress bar: "88% Ready to Post" (ready / total)
- Time estimate: "Est. 5 min to review & approve" (based on item count)
- Post button only enabled when ready-to-post count > 0

**Success Criteria:**
- [ ] Breakdown calculated correctly
- [ ] Each section clickable
- [ ] Progress bar reflects actual state
- [ ] Estimate reasonable (test with Francisco)
- [ ] Post button conditional logic works

---

### 4.2 Review Workflow Summary
**Problem:** No way to see what's been approved vs. pending. No audit trail.

**Requirements:**
- Show "Session Summary" panel during review:
  - Approved: 5 transactions
  - Pending: 32 transactions
  - Rejected: 0 transactions
  - Matches awaiting post: 3 invoices
- Show timestamp for each action
- Undo last 5 actions (button)
- Export session summary (CSV/PDF) before posting
- Show "Ready to Post" status before final step

**Success Criteria:**
- [ ] Counts update in real-time
- [ ] Undo works (reverts DB)
- [ ] Export functional
- [ ] Clear indication when ready to post

---

## Implementation Groups for Claude Code

### Group 0 (Priority 0 - Foundation/Performance)
- Batch 0.1: Page Load & Navigation Speed
- Batch 0.2: Real-Time UI Responsiveness
- Batch 0.3: API Response Time Optimization
- Batch 0.4: Mobile Performance
- Batch 0.5: Monitoring & Alerts

**Prompt:** "Optimize for speed. The app should feel buttery smooth — no lag, no jank. Implement code splitting/lazy loading, optimize bundle size (< 250KB), add service worker caching, use optimistic UI updates, paginate large lists, parallelize API calls, and add Web Vitals monitoring. Goal: Dashboard loads < 800ms, route transitions < 200ms, button feedback < 50ms."

---

### Group A (Priority 1 - Blockers)
- Batch 1.1: QB/Xero Selector Persistence
- Batch 1.2: Approve/Reject/Bulk Buttons
- Batch 1.3: Two-Column Review UX

**Prompt:** "Fix the three critical Phase 3 blockers: (1) QB/Xero selector must persist through workflow, (2) approve/reject/bulk buttons must work and post decisions to DB, (3) implement sticky left column for bank txn so accountant doesn't scroll to see merchant/date/amount while reviewing."

---

### Group B (Priority 2 - Decision Automation)
- Batch 2.1: Suggested Resolution for Issues
- Batch 2.2: Suggested Category Mapping
- Batch 2.3: Bulk Approval

**Prompt:** "Turn detection into action. For each flagged issue, show [Reason + Suggested Action + Confidence]. For each merchant, suggest a GL category with confidence. Add bulk approval buttons ('Approve all Software expenses', etc.). Each decision must be logged to DB for learning."

---

### Group C (Priority 3 - Matching & Impact)
- Batch 3.1: Invoice Matching
- Batch 3.2: Accounting Impact Preview

**Prompt:** "Connect bank transactions to invoices. Scan merchant name for invoice refs (INV-XXXX). If found, query invoices table and show [Invoice + Customer + Amount + Confidence + Match Button]. For each categorised/matched txn, calculate GL impact ('Mark Invoice as Paid, Reduce Debtors £1,800') and show in accountant language."

---

### Group D (Priority 4 - Dashboard & Visibility)
- Batch 4.1: Smart Import Dashboard
- Batch 4.2: Review Workflow Summary

**Prompt:** "Redesign import dashboard to show 37 Transactions: 22 Ready, 8 Need Review, 2 Refunds, 1 Duplicate, 3 Uncategorized (instead of scary 'Potential Issues: 30'). Add session summary panel showing approved/pending/rejected counts, timestamps, and undo. Show progress bar and time estimate."

---

## Design Handoff to Claude Design

**Before** Batch 1 builds:
- Create high-fidelity mockups of two-column review layout
- Design suggested action card component
- Design smart dashboard breakdown
- Create filter sidebar interaction flow
- Design bulk approval preview modal

**Deliverables to Claude Code:**
- Figma links or component specs
- Interactive prototype (if possible)
- Responsive (mobile) considerations

---

## Database Schema Updates Needed

```sql
-- User learning: merchant → category mappings
CREATE TABLE user_merchant_preferences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  merchant_name TEXT NOT NULL,
  suggested_category TEXT,
  approval_count INT DEFAULT 0,
  last_approved TIMESTAMP,
  UNIQUE(user_id, merchant_name)
);

-- Transaction decisions (for learning)
CREATE TABLE reconciliation_decisions (
  id UUID PRIMARY KEY,
  reconciliation_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  decision_type TEXT (approve/reject/merge/match),
  merchant_name TEXT,
  suggested_category TEXT,
  user_choice_category TEXT,
  invoice_match_id UUID,
  created_at TIMESTAMP
);

-- Invoice matches
CREATE TABLE invoice_matches (
  id UUID PRIMARY KEY,
  bank_transaction_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  confidence DECIMAL(3,2),
  matched_by TEXT (reference/amount_date/fuzzy),
  status TEXT (pending/matched/rejected),
  created_at TIMESTAMP
);
```

---

## Success Metrics

After all four groups are built:
- **Approval time per transaction:** < 10 seconds (was 1–2 min)
- **Auto-approval rate:** 60–70% (no user decision needed)
- **Francisco's weekly reconciliation time:** 30 min (was 4–6 hours)
- **User satisfaction:** "Feels like AI did 90% of the work"

---

## Notes for Claude Code

1. **No API budget constraints** — Suggested category mapping should use a hardcoded UK merchant database (fast, free) + fallback to GPT for unknown merchants
2. **Test with real UK merchants** — HMRC, SHELL, GOOGLE, AMAZON, WISE, etc.
3. **Mobile-first for filters** — accountants will review on phone/tablet
4. **Undo must work** — revert DB state, not just UI
5. **Learning confidence increases after 3 approvals** — not 1

---

## Next Steps

1. **Claude Code Group 0** optimizes performance (parallel with design)
2. **Claude Design** creates mockups (two-column review, dashboard, bulk approval modal)
3. **Claude Code Group A** fixes blockers + integrates design mockups (1–2 days)
4. **Francisco tests** with Group A ready for pilot
5. **Claude Code Group B** builds decision automation (3–4 days)
6. **Claude Code Group C** builds invoice matching (2–3 days)
7. **Claude Code Group D** finalizes dashboard (1–2 days)