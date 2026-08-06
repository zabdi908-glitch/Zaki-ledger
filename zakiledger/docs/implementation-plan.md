# Zaki Ledger — Extraction Rebuild Implementation Plan

> Track progress: mark each sub-phase `[x]` when done. Commit after each phase.

---

## Phase 1: Schema hardening + model landmine removal (Item 4)

### 1.1 — Add `reason` to ConfidentString and ConfidentNumber (`lib/schema.ts`)
- [x] Add `reason: z.string()` to `ConfidentString` (after `confidence`)
- [x] Add `reason: z.string()` to `ConfidentNumber` (after `confidence`)
- [x] Add `reason: z.string()` to `ConfidentDocumentType`
- [x] Fix `lib/demo.ts` fixtures to include `reason` field
- [x] Fix `tests/bulk-approve.test.ts` to include `reason` field

### 1.2 — Add `reason` to reconciliation schemas (`lib/reconciliation-schema.ts`)
- [x] Define `ConfidentString` / `ConfidentNumber` wrapper pair matching schema.ts shape
- [x] Update `ParsedBankTransactionSchema`: wrap key fields (transactionDate, merchant, description, amount) in wrapper types
- [x] Fix `lib/bank-parsers.ts` CSV/OFX parsers to output wrappers
- [x] Fix `lib/bank-statement-pdf.ts` demo statement to output wrappers
- [x] Fix `lib/reconciliation-store.ts` to unwrap `.value` for DB inserts
- [x] Fix `tests/reconciliation-qb-upload.test.ts` to use wrappers
- [x] Fix `tests/reconciliation-store.test.ts` to use wrappers

### 1.3 — Replace `claude-opus-4-8` with `claude-sonnet-4-5` (`lib/anthropic.ts`)
- [x] Change `const MODEL = "claude-opus-4-8"` → `const MODEL = "claude-sonnet-4-5"`
- [x] Rewrite comment: "most capable model" → "escalation model — runs only when GPT-4o-mini flags low confidence"

### 1.4 — Update README architecture diagram (`README.md`)
- [x] Replace `Claude (claude-opus-4-8, vision)` with `GPT-4o-mini → Claude Sonnet (escalation)`
- [x] Update tech stack list: OpenAI primary, Claude escalation

**Checkpoint:** Typecheck passes ✅. Commit.

---

## Phase 2: Two-tier extraction pipeline (Item 5)

### 2.1 — Add Sonnet escalation functions to `lib/anthropic.ts`
- [x] Add `extractDocumentEscalation(base64, mediaType, priorHints?)` — thin wrapper, same Zod schema, uses Claude Sonnet
- [x] Add `extractBankStatementEscalation(base64, mediaType)` — same for bank statement PDFs
- [x] Tighter system prompt: "escalation reviewer, focus on low-confidence fields"

### 2.2 — Wire OpenAI as primary in `lib/extract-pipeline.ts`
- [x] Change import: `extractDocument` from `"./anthropic"` → from `"./openai"`
- [x] Add import: `extractDocumentEscalation` from `"./anthropic"`
- [x] After pass-2 extraction: if `overallConfidence < 0.7` or any critical field < 0.5, run escalation
- [x] Update demo gate: production needs `OPENAI_API_KEY`; missing Anthropic key = skip escalation, flag for review

### 2.3 — Wire OpenAI as primary in `lib/bank-statement-pdf.ts`
- [x] Change import: `extractBankStatement` from `"./anthropic"` → from `"./openai"`
- [x] Add import: `extractBankStatementEscalation` from `"./anthropic"`
- [x] After OpenAI read: if >30% of transactions missing merchant+description, escalate
- [x] Update demo gate: check `OPENAI_API_KEY` first, fall back to demo

**Checkpoint:** Typecheck must pass. Commit.

---

## Phase 3: Configuration + environment (Item 6)

### 3.1 — Add `OPENAI_API_KEY` to `zakiledger/.env.example`
- [x] Add `# --- OpenAI (primary extraction) ---` section above the Anthropic section
- [x] Add `OPENAI_API_KEY=sk-...` with documentation comment
- [x] Update Anthropic section comment: now the escalation tier

**Checkpoint:** Commit.

---

## Phase 4: Verification (Item 7)

### 4.1 — Run typecheck
- [ ] `cd zakiledger && npx tsc --noEmit` — fix any type errors

### 4.2 — Run tests
- [ ] `cd zakiledger && npx vitest run` — fix any test failures (demo fixtures may need `reason` fields)

### 4.3 — Spot-check demo mode
- [ ] `npm run dev` with no API keys — verify demo extraction still works

**Checkpoint:** All green. Commit.

---

## Phase 5: Documentation (Item 8 + File Reconciliation Spec)

### 5.1 — Summarize all fixes
- [ ] Write summary of all 8 items to `FIXES_APPLIED.md` (or append to `BUGS_TO_FIX_SESSION.md`)

### 5.2 — Write file reconciliation spec
- [ ] Create `zakiledger/docs/file-reconciliation-spec.md`
- [ ] Sections: Overview, Supported formats, Ingestion flow, Four match categories, Matching logic, UI layout, Two-paths architecture, Implementation phases

---

## Completed Items (pre-existing, uncommitted)

- [x] 1. reconciliation-store.ts — approveMatches/unapproveMatches scoped to statement_id+user_id
- [x] 2. reconciliation_reports upsert hardened to preserve row id
- [x] 3. lib/openai.ts — GPT-4o-mini extraction with per-field reason
- [x] 4. package.json — OpenAI dependency added