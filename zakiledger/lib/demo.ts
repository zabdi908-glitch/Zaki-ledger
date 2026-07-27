import type { InvoiceExtraction } from "./schema";

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
    documentType: { value: "invoice", confidence: 0.98 },
    supplierName: { value: "Riverside Office Supplies Ltd", confidence: 0.97 },
    invoiceNumber: { value: "INV-20487", confidence: 0.72 }, // low → flagged for review
    invoiceDate: { value: "2026-06-30", confidence: 0.94 },
    currency: { value: "GBP", confidence: 0.99 },
    subtotal: { value: 240.0, confidence: 0.96 },
    tax: { value: 48.0, confidence: 0.9 },
    total: { value: 288.0, confidence: 0.98 },
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
    documentType: { value: "receipt", confidence: 0.96 },
    supplierName: { value: "Greenway Fuel & Services", confidence: 0.95 },
    invoiceNumber: { value: "R-88213", confidence: 0.88 },
    invoiceDate: { value: "2026-07-18", confidence: 0.93 },
    currency: { value: "GBP", confidence: 0.99 },
    subtotal: { value: 52.5, confidence: 0.94 },
    tax: { value: 10.5, confidence: 0.91 },
    total: { value: 63.0, confidence: 0.97 },
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
    documentType: { value: "receipt", confidence: 0.89 },
    supplierName: { value: "The Corner Cafe", confidence: 0.61 }, // smudged → gates
    invoiceNumber: { value: "", confidence: 0 }, // no number on the receipt at all
    invoiceDate: { value: "2026-07-22", confidence: 0.86 },
    currency: { value: "GBP", confidence: 0.97 },
    subtotal: { value: 0, confidence: 0 }, // no subtotal line
    tax: { value: 0, confidence: 0 }, // VAT not broken out
    total: { value: 12.4, confidence: 0.95 },
    taxItemized: false,
    lineItems: [
      { description: "Flat white x2", quantity: 2, unitPrice: 3.2, amount: 6.4 },
      { description: "Toasted sandwich", quantity: 1, unitPrice: 6.0, amount: 6.0 },
    ],
    overallConfidence: 0.78,
  };
}

/**
 * Pick a demo sample from the uploaded filename, so the receipt paths are
 * reachable without an API key: a name containing "messy" or "till" gives the
 * no-number/no-VAT receipt, "receipt" gives the clean receipt, anything else
 * gives the invoice. Demo-mode only — real extraction never looks at the name.
 */
export function sampleForFilename(filename: string): InvoiceExtraction {
  const name = filename.toLowerCase();
  if (name.includes("messy") || name.includes("till")) return sampleMessyReceiptExtraction();
  if (name.includes("receipt")) return sampleReceiptExtraction();
  return sampleExtraction();
}
