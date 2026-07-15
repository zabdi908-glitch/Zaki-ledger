# Zaki Ledger — 6-Month Roadmap

> **Owner:** Zaki (Zachi) · Solo developer · UK
> **Started:** July 2026
> **Domain:** zakiledger.co.uk · **Contact:** zachi@zakiledger.co.uk
> **Status:** Month 0 — setup

---

## 1. Why we're building this

Professional accountants and bookkeepers lose **26–50% of their week** to manual,
repetitive work. The research is blunt about it:

- **86%** of accountants report burnout, largely from "boring" repetitive tasks.
- Manual **data entry** eats 8–18 hrs/week (14+ during month-end close).
- **Reconciliation & error correction** eats ~12.5 hrs/week.
- **Chasing clients** for documents eats 5–15 hrs/week.
- Firms estimate **£20k–£50k/month** in lost advisory revenue because staff are
  buried in admin instead of high-value work.

The problem is repetitive (software is good at that), the ROI is provable (in hours
and pounds), the scope is narrow enough to ship, and the user *wants* the help
instead of fearing it. That's a rare, buildable opportunity.

**Zaki Ledger** is an AI copilot that sits on top of the tools accountants already
use (QuickBooks, Xero, bank feeds) and kills the **"Big Three"** time-wasters:
**data entry, bank reconciliation, and client document chasing** — handing users
back an estimated **15–20 hours per week**.

---

## 2. Product principles (non-negotiable)

1. **Human-in-the-loop, always.** The AI drafts; the accountant approves with one
   click. Every action is logged, reversible, and attributable — this kills the
   "audit-trail anxiety" the profession cites.
2. **Confidence scores, not black boxes.** Every extraction/match shows a
   confidence %. High-confidence auto-clears; low-confidence gets flagged to a human.
3. **Sit on top, don't replace.** Integrate with what they already use. Adoption
   friction is the #1 killer of tools like this.
4. **Consistency is a feature.** A machine enters data the same way every time —
   the cure for "reconciliation nightmares" from inconsistent manual entry.
5. **Narrow and deep beats broad and shallow.** Win one chore completely before
   starting the next.

---

## 3. The 6-month North Star

> **By end of Month 6:** Zaki Ledger reliably automates **invoice/receipt data
> entry** into at least two accounting platforms at **95%+ accuracy**, has a
> working **bank-reconciliation** engine in early use, and has **10–15 real firms**
> (pilot or paying) with at least one documented case study proving **10+ hours/week
> saved**. Business email, brand, and outreach engine are all live.**

### Definition of done (the 6 numbers we're chasing)
| Metric | 6-month target |
|---|---|
| OCR extraction accuracy (common docs) | ≥ 95% |
| Accounting integrations live | 2 (e.g. Xero + QuickBooks) |
| Firms actively using it (pilot/paid) | 10–15 |
| Documented hours saved / user / week | ≥ 10 |
| Cold outreach firms contacted | 40+ (our built list) |
| Case studies published | ≥ 1 |

---

## 4. Guiding cadence

**Weekly rhythm**
- **Mon** — plan the week's one shippable slice; review last week's accuracy metrics.
- **Tue–Thu** — build + ship. One narrow improvement to "done" per day where possible.
- **Fri** — talk to a real accountant (discovery or pilot check-in). Non-negotiable.
- **Fri PM** — write up: what shipped, what broke, next slice. Update this roadmap.

**Daily rhythm (as the developer)**
1. Review overnight processing accuracy — accuracy is the product, track it like a vital sign.
2. Ship one slice (a doc type, a bank format, an edge case).
3. Read every AI override from real users — each override is a bug report from the future.
4. Harden the boring stuff: error handling, audit logging, edge cases.
5. Log progress.

---

## 5. Month-by-month plan

### 🟢 Month 0 (this week) — Foundation
Get the rails in place before building.
- [ ] Buy **zakiledger.co.uk** (and optionally .com) via Cloudflare/Namecheap.
- [ ] Set up mailbox (Google Workspace recommended for deliverability; Zoho free tier as fallback).
- [ ] Configure **SPF + DKIM + DMARC** (start DMARC at `p=none`, tighten later).
- [ ] Set up email signature: `Zaki · Zaki Ledger` + one-line pitch.
- [ ] Connect the new inbox so outreach replies stay clean and separate.
- [ ] Repo scaffolding for the product (separate from this planning doc).

### 🟢 Month 1 — Prove ONE thing works
**Mission: kill manual data entry for one document type, end to end.**
- Build the core pipeline: upload an invoice → AI extracts vendor, date, amount,
  line items → shows confidence score → user approves → posts to **one** platform
  (pick Xero *or* QuickBooks first).
- Pick a realistic tech stack and stand up the skeleton (see §6).
- **GTM:** run **5–10 discovery conversations** from the 40-firm list. Goal is
  learning, not selling: *"Can I watch you do invoice entry for 20 minutes?"*
- **Exit criteria:** one accountant says *"That just saved me 10 minutes and it was
  right."* One true believer beats a polished demo.

### 🟢 Month 2 — Make data entry trustworthy
**Mission: production-grade accuracy at low volume.**
- Push OCR accuracy toward **95%+** on common invoices; add **receipts**.
- Build **audit trail** + **one-click approve** (and bulk approve).
- Handle the messy edge cases (multi-page, poor scans, odd formats).
- **GTM:** convert 2–3 discovery contacts into **free design partners** actively
  using it. Begin **cold outreach** in batches of 8–10 from the list.
- **Exit criteria:** 3 firms using it weekly; accuracy holding at 95%+.

