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

/**
 * What a gate reason can point at: a reviewable field, or the document-type
 * classification itself (which is not a field the human edits, but is gated the
 * same way — see gateApproval).
 */
export type GateSubject = ReviewableField | "documentType";

/** A single field that fell short, with the confidence that triggered it. */
export interface ApprovalReason {
  field: GateSubject;
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
  /**
   * The model's confidence in the invoice-vs-receipt classification. Gated with
   * the same CRITICAL_THRESHOLD used for fields, one level up — see the note on
   * gateApproval. Omitted (undefined) means "not supplied", which is treated as
   * certain, so existing callers are unaffected.
   */
  documentTypeConfidence?: number;
  /**
   * The human explicitly confirmed (or overrode) the document type. Clears the
   * type gate, mirroring confirm-as-is for fields — without it an uncertain
   * classification would be an unbreakable deadlock, since the type is not a
   * field the human can edit.
   */
  documentTypeConfirmed?: boolean;
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
 *
 * Rule 0 runs before all of them: if the document-type classification itself is
 * below CRITICAL_THRESHOLD, block. Everything downstream — which fields are
 * Critical, what the labels say, how duplicates are matched — is derived from
 * that one decision, so committing to it silently on a 51/49 read would gate the
 * document against the wrong field set with no sign anything was uncertain. It
 * is the most load-bearing value in the extraction and was the only one not
 * subject to the trust rules; this applies the same threshold one level up.
 * `documentTypeConfirmed` is the escape hatch, exactly as confirm-as-is is for a
 * correct-but-timid field.
 */
export function gateApproval(
  confidenceByField: Record<ReviewableField, number>,
  ctx: GateContext = {},
): ApprovalGate {
  const typeConfidence = ctx.documentTypeConfidence;
  if (
    typeConfidence !== undefined &&
    typeConfidence < CRITICAL_THRESHOLD &&
    !ctx.documentTypeConfirmed
  ) {
    return { status: "blocked", reasons: [{ field: "documentType", confidence: typeConfidence }] };
  }

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

// --- Human-readable gate reasons --------------------------------------------

/**
 * Field labels — bookkeepers should never see raw field keys. Same fields either
 * way; a receipt just calls them by their receipt names ("Merchant", not
 * "Supplier"), which is what's printed on the document in front of them.
 *
 * Lives here, next to the gate, because two callers now render gate reasons: the
 * review screen (per field, as the human edits) and bulk approve (server-side,
 * where no human is present to interpret a field key). One wording, both places.
 */
export const FIELD_LABELS_BY_TYPE: Record<DocumentType, Record<ReviewableField, string>> = {
  invoice: {
    supplierName: "Supplier",
    invoiceNumber: "Invoice number",
    invoiceDate: "Invoice date",
    currency: "Currency",
    subtotal: "Subtotal",
    tax: "Tax",
    total: "Total",
  },
  receipt: {
    supplierName: "Merchant",
    invoiceNumber: "Receipt number (optional)",
    invoiceDate: "Receipt date",
    currency: "Currency",
    subtotal: "Subtotal",
    tax: "VAT",
    total: "Total",
  },
};

export function fieldLabels(documentType: DocumentType): Record<ReviewableField, string> {
  return FIELD_LABELS_BY_TYPE[documentType] ?? FIELD_LABELS_BY_TYPE.invoice;
}

/** e.g. "Invoice date not detected (0%)" or "Tax low confidence (34%)". */
export function reasonText(
  field: GateSubject,
  confidence: number,
  documentType: DocumentType,
): string {
  const pct = Math.round(confidence * 100);
  if (field === "documentType") {
    return `Not sure whether this is an invoice or a receipt (${pct}%) — confirm below`;
  }
  return `${fieldLabels(documentType)[field]} ${pct === 0 ? "not detected" : "low confidence"} (${pct}%)`;
}

/** All of a gate's reasons as one sentence — for contexts with no per-field UI. */
export function gateReasonSummary(gate: ApprovalGate, documentType: DocumentType): string {
  return gate.reasons.map((r) => reasonText(r.field, r.confidence, documentType)).join("; ");
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
