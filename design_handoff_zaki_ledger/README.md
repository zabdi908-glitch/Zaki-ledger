# Handoff: Zaki Ledger — Bookkeeping Automation Prototype

## Overview
Zaki Ledger is a bookkeeping/accounting-automation web app. It extracts data from invoices, receipts, and bank statements; lets a user review/edit low-confidence extractions; and reconciles bank transactions against QuickBooks. This package documents an interactive HTML prototype of the full app so it can be rebuilt in a real codebase.

## About the Design Files
The bundled `.dc.html` files are **design references built in a proprietary HTML prototyping format** (custom `{{ }}` template bindings, `sc-for`/`sc-if` control-flow tags, a `support.js` runtime). They are NOT meant to be copied as-is or run in production — that runtime is not something your build can depend on. Your task is to **recreate this design and behavior in the target codebase's actual stack** (React, Vue, Swift, etc. — whichever the project already uses, or the most sensible choice if none exists yet), reproducing the layouts, states, copy, and interactions described below. Read the HTML markup/inline styles as ground truth for exact spacing, color, and typography values; read the JS class as ground truth for state and logic.

`Zaki Ledger Walkthrough.dc.html` is NOT part of the app — it's an auto-advancing screenshot carousel used only to preview the flow. Ignore it for implementation purposes (included for reference only; its screenshots are not bundled).

## Fidelity
**High-fidelity.** All colors, spacing, type sizes, and copy in the HTML file are final and should be reproduced pixel-for-pixel using your framework's styling approach (CSS-in-JS, Tailwind, stylesheet, etc.) — do not restyle with a different design system.

## App Shell / Navigation
- Fixed-width left sidebar (240px expanded / 72px collapsed, animated width transition) + flex-1 scrollable content area, 100vh, no page scroll on the shell itself.
- Sidebar: dark navy background `oklch(24% 0.05 260)`, white text. Logo "Zaki." (period accented in teal `oklch(70% 0.12 195)`) top-left, collapse toggle (☰) top-right — also bound to Cmd/Ctrl+B.
- Nav is grouped with uppercase group labels (11px, letter-spacing 0.06em, gray `oklch(50% 0.02 260)`): unlabeled Dashboard item, then groups **Extraction** (Upload & Extract, Review & Edit, Batch Review), **Reconciliation** (Upload Statement, Review Matches, Batch Review), **Organization** (Auto-Categorize, Document Portal — both tagged "SOON"), **Insights** (Reports & Analytics — "SOON"), **Account** (Settings).
- Each nav item: icon (emoji) + label, 9px/12px padding, 8px radius, active state = lighter navy pill `oklch(32% 0.07 260)` + white text; inactive = transparent + `oklch(78% 0.02 260)` text; "soon" items are dimmed and non-navigating with a bordered "SOON" badge.
- Collapsed state shows icon-only, centered.
- Footer (only when expanded): user name "Francisco M." (white, 600) + "Growing Practice · Tier 2" (gray, 12px), top border.
- Content area: max-width 1200px centered, 40px/48px padding.
- Global toast: fixed bottom-right, dark pill, appears for 2.5s after bulk actions.

## Design Tokens
- **Font**: Inter (400/500/600/700) for UI text; IBM Plex Mono (500/600) for numbers/amounts/dates/codes. Load via Google Fonts.
- **Background**: page `oklch(98% 0.004 240)` (near-white cool gray); cards `white` with `1px solid oklch(90% 0.008 240)` border, 10-14px radius.
- **Text**: primary `oklch(20% 0.02 240)`; secondary/muted `oklch(48% 0.02 240)`; tertiary `oklch(55-60% 0.01-0.02 240)`.
- **Sidebar**: base `oklch(24% 0.05 260)`, active pill `oklch(32% 0.07 260)`, primary buttons `oklch(30% 0.08 260)`.
- **Accent (teal, progress/brand)**: `oklch(62% 0.11 195)`; logo dot `oklch(70% 0.12 195)`.
- **Confidence tiers** (used throughout): High ≥95% → green `oklch(45% 0.14 155)` text / `oklch(94-96% 0.05 155)` bg, icon ✓. Medium 70–94% → amber `oklch(48-52% 0.15 80)` text / `oklch(94-96% 0.06 80)` bg, icon !. Low <70% → red `oklch(48-52% 0.18 25)` text / `oklch(94-96% 0.06 25)` bg, icon ✕.
- **Radii**: 6-8px (buttons/small), 10-14px (cards), 999px (pills/badges).
- **Type scale**: page title 32px/700; card headers 16px/600; body 13.5-15px; stat numbers 22-28px/700 (mono); micro-labels 11-12px uppercase, letter-spacing 0.03-0.06em.

## Screens / Views
Navigation is a single-page client-side view switch (`state.view`), no routing library needed but should map to real routes, e.g. `/dashboard`, `/upload`, `/review`, `/batch`, `/reconcile`, `/reconcile/review`, `/reconcile/batch`, `/settings`, plus disabled "coming soon" stubs for `/auto-categorize`, `/document-portal`, `/reports`.

