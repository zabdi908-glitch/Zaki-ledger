# Zaki Ledger — MVP

An AI copilot that reads invoices/receipts, extracts the data with a **confidence
score**, lets an accountant approve with one click, and **gets smarter from every
correction** (the correction ledger).

> **Month-1 scope (the "prove ONE thing works" mission):**
> upload an invoice → Claude extracts fields → confidence-scored review → approve →
> (later) post to Xero. Every correction is captured to make the next extraction better.

## Architecture (the shape of it)

```
 Upload invoice (PDF/image)
        │
        ▼
 /api/extract ──► Claude (claude-opus-4-8, vision)  ◄── few-shot hints from past corrections
        │            └─ returns structured JSON + per-field confidence
        ▼
 Review screen  (high-confidence auto-filled, low-confidence flagged for a human)
        │
        ▼
 /api/approve ──► writes the approved record
                  AND appends every human edit to the CORRECTION LEDGER
                        │
                        └─ that ledger is BOTH the audit trail AND the training data
```

**Principle #1 — human-in-the-loop:** the AI drafts, the human approves. Nothing
posts silently. Every action is logged and reversible.

## The moat: the correction ledger

`db/schema.sql` defines an append-only `corrections` table. Every time a human
changes a field the AI proposed, we store: what the AI predicted, what the human
corrected it to, and the source document. That table is:

- the **audit trail** accountants demand (compliance), and
- the **training data** that makes extraction smarter per client (the flywheel).

One table, two payoffs. It is populated from invoice #1 — never bolt it on later.

## Tech stack

- **Next.js + TypeScript** (one codebase, front + API routes)
- **Claude** (`@anthropic-ai/sdk`, model `claude-opus-4-8`) for vision extraction
- **Supabase / Postgres** for data + the correction ledger + file storage
- **Tailwind + shadcn/ui** for the review UI (add as you flesh out the front end)
- **Xero API** as the first accounting integration (Month 3)

## Running it

> ⚠️ **Honest note:** this is a working skeleton, not a finished, tested app. It needs
> real API keys and a Postgres/Supabase database to run end-to-end. It has **not** been
> executed here (no keys in this environment). Treat it as the scaffold to build on.

1. `cd zaki-ledger/app && npm install`
2. Copy `.env.example` to `.env.local` and fill in the keys.
3. Create the database tables: run `db/schema.sql` against your Postgres/Supabase DB.
4. `npm run dev` → open http://localhost:3000

## Next steps (mirrors the roadmap)

- [ ] Wire the correction ledger to Supabase (currently an in-memory stub in `lib/store.ts`)
- [ ] Add supplier-specific few-shot retrieval (learn per vendor)
- [ ] Add the Xero OAuth flow + "post to Xero" action
- [ ] Bulk approve + full audit-log view
- [ ] Receipts (not just invoices)
