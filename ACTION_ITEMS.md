# Action Items — Critical Path to Believer #1

> **Filter Question:** *"Does this get a bookkeeper to try it THIS WEEK?"* If no → park it.

---

## 🚀 THIS WEEK (Wed–Fri)

### Thursday (Payday)
- [ ] Get Anthropic API key
- [ ] Add credits to Anthropic account (enough for testing extraction on ~50–100 invoices at ~$0.01–$0.05 per invoice)

### Friday
- [ ] Deploy Phase 1+3 to Render
  - Use `render.yaml` blueprint
  - Set env vars: `ANTHROPIC_API_KEY`
  - Optional: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for persistence

- [ ] Test Phase 1+3 live
  - Upload a real invoice (PDF or image)
  - Verify extraction shows confidence scores
  - Click "Approve & Post to Xero"
  - Verify bill is created in test Xero account
  - Check audit trail is logged

- [ ] Go live: Phase 1+3 is publicly accessible and working

---

## 📧 NEXT WEEK (Mon–Fri) — Wave 2 Outreach

### Monday
- [ ] Confirm Phase 1+3 is stable (no overnight errors)
- [ ] Pick 8–10 prospects from `zakiledger/docs/prospects.md` (prospects #11–20)
  - Vary by region/specialty (like Wave 1)
  - Skip obvious non-ICP

### Mon–Fri — Send Wave 2
- [ ] Send personalized cold emails (space 15–30 min apart, don't blast all at once)
  - **Subject:** "20-min demo of Phase 1 + 3"
  - **Angle:** Invoice extraction that auto-posts to Xero
  - **CTA:** "Want to see it in action?"
  - **From:** `zachi@zakiledger.co.uk` (human sender, not automated)

- [ ] Track replies in email inbox
  - Log in `zakiledger/docs/prospects.md` (add "Wave 2" column)
  - Note: replied, interested, not interested, bounced

**Goal:** Get 3–5 "yes" responses to demo calls

---

## 📞 WEEK 3 (Demo Calls)

- [ ] Schedule 3–5 demo calls (30 min each)
  - Best times: 10am–12pm UK time (bookkeepers are least busy morning)

- [ ] For each demo:
  - Show Phase 1+3 flow (use mockups from artifacts if needed)
  - Let them upload their own invoice
  - Show extraction + confidence scores
  - Show "Approve & Post" → bill in Xero
  - Ask: "Would you test this for real on 5–10 invoices next week?"

- [ ] Book 1–2 active testers
  - Get their email + permission to send them test link
  - Set expectations: "Test on real invoices, give feedback Friday"

---

## 🧪 WEEK 4 (Testing + Feedback)

- [ ] Testers use Phase 1+3 on real invoices
  - Send them the Render link Monday
  - Support them if they hit bugs
  - Track: # invoices tested, time per invoice, accuracy, bugs

- [ ] Collect feedback Friday
  - Call them: "How'd it go? Would you use this for real?"
  - Ask: "Did it save you time? Was the accuracy good?"
  - Listen for: *"That saved me time — and it was right."*

- [ ] **Get at least ONE person to say they'd use it** → Believer #1 acquired → Mission hit ✅

---

## 🔴 DO NOT DO (Distractions — Park Until After Believer #1)

- ❌ Build Phase 2 (receipts + bulk approve)
- ❌ Build bank reconciliation (Phase 4)
- ❌ Add auth / multi-tenancy
- ❌ Optimize for dual-model (OpenAI + Claude)
- ❌ Design pricing tiers
- ❌ Create advanced UI features
- ❌ Write case studies yet
- ❌ Cold email more than 10 prospects at a time
- ❌ Launch product marketing site
- ❌ Pursue Muhammad & Matthew further (they're out)

**Why?** They don't help you get a believer THIS WEEK. Park them.

---

## 📊 Success Metrics (Tracking)

**Week 1 (This week):**
- [ ] Phase 1+3 deployed & tested ✅

**Week 2 (Wave 2):**
- [ ] 8–10 outreach emails sent
- [ ] 20%+ response rate (at least 2 "yes" to demo)

**Week 3 (Demos):**
- [ ] 3–5 demo calls completed
- [ ] 1–2 testers booked

**Week 4 (Testing):**
- [ ] At least 1 person says: *"That saved me time — and it was right."* ✅

---

## 💾 Key Files (Reference During Execution)

- **`zakiledger/docs/FOCUS.md`** — The mission (never lose sight)
- **`zakiledger/docs/ROADMAP.md`** — 6-month plan (Phase 1–4)
- **`zakiledger/docs/prospects.md`** — 40 verified bookkeeping firms (Wave 2 source)
- **`zakiledger/docs/outreach/wave-1.md`** — Template for cold emails (replicate for Wave 2)
- **`render.yaml`** — Deployment blueprint (use Friday)
- **`SESSION_SUMMARY_2026-07-23.md`** — Today's decisions & context (read if lost)

---

## ⚠️ Known Issues / Risks

| Risk | Mitigation |
|---|---|
| Extraction accuracy isn't good enough | Test with real invoices Friday. If <80% accuracy on common fields, improve prompt or model. |
| Xero API connection fails | Test auth & posting Friday. Have fallback manual approval UI. |
| Demo prospects don't respond | Wave 2 goes out Monday. If <15% response rate by Wednesday, adjust email angle. |
| Testers don't see time savings | They might need training or UI tweaks. Capture feedback & iterate before Wave 3. |

---

## 🎯 The North Star

> **Get ONE bookkeeper to try Zaki Ledger and say: "that saved me time — and it was right."**

Everything you do this week should move the needle on that. Nothing else matters.

---

*Updated: 2026-07-23 | Ready to execute.*
