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
 /api/extract ──► GPT-4o-mini (primary) → Claude Sonnet (escalation on low confidence)
        │            └─ returns structured JSON + per-field confidence + per-field reason
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

### Uploading several at once

Picking 2+ files hands off to `/api/extract-batch`, which reads them in parallel
(up to `EXTRACT_CONCURRENCY`, currently 5 — a ceiling, so a fifty-file drop can't
turn a provider rate limit into "your upload failed") and **streams NDJSON**, one
line per document as it lands:

```
{"type":"start","total":5}
{"type":"result","index":1,"filename":"receipt-2.png","status":"success",…}
{"type":"summary","total":5,"succeeded":4,"failed":1,"queued":4}
```

Streaming rather than one array at the end is what makes the progress real. A
response that arrives when everything is finished gives the UI nothing to report
until there's nothing left to report, so any "3 of 5" drawn from it would be an
animation. Lines arrive in *completion* order and each carries its `index`, so
the list stays in the order the files were picked.

One unreadable file is one failed row: it reports its own reason and the other
four are untouched and still queued. The reading itself is
`lib/extract-pipeline.ts`, shared with the single-file route — "run the existing
extract logic on each file" means the same logic, not a copy that drifts.

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
- **OpenAI** (`openai`, `gpt-4o-mini`) for primary vision extraction
- **Claude** (`@anthropic-ai/sdk`, `claude-sonnet-4-5`) for escalation on low-confidence documents
- **Supabase / Postgres** for data + the correction ledger + file storage
- **Tailwind + shadcn/ui** for the review UI (add as you flesh out the front end)
- **Xero API** as the first accounting integration (Month 3)

## Running it — three tiers of testing

Zaki Ledger has Supabase Auth in front of it, and that part has no offline mode:
every page requires `SUPABASE_URL` + `SUPABASE_ANON_KEY` even before you touch any
of the tiers below, and the first account you create adopts any pre-existing data
in the project (see "Auth setup" below). Once you're logged in, you can still test
at three levels from there, from zero-setup extraction to fully wired persistence
— each tier just adds a capability.

```
cd zakiledger
npm install
npm run dev          # → http://localhost:3000, redirects to /login
```

**Tier 1 — Demo extraction (no Anthropic key, no persistence).** Sign up, then
upload anything. With no `ANTHROPIC_API_KEY` set, uploading *any* file returns a
realistic sample invoice so you can click the whole flow: review → edit a flagged
field → approve → see "correction recorded." Corrections live in memory (reset on
restart, and — without `SUPABASE_SERVICE_ROLE_KEY`, see tier 3 — shared by whoever
is logged in, since there's no database backing per-user isolation yet). Perfect
for showing an accountant the UX in 30 seconds.

**Tier 2 — Real extraction.** Copy `.env.example` to `.env.local` and set
`ANTHROPIC_API_KEY`. Now uploads are read by Claude vision — real invoices, real
confidence scores. Corrections still in memory unless you add tier 3.

**Tier 3 — Real persistence.** Also set `SUPABASE_SERVICE_ROLE_KEY`, and run
`db/schema.sql` in your Supabase project's SQL editor. Now approved invoices and
the correction ledger persist across restarts, scoped per user — the moat is live.
(`db/schema.sql` is idempotent — re-run it after pulling to pick up new columns,
including the `pending_documents` table bulk approve reads from and the per-user
`user_id` columns auth added.)

In demo mode the queue starts empty; **Load a demo batch** seeds five documents —
three clean receipts, one smudged merchant name, one unpostable currency — so
bulk approve can be exercised end to end with no Anthropic key.

### Auth setup

1. In the Supabase dashboard: **Authentication → Settings** — enable the
   Email/Password provider, and turn OFF "Confirm email" so signup logs a user in
   immediately (this app doesn't build a check-your-email screen).
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API).
3. Sign up. **The first account ever created in the project adopts every row that
   predates auth** (any pending documents, invoices, and corrections written
   before this feature existed, plus an existing Xero/QuickBooks connection) —
   see `lib/auth.ts`. If you're deploying somewhere public, sign up immediately
   after your first deploy, before anyone else finds the URL.

#### Uploads succeed but `/pending` stays empty

The queue write is non-fatal by design — a broken queue must never cost you an
extraction — so this shows up as documents that read fine and then don't appear.
The review screen now says so explicitly when it happens, and the server logs
`[pending-queue] could not queue this document`.

Almost always the `pending_documents` table is missing or out of date. **Re-run
`db/schema.sql`** — the fix is the `alter table … add column if not exists` block,
because `create table if not exists` is a no-op against a table that already
exists with different columns and will not repair one. Re-running the whole file
is safe.

Two divergences seen in the wild, both repaired by that re-run:

| Log says | Cause |
| --- | --- |
| `Could not find the 'extraction' column` | table created from a different definition |
| `null value in column "user_id" … violates not-null constraint` | table came from a **multi-tenant** definition |

The second is worth understanding rather than working around: **Zaki Ledger has
no authentication** — no login, no Supabase session, no users table. Routes reach
Postgres with the service-role key, so there is no "current user" to put in a
`user_id`, and no application change can supply one. The migration drops that
NOT NULL rather than inventing an ID, because fabricated attribution in a
bookkeeping audit trail is worse than no attribution. If the app ever grows real
accounts, a real user id gets plumbed through and the constraint comes back.

If you would rather start clean than converge a foreign table — and the queue has
never successfully held anything, so there is nothing to lose — `drop table
pending_documents;` then re-run `db/schema.sql`.

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
