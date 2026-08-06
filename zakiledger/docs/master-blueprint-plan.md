# Zaki Ledger — Master Implementation Plan

> **Last updated:** 8 May 2026

---

## ⚠️ RULE 1

**ONE SUB-PHASE PER ACT MODE SESSION.** Copy the sub-phase prompt below into a fresh chat. Complete it. Run `npx tsc --noEmit && npx vitest run`. Stop. Do not start the next sub-phase in the same chat.

---

## Phase 1: Cross-File Comparison Engine

The accountant's #1 request: upload a bank CSV + QB CSV, AI finds missing transactions, duplicates, amount differences, and unmatched items.

### 1a — Define Comparison Schema & Types
```
Phase 1a: Define Comparison Schema & Types

Working directory: zakiledger/

Create lib/comparison-schema.ts with Zod schemas and TypeScript types for cross-file comparison results.

Types needed:
- ComparisonIssueSeverity: "info" | "warning" | "critical"
- MissingTransaction: { entry, source ("bank"|"qb"), reason }
- DuplicateTransaction: { entries[], source, reason }
- AmountMismatch: { bankTransaction, qbTransaction, bankAmount, qbAmount, difference, reason }
- UnmatchedItem: { transaction, source, possibleMatches[], severity }
- ComparisonMatch: { bankTransaction, qbTransaction, matchType ("exact"|"fuzzy_amount"|"fuzzy_merchant"|"fuzzy_date"), confidence }
- ComparisonFilters: { dateStart?, dateEnd?, minAmount?, maxAmount? }
- ComparisonResult: { matches[], missingInBank[], missingInQb[], duplicates[], amountMismatches[], unmatchedItems[], summary }

Import BankTransaction and QbTransaction from "./reconciliation-schema".

After: cd zakiledger && npx tsc --noEmit. Fix errors. Stop.
```

### 1b — Build Deterministic Comparison Logic
```
Phase 1b: Build Deterministic Comparison Logic

Working directory: zakiledger/

Create lib/comparison-engine.ts with pure function compareBankToQb(bankTransactions, qbTransactions, filters?): ComparisonResult

Deterministic matching (no AI):
1. Filter by date range if provided
2. Match on exact amount (±1%) + date (±5 days) → "exact"
3. Amount matches but date differs → "fuzzy_date"
4. Date+merchant match but amount differs (>1%, <5%) → AmountMismatch
5. Bank txns with no QB match → unmatchedItems
6. QB txns with no bank match → missingInBank
7. Two+ bank txns matching same QB → DuplicateTransaction

Also create tests/comparison-engine.test.ts with: exact match, extra bank, extra QB, fuzzy date, amount mismatch, duplicates, date filter, empty arrays.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 1c — Claude Sonnet Fuzzy Merchant Resolution
```
Phase 1c: Claude Sonnet Fuzzy Merchant Resolution

Working directory: zakiledger/

Create lib/comparison-ai.ts with function resolveFuzzyMerchants(unmatchedBank, unmatchedQb): Promise<FuzzyResolution[]>

Uses Claude 3.5 Sonnet to resolve "AMZN MKTP" → "Amazon Web Services" style mismatches.
FuzzyResolution: { bankTransactionId, qbTransactionId|null, resolvedBankMerchant, resolvedQbMerchant, confidence, explanation }

Claude prompt: Look at amounts, dates, and raw strings. Recognize common patterns (SQ* = Square, TFL = Transport for London, AMZN = Amazon). Never invent matches. Return null qbTransactionId if uncertain.

Then modify lib/comparison-engine.ts to add compareBankToQbWithAI() that runs deterministic + Claude in one call. Keep the pure compareBankToQb() for testing.

