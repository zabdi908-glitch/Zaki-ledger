// zod/v4 subpath — required so schemas are compatible with the Anthropic SDK's
// zodOutputFormat helper (which imports from "zod/v4").
import { z } from "zod/v4";

/**
 * Every extracted field carries its own confidence (0–1). This is principle #2:
 * confidence scores, not a black box. High-confidence fields auto-fill; low-confidence
 * fields get flagged for a human. The UI uses `confidence` to decide what to highlight.
 */
const ConfidentString = z.object({
  value: z.string(),
  confidence: z.number(),
});

const ConfidentNumber = z.object({
  value: z.number(),
  confidence: z.number(),
});

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number(),
});

/**
 * What kind of document this is. Detected by the same extraction pass that reads
 * the fields — one pipeline, not two. The difference is not the data we pull but
 * what we can *expect* to find: a receipt often has no document number and often
 * doesn't break out tax, so downstream gating relaxes accordingly.
 */
export const DocumentTypeSchema = z.enum(["invoice", "receipt"]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

const ConfidentDocumentType = z.object({
  value: DocumentTypeSchema,
  confidence: z.number(),
});

export const InvoiceExtractionSchema = z.object({
  /** invoice | receipt, detected in the same pass as the fields. */
  documentType: ConfidentDocumentType,
  /**
   * The counterparty we bought from. Labelled "Supplier" on an invoice and
   * "Merchant" on a receipt — same field, same storage, same per-party learning.
   * Keeping one key is deliberate: the correction/confirmation ledgers and the
   * calibration curve are all keyed on it, so a receipt's merchant history
   * accumulates through exactly the same machinery as a supplier's.
   */
  supplierName: ConfidentString,
  /**
   * Invoice number, or a receipt's transaction/receipt number. **Optional on a
   * receipt** — plenty of till receipts carry no number at all. When absent the
   * model returns "" at confidence 0 and the gate stops treating it as critical
   * (see CRITICAL_FIELDS_BY_TYPE); it is never a hard error.
   */
  invoiceNumber: ConfidentString,
  invoiceDate: ConfidentString, // ISO 8601 (YYYY-MM-DD) where possible
  currency: ConfidentString, // e.g. "GBP"
  subtotal: ConfidentNumber,
  tax: ConfidentNumber,
  total: ConfidentNumber,
  /**
   * Did the document actually break out a tax/VAT amount? Receipts frequently
   * show only a gross total. False means "this document doesn't state tax" —
   * which is a fact about the document, not a failed read, so it must degrade
   * gracefully: the tax field drops out of the confidence gate and the
   * subtotal + tax = total arithmetic check is skipped rather than failed.
   */
  taxItemized: z.boolean(),
  lineItems: z.array(LineItemSchema),
  /** The model's own overall confidence in the whole extraction. */
  overallConfidence: z.number(),
});

export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;
export type LineItem = z.infer<typeof LineItemSchema>;

/** Fields the human reviews/edits — used by the correction ledger. */
export const REVIEWABLE_FIELDS = [
  "supplierName",
  "invoiceNumber",
  "invoiceDate",
  "currency",
  "subtotal",
  "tax",
  "total",
] as const;
export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

/**
 * Cross-check the arithmetic. If subtotal + tax != total (within a penny), the
 * extraction is internally inconsistent and MUST be flagged to a human regardless
 * of the model's stated confidence. Consistency is a feature, not an afterthought.
 *
 * Skipped when the document doesn't itemise tax (common on receipts): there is no
 * subtotal/tax split to reconcile, so "0 + 0 != 12.50" is a property of the
 * document, not an inconsistency. Flagging it would be a false alarm that trains
 * the user to ignore the check.
 */
export function arithmeticMismatch(x: InvoiceExtraction): boolean {
  if (!x.taxItemized) return false;
  const expected = x.subtotal.value + x.tax.value;
  return Math.abs(expected - x.total.value) > 0.01;
}
