# Zaki Ledger — Visual Smoke Test Checklist

Run through this checklist after any deploy to confirm the app is rendering
correctly and core workflows are intact. Each item is a visual check — no
automation required. Tick the box when it passes.

---

## 1. Dashboard

- [ ] `/dashboard` loads without a blank white screen
- [ ] Three stat tiles render (Invoices, Receipts, Bank Statements) with non-zero
      counts or "0"
- [ ] Monthly Volume chart renders (bars or empty-state message)
- [ ] Accounting tile(s) show connection status (Connected / Disconnected)
- [ ] "Recent Activity" or feed section renders (list of items or "No activity
      yet")
- [ ] Page is responsive — tiles stack vertically on narrow viewport (< 768 px)

## 2. Upload & Extract

- [ ] Navigate to `/upload`
- [ ] Drag-and-drop zone is visible ("Drop files here" or browse button)
- [ ] Upload a real PDF (or image) of an invoice/receipt
- [ ] Progress indicator appears during extraction (spinner, progress bar, or
      streaming text)
- [ ] Extraction completes without a hard error — extracted fields are displayed
- [ ] Confidence scores are shown per field (percentage or badge)
- [ ] Low-confidence fields are visually flagged (yellow/red highlight or warning
      icon)
- [ ] Upload succeeds for a second file without a page reload
- [ ] Error state: uploading an unsupported file type shows a clear error message
- [ ] Error state: uploading no file and clicking submit shows validation feedback

## 3. Review & Edit

- [ ] Navigate to `/review`
- [ ] Review queue lists pending documents (or shows "No pending documents")
- [ ] Each row shows merchant, amount, date, type, and confidence badge
- [ ] Clicking a row expands detail view with per-field confidence scores
- [ ] Editable fields can be changed and changes persist visually
- [ ] "Approve" button is present and enabled for high-confidence documents
- [ ] Approving a document removes it from the queue (or shows success toast)
- [ ] "Approve Selected" (bulk) button appears when 2+ checkboxes are ticked
- [ ] "Approve Selected" processes multiple documents and reports per-item results
- [ ] A document blocked by the gate shows the reason (currency / confidence /
      duplicate)

## 4. Batch Review

- [ ] Navigate to `/batch`
- [ ] Batch upload area is visible
- [ ] Selecting multiple files starts a batch extraction
- [ ] Progress stream shows per-file results as they complete (NDJSON streaming)
- [ ] Summary line reports total succeeded / failed / queued counts
- [ ] One corrupted/unreadable file reports its own error without blocking others

## 5. Upload Statement (Reconciliation)

- [ ] Navigate to `/reconciliation`
- [ ] Upload a bank statement (CSV, OFX, or PDF)
- [ ] Upload progress is shown
- [ ] After upload, the reconciliation detail page (`/reconciliation/[id]`) loads
- [ ] Statement transactions are listed in a table

## 6. Review Matches

- [ ] Match list renders on the reconciliation detail page
- [ ] Each match shows the bank transaction side and the book transaction side
- [ ] Match confidence or status is displayed per row
- [ ] "Approve match" action works on a single row
- [ ] Bulk approve matches works when multiple are selected
- [ ] Non-matching items are listed separately (unmatched bank / unmatched books)

## 7. Cross-File Compare

- [ ] Navigate to `/reconciliation/compare`
- [ ] Two upload zones are visible (File A / File B, or Bank / Books)
- [ ] Upload two files and progress indicators appear
- [ ] Comparison results table renders after both uploads complete
- [ ] Matched rows are visually distinguished from unmatched rows
- [ ] "Approve all matches" bulk action works

## 8. Match Dashboard

- [ ] Reconciliation list page (`/reconciliation`) shows past reconciliation
      sessions
- [ ] Each session row shows date, statement name, match count, and status
- [ ] Clicking a session navigates to its detail page

## 9. Settings

- [ ] Navigate to `/settings`
- [ ] Xero connection section is visible (Connect / Disconnect button)
- [ ] QuickBooks connection section is visible (Connect / Disconnect button)
- [ ] "Connected" state shows a green indicator or chip
- [ ] "Disconnected" state shows a connect button
- [ ] Any form fields (API keys, webhook URLs) are visible
- [ ] Dark mode toggle works (if implemented)

## 10. Global

- [ ] Sidebar navigation renders and all links are clickable
- [ ] Active nav item is highlighted
- [ ] Logged-in state persists across page navigations (no redirect to /login)
- [ ] Logout button works and redirects to /login
- [ ] Unauthenticated visits to any `/app` route redirect to `/login`
- [ ] Mobile hamburger menu opens and closes correctly
- [ ] No console errors on any page (check DevTools)
- [ ] No 404s for static assets (JS, CSS, favicon)
- [ ] Page title / `<title>` tag updates per route
- [ ] All currency amounts are formatted with a symbol (not raw code)