Create tests/comparison-ai.test.ts: demo mode (no API key returns empty array), schema validation, integration test with fuzzy merchant fixture.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 1d — API Route for Comparison
```
Phase 1d: API Route for Comparison

Working directory: zakiledger/

Create POST route at app/api/reconciliation/compare/route.ts
- Accepts multipart/form-data: bankFile (File), qbFile (File), dateStart?, dateEnd?
- Parse both files using existing parseCsvStatement/parseOfxStatement from lib/bank-parsers.ts
- Convert QB side using parsedTransactionsToQbInputs
- Call compareBankToQbWithAI from lib/comparison-engine.ts
- Return ComparisonResult as JSON

Error handling: missing file → 400, invalid CSV → 400, unexpected → 500

Create tests/comparison-api.test.ts: valid two-file upload, missing bankFile, missing qbFile, invalid CSV, date filter, OFX bank + CSV QB.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 1e — Upload UI for Comparison
```
Phase 1e: Upload UI for Comparison

Working directory: zakiledger/

Create three files:

1. app/(app)/reconciliation/compare/page.tsx ("use client")
   Title: "Cross-File Comparison" with subtitle. Manages comparisonResult, isLoading, error state.
   POSTs to /api/reconciliation/compare with FormData on submit.

2. components/reconciliation/compare-upload.tsx ("use client")
   Two drag-and-drop zones: "Bank Statement (CSV/OFX)" and "QuickBooks Export (CSV)"
   Two optional date inputs (start/end). "Compare Files" button.
   Props: onCompare(files, dateRange)

3. components/reconciliation/comparison-results.tsx ("use client")
   Sections: Matched ✅, Missing in QB ⚠️, Missing in Bank ⚠️, Duplicates 🔴, Amount Mismatches 🔴, Unmatched ❓
   All collapsible with count badges. Color coding: green/yellow/red. Summary card at top.

Use Tailwind CSS. Keep consistent with existing app style.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

---

## Phase 2: Claude Sonnet Audit Memo Layer

Claude writes plain-English explanations for every match decision.

### 2a — Audit Memo Schema
```
Phase 2a: Audit Memo Schema

Working directory: zakiledger/

Create lib/audit-memo-schema.ts with Zod schemas:
- AuditCategory: "PERFECT_MATCH" | "FUZZY_MERCHANT" | "FUZZY_AMOUNT" | "FUZZY_DATE" | "TAX_MISMATCH" | "DUPLICATE_WARNING" | "UNMATCHED"
- AuditSeverity: "info" | "warning" | "critical"
- AuditMemo: { matchId, category, severity, title, explanation, suggestedAction, taxRelevant, ruleReference, matchedFields[], mismatchedFields[] }
- AuditMemoBatch: array of AuditMemo

After: cd zakiledger && npx tsc --noEmit. Fix. Stop.
```

### 2b — Claude Audit Memo Generator
```
Phase 2b: Claude Audit Memo Generator

Working directory: zakiledger/

Create lib/audit-memo-generator.ts with function generateAuditMemos(matches, bankTransactions, qbTransactions): Promise<AuditMemo[]>

Claude prompt: UK bookkeeping platform. Write plain English a bookkeeper can act on in seconds.
- PERFECT_MATCH when amount+date+merchant align
- TAX_MISMATCH when total/1.2 ≈ round number (UK VAT 20% not itemized)
- FUZZY_MERCHANT when amount+date match but names differ
- Never fabricate details

Demo mode (no API key): return template memos based on match.flaggedLevel.

Create tests/audit-memo.test.ts: demo mode green→PERFECT, yellow→FUZZY_MERCHANT, red→UNMATCHED, empty array, valid categories.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 2c — Wire Memos into Reconciliation Store
```
Phase 2c: Wire Audit Memos into Reconciliation Store

Working directory: zakiledger/

1. MODIFY lib/reconciliation-schema.ts: add auditMemo: AuditMemo|null field to ReconciliationMatch

