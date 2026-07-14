import type { InvoiceExtraction } from "./schema";

/**
 * A realistic sample extraction, returned when ANTHROPIC_API_KEY isn't set so the
 * full flow (review → edit → approve → correction recorded) can be demoed with
 * zero setup — no API key, no database.
 *
 * `invoiceNumber` is deliberately low-confidence (< the UI's 0.85 threshold) so
 * the "⚠ check" highlight and the correction loop are both visible in the demo.
 * The amounts are internally consistent (subtotal + tax = total).
 */
export function sampleExtraction(): InvoiceExtraction {
  return {
    supplierName: { value: "Riverside Office Supplies Ltd", confidence: 0.97 },
    invoiceNumber: { value: "INV-20487", confidence: 0.72 }, // low → flagged for review
    invoiceDate: { value: "2026-06-30", confidence: 0.94 },
    currency: { value: "GBP", confidence: 0.99 },
    subtotal: { value: 240.0, confidence: 0.96 },
    tax: { value: 48.0, confidence: 0.9 },
    total: { value: 288.0, confidence: 0.98 },
    lineItems: [
      { description: "A4 paper (box of 5 reams)", quantity: 4, unitPrice: 24.0, amount: 96.0 },
      { description: "Ballpoint pens (pack of 50)", quantity: 6, unitPrice: 12.0, amount: 72.0 },
      { description: "Desk organiser", quantity: 3, unitPrice: 24.0, amount: 72.0 },
    ],
    overallConfidence: 0.9,
  };
}