### 🟢 Month 3 — First real traction
**Mission: volume + a second integration + first money signal.**
- Add the **second accounting integration**.
- Support 2–3 real **bank/document formats**.
- Ship whatever's needed to handle *volume*, not just one invoice at a time.
- **GTM:** reach **10–15 pilot/paying firms**. Introduce simple pricing. Nail the
  headline metric: "hours of data entry saved per week."
- **Exit criteria:** 10+ firms; first paid conversion(s); a clean saved-hours number per user.

### 🟢 Month 4 — Start the second Big Three: Reconciliation
**Mission: begin turning "data-mismatch hell" into a one-screen review.**
- Build the **bank-reconciliation engine v1**: auto-match bank-feed transactions to
  the ledger, surfacing only genuine discrepancies for a human.
- Keep hardening data entry from real usage.
- **GTM:** deepen relationships with active firms; collect testimonials + usage data.
- **Exit criteria:** reconciliation demoable on real data for at least one firm.

### 🟢 Month 5 — Reconciliation + Compliance stickiness (UK)
**Mission: make Zaki Ledger part of the daily routine.**
- Extend reconciliation (VAT reconciliation; **Making Tax Digital**-friendly output).
- Add a **UK compliance deadline tracker**: VAT/MTD, Self Assessment, Corporation
  Tax, Companies House, payroll RTI — cheap to build, kills real "penalty anxiety,"
  boosts daily stickiness.
- **GTM:** aim for a measurable **10+ hours/week reclaimed** per active user.
- **Exit criteria:** at least one firm relying on it for reconciliation + deadlines.

### 🟢 Month 6 — Consolidate & prove the ROI
**Mission: turn traction into a repeatable story.**
- Stabilise everything; fix the top pain points from real usage.
- Publish **≥1 case study**: "We gave [firm] back X hours/week."
- Firm up **pricing** and the plan to scale outreach (referrals + partner channel:
  Xero/QuickBooks advisors, ProAdvisors).
- **Exit criteria:** hit the §3 Definition of Done. Decide the next 6-month bet.

---

## 6. Proposed tech stack (to confirm in Month 1)
> Optimised for a solo dev shipping fast. Adjust as reality dictates.
- **Frontend:** React + TypeScript + Vite (already familiar in this repo).
- **Backend:** Node/TypeScript API (keeps one language across the stack).
- **OCR / extraction:** start with a hosted document-AI API for speed, evaluate
  cost/accuracy vs. self-hosted later. Always attach a confidence score.
- **Integrations:** Xero API and QuickBooks Online API (OAuth).
- **Data:** Postgres. Full audit-log table from day one (immutable, append-only).
- **Auth/security:** managed auth; encrypt tokens at rest; least-privilege API scopes.
- **Hosting:** a simple managed platform first; don't over-engineer infra pre-traction.

---

## 7. Go-to-market: the 40-firm engine
- The prospect list already exists (`zaki-ledger/prospects.md` — to be added): 40+
  small UK bookkeeping/accounting firms, most with a verified public email.
- **Don't blast all 40.** Send 8–10 at a time so we can learn and refine.
- **Human sender** (`Zaki · Zaki Ledger`), pain-led message, one-line opt-out
  (UK PECR/GDPR legitimate-interest compliant).
- **Goal of round one = conversations, not sales.** The first believer comes from these.
- Later: referrals (accountants know accountants) + partner/reseller channel.

---

## 8. Risks & how we de-risk
| Risk | Mitigation |
|---|---|
| Accuracy not good enough to trust | Confidence scores + human approval; never silently auto-post low-confidence |
| Emails land in spam | SPF/DKIM/DMARC set up before outreach; warm the domain; small batches |
| Building in a vacuum | Mandatory weekly accountant conversation; act on every override |
| Scope creep across the Big Three | One chore fully won before the next; monthly exit criteria |
| Solo-founder overload | Ship small daily slices; document everything; automate our own admin |
| Integration/API limits | Start with one integration; respect rate limits; cache |

---

## 9. Immediate next actions (this week)
- [ ] **Tonight:** buy `zakiledger.co.uk`, set up mailbox, add SPF/DKIM/DMARC.
- [ ] Tell Zaki Ledger's assistant which mail provider → get exact DNS records.
- [ ] Draft the GDPR-compliant cold-email template + signature.
- [ ] Add the 40-firm list to `zaki-ledger/prospects.md`.
- [ ] Decide first integration (Xero vs QuickBooks) and scaffold the product repo.
- [ ] Book the first 2–3 discovery calls from the list.

---

## 10. Path to 10 clients (how we handle traction)

Two sides — people and product.

**People (doable solo — and the point):**
- Onboard **one firm at a time** using `docs/onboarding-sop.md`. High-touch is intentional early.
- Support is **founder-led and personal** — every request is a product insight.
- ~30 min/week per firm at first. First hire (an **assistant**, per PLAYBOOK §3) only when admin
  reliably steals your build/sell hours — around real revenue, not before.

**Product (build when usage demands it, not before):**
- Today's MVP has **no auth** and **no per-firm data separation** — fine for manual, one-at-a-time
  design partners; not fine for 10 concurrent logins.
- Before 10 concurrent firms, build: (1) **accounts/auth**; (2) **multi-tenancy** — an `org_id` on
  every row + Postgres **row-level security** so no firm ever sees another's data; (3) **per-firm
  isolation** of the correction-ledger learning.
- **Volume is a non-issue** — 10 firms of invoices is trivial for Postgres + the Claude API. The
  work is isolation, not scale.

**Trigger & sequence:** onboard first design partners manually now → when **2–3 use it weekly
(Month 2–3)**, build auth + tenant isolation → then scale to 10.

---

*This is a living document — review and update it every Friday.*
