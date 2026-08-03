# Invoice Extraction Rebuild — Complete Specification
**Phase 1 of Zaki Ledger: From Scratch**

Based on accountant feedback (Eric, Francisco), developer insights, and real-world learnings.

---

## Executive Summary

Rebuild invoice extraction feature from scratch. The current version has bugs:
- Confidence scoring too loose/tight (flags correct data as uncertain)
- Duplicate detection not working
- Approve/reject/edit buttons unreliable

The new version will fix these issues and add transparency: show reasoning for every extraction, flag edge cases honestly, explain why something was flagged.

---

## What It Does

Users upload invoices (PDF, JPG, PNG, TIFF). AI extracts merchant, date, amount, tax, invoice number with confidence scores and reasoning. User reviews and corrects. Posts to QB/Xero.

**Key difference:** Every extraction is explainable. Not a black box.

---

## Core Features

### 1. Upload Interface

**Accepts:**
- PDF files
- JPG/JPEG images
- PNG images
- TIFF images

**Upload modes:**
- Single file upload
- Bulk upload (multiple files)
- Drag-and-drop support

**Constraints:**
- File size limit: 10MB per file
- Progress indicator during upload
- Clear error messages if file invalid

**UX:**
- Button: "Upload Invoices"
- Drag-and-drop zone with visual feedback
- File list showing uploaded files
- Cancel/retry options

---

### 2. AI Extraction (Primary: OpenAI GPT-4o-mini)

**Extract these fields from each document:**

1. **Invoice Number / Reference**
   - Examples: INV-2044, #1234, 2024-07-15-001
   - Handle alphanumeric patterns (INV-2044-A) as valid

2. **Invoice Date**
   - Format: YYYY-MM-DD
   - Handle various date formats in source (01/07/2026, July 1 2026, etc.)
   - Infer from document if not explicit

3. **Merchant Name**
   - Company name that issued invoice
   - Handle variations: "ACME Ltd", "ACME Limited", "Acme Corp"
   - Marketplace receipts: Often unclear (Amazon, eBay) — flag honestly

4. **Total Amount**
   - Numeric value with decimal
   - Include currency if visible
   - Handle handwritten amounts carefully (risky, flag low confidence)

5. **Tax Amount**
   - VAT/GST/Sales tax if shown
   - Separate from total if possible
   - May be 0 if no tax line

6. **Line Items** (if present)
   - Description + Amount for each item
   - Optional but helpful for validation

7. **Payment Terms** (if present)
   - Net 30, Due on Receipt, etc.
   - Optional

8. **Currency**
   - GBP, USD, EUR, etc.
   - Default to GBP for UK invoices, but show if different

9. **Customer PO Number** (if present)
   - Purchase order reference if shown

---

### 3. Confidence Scoring with Reasoning

**Every extracted field gets:**
- Confidence score (0-99%)
- Reason why that score

**Confidence levels:**

**95-99% (High Confidence):**
- Text clearly visible and unambiguous
- Matched against known database (e.g., UK merchant list)
- Standard format (e.g., standard date format)
- Examples: "Confidence 96% (text clear, UK database match)"

**70-85% (Medium Confidence):**
- Text partially obscured or unclear
- Ambiguous formatting
- Slight font/image quality issues
- Examples: "Confidence 78% (text partially faded, readable but uncertain)"

**0-69% (Low Confidence, Flag for Review):**
- Text unreadable or missing
- Handwritten amounts (risky)
- Damaged documents
- Marketplace receipts with unclear merchant
- Examples: "Confidence 45% (handwritten, difficult to read)"

**Edge Cases:**

1. **Marketplace Receipts (Amazon, eBay, Etsy)**
   - Merchant name often unclear or generic ("Amazon.com")
   - Score: 75-80% (honest about ambiguity)
   - Reason: "Marketplace receipt, merchant name unclear"

