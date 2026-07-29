# CLAUDE CODE BRIEF: PHASE 3 — BANK RECONCILIATION ENGINE

**Date:** July 29, 2026  
**Priority:** NEXT PHASE (Build now, API integration tomorrow)  
**Complexity:** High (multi-format parsing, matching algorithm, confidence scoring, DB schema)  
**Time Estimate:** 16–20 hours (can split across multiple sessions)  
**API Keys Needed:** NONE TODAY (logic-only build; Claude/GPT added tomorrow)

---

## 🎯 PHASE 3 OVERVIEW

**Goal:** Auto-reconcile bank statements (CSV, OFX, PDF) against QB/Xero posted transactions.

**Pain Point Solved:** Francisco spends 4–6 hours/week manually matching 100+ bank transactions to QB entries.

**Time Saved:** 4–6 hours → 30 min/week (87.5% reduction)

**Value to Customer:** ~$10,000–20,000/year (at Francisco's billable rate)

---

## 📊 PHASE 3 FEATURE SET

### Core Features
1. **Multi-Format Bank Statement Import**
   - CSV (most common)
   - OFX (structured XML, industry standard)
   - PDF (OCR extraction — added tomorrow with Claude)

2. **Transaction Extraction**
   - Parse date, amount, merchant/description
   - Detect currency
   - Handle multi-line items

3. **Confidence-Scored Matching**
   - Amount match: ±1% tolerance
   - Date match: ±2 days tolerance
   - Merchant match: fuzzy (Vendor X = Vendor X Inc)
   - Confidence: 95%+ auto-match, 70–95% yellow flag, <70% red flag

4. **Audit Trail Protection**
   - Can't delete reconciliations (immutable for compliance)
   - Log all matching decisions
   - Show why each match was made

5. **Partial Reconciliation**
   - Doesn't require 100% match
   - Can reconcile subset of transactions
   - Leave unmatched for later

6. **Reconciliation Report**
   - Matched transactions
   - Unmatched bank items
   - Unmatched QB items
   - Variance summary
   - Export to PDF/CSV

---

## 🛠️ TECHNICAL ARCHITECTURE

### 1. FILE PARSING (No API Calls)

#### CSV Parser
```
Input: Bank CSV (Date | Description | Debit | Credit format)
Output: Array of transactions {date, amount, merchant, currency}

Task:
- Detect delimiter (comma, semicolon, tab)
- Handle headers (skip first row if headers)
- Parse date formats (DD/MM/YYYY, MM/DD/YYYY, ISO)
- Separate debit/credit into signed amounts
- Detect currency (from bank name or file metadata)
- Validate: amount is number, date is valid
```

#### OFX Parser
```
Input: OFX XML file
Output: Array of transactions {date, amount, merchant, currency}

Task:
- Parse XML structure (OFX standard)
- Extract STMTTRN (statement transactions)
- Read: DTPOSTED (date), TRNAMT (amount), TRNID (transaction ID), MEMO (description)
- Map to transaction object
- Handle BALANCE elements (opening/closing balance)
- Validate structure
```

#### PDF Parser (Add Tomorrow with Claude)
```
Input: PDF bank statement
Output: Array of transactions {date, amount, merchant, currency}

Task (tomorrow):
- Send PDF to Claude with: "Extract bank transactions. Return JSON array."
- Parse Claude's response
- Validate fields present
- Store extraction confidence
```

### 2. MATCHING ALGORITHM (Core Logic — No API)

**Input:** 
- Bank transactions: [{date, amount, merchant}]
- QB transactions: [{date, amount, description, account}]

**Output:**
- Matches: [{bankId, qbId, confidence, reason}]
- Unmatched bank items
- Unmatched QB items

**Matching Logic:**

```
For each bank transaction:
  candidates = []
  
  For each QB transaction:
    score = 0
    
    // Amount matching (±1% tolerance)
    if abs(bank.amount - qb.amount) <= max(1% of amount, 0.01):
      score += 40
    
    // Date matching (±2 days tolerance)
    date_diff = abs(bank.date - qb.date)
    if date_diff <= 2 days:
      score += 35
    elif date_diff <= 5 days:
      score += 15 (pending, might clear later)
    
    // Merchant matching (fuzzy)
    merchant_match = fuzzy_compare(bank.merchant, qb.description)
    if merchant_match > 0.8:
      score += 25
    elif merchant_match > 0.5:
      score += 10
    
    if score > 0:
      candidates.push({qbId, score})
  
  // Pick best match
  if candidates not empty:
    best = candidates.sort(score).first()
    if best.score >= 75:
      confidence = min(best.score / 100, 1.0)
      matches.push({bankId, qbId: best.qbId, confidence})
    else if best.score >= 50:
      // Yellow flag - needs review
      matches.push({bankId, qbId: best.qbId, confidence, flagged: 'yellow'})
    else:
      // Red flag - likely mismatch
      matches.push({bankId, flagged: 'red'})
  else:
    // Unmatched
    unmatched_bank.push(bankId)
```

**Confidence Mapping:**
- Score 95–100 = GREEN (95% confidence, auto-post)
- Score 70–94 = YELLOW (70–95% confidence, review required)
- Score <70 = RED (<70% confidence, manual review)

### 3. DATABASE SCHEMA

```sql
-- Bank statements (uploaded files)
CREATE TABLE bank_statements (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  file_name TEXT,
  file_format VARCHAR(10), -- 'csv', 'ofx', 'pdf'
  upload_date TIMESTAMP,
  statement_period_start DATE,
  statement_period_end DATE,
  currency VARCHAR(3), -- 'GBP', 'USD', 'EUR'
  opening_balance DECIMAL(12,2),
  closing_balance DECIMAL(12,2),
  transaction_count INT,
  created_at TIMESTAMP
);

-- Bank transactions (extracted from statements)
CREATE TABLE bank_transactions (
  id UUID PRIMARY KEY,
  statement_id UUID REFERENCES bank_statements(id),
  transaction_date DATE,
  posted_date DATE, -- may differ from transaction date
  merchant VARCHAR(255),
  description TEXT,
  amount DECIMAL(12,2), -- signed: positive = debit, negative = credit
  currency VARCHAR(3),
  transaction_id VARCHAR(100), -- bank's transaction ID
  memo TEXT,
  created_at TIMESTAMP
);

-- QB/Xero transactions (already posted)
CREATE TABLE qb_transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  qb_transaction_id VARCHAR(100), -- QB/Xero's ID
  qb_account_id VARCHAR(100),
  posted_date DATE,
  amount DECIMAL(12,2),
  description VARCHAR(255),
  account_name VARCHAR(100),
  account_type VARCHAR(50), -- 'bank', 'expense', etc.
  currency VARCHAR(3),
  synced_from_qb_at TIMESTAMP,
  created_at TIMESTAMP
);

-- Reconciliation matches
CREATE TABLE reconciliation_matches (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  statement_id UUID REFERENCES bank_statements(id),
  bank_transaction_id UUID REFERENCES bank_transactions(id),
  qb_transaction_id UUID REFERENCES qb_transactions(id),
  confidence DECIMAL(3,2), -- 0.00 to 1.00
  match_reason VARCHAR(255), -- 'amount + date + merchant', etc.
  flagged_level VARCHAR(10), -- 'green', 'yellow', 'red'
  matched_by VARCHAR(50), -- 'auto', 'manual', 'user'
  matched_at TIMESTAMP,
  approved_by UUID, -- user who approved
  approved_at TIMESTAMP,
  created_at TIMESTAMP,
  UNIQUE(bank_transaction_id, statement_id) -- can't match same transaction twice
);

-- Unmatched transactions
CREATE TABLE unmatched_transactions (
  id UUID PRIMARY KEY,
  statement_id UUID REFERENCES bank_statements(id),
  bank_transaction_id UUID REFERENCES bank_transactions(id),
  unmatched_reason VARCHAR(255), -- 'no qb entry', 'low confidence', etc.
  created_at TIMESTAMP
);

-- Reconciliation summary/report
CREATE TABLE reconciliation_reports (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  statement_id UUID REFERENCES bank_statements(id),
  period_start DATE,
  period_end DATE,
  bank_opening_balance DECIMAL(12,2),
  bank_closing_balance DECIMAL(12,2),
  qb_opening_balance DECIMAL(12,2),
  qb_closing_balance DECIMAL(12,2),
  total_matched DECIMAL(12,2),
  total_unmatched_bank DECIMAL(12,2),
  total_unmatched_qb DECIMAL(12,2),
  variance DECIMAL(12,2), -- closing_balance difference
  is_reconciled BOOLEAN DEFAULT false,
  reconciled_at TIMESTAMP,
  created_at TIMESTAMP
);

-- Audit trail
CREATE TABLE reconciliation_audit_log (
  id UUID PRIMARY KEY,
  reconciliation_match_id UUID REFERENCES reconciliation_matches(id),
  action VARCHAR(50), -- 'match_created', 'match_approved', 'match_rejected'
  action_by UUID,
  action_at TIMESTAMP,
  old_confidence DECIMAL(3,2),
  new_confidence DECIMAL(3,2),
  notes TEXT,
  created_at TIMESTAMP
);
```

### 4. API ENDPOINTS

**Upload & Extract**
```
POST /api/reconciliation/upload
Body: multipart/form-data (bank_statement file)
Returns: {
  statement_id: UUID,
  transaction_count: int,
  date_range: {start, end},
  currency: string,
  status: 'extracted'
}
```

**Get Transactions (Bank + QB)**
```
GET /api/reconciliation/:statement_id/transactions
Returns: {
  bank_transactions: [{id, date, merchant, amount, flagged}],
  qb_transactions: [{id, date, description, amount}],
  matches: [{bankId, qbId, confidence, reason}],
  unmatched_bank: [ids],
  unmatched_qb: [ids]
}
```

**Create Manual Match (User Override)**
```
POST /api/reconciliation/:statement_id/match
Body: {bank_transaction_id, qb_transaction_id}
Returns: {match_id, confidence, flagged_level}
```

**Approve Reconciliation**
```
POST /api/reconciliation/:statement_id/approve
Body: {matches_to_approve: [ids]}
Returns: {
  reconciled: int,
  variance: decimal,
  report_id: UUID
}
```

**Get Reconciliation Report**
```
GET /api/reconciliation/:statement_id/report
Returns: {
  period: {start, end},
  bank_balance: {opening, closing},
  qb_balance: {opening, closing},
  matched_count: int,
  matched_amount: decimal,
  unmatched_bank: {count, amount},
  unmatched_qb: {count, amount},
  variance: decimal,
  is_reconciled: boolean
}
```

---

## 🧪 IMPLEMENTATION SEQUENCE

### Session 1 (Today) — 6–8 hours
1. **CSV Parser** (1 hour)
   - Detect format, parse columns, validate

2. **OFX Parser** (1.5 hours)
   - XML parsing, extract STMTTRN elements, validate

3. **Matching Algorithm** (2 hours)
   - Amount/date/merchant logic
   - Confidence scoring
   - Edge cases (multiple matches, ambiguous dates)

4. **Database Schema** (1 hour)
   - Create tables, indexes, constraints

5. **API Endpoints (Scaffold)** (1.5 hours)
   - Route definitions, input validation
   - No business logic yet (logic will call matching algorithm)

6. **Unit Tests** (1 hour)
   - Parser tests with real bank CSVs/OFXs
   - Matching algorithm tests with known scenarios

### Session 2 (Tomorrow) — 8–12 hours
1. **PDF Parser Integration** (2 hours)
   - Add Claude extraction (when budget available)

2. **QB/Xero Integration** (3 hours)
   - Fetch live transactions from QB/Xero APIs
   - Sync logic, error handling

3. **UI Components** (3 hours)
   - Upload interface
   - Match review/approval workflow
   - Reconciliation report view

4. **End-to-End Testing** (2 hours)
   - Real bank statement + real QB data
   - Verify matching accuracy, confidence scoring
   - Cost verification (should be near-zero for CSV/OFX)

5. **Deployment** (1 hour)
   - Render push, environment setup

---

## 📋 SUCCESS CRITERIA

**Session 1 (Today) — Foundation Complete:**
- ✅ CSV parser works on 5 real bank CSVs
- ✅ OFX parser works on 5 real OFX files
- ✅ Matching algorithm produces correct matches on test data
- ✅ Confidence scoring: 95%+ auto = 3 examples, 70–95% yellow = 2 examples, <70% red = 2 examples
- ✅ Database schema created, tables exist
- ✅ API routes defined, input validation works
- ✅ Unit tests pass (10+ test cases)
- ✅ No API calls made (zero cost today)

**Session 2 (Tomorrow) — Integration Complete:**
- ✅ PDF parser added (with Claude)
- ✅ QB/Xero sync working
- ✅ End-to-end test: upload statement → auto-match → review → approve → report
- ✅ Cost verified: <$0.01 per CSV/OFX reconciliation
- ✅ Francisco can pilot (real data test)

---

## 🎓 MATCHING ALGORITHM EDGE CASES

**Handle These:**

1. **Pending Transactions**
   - QB shows £500 posted July 15
   - Bank shows £500 on July 18 (cleared after 3 days)
   - ✅ Should match (date tolerance ±2 days, and pending is common)

2. **Duplicate Transactions**
   - Same merchant, same amount, same date, two QB entries
   - Don't match to both; flag one for review

3. **Bank Fees**
   - Bank statement shows: -£2.50 (monthly fee)
   - QB might not have entry yet (not posted)
   - Flag as unmatched for manual entry

4. **Foreign Currency**
   - Bank: USD $1,000
   - QB: GBP £750 (same transaction, different currency)
   - Check conversion rate; if within 1%, match with note

5. **Partial Reconciliation**
   - Bank statement missing first 5 days of month
   - QB has full month
   - Allow reconciliation of subset; flag missing dates

6. **Multiple Line Items**
   - Invoice for £1,000 + tax £200 = £1,200 total
   - Posted as one QB entry for £1,200
   - Bank statement shows: -£1,200 (single line)
   - ✅ Should match on amount

---

## 📊 TEST DATA NEEDED

**From Francisco or Zaki:**
1. 3–5 real bank CSVs (different formats)
2. 2–3 real OFX files
3. Corresponding QB exports for same period
4. Expected matches (so we can validate accuracy)

**If not available:**
- Create synthetic test data (10 transactions per format)
- Document assumptions

---

## ⚠️ KNOWN CONSTRAINTS

- **No Claude/GPT today** (added tomorrow)
- **No live QB sync today** (APIs added tomorrow)
- **Local testing only** (no production deployment yet)
- **CSV/OFX only today** (PDF added tomorrow)

---

## 🚀 TOMORROW PLAN (After Payment)

1. Add PDF parser (Claude extraction)
2. Integrate QB/Xero live APIs
3. End-to-end test with real data
4. Hybrid extraction for Phase 2.5
5. Ship to Francisco for pilot

---

## 🎯 BIG PICTURE

**Phase 3 is the moat.** Bank reconciliation is what accountants struggle with most, costs you nearly nothing, and is hard for competitors to replicate.

By the time you ship Phase 3:
- Phases 1 + 3 together = 12+ hour/week savings
- Francisco can't leave (too sticky)
- Margin is 87%+ per customer
- Ready to onboard 5–10 similar customers

**Build it right.**

---

**END OF PHASE 3 BRIEF**

*Claude Code: This is the next phase. Build the foundation today (parsers, matching algorithm, DB, API scaffold). Tomorrow we add Claude/GPT and QB integration. Francisco pilots at month-end. Questions? Ask in the response.*