2. MODIFY lib/reconciliation-store.ts:
   - Import generateAuditMemos
   - In computeAndPersistMatches: generate memos for new auto-matches before persisting, store as auditMemo
   - In createManualMatch: generate a single PERFECT_MATCH memo
   - Update mapMatchRow to parse JSONB audit_memo column

3. Update existing tests to include auditMemo field (null is fine for old tests, add one test verifying memo generation)

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

---

## Phase 3: Three-Tab Reconciliation Dashboard

The 9:00 AM bookkeeper experience: 🟢 Green / 🟡 Fuzzy / 🔴 Exceptions.

### 3a — Dashboard Data Pipeline
```
Phase 3a: Dashboard Data Pipeline

Working directory: zakiledger/

Create lib/dashboard-pipeline.ts with getDashboardData(userId, statementId): Promise<DashboardData>

DashboardData: { statement, greenMatches[], yellowMatches[], redMatches[], unmatchedBank[], unmatchedQb[], report }
MatchWithDetails: { match, bankTransaction, qbTransaction, auditMemo }

Fetches everything in one call, groups by flaggedLevel, looks up transaction details per match.

Create GET route at app/api/reconciliation/[id]/dashboard/route.ts that calls getDashboardData.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 3b — Match Card Component
```
Phase 3b: Match Card Component

Working directory: zakiledger/

Create components/reconciliation/match-card.tsx ("use client")

Props: match, bankTransaction, qbTransaction, auditMemo, onApprove, onReject, onManualMatch

Layout:
- Colored left border (green/yellow/red)
- Top: confidence badge + match type
- Middle: two columns (Bank ↔ QB) with amount, date, merchant
- Match reason line below
- Expandable audit memo section (title, explanation, suggestedAction, tax badge)
- Actions: Approve (green/yellow), Reject (all), Manual Match (unmatched)

Use Tailwind CSS. Keep consistent with existing app style.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 3c — Three-Tab Page Layout
```
Phase 3c: Three-Tab Page Layout

Working directory: zakiledger/

Create three files:

1. components/reconciliation/tab-bar.tsx ("use client")
   Tabs with colored underline + count badges. Props: tabs[], activeTab, onTabChange

2. components/reconciliation/match-list.tsx ("use client")
   Renders MatchCard list. Empty state with message. Props: matches[], onApprove, onReject, onManualMatch, emptyMessage

3. app/(app)/reconciliation/[id]/page.tsx ("use client")
   Fetches from /api/reconciliation/[id]/dashboard. Three tabs: ✅ Perfect (N), ⚠️ Review (N), 🔴 Exceptions (N).
   Statement metadata header. Summary bar: matched total, unmatched, variance.
   Approve/Reject calls existing API endpoints.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 3d — Bulk Approve & Sync
```
Phase 3d: Bulk Approve & Sync

Working directory: zakiledger/

Add "Approve & Sync All" button to the green tab that:
1. Calls approveMatches for all green match IDs
2. Shows a progress indicator
3. Refreshes the dashboard data after completion
4. Handles partial failures (some approved, some errored)

Modify match-card.tsx header on green tab to include a "Select All" checkbox and bulk action bar.
Modify the page.tsx to wire the bulk action.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

---

## Phase 4: Nightly Cron + On-Demand Pipeline

### 4a — Nightly Match Orchestrator
```
Phase 4a: Nightly Match Orchestrator

Working directory: zakiledger/

Create lib/nightly-match.ts with runNightlyMatch(userId): Promise<NightlyResult>

Flow:
1. Pull un-reconciled bank transactions from QB/Xero APIs (using stored OAuth tokens from lib/oauth-store.ts)
2. Pull all reconciliation_ready invoices from Supabase holding bay (lib/store.ts)
3. Run computeAndPersistMatches for the combined dataset
4. Generate audit memos for all new matches
5. Write results to reconciliation_matches table
6. Return summary: { statementsProcessed, matchesFound, greenCount, yellowCount, redCount, errors[] }

Create tests/nightly-match.test.ts: mock OAuth, mock Supabase, verify flow.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 4b — Cron API Endpoint
```
Phase 4b: Cron API Endpoint

