# Zaki Ledger

**Invoice extraction copilot for UK bookkeepers. AI-powered, human-in-the-loop, learns per supplier.**

---

## 🎯 The One Goal Right Now

**Get ONE bookkeeper to try Zaki Ledger and say: "that saved me time — and it was right."**

Not ten users, not a finished product — one true believer. That's the entire focus for the next 2–4 weeks.

See `zakiledger/docs/FOCUS.md` for the full strategy.

---

## 📊 Current Status

**Last updated:** 2026-07-23 (Product rebuild decision made, Phase 1+3 is critical path)

### ✅ What's Done
- Invoice extraction with confidence scores (Claude vision)
- One-click approve workflow
- Correction ledger wired to Supabase (+ in-memory fallback)
- Per-supplier learning (two-pass extraction)
- Demo mode (runs with no API keys)
- Polished, branded UI
- `render.yaml` deployment blueprint ready
- **Domain `zakiledger.co.uk` purchased & live** ✓
- **Email `zachi@zakiledger.co.uk` set up in Gmail** ✓
- **DNS records fully verified** (SPF, DKIM, DMARC, MX, Addresses all green) ✓
- **Wave 1: All 9 personalized cold emails sent** ✓
- **Market validation complete:** Bank reconciliation is #1 pain, but customers won't test invoice extraction alone — must include Xero/QB posting ✓
- **Product decision made:** Build Phase 1 + Phase 3 together (extract + auto-post), not Phase 1 alone ✓
- **Xero API confirmed:** 100% free to use, no cost ✓
- **Visual mockups created:** Phase 1+2+3 flow + Phase 4 (bank reconciliation) for customer demos ✓
- LinkedIn strategy active (3x/week posts, high-engagement content)
- README created (handoff doc for any session/developer)

### 📍 What's Next (This Week — Critical Path)
1. **Thursday:** Get Anthropic API key (payday) → add credits
2. **Friday:** Deploy Phase 1+3 to Render + test live extraction with real Xero API
3. **Next week (Mon–Fri):** Send Wave 2 outreach to 8–10 new prospects from the 40-firm list
4. **Week 3:** Run demo calls, book 3–5 testers
5. **Week 4:** Get first "saved me time" signal from at least one real bookkeeper (target hit)

### ⏸️ Parked (After Believer #1)
- Phase 2 (receipts + bulk approve) — build after Phase 1+3 is tested
- Phase 4 (bank reconciliation) — roadmap Month 4
- Multi-tenancy, advanced auth
- Dual-model cost optimization
- Additional outreach waves beyond Wave 2

---

## 🏃 How to Run It

### Development (Local)
```bash
cd zakiledger
npm install
npm run dev
```

Runs on `http://localhost:3000`. 

**Demo mode:** Works with no API keys.
**Real extraction:** Set `ANTHROPIC_API_KEY` in `.env.local` to test invoice processing.

### Deploy to Render
Use `render.yaml` (blueprint is ready). When deploying, set these env vars in the Render dashboard:
- `ANTHROPIC_API_KEY` (required for real extraction)
- `SUPABASE_URL` (optional, for persistence)
- `SUPABASE_SERVICE_ROLE_KEY` (optional)

See `render.yaml` for full details.

---

## 📁 Docs (Read in This Order)

**Strategic (must read):**
1. `zakiledger/docs/FOCUS.md` — the one target + why we're doing this
2. `zakiledger/docs/HANDOFF.md` — what's built, key decisions, context
3. `zakiledger/docs/ROADMAP.md` — 6-month plan, path to 10 clients

**Go-to-market (ready to use):**
- `zakiledger/docs/outreach/wave-1.md` — 9 personalized cold emails (ready to send)
- `zakiledger/docs/prospects.md` — 40 verified UK bookkeeping firms (ICP screening, contact hooks)
- `zakiledger/docs/content/linkedin.md` — content bank + demo video + caption

**Operations & learning:**
- `zakiledger/docs/PLAYBOOK.md` — GTM framework + Dan Martell strategies
- `zakiledger/docs/onboarding-sop.md` — getting-started flow for first customer
- `zakiledger/docs/getting-started.md` — customer-facing onboarding guide
- `zakiledger/docs/glossary.md` — plain-English terms (for discovery calls)
- `zakiledger/docs/knowledge-base.md` — FAQ + troubleshooting

**Prompts & AI:**
- `zakiledger/docs/prompts/master-prompt.md` — core extraction system prompt
- `zakiledger/docs/prompts/outreach-system-prompt.md` — personalization logic

---

## 🏗️ Architecture Overview

**Tech Stack:**
- Frontend: Next.js (React) + TypeScript
- Backend: Node.js/Express
- AI: Anthropic Claude (vision + multi-turn)
- Database: Supabase (optional; in-memory fallback works)
- Deployment: Render (free tier or paid)

**Core Flow:**
1. User uploads invoice (image or PDF)
2. Claude extracts all fields with confidence scores
3. User reviews & approves (one-click) or corrects
4. Correction logged to Supabase + used in next pass for same supplier
5. Per-supplier learning improves over time

---

## 🎯 Filter Question (Use This for Every Decision)

> **"Does this get a bookkeeper to try it THIS WEEK?"**

If **no** → it's a distraction. Park it. Come back after believer #1.

---

## 🔐 Important Notes

- **No accounting/tax advice** given to customers — product help only (liability)
- **UK small firms only** — 1–5 bookkeepers per firm (staying focused on ICP)
- **Human-in-the-loop always** — AI suggests, human approves (builds trust, audit trail)
- **Live extraction untested** — real `ANTHROPIC_API_KEY` testing happens post-deploy

---

## 📞 Next Immediate Actions

- [ ] Send Wave 1 emails (spaced 15–30 min apart, starting tomorrow)
- [ ] Monitor replies in Proton Mail inbox
- [ ] Book first 20-min call (show demo, validate problem)
- [ ] Update this README every 2 days with progress

---

## ❓ Questions?

Start with `zakiledger/docs/FOCUS.md` → `HANDOFF.md` → `ROADMAP.md`. If you're new to the project, that's your onboarding.

---

*Built by Zaki. One bookkeeper believer. That's the goal.*
