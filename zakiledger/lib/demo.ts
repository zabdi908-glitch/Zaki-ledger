import type { InvoiceExtraction } from "./schema";

function s(value: string, confidence: number, reason = "demo fixture"): { value: string; confidence: number; reason: string } {
  return { value, confidence, reason };
}
function n(value: number, confidence: number, reason = "demo fixture"): { value: number; confidence: number; reason: string } {
  return { value, confidence, reason };
}
function dt(value: "invoice" | "receipt", confidence: number, reason = "demo fixture"): { value: "invoice" | "receipt"; confidence: number; reason: string } {
  return { value, confidence, reason };
}

/**
 * Realistic sample extractions, returned when ANTHROPIC_API_KEY isn't set so the
 * full flow (review → edit → approve → correction recorded) can be demoed with
 * zero setup — no API key, no database.
 *
 * `invoiceNumber` is deliberately low-confidence (< the UI's 0.85 threshold) so
 * the "⚠ check" highlight and the correction loop are both visible in the demo.
 * The amounts are internally consistent (subtotal + tax = total).
 */
export function sampleExtraction(): InvoiceExtraction {
  return {
    documentType: dt("invoice", 0.98),
    supplierName: s("Riverside Office Supplies Ltd", 0.97),
    invoiceNumber: s("INV-20487", 0.72, "deliberately low for demo"), // low → flagged for review
    invoiceDate: s("2026-06-30", 0.94),
    currency: s("GBP", 0.99),
    subtotal: n(240.0, 0.96),
    tax: n(48.0, 0.9),
    total: n(288.0, 0.98),
    taxItemized: true,
    lineItems: [
      { description: "A4 paper (box of 5 reams)", quantity: 4, unitPrice: 24.0, amount: 96.0 },
      { description: "Ballpoint pens (pack of 50)", quantity: 6, unitPrice: 12.0, amount: 72.0 },
      { description: "Desk organiser", quantity: 3, unitPrice: 24.0, amount: 72.0 },
    ],
    overallConfidence: 0.9,
  };
}

/**
 * A clean VAT receipt: has a receipt number and breaks out VAT, so it behaves
 * almost exactly like an invoice — the arithmetic check runs and passes.
 */
export function sampleReceiptExtraction(): InvoiceExtraction {
  return {
    documentType: dt("receipt", 0.96),
    supplierName: s("Greenway Fuel & Services", 0.95),
    invoiceNumber: s("R-88213", 0.88),
    invoiceDate: s("2026-07-18", 0.93),
    currency: s("GBP", 0.99),
    subtotal: n(52.5, 0.94),
    tax: n(10.5, 0.91),
    total: n(63.0, 0.97),
    taxItemized: true,
    lineItems: [{ description: "Unleaded petrol 35.2L", quantity: 1, unitPrice: 52.5, amount: 52.5 }],
    overallConfidence: 0.94,
  };
}

/**
 * The awkward-but-common case, and the one worth demoing: a crumpled till receipt
 * with **no receipt number at all** and **no VAT breakdown** — just a gross total.
 *
 * Everything about it should degrade gracefully rather than error:
 *   - `invoiceNumber` "" @ 0 → not Critical for a receipt, so it never blocks.
 *   - `taxItemized: false` → tax drops out of the gate and the
 *     subtotal + tax = total check is skipped, not failed.
 *   - the merchant name is genuinely smudged, so it sits low and DOES gate —
 *     that one is a real read problem and should be flagged.
 */
export function sampleMessyReceiptExtraction(): InvoiceExtraction {
  return {
    documentType: dt("receipt", 0.89),
    supplierName: s("The Corner Cafe", 0.61, "smudged → gates"), // smudged → gates
    invoiceNumber: s("", 0, "no number on the receipt at all"), // no number on the receipt at all
    invoiceDate: s("2026-07-22", 0.86),
    currency: s("GBP", 0.97),
    subtotal: n(0, 0, "no subtotal line"), // no subtotal line
    tax: n(0, 0, "VAT not broken out"), // VAT not broken out
    total: n(12.4, 0.95),
    taxItemized: false,
    lineItems: [
      { description: "Flat white x2", quantity: 2, unitPrice: 3.2, amount: 6.4 },
      { description: "Toasted sandwich", quantity: 1, unitPrice: 6.0, amount: 6.0 },
    ],
    overallConfidence: 0.78,
  };
}

/**
 * A document the model genuinely can't classify — a paid invoice stamped "PAID",
 * which reads as both. documentType confidence sits below CRITICAL_THRESHOLD, so
 * approval blocks until a human settles the type. Every field reads well; the
 * uncertainty is purely about *what kind of document this is*, which is exactly
 * the case that used to commit to a ruleset silently.
 */
export function sampleAmbiguousExtraction(): InvoiceExtraction {
  return {
    documentType: dt("invoice", 0.54, "coin-flip → gates"), // coin-flip → gates
    supplierName: s("Harbour Print Co", 0.95),
    invoiceNumber: s("HP-4471", 0.92),
    invoiceDate: s("2026-07-14", 0.93),
    currency: s("GBP", 0.98),
    subtotal: n(180.0, 0.94),
    tax: n(36.0, 0.92),
    total: n(216.0, 0.96),
    taxItemized: true,
    lineItems: [{ description: "Business cards (500)", quantity: 1, unitPrice: 180.0, amount: 180.0 }],
    overallConfidence: 0.86,
  };
}