Working directory: zakiledger/

Create app/api/cron/nightly-match/route.ts
- GET handler (Vercel Cron uses GET)
- Protected by CRON_SECRET header check
- Calls runNightlyMatch for all active users
- Returns JSON summary
- 401 if missing/invalid secret, 200 with results otherwise

Add CRON_SECRET to zakiledger/.env.example.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 4c — On-Demand Fallback Mode
```
Phase 4c: On-Demand Fallback Mode

Working directory: zakiledger/

Create POST route at app/api/reconciliation/on-demand/route.ts
- Accepts { statementId } in body
- Runs the same pipeline as nightly-match but scoped to one statement
- Returns match results immediately (synchronous response, no polling needed)

Wire a "Run Matching Now" button on the reconciliation page that calls this endpoint.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

---

## Phase 5: Live Upload + Realtime Progress

### 5a — Realtime Progress Streaming
```
Phase 5a: Realtime Progress Streaming

Working directory: zakiledger/

Create lib/realtime-progress.ts:
- publishProgress(userId, statementId, stage, details) — pushes to Supabase Realtime channel
- ProgressStage: "uploading" | "parsing" | "extracting" | "matching" | "generating_memos" | "complete" | "error"

Create hook hooks/use-reconciliation-progress.ts:
- Subscribes to Supabase Realtime channel for a statement
- Returns { stage, details, progress% }

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 5b — Progress UI Component
```
Phase 5b: Progress UI Component

Working directory: zakiledger/

Create components/reconciliation/progress-stream.tsx ("use client")
- Uses useReconciliationProgress hook
- Shows animated progress bar with stage labels
- Each stage lights up as it completes
- Error state: shows what went wrong with retry button
- "Complete" state: auto-redirects to the dashboard page after 2 seconds

Integrate into the upload flow on the reconciliation page.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

---

## Phase 6: Integration & Polish

### 6a — End-to-End Flow Test
```
Phase 6a: End-to-End Flow Test

Working directory: zakiledger/

Create tests/e2e/reconciliation-flow.test.ts:
- Upload bank CSV → parse → store
- Upload QB CSV → parse → store
- Run matching → verify green/yellow/red distribution
- Approve green matches → verify report generated
- Bulk approve → verify all approved
- Cross-file compare → verify mismatch detection

Use existing test fixtures from tests/fixtures/.

After: cd zakiledger && npx tsc --noEmit && npx vitest run. Fix. Stop.
```

### 6b — Documentation & README Update
```
Phase 6b: Documentation & README Update

Working directory: zakiledger/

1. Update zakiledger/README.md architecture diagram to reflect:
   - Cross-file comparison engine
   - Three-tab dashboard
   - Nightly cron pipeline
   - Audit memo layer

2. Update zakiledger/.env.example with all new required variables:
   - CRON_SECRET
   - Any new API keys

3. Create zakiledger/docs/accountant-workflow.md:
   - Step-by-step guide for the cross-file comparison feature
   - Screenshot placeholders
   - Common troubleshooting

After: cd zakiledger && npx tsc --noEmit. Fix. Stop.
```

---

## Summary

| Phase | Sub-phases | What It Delivers |
|---|---|---|
| 1 | 1a–1e | Cross-file bank vs QB comparison with Claude fuzzy matching + upload UI |
| 2 | 2a–2c | Claude audit memos explaining every match decision |
| 3 | 3a–3d | Three-tab dashboard (green/yellow/red) with bulk approve |
| 4 | 4a–4c | 2:00 AM cron job + on-demand matching |
| 5 | 5a–5b | Supabase Realtime progress streaming |
| 6 | 6a–6b | E2E tests + documentation |

**Total: 19 sub-phases. One per chat session.**