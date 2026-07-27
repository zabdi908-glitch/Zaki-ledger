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

### The approval queue (`/pending`)

Reading a document also parks it in an **approval queue** (`pending_documents`),
which is what gives it an id before it is approved. `/pending` lists everything
waiting — merchant, amount, date, confidence, type — with two ways through it:

- **Approve** on a row, for working down the queue one at a time.
- **Approve Selected**, which appears once 2+ are ticked. Below that it would
  just be a second, worse button for the row action already sitting there.

Both hit the same endpoint with the same gate, so a document is judged
identically whether it was approved alone or in a batch of ten — the single-row
button is a batch of one, not a separate code path. **View details** expands the
full extraction with a confidence score per field, fetched on demand so the list
itself stays light.

`/api/approve/bulk` runs the *same* `gateApproval` decision over each document
independently, posting only the ones that clear it:

```
 POST /api/approve/bulk  { documentIds: [...] }
        │
        ├─ per document, in sequence ──► currency check → confidence gate →
        │                                arithmetic → duplicate → ledger → bill
        │
        ▼
 { results: [ per-item status + merchant + total + reason ],
   summary: "3 approved, 1 blocked, 1 error | Total posted: £315.60" }
```

Two rules make it safe to press:

- **Documents are independent.** One document's bad currency or a platform
  outage produces one error result; the other nine still get approved.
- **The bar is higher than the review screen's, because nobody is watching.**
  The review screen offers "Approve anyway" on a flagged field — a human is
  looking right at it. In bulk only a clean `ready` posts; anything uncertain
  (low confidence, unclassifiable type, arithmetic that doesn't reconcile, a
  possible duplicate) comes back with the reason and stays in the queue.

Approved documents leave the queue; blocked and errored ones stay, carrying the
reason, so the queue is always "what still needs a human".

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

## Running it — three tiers of testing

You can test at three levels, from zero-setup to fully wired. All of them are the
same app; each tier just adds a capability.

```
cd zakiledger
npm install
npm run dev          # → http://localhost:3000
```

**Tier 1 — Demo mode (no keys, no database).** Just run it. With no
`ANTHROPIC_API_KEY` set, uploading *any* file returns a realistic sample invoice
so you can click the whole flow: review → edit a flagged field → approve → see
"correction recorded." Corrections live in memory (reset on restart). Perfect for
showing an accountant the UX in 30 seconds.

**Tier 2 — Real extraction.** Copy `.env.example` to `.env.local` and set
`ANTHROPIC_API_KEY`. Now uploads are read by Claude vision — real invoices, real
confidence scores. Corrections still in memory unless you add tier 3.

**Tier 3 — Real persistence.** Also set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
and run `db/schema.sql` in your Supabase project's SQL editor. Now approved
invoices and the correction ledger persist across restarts — the moat is live.
(`db/schema.sql` is idempotent — re-run it after pulling to pick up the
`pending_documents` table that bulk approve reads from.)

In demo mode the queue starts empty; **Load a demo batch** seeds five documents —
three clean receipts, one smudged merchant name, one unpostable currency — so
bulk approve can be exercised end to end with no key and no database.

### Testing it on a URL (share with a real accountant)

Deploy to **Vercel** (it auto-detects Next.js — no config needed):
1. Push this repo (done) and import it at vercel.com → set the root directory to
   `zakiledger`.
2. Deploy with **no env vars** → you get a public URL running in demo mode.
3. Add `ANTHROPIC_API_KEY` (and optionally the Supabase vars) in Vercel → Settings
   → Environment Variables, then redeploy to go from demo to real.

## Next steps (mirrors the roadmap)

- [x] Wire the correction ledger to Supabase (`lib/store.ts` is now Supabase-backed, with an in-memory fallback when keys are absent; `/api/approve` also persists the approved invoice)
- [x] Add supplier-specific few-shot retrieval (learn per vendor) — `/api/extract` now does a
  two-pass read: pass 1 identifies the supplier, then if we hold corrections for that supplier it
  re-extracts with their targeted hints (second call only fires when supplier history exists)
- [ ] Add the Xero OAuth flow + "post to Xero" action
- [x] Bulk approve — an approval queue (`pending_documents`) plus `/api/approve/bulk`, which runs
  the existing `gateApproval` per document independently, posts only the ones that clear it, and
  reports per-item status/reason with a summary. Blocked and errored documents stay queued with
  the reason attached
- [ ] Full audit-log view
- [ ] Receipts (not just invoices)