/**
 * A perfectly-read receipt in a currency we don't post in. Every field is
 * confident, so the confidence gate has nothing to say about it — which is the
 * point: this failure mode is invisible to the gate and has to be caught by an
 * explicit precondition, or the bill goes out booked at the wrong amount in the
 * organisation's base currency.
 */
export function sampleForeignCurrencyReceiptExtraction(): InvoiceExtraction {
  return {
    documentType: dt("receipt", 0.95),
    supplierName: s("Shinjuku Station Kiosk", 0.93),
    invoiceNumber: s("T-5521", 0.87),
    invoiceDate: s("2026-07-19", 0.94),
    currency: s("JPY", 0.96, "read correctly — we just can't post it"), // read correctly — we just can't post it
    subtotal: n(3400, 0.93),
    tax: n(340, 0.9),
    total: n(3740, 0.95),
    taxItemized: true,
    lineItems: [{ description: "Rail pass top-up", quantity: 1, unitPrice: 3400, amount: 3400 }],
    overallConfidence: 0.93,
  };
}

/**
 * The mixed batch the bulk-approve flow is designed around — five documents that
 * between them exercise all three outcomes in one pass:
 *
 *   3 clean receipts        → high confidence throughout, arithmetic reconciles,
 *                             distinct merchant/date/total so none reads as a
 *                             duplicate of another → all three approve and post.
 *   1 smudged merchant name → Critical field under threshold → blocked for review.
 *   1 foreign currency      → confident but unpostable → error, with the reason.
 *
 * Deliberately kept as data, not as a test-only fixture: it's what the "Load demo
 * batch" button seeds, so the feature is demonstrable with no key and no database.
 */
export function sampleBulkBatch(): Array<{ filename: string; extraction: InvoiceExtraction }> {
  return [
    { filename: "receipt-greenway-fuel.png", extraction: sampleReceiptExtraction() },
    {
      filename: "receipt-northgate-hardware.png",
      extraction: {
        ...sampleReceiptExtraction(),
        supplierName: s("Northgate Hardware", 0.96),
        invoiceNumber: s("NH-10442", 0.91),
        invoiceDate: s("2026-07-20", 0.95),
        subtotal: n(128.0, 0.95),
        tax: n(25.6, 0.92),
        total: n(153.6, 0.97),
        lineItems: [
          { description: "Cordless drill bits (set)", quantity: 2, unitPrice: 44.0, amount: 88.0 },
          { description: "Safety goggles", quantity: 4, unitPrice: 10.0, amount: 40.0 },
        ],
      },
    },
    {
      filename: "receipt-mereside-catering.png",
      extraction: {
        ...sampleReceiptExtraction(),
        supplierName: s("Mereside Catering", 0.94),
        invoiceNumber: s("MC-3390", 0.89),
        invoiceDate: s("2026-07-21", 0.92),
        subtotal: n(82.5, 0.93),
        tax: n(16.5, 0.9),
        total: n(99.0, 0.96),
        lineItems: [{ description: "Team lunch (11 covers)", quantity: 11, unitPrice: 7.5, amount: 82.5 }],
      },
    },
    { filename: "messy-till-receipt.png", extraction: sampleMessyReceiptExtraction() },
    { filename: "receipt-tokyo-kiosk.png", extraction: sampleForeignCurrencyReceiptExtraction() },
  ];
}

/**
 * Pick a demo sample from the uploaded filename, so the receipt paths are
 * reachable without an API key: a name containing "messy" or "till" gives the
 * no-number/no-VAT receipt, "ambiguous" gives the unclassifiable document,
 * "foreign" or "jpy" gives the unpostable-currency receipt, "receipt" gives the
 * clean receipt, anything else gives the invoice.
 * Demo-mode only — real extraction never looks at the name.
 */
export function sampleForFilename(filename: string): InvoiceExtraction {
  const name = filename.toLowerCase();
  if (name.includes("messy") || name.includes("till")) return sampleMessyReceiptExtraction();
  if (name.includes("ambiguous")) return sampleAmbiguousExtraction();
  if (name.includes("foreign") || name.includes("jpy")) {
    return sampleForeignCurrencyReceiptExtraction();
  }
  if (name.includes("receipt")) return cleanReceiptForName(name);
  return sampleExtraction();
}

/**
 * A clean receipt, varied by any digit in the filename.
 *
 * Without this, uploading receipt-1 … receipt-5 in demo mode returns five copies
 * of the same receipt — and copies two and three correctly block as duplicates of
 * copy one. That is the duplicate rule working exactly as intended, but it left
 * the batch flow impossible to demonstrate without an API key: the one thing the
 * demo data exists to prevent. The three distinct receipts are the ones the
 * "Load a demo batch" button already seeds, reused rather than re-invented.
 */
function cleanReceiptForName(name: string): InvoiceExtraction {
  const pool = sampleBulkBatch()
    .slice(0, 3)
    .map((b) => b.extraction);
  const digit = name.match(/\d/)?.[0];
  return digit ? pool[(Number(digit) - 1 + pool.length) % pool.length] : pool[0];
}

/**
 * Demo-mode filenames that stand for an unreadable file. Demo extraction always
 * succeeds otherwise, which left the one outcome the batch screen has to handle
 * gracefully — a file that simply can't be read — unreachable without a real API
 * key and a genuinely corrupt document.
 */
export function isDemoUnreadable(filename: string): boolean {
  const name = filename.toLowerCase();
  return name.includes("broken") || name.includes("corrupt") || name.includes("unreadable");
}
