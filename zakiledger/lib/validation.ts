/**
 * Client-side invoice validation for the review screen.
 *
 * Two independent checks, both pure calculations on numbers we already hold — no
 * API calls, no AI calls, so they recompute instantly as the human edits:
 *   1. `checkTotals`   — does subtotal + tax reconcile to the total?
 *   2. `gateApproval`  — do we trust the extracted fields enough to approve?
 * They catch different problems and can both fire at once. Neither ever hard-
 * locks a human out of approving; the accountant stays in the loop.
 */
import type { DocumentType, ReviewableField } from "./schema";

// --- Confidence-based approval gating ---------------------------------------

/** Fields that must be trustworthy before approval — a low score here blocks. */
export const CRITICAL_FIELDS: ReviewableField[] = [
  "supplierName",
  "invoiceNumber",
  "invoiceDate",
  "total",
];

/**
 * Which fields are Critical, per document type. Same tiers, same thresholds, same
 * classifier — only the membership differs, because the documents differ.
 *
 * A receipt drops `invoiceNumber` from Critical: till receipts routinely carry no
 * number, so gating on it would permanently block a perfectly good receipt on a
 * field the document never had. It stays visible and editable, just ungated.
 */
export const CRITICAL_FIELDS_BY_TYPE: Record<DocumentType, ReviewableField[]> = {
  invoice: CRITICAL_FIELDS,
  receipt: ["supplierName", "invoiceDate", "total"],
};

/** Fields that warrant a warning (but not a block) when low confidence. */
export const IMPORTANT_FIELDS: ReviewableField[] = ["tax", "currency"];

/** A Critical field below this confidence blocks approval. */
export const CRITICAL_THRESHOLD = 0.8;

/** An Important field below this confidence warns but still allows approval. */
export const IMPORTANT_THRESHOLD = 0.6;

/**
 * A field's effective confidence for the approval gate. Two human actions count
 * as verified (→ 1.0), both of which clear the gate:
 *   - editing the value to something new and non-empty (a correction), or
 *   - explicitly affirming the value as-is ("confirm as-is") without changing it.
 *
 * The affirm path is what breaks the deadlock: a correct-but-low-confidence field
 * (e.g. an invoice number the model reads right but timidly) can clear the gate
 * WITHOUT an edit — so the approve route records it as a confirmation, not a
 * correction, and its calibration trend accumulates instead of resetting.
 * Otherwise the model's raw confidence stands.
 */
export function effectiveConfidence(
  rawConfidence: number,
  original: string,
  editedValue: string | undefined,
  affirmed: boolean,
): number {
  const changedNonEmpty =
    editedValue !== undefined && editedValue !== original && editedValue.trim() !== "";
  const affirmedAsIs = affirmed && (editedValue === undefined || editedValue === original);
  return changedNonEmpty || affirmedAsIs ? 1 : rawConfidence;
}

export type ApprovalStatus = "ready" | "review" | "blocked";

/** A single field that fell short, with the confidence that triggered it. */
export interface ApprovalReason {
  field: ReviewableField;
  confidence: number;
}

export interface ApprovalGate {
  status: ApprovalStatus;
  /** Which field(s) triggered a "review" or "blocked" status (empty when ready). */
  reasons: ApprovalReason[];
}

/** Document-shape facts that change which fields the gate can fairly judge. */
export interface GateContext {
  /** invoice (default) or receipt — selects the Critical field set. */
  documentType?: DocumentType;
  /**
   * Did the document state a tax amount? When false, tax is excluded from the
   * Important tier: a document that doesn't break out tax hasn't failed to read
   * it, and warning about it would be noise.
   */
  taxItemized?: boolean;
}

/**
 * Classify whether an extraction is trustworthy enough to approve, given the
 * effective confidence per field. Rules evaluate in order — a Critical failure
 * blocks outright before Important fields are even considered:
 *   1. any Critical field  < CRITICAL_THRESHOLD  → "blocked"
 *   2. any Important field < IMPORTANT_THRESHOLD → "review"
 *   3. otherwise                                 → "ready"
 *
 * "Effective" confidence means the caller should pass 1 (100%) for any field the
 * human has edited — a human-entered value is verified, which is what lets a
 * blocked form unlock live as the accountant corrects the flagged field.
 *
 * `ctx` only changes *which fields are judged*, never the tiers or thresholds —
 * receipts run through this same classifier, not a parallel one.
 */
export function gateApproval(
  confidenceByField: Record<ReviewableField, number>,
  ctx: GateContext = {},
): ApprovalGate {
  const criticalFields = CRITICAL_FIELDS_BY_TYPE[ctx.documentType ?? "invoice"];
  const critical = criticalFields.filter((f) => confidenceByField[f] < CRITICAL_THRESHOLD);
  if (critical.length > 0) {
    return { status: "blocked", reasons: critical.map((f) => ({ field: f, confidence: confidenceByField[f] })) };
  }

  // A document that states no tax has no tax read to doubt — drop it from the tier.
  const importantFields =
    ctx.taxItemized === false ? IMPORTANT_FIELDS.filter((f) => f !== "tax") : IMPORTANT_FIELDS;
  const important = importantFields.filter((f) => confidenceByField[f] < IMPORTANT_THRESHOLD);
  if (important.length > 0) {
    return { status: "review", reasons: important.map((f) => ({ field: f, confidence: confidenceByField[f] })) };
  }

  return { status: "ready", reasons: [] };
}

// --- Arithmetic reconciliation ----------------------------------------------

/** Rounding tolerance (in currency units) when checking subtotal + tax = total. */
export const TOTALS_TOLERANCE = 0.01;

export interface TotalsCheck {
  /** True when subtotal + tax equals total within TOTALS_TOLERANCE. */
  ok: boolean;
  /** The arithmetic expectation: subtotal + tax. */
  expected: number;
  /** The total as entered/extracted. */
  found: number;
}

/**
 * Verify subtotal + tax = total within a small rounding tolerance.
 * Returns null when any input isn't a finite number (nothing to check yet).
 */
export function checkTotals(
  subtotal: number | null,
  tax: number | null,
  total: number | null,
): TotalsCheck | null {
  if (subtotal === null || tax === null || total === null) return null;
  if (!Number.isFinite(subtotal) || !Number.isFinite(tax) || !Number.isFinite(total)) return null;

  const expected = subtotal + tax;
  return { ok: Math.abs(expected - total) <= TOTALS_TOLERANCE, expected, found: total };
}