2. **Alphanumeric Invoice Numbers (INV-2044-A, #ABC123)**
   - Valid patterns, recognize as such
   - Score: 95%
   - Reason: "Alphanumeric format recognized as valid invoice number"

3. **Handwritten Amounts**
   - Risky, OCR unreliable
   - Score: 60-70%
   - Reason: "Handwritten text, confidence limited"

4. **Multi-Currency Invoices**
   - Clearly mark currency
   - If currency unclear, flag
   - Score: 90% if clear, 70% if ambiguous

5. **Old/Damaged Invoices**
   - Faded text, water damage, poor quality scans
   - Be honest: "Confidence 55% (text faded, partially illegible)"
   - Don't guess or pretend to read illegible text

6. **Non-Standard Formats**
   - Handwritten invoices
   - Very old invoices (different layout standards)
   - Custom forms
   - Score appropriately low if unclear

**Reasoning Examples:**

```
MERCHANT: ACME Ltd
Confidence: 96%
Reason: Company name text clear, matched UK business database

DATE: 2026-07-15
Confidence: 98%
Reason: Standard date format (YYYY-MM-DD), clearly printed

AMOUNT: £1,450.00
Confidence: 95%
Reason: Text clear, currency symbol visible, no ambiguity

INVOICE_NUMBER: INV-2044-A
Confidence: 95%
Reason: Alphanumeric pattern recognized, text clear

TAX_AMOUNT: £290.00
Confidence: 92%
Reason: VAT line visible and legible, calculation matches

---

MERCHANT: Amazon Marketplace
Confidence: 75%
Reason: Marketplace receipt, seller name unclear

AMOUNT: £45.32
Confidence: 65%
Reason: Handwritten on receipt, OCR uncertain

DATE: 01-02-2026
Confidence: 70%
Reason: Ambiguous date format (could be DD-MM or MM-DD), needs clarification
```

---

### 4. Fallback Validation (Anthropic Claude Sonnet)

**When to use Claude Sonnet:**
- Any critical field (merchant, date, amount) < 70% confidence
- Ambiguous extractions that GPT-4o-mini flagged
- Complex invoices with unclear structure

**What Claude does:**
- Re-extracts the field
- Provides alternative interpretation
- Explains reasoning
- Returns confidence score

**Show user:**
```
OpenAI extracted: "McDonald's"
Confidence: 65%

Claude alternative: "McDonald's UK Ltd"
Confidence: 72%

Which should we use? [McDonald's] [McDonald's UK Ltd] [Manual Entry]
```

**Cost optimization:**
- Only use Claude for < 70% fields (selective, not every extraction)
- Blended cost stays ~$0.009 per document

---

### 5. Confidence Gating

**Rule:**
Show extracted results ONLY if merchant + amount + date ALL > 70%

**If critical field < 70%:**
1. Show confidence score + reason
2. Show manual review prompt
3. Route to manual review UI
4. User can approve as-is (with warning) or edit

**For edge cases (75-80% confidence):**
- Show result but with warning
- Allow user to approve with confirmation: "This field has medium confidence. Confirm?"
- Don't hide ambiguity

**Show per-field breakdown:**
```
✅ Merchant (96%) - Clear match
✅ Date (98%) - Standard format
✅ Amount (95%) - Clearly visible
---
✓ Ready for export
```

vs.

```
✅ Merchant (96%) - Clear match
⚠️ Date (72%) - Ambiguous format, needs review
✅ Amount (95%) - Clearly visible
---
🔍 Needs manual review
```

---

### 6. Manual Review & Correction UI

**Click-to-edit interface:**
- Each field is clickable
- Click merchant → dropdown with UK merchant suggestions
- Click date → date picker
- Click amount → number input with validation

**Show reasoning:**
- Display why field was extracted the way it was
- User can see the logic before deciding to change it

**Edit flow:**
1. User clicks field
2. Current value + reasoning shown
3. User can:
   - Confirm (accept as-is)
   - Edit (change to different value)
   - Suggest alternative (if Claude provided alternative)
4. Save immediately to database (no lag)
5. Timestamp the edit for audit trail

**Dropdown suggestions:**
- For merchant: Hardcoded UK merchant list (GOOGLE, SHELL, AMAZON, HMRC, etc.)
- For category (receipts): Suggested GL categories
- Auto-complete as user types

**Validations:**
- Date: Valid date format, reasonable year (1990-2030)
- Amount: Decimal number, positive
- Invoice number: Text/alphanumeric
- Merchant: Text input

---

### 7. Duplicate Detection (Smart)

**Check for duplicates in two scenarios:**

**Scenario 1: Duplicate in current batch**
- User uploads 20 invoices
- Same invoice number appears twice (INV-2044)
- Flag both and show: "Invoice INV-2044 appears twice in this batch. Is this a duplicate?"

**Scenario 2: Duplicate in historical invoices**
- User uploads INV-2044
- Same invoice number already exists in database (uploaded 2026-07-10)
- Flag and show: "Invoice INV-2044 was already uploaded on 2026-07-10. Keep both or reject?"

**UX for duplicate detection:**
```
⚠️ POSSIBLE DUPLICATE

Invoice: INV-2044
First occurrence: 2026-07-15, £1,450 from ACME Ltd
Second occurrence: 2026-07-15, £1,450 from ACME Ltd

This appears to be a duplicate. What do you want to do?

[CONFIRM DUPLICATE] [KEEP BOTH] [REVIEW MANUALLY]
```

**Show both documents side-by-side so user can verify**

**Save decision to database:**
- Mark if duplicate confirmed, rejected, or needs review
- Learn over time if user frequently has legitimate duplicates (e.g., multi-part invoices)

---

### 8. Show Extraction Reasoning (Transparency)

**For each extracted invoice, display:**

```
┌─────────────────────────────────┐
│ EXTRACTED INVOICE              │
├─────────────────────────────────┤
│                                 │
│ MERCHANT: ACME Ltd              │
│ Confidence: 96%                 │
│ Reason: Company name matched    │
│         UK database, text clear │
│                                 │
│ DATE: 2026-07-15                │
│ Confidence: 98%                 │
│ Reason: Standard date format,   │
│         clearly printed         │
│                                 │
│ AMOUNT: £1,450.00               │
│ Confidence: 95%                 │
│ Reason: Text clear, currency    │
│         symbol visible          │
│                                 │
│ INVOICE NUMBER: INV-2044        │
│ Confidence: 96%                 │
│ Reason: Alphanumeric pattern    │
│         recognized, text clear  │
│                                 │
│ TAX: £290.00                    │
│ Confidence: 92%                 │
│ Reason: VAT line visible and    │
│         legible                 │
│                                 │
│ [✓ APPROVE] [EDIT] [REJECT]    │
└─────────────────────────────────┘
```

**This builds trust.** User understands why AI scored things this way. Not a black box.

---

### 9. Export Options

**Export to QuickBooks:**
- POST /invoices endpoint
- Include: Invoice number, date, merchant, amount, tax, line items
- Return QB transaction ID

**Export to Xero:**
- POST /contacts + /invoices
- Create contact if merchant not found
- Create invoice for customer

**Export to CSV:**
- Standard CSV format
- All extracted fields
- Include confidence scores (optional, for audit)

**Export feedback:**
- Show success: "✅ Exported to QB. Transaction ID: 12345"
- Show errors: "❌ Export failed: QB connection error. Retry?"
- Include export timestamp

**Export metadata:**
- Extraction source: "Extracted by AI on 2026-08-01, reviewed by user"
- Who made corrections
- Which fields were edited

---

### 10. Learning Opportunity (Foundation for Phase 2)

**Save user corrections:**
- Track: Original extraction vs. user correction
- Store in database

**Identify patterns:**
- After 5 corrections of same type, flag to user
- Example: "You've corrected 'HMRC' to VAT Control Account 5 times. Should we auto-categorize these?"

**This data feeds Phase 2 learning** (categorization suggestions)

---

## Key Learnings from Accountants

### From Eric (CPA, LinkedIn)

**Fear:** AI categorizes without understanding context

**Example:** McDonald's receipt at 1:24 PM categorized as "Lunch" without showing ambiguity

**Solution Zaki applies:**
- Don't hide ambiguity
- Show confidence WITH reasoning
- Flag edge cases: "Time is ambiguous (could be breakfast/lunch), confidence 72%"
- Let user decide, not AI

**For Phase 1 (invoice extraction):** Show reasoning so Eric understands why something was extracted a certain way.

---

### From Francisco (Pilot User, Mexico)

**Pain:** Manual reconciliation takes 4–6 hours/week

**Need:** Speed, reliability, audit trail

**What matters:**
- Extraction must be fast (< 2s per image)
- Corrections must save immediately (no lag)
- Must work on phone
- Needs audit trail (who did what, when)

**For Phase 1:** Fast, reliable extraction that doesn't lose corrections.

---

### From Developer Insights (7 Missing Pieces)

**Key insight:** Show your work

1. **Suggested Resolutions** — Every flag needs a reason
2. **Suggested Categories** — With edge-case detection
3. **Auto-Approval Queue** — Smart dashboard (not scary)
4. **Learning** — From user decisions
5. **Invoice Matching** — Connect bank txn to invoice
6. **Accounting Impact** — Show GL outcome
7. **Bulk Actions** — Approve many at once

**For Phase 1:** Confidence scoring is step 1. Must show reasoning, not just %, so accountant understands extraction logic.

---

## Real-World Testing Requirements

**Don't test with AI-generated invoices.** Behavior differs significantly from real documents.

**Test with:**
1. **Actual UK invoices** (Sage, FreshBooks, Wave, Xero native exports)
2. **Marketplace receipts** (Amazon, eBay, Etsy screenshots)
3. **Handwritten invoices** (mobile photos)
4. **Damaged/old invoices** (faded text, water stains, poor quality scans)
5. **Multi-currency invoices** (USD, EUR, GBP mixed)
6. **VAT/GST scenarios** (different tax rates)
7. **Custom business forms** (non-standard layouts)

**For each test, verify:**
- Confidence score accurate
- Reasoning makes sense
- Edge cases flagged (not hidden)
- Duplicates detected
- Corrections save properly

---

## Database Schema

```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  
  -- File info
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT, -- pdf, jpg, png, tiff
  file_size INT,
  
  -- Extracted fields
  invoice_number TEXT,
  invoice_date DATE,
  merchant_name TEXT,
  total_amount DECIMAL(12,2),
  tax_amount DECIMAL(12,2),
  currency TEXT DEFAULT 'GBP',
  line_items JSONB, -- Array of {description, amount}
  payment_terms TEXT,
  customer_po_number TEXT,
  
  -- Confidence scores + reasons
  merchant_confidence DECIMAL(3,2),
  merchant_confidence_reason TEXT,
  date_confidence DECIMAL(3,2),
  date_confidence_reason TEXT,
  amount_confidence DECIMAL(3,2),
  amount_confidence_reason TEXT,
  invoice_number_confidence DECIMAL(3,2),
  invoice_number_confidence_reason TEXT,
  
  -- Duplicate handling
  is_duplicate BOOLEAN DEFAULT FALSE,
  duplicate_of_id UUID REFERENCES invoices(id),
  duplicate_checked_at TIMESTAMP,
  
  -- Status
  extraction_status TEXT DEFAULT 'extracted', -- extracted, reviewed, approved, posted
  user_edited BOOLEAN DEFAULT FALSE,
  edited_by_user TIMESTAMP,
  
  -- QB/Xero export
  posted_to_qb BOOLEAN DEFAULT FALSE,
  qb_id TEXT,
  posted_to_xero BOOLEAN DEFAULT FALSE,
  xero_id TEXT,
  export_timestamp TIMESTAMP,
  export_source TEXT, -- "Extracted AI, reviewed user"
  
  -- Metadata
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  
  CONSTRAINT merchant_or_manual CHECK (merchant_name IS NOT NULL OR extraction_status = 'manual_review'),
  INDEX idx_user_id (user_id),
  INDEX idx_invoice_number (invoice_number),
  INDEX idx_extraction_status (extraction_status),
  INDEX idx_is_duplicate (is_duplicate)
);

-- Track corrections for learning
CREATE TABLE invoice_corrections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  
  field_name TEXT NOT NULL, -- merchant_name, invoice_date, amount, etc.
  original_extraction TEXT,
  original_confidence DECIMAL(3,2),
  user_correction TEXT,
  
  corrected_by TEXT, -- user_id
  corrected_at TIMESTAMP DEFAULT now(),
  
  INDEX idx_invoice_id (invoice_id),
  INDEX idx_corrected_at (corrected_at)
);

-- Track duplicate decisions for learning
CREATE TABLE duplicate_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  original_invoice_id UUID NOT NULL REFERENCES invoices(id),
  duplicate_invoice_id UUID NOT NULL REFERENCES invoices(id),
  
  decision TEXT, -- confirmed_duplicate, kept_both, manual_review
  decided_by TEXT, -- user_id
  decided_at TIMESTAMP DEFAULT now(),
  
  INDEX idx_original (original_invoice_id),
  INDEX idx_duplicate (duplicate_invoice_id)
);
```

---

## Testing Checklist

**Upload & Extraction:**
- [ ] Single invoice upload (PDF)
- [ ] Single invoice upload (JPG)
- [ ] Single invoice upload (PNG)
- [ ] Single invoice upload (TIFF)
- [ ] Bulk upload (10+ files)
- [ ] Drag-and-drop upload
- [ ] File size validation (reject > 10MB)
- [ ] Error message for invalid file type

**Confidence Scoring:**
- [ ] High-confidence extraction (95%+) tested with real UK invoice
- [ ] Medium-confidence extraction (70-85%) tested with partially obscured invoice
- [ ] Low-confidence extraction (< 70%) tested with damaged/faded invoice
- [ ] Reasoning displayed for each confidence level
- [ ] Edge cases: Marketplace receipt (75-80% honest confidence)
- [ ] Edge cases: Alphanumeric invoice number (95% recognized)
- [ ] Edge cases: Handwritten amount (60-70% flagged as risky)
- [ ] Edge cases: Multi-currency invoice (handled correctly)
- [ ] Edge cases: Damaged invoice (not guessed, confidence lowered)

**Fallback Validation (Claude Sonnet):**
- [ ] Claude triggered when field < 70%
- [ ] User shown OpenAI vs Claude options
- [ ] User can choose which to use
- [ ] Higher confidence option selected by default

**Confidence Gating:**
- [ ] Results shown ONLY if merchant + date + amount all > 70%
- [ ] Manual review route for < 70% fields
- [ ] Edge cases (75-80%) allowed with confirmation

**Manual Review UI:**
- [ ] Click-to-edit interface works
- [ ] Merchant dropdown suggestions functional
- [ ] Date picker works
- [ ] Amount validation works (numbers only)
- [ ] Edits save immediately (no lag)
- [ ] Corrections timestamped
- [ ] Edit history logged

**Duplicate Detection:**
- [ ] Duplicate in current batch detected
- [ ] Duplicate in historical invoices detected
- [ ] Both invoices shown side-by-side
- [ ] User can confirm duplicate or keep both
- [ ] Decision saved to database
- [ ] Duplicate marked in UI

**Export:**
- [ ] Export to QB works
- [ ] QB transaction ID returned
- [ ] Export to Xero works
- [ ] Contact created if needed
- [ ] Export to CSV works
- [ ] Export metadata included (extraction source, corrections)
- [ ] Export success feedback shown
- [ ] Export error feedback shown

**Performance:**
- [ ] Dashboard loads: < 800ms
- [ ] Single image extraction: < 2s
- [ ] Bulk preview for 20 images: < 3s
- [ ] Manual review UI button feedback: < 50ms
- [ ] Mobile upload on 3G: < 3s

**Data Integrity:**
- [ ] All button clicks post to DB successfully
- [ ] Corrections don't get lost
- [ ] Duplicate decisions logged
- [ ] Audit trail complete
- [ ] No race conditions on rapid clicks

---

## Performance Targets

| Task | Target |
|------|--------|
| Dashboard load | < 800ms |
| Single image extraction | < 2s |
| Bulk preview (20 images) | < 3s |
| Manual review UI responsiveness | < 50ms |
| Mobile upload (3G) | < 3s |
| DB write for correction | < 200ms |
| Export to QB/Xero | < 3s |

---

## Key Principles

1. **Show your work** — Every extraction is explainable. User understands why AI scored things a certain way.

2. **Be honest about uncertainty** — Don't hide edge cases or low confidence. Flag and explain.

3. **Test with real data** — Behavior differs between AI-generated and real-world documents. Test with actual UK invoices, marketplace receipts, damaged documents.

4. **Buttons must work** — Every click must reliably post to database. No intermittent failures.

5. **Speed matters** — Sluggish extraction kills adoption. Performance is a feature.

6. **Audit trail is essential** — Who extracted, who reviewed, who edited, when. Accountants need this.

7. **Edge cases need user decision** — Don't guess on ambiguous extractions. Show alternatives and ask.

8. **Mobile works** — Accountants upload on phones. Must be fast and reliable.

9. **Corrections save immediately** — No lag. User edits, it saves. No "save" button needed.

10. **Learning builds on this** — Corrections logged here feed Phase 2 categorization suggestions.

---

## Success Looks Like

✅ Fast, reliable extraction (< 2s per image)  
✅ Confidence scores with clear reasoning  
✅ Edge cases flagged (not hidden)  
✅ Duplicate detection working  
✅ All buttons reliable (approve, edit, reject)  
✅ Exports to QB/Xero/CSV working  
✅ Audit trail complete  
✅ Mobile functional  
✅ Real invoices tested  
✅ Users trust the extraction (not a black box)