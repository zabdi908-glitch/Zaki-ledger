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

export const InvoiceExtractionSchema = z.object({
  supplierName: ConfidentString,
  invoiceNumber: ConfidentString,
  invoiceDate: ConfidentString, // ISO 8601 (YYYY-MM-DD) where possible
  currency: ConfidentString, // e.g. "GBP"
  subtotal: ConfidentNumber,
  tax: ConfidentNumber,
  total: ConfidentNumber,
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
 */
export function arithmeticMismatch(x: InvoiceExtraction): boolean {
  const expected = x.subtotal.value + x.tax.value;
  return Math.abs(expected - x.total.value) > 0.01;
}
