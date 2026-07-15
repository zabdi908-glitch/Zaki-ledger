# Handoff — start here

> For a fresh session: read this, then `docs/FOCUS.md`, `docs/ROADMAP.md`, and `docs/PLAYBOOK.md`.
> Everything below is already in the repo. Last updated at the end of the first build session.

## What Zaki Ledger is
An AI copilot for UK bookkeepers that kills manual invoice data entry: upload an invoice → AI
extracts every field with a confidence score → human approves in one click → every correction is
logged (audit trail) and makes the next read smarter (the moat). Human-in-the-loop always. Sits on
top of Xero/QuickBooks. Solo founder (Zaki/Zachi), pre-launch, UK.

## 🎯 The one target right now (see FOCUS.md)
**Get ONE bookkeeper to try it and say "that saved me time."** Not ten, not a finished product —
one believer. Filter for every task: *"Does this get a bookkeeper to try it this week?"* If no, park it.

## What's BUILT (product — in `zakiledger/`)
- Invoice extraction w/ confidence scores (Claude vision) · one-click approve · correction ledger
  (Supabase-wired + in-memory fallback) · **demo mode** (runs with no keys) · **per-supplier
  learning** (two-pass) · `/corrections` viewer · polished UI · `render.yaml` for deploy.
- Verified via typecheck/build + demo E2E. **Live extraction untested — needs a real ANTHROPIC_API_KEY.**
- NOT built yet (later): posting into Xero/QuickBooks (Month 3), receipts, bulk approve, auth +
  multi-tenancy (before 10 concurrent clients), reconciliation (Month 4).

## What's READY (go-to-market — in `zakiledger/docs/`)
- `prospects.md` — 40 firms verified, with hooks + ICP screening (staying **UK small-firm only**).
- `outreach/wave-1.md` — 9 ready-to-send personalised emails (text only; no attachments on cold send).
- `content/linkedin.md` — content bank (post weekdays only). Demo video + caption ready to post.
- `prompts/` (master + outreach), `onboarding-sop.md`, `getting-started.md`, `glossary.md`,
  `knowledge-base.md`.

## Immediate next steps (in order)
1. **Buy `zakiledger.co.uk` + mailbox** → then set SPF/DKIM/DMARC (ask the assistant for exact records once provider is known).
2. **Deploy to Render** (blueprint ready) with `ANTHROPIC_API_KEY` → run the real extraction + learning test.
3. **Send Wave 1** (text only) + **post the demo** on LinkedIn + reply to warm connections (Becky, Amanjot).
4. **Book a 20-min call** → show the demo → get the first believer.

## Key decisions & facts
- **Provider:** built on Anthropic (Claude). OpenAI key won't drop in without an adapter; Anthropic
  is pay-as-you-go (pennies to test). Founder plans to add credit after payday.
- **Market:** UK small bookkeeping firms only. US/large firms rejected (logged in prospects.md).
- **Domain not bought yet.** Business email `zachi@zakiledger.co.uk` is aspirational until then.
- **Repo/branches:** work happens on `claude/zaki-ledger-migration-xe84mw`; founder merges to `main`
  via PRs. All work to date is on `main`.
- **No accounting/tax advice** to customers — product help only (liability + positioning).

## Doc map
`FOCUS.md` (the target) · `ROADMAP.md` (6-month plan + Path to 10 clients) · `PLAYBOOK.md` (GTM +
Dan Martell frameworks) · `prospects.md` · `outreach/wave-1.md` · `onboarding-sop.md` ·
`getting-started.md` · `glossary.md` · `content/linkedin.md` · `prompts/` · `knowledge-base.md`.