### 1. Dashboard (`/dashboard`)
- H1 "Dashboard" + subtitle "Overview for July 2026".
- 4-col stat grid: Items extracted (245, +12% vs June in green), Pending review (dynamic count, amber note), Avg. confidence (dynamic %), QuickBooks (Connected ✓ in green, "Last synced 2h ago").
- Below: 2-col grid (1.4fr/1fr) — left: "Monthly extraction volume" bar chart (6 months Feb–Jul, current month bar teal, others light gray, values 60/72/68/85/78/100% height); right: "Quick actions" (2 buttons: "Upload invoices or receipts →" primary navy, "Review N pending items →" outlined) + "Recent activity" list (4 rows, text + relative time e.g. "2h ago", "Yesterday").

### 2. Upload & Extract (`/upload`)
Three sub-states driven by one flow:
- **Idle**: large dashed drop zone (14px radius, dashed border `oklch(85% 0.01 240)`), "Drag & drop files here", "or click to browse — PDF, CSV, OFX up to 25MB each", "Choose files" button. Below: 3 file-type chips (PDF=red-ish, CSV=green, OFX=amber) each with a 28px colored icon box + label.
- **Processing**: clicking the drop zone starts a simulated upload — "Extracting data from 12 files…" + horizontal progress bar (teal fill) animating 0→100% in ~9%/140ms increments, "{pct}% complete" mono caption below.
- **Done**: "12 items extracted" summary card with 3-col breakdown (Auto-approved 95%+ green, Needs review 70–95% amber, Flagged <70% red — counts computed from data) + 2 CTAs: "Review flagged items (N)" primary, "Back to dashboard" outlined.

### 3. Review & Edit (`/review`)
- List of only *pending* items (one card per item, 14px gap, 20/24px padding, 12px radius).
- Each card: merchant name (17px/600) + inline "✎ edit" toggle (swaps to a text input + Save/Cancel when editing — saving sets confidence to 99% and status to approved); mono metadata row (invoice #, date, amount, category); right-aligned confidence pill (tier icon + label + %); optional "Why flagged: {reason}" note in a light gray box; action row (Approve/Edit/Reject buttons — approve = green fill, edit = white bordered, reject = white bordered red text).

### 4. Batch Review (`/batch`)
- Progress subtitle "{reviewed} of {initial} flagged items reviewed" + thin progress bar.
- Toolbar: confidence filter select (All / Medium 70–95% / Low <70%), sort toggle button ("Sort: Lowest/Highest confidence first"), right-aligned bulk actions "Approve selected (N)" (green, disabled/50% opacity when none selected) and "Reject selected" (outlined red).
- Table: header row with select-all checkbox + Merchant/Invoice #/Date/Amount/Confidence/Actions columns (7-col grid: 32px 1.4fr 1fr 1fr 1fr 1.3fr 1.6fr). Each row: checkbox, merchant (600), mono invoice #/date/amount, confidence pill, per-row Approve/Reject buttons.
- Empty state: "All flagged items reviewed — nice work." centered message when list empties.

### 5. Bank Reconciliation — Upload Statement (`/reconcile`)
Same idle → processing → matched 3-state pattern as Upload:
- **Idle**: dashed drop zone, "Drop your bank statement here", "CSV, OFX, or PDF — we'll match it against your QuickBooks entries", "Choose statement" button.
- **Processing**: "Matching 8 transactions against QuickBooks…" + progress bar (10%/130ms increments).
- **Matched**: summary card "{matched} matched ✓ · {pending} need review ⚠" + "Review matches" CTA.

### 6. Review Matches (`/reconcile/review`)
- Subtitle + progress bar (same pattern as Review/Batch).
- Right-aligned "Approve selected (N)" bulk button.
- One card per pending match: checkbox + "NEEDS REVIEW" label (left), confidence pill (right); 2-col comparison (divided by a vertical border) — "Bank transaction" (desc, mono date · amount) vs "QuickBooks entry" (desc, mono date · amount); detail note box (e.g. "Amount ✓ · Date ≈ 2 days · Merchant ≈ 65%"); Approve match / Reject actions.
- Empty state message + "Generate reconciliation report" CTA button appears once all reviewed.

### 7. Reconciliation Batch Review (`/reconcile/batch`)
- Progress subtitle + bar.
- Toolbar row 1: confidence filter select + 3 sort toggle buttons (Confidence / Amount diff / Date gap, each showing ↑/↓ arrow for active sort).
- Toolbar row 2 (right-aligned): "Edit selected (N)", "Reject all", "Approve all".
- Table (6-col grid: 32px 1.3fr 1fr 1fr 0.9fr 1.3fr): checkbox, Bank/QuickBooks (2-line: bank desc bold, qb desc gray below), Amount diff (mono $), Date gap (mono "{n}d"), confidence pill, per-row "Select" button.
- Same empty state message as Batch Review.

### 8. Settings (`/settings`)
- 2-col grid: **Account** card (Name/Email/Plan key-value rows) and **QuickBooks integration** card (connection status label — green "Connected ✓" or red "Disconnected" — + "Last synced 2h ago" + Disconnect/Reconnect toggle button).
- **Audit log** card below (full width): table of {date (mono), action (600), user, change} rows, no header row, just top border between rows.
- "Sign out" button (outlined, red text) at the bottom.

### 9. Coming Soon stub (`/auto-categorize`, `/document-portal`, `/reports`)
- Centered narrow (520px) block: 48px icon square (⏳) on light gray bg, phase eyebrow ("Phase 5 · Coming soon" in teal uppercase), H1 title, description paragraph. Content varies per route (see Sample Data below).

## Interactions & Behavior
- **View switching**: instant, client-side, no transition animation.
- **Sidebar collapse**: toggled via ☰ click or Cmd/Ctrl+B; animates width 240px↔72px over 0.15s ease; hides labels/group headers/footer when collapsed, centers icons.
- **Upload simulation**: clicking the drop zone starts a fake progress timer (~140ms tick, +9% each tick) that lands on a "done" summary; purely client-side simulation — replace with real upload/extraction API call + progress reporting.
- **Reconcile simulation**: same pattern, 130ms tick, +10% each tick, ends in "matched" summary.
- **Inline edit**: clicking "✎ edit" on a Review & Edit card swaps merchant name for a text input with Save/Cancel; Save sets confidence to 99% and status to approved (in the real app this should re-run extraction confidence, not hardcode).
- **Approve/Reject**: per-item and bulk (checkbox selection + "Approve selected"/"Reject selected"), same pattern in Batch Review and Reconciliation Batch Review. Bulk actions show a 2.5s toast confirmation (e.g. "3 items approved").
- **Select-all checkbox** in Batch Review header toggles all currently-filtered rows.
- **Filter & sort**: Batch Review filters by confidence tier (all/medium/low) and sorts by confidence only (asc/desc toggle). Reconciliation Batch Review adds two more sort keys (amount diff, date gap) with per-column arrow indicators; clicking an already-active sort button flips direction, clicking a different one resets to descending.
- **QuickBooks connect/disconnect**: toggle button in Settings flips connection state and shows a toast.
- No loading/error states are modeled beyond the simulated progress bars — real implementation needs actual async states (upload error, extraction failure, no network, etc.) which are not designed here — flag to the user/design team if needed.

## State Management
Suggested state shape (mirrors the prototype's single component state):
- `view`: current route/tab id.
- `sidebarCollapsed`: boolean.
- `items[]`: extracted line items — `{id, merchant, amount, date, invoiceNumber, confidence, category, status: pending|approved|rejected, reason}`. Confidence tiers derived as: ≥95 high, 70–94 medium, <70 low.
- `uploadStage`: idle | processing | done; `uploadProgress`: 0–100.
- `editingItemId` / `editingValue`: inline-edit state for Review & Edit.
- `selectedIds[]`: batch-review checkbox selection.
- `batchFilterTier`: all | medium | low; `batchSortDesc`: boolean.
- `matches[]`: reconciliation matches — `{id, bankDesc, bankDate, bankAmount, qbDesc, qbDate, qbAmount, confidence, detail, status: matched|pending|rejected, dateGapDays}`.
- `reconcileStage`: idle | processing | matched.
- `selectedMatchIds[]`, `reconcileBatchFilter`, `reconcileBatchSortBy` (confidence|amountDiff|dateGap), `reconcileBatchSortDesc`, `reconcileBatchSelectedIds`.
- `qbConnected`: boolean.
- `auditLog[]`: `{date, action, user, change}`.
- `toast`: transient message string, auto-clears after 2.5s.
- Derived/computed everywhere: pending counts, tier counts, review progress percentages, filtered/sorted lists — recompute from source arrays rather than storing separately.
- All data in the prototype is mocked/hardcoded (see "Sample Data" below) — real implementation needs actual extraction, matching, and QuickBooks integration APIs.

## Sample Data (for reference / seeding fixtures)
Full mock datasets (12 line items, 8 bank/QuickBooks matches, 4 audit log entries, monthly chart values Feb–Jul) are in the `items`, `matches`, `auditLog` arrays and `chartData` inside the class body of `Zaki Ledger.dc.html` — copy these directly as fixture/seed data if useful; they are not meant to be permanent production content. "Coming soon" copy for Auto-Categorize, Document Portal, and Reports & Analytics is in the `comingSoonMeta` object in the same file.

## Assets
No external image assets — all icons are emoji glyphs (🏠📤✏️✅🏦🔍✔️📁📋📊⚙️⏳✓!✕✎). No logos or illustrations. Typography via Google Fonts (Inter, IBM Plex Mono) — use the same Google Fonts CDN or self-host the same families/weights.

## Files
- `Zaki Ledger.dc.html` — the full app prototype (all 9 screens, sidebar, all interaction logic). This is the primary reference.
- `Zaki Ledger Walkthrough.dc.html` — a screenshot-carousel viewer, NOT part of the app; reference only (screenshots themselves are not included in this bundle).
