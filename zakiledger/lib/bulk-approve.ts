import {
  arithmeticMismatch,
  REVIEWABLE_FIELDS,
  type DocumentType,
  type InvoiceExtraction,
  type ReviewableField,
} from "./schema";
import { gateApproval, gateReasonSummary } from "./validation";
import {
  findDuplicateDocument,
  getPendingDocument,
  recordConfirmation,
  resolvePendingDocument,
  saveApprovedInvoice,
  type PendingDocument,
  type PendingOutcome,
} from "./store";
import { postApprovedBill } from "./accounting";
import { formatMoney, isSupportedCurrency, unsupportedCurrencyReason } from "./currency";

/**
 * Bulk approve: run the ordinary approval decision over a batch of queued
 * documents, one at a time, and post the ones that clear it.
 *
 * Two properties define this module:
 *
 *  1. **Every document is independent.** One document's failure — a bad currency,
 *     a Xero outage, a corrupt row — must not cost the other nine their approval.
 *     So each item is wrapped in its own try/catch and contributes exactly one
 *     result; the batch itself cannot fail.
 *
 *  2. **The bar is higher than the review screen's, because nobody is watching.**
 *     On the review screen a "review"-status document still offers "Approve
 *     anyway", because a human is looking straight at the flagged field. In bulk
 *     there is no such human, so only a clean "ready" auto-posts. Anything the
 *     gate is unsure about is reported back, not waved through. This is the same
 *     `gateApproval` — the same tiers, the same thresholds — just without the
 *     human override that only makes sense when a human is present.
 *
 * Processing is sequential, which is deliberate rather than lazy: the accounting
 * platforms rate-limit, and it means a document is already in the ledger before
 * the next one is checked — so two copies of the same receipt inside one batch
 * are caught by the existing duplicate rule instead of both sailing through.
 */

/** Per-item outcome. Mirrors the store's `PendingOutcome`. */
export type BulkItemStatus = PendingOutcome;

export interface BulkItemResult {
  documentId: string;
  status: BulkItemStatus;
  /** Supplier on an invoice, merchant on a receipt — the same field either way. */
  merchantName: string;
  total: number | null;
  currency: string;
  documentType: DocumentType;
  /** Why it was blocked or errored. Absent on an approval. */
  reason?: string;
  /** The ledger row it became, when it got that far. */
  invoiceId?: string;
  /** The draft bill it posted as, when a platform is connected. */
  billId?: string | null;
  billPlatform?: string | null;
}

export interface BulkApproveSummary {
  approved: number;
  blocked: number;
  errors: number;
  /** Total actually posted, per currency — a batch can legitimately mix them. */
  postedTotals: Record<string, number>;
  /** Those totals rendered, e.g. "£315.40" or "£315.40 + €40.00". */
  postedLabel: string;
  /** True when documents were approved but no accounting platform is connected. */
  approvedWithoutPosting: boolean;
}

export interface BulkApproveResult {
  results: BulkItemResult[];
  summary: BulkApproveSummary;
}

/** The confidence the gate judges. No edits exist in bulk, so these are the raw reads. */
function confidencesOf(extraction: InvoiceExtraction): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    out[f] = (extraction as any)[f].confidence as number;
  }
  return out;
}

/** Identity fields for a result row, readable whatever the outcome was. */
function identityOf(doc: PendingDocument) {
  const x = doc.extraction;
  return {
    documentId: doc.id,
    merchantName: x.supplierName.value.trim() || "(unknown)",
    total: Number.isFinite(x.total.value) ? x.total.value : null,
    currency: x.currency.value.trim().toUpperCase(),
    documentType: (x.documentType?.value ?? "invoice") as DocumentType,
  };
}

/**
 * Decide and, if it passes, commit one document. Returns the result to report;
 * throwing is reserved for genuinely unexpected failures, which `bulkApprove`
 * catches and turns into an error result.
 */
async function approveOne(doc: PendingDocument): Promise<BulkItemResult> {
  const id = identityOf(doc);
  const x = doc.extraction;
  const documentType = id.documentType;

  // Already in the ledger — almost always a double-click on Approve All. Report
  // it rather than posting a second bill for the same document.
  if (doc.status === "resolved") {
    return { ...id, status: "error", reason: "Already approved — not posted again." };
  }

  // Currency first, before the confidence gate. It is a hard precondition that no
  // amount of reviewing confidence scores can satisfy, so surfacing it first means
  // the human sees the real obstacle in one pass instead of fixing a flagged field
  // and only then discovering the document was never postable.
  if (!isSupportedCurrency(id.currency)) {
    const reason = unsupportedCurrencyReason(x.currency.value);
    await resolvePendingDocument(doc.id, { outcome: "error", reason });
    return { ...id, status: "error", reason };
  }

  // The existing gate, unchanged — including the document-type check, so a
  // document we can't even classify never auto-posts against the wrong field set.
  const gate = gateApproval(confidencesOf(x), {
    documentType,
    taxItemized: x.taxItemized,
    documentTypeConfidence: x.documentType?.confidence,
  });
  if (gate.status !== "ready") {
    const reason = `Needs review: ${gateReasonSummary(gate, documentType)}`;
    await resolvePendingDocument(doc.id, { outcome: "blocked", reason });
    return { ...id, status: "blocked", reason };
  }

  // Internally inconsistent arithmetic must reach a human regardless of stated
  // confidence — the one rule that overrides a confident read.
  if (arithmeticMismatch(x)) {
    const expected = x.subtotal.value + x.tax.value;
    const reason =
      `Totals don't add up — subtotal + tax = ${expected.toFixed(2)}, ` +
      `but the total reads ${x.total.value.toFixed(2)}.`;
    await resolvePendingDocument(doc.id, { outcome: "blocked", reason });
    return { ...id, status: "blocked", reason };
  }

  // Duplicates warn-and-let-the-human-decide on the review screen. There is no
  // human here to decide, so in bulk they block — the safe half of that choice.
  const invoiceNumber = x.invoiceNumber.value.trim();
  const invoiceDate = x.invoiceDate.value.trim() || null;
  const dup = await findDuplicateDocument(documentType, {
    supplierName: id.merchantName,
    invoiceNumber,
    invoiceDate,
    total: id.total,
  });
  if (dup) {
    const reason =
      `Possible duplicate of a ${documentType} already processed on ` +
      `${new Date(dup.createdAt).toLocaleDateString("en-GB")} — approve it individually to confirm.`;
    await resolvePendingDocument(doc.id, { outcome: "blocked", reason });
    return { ...id, status: "blocked", reason };
  }

  // --- Committed from here: it clears the gate, so it enters the ledger. ---
  const invoiceId = await saveApprovedInvoice({
    documentType,
    supplierName: id.merchantName,
    invoiceNumber,
    invoiceDate,
    currency: id.currency,
    subtotal: Number.isFinite(x.subtotal.value) ? x.subtotal.value : null,
    tax: Number.isFinite(x.tax.value) ? x.tax.value : null,
    total: id.total,
    overallConfidence: x.overallConfidence,
  });

  // Bulk approval has no edits, so every field the model actually read is a field
  // the human accepted as read — a confirmation. Same exclusions as the single
  // approve route: a blank value or a zero-confidence read is an absence, not a
  // correct read, and building trust out of absences would corrupt calibration.
  for (const field of REVIEWABLE_FIELDS) {
    const node = (x as any)[field] as { value: unknown; confidence: number };
    const value = String(node.value);
    if (value.trim() === "" || node.confidence <= 0) continue;
    await recordConfirmation({
      invoiceId: invoiceId ?? undefined,
      supplierName: id.merchantName,
      field,
      value,
      confidence: node.confidence,
    });
  }

  // Post to whichever platform is connected. A failure here does NOT undo the
  // approval (the ledger entry and its confirmations stand, same as the single
  // approve route) — but bulk reports it as an error rather than burying it,
  // because nobody is reading a success message per document.
  try {
    const posted = await postApprovedBill({
      documentType,
      supplierName: id.merchantName,
      invoiceNumber: invoiceNumber || null,
      invoiceDate,
      currency: id.currency,
      subtotal: Number.isFinite(x.subtotal.value) ? x.subtotal.value : null,
      tax: Number.isFinite(x.tax.value) ? x.tax.value : null,
      total: id.total,
      lineItems: x.lineItems,
    });
    await resolvePendingDocument(doc.id, { outcome: "approved", invoiceId });
    return {
      ...id,
      status: "approved",
      invoiceId: invoiceId ?? undefined,
      billId: posted?.billId ?? null,
      billPlatform: posted?.platform ?? null,
    };
  } catch (err) {
    const reason =
      `Approved and recorded, but posting the bill failed: ` +
      `${err instanceof Error ? err.message : "unknown error"}`;
    // Resolved despite the error: it IS in the ledger, and re-running it would
    // double-post. The reason tells the human to finish it in the platform.
    await resolvePendingDocument(doc.id, { outcome: "error", reason, invoiceId });
    return { ...id, status: "error", reason, invoiceId: invoiceId ?? undefined };
  }
}

/** Render per-currency posted totals, e.g. "£315.40" or "£315.40 + €40.00". */
function formatPostedTotals(totals: Record<string, number>): string {
  const parts = Object.entries(totals).map(([code, amount]) => formatMoney(amount, code));
  return parts.length > 0 ? parts.join(" + ") : formatMoney(0, "GBP");
}

/**
 * Approve a batch of queued documents. Never throws for a per-document problem —
 * every id in, exactly one result out, in the order given.
 */
export async function bulkApprove(documentIds: string[]): Promise<BulkApproveResult> {
  // A repeated id in one batch would otherwise be approved, then flagged as its
  // own duplicate on the second pass. It's one document; approve it once.
  const ids = [...new Set(documentIds)];
  const results: BulkItemResult[] = [];

  for (const documentId of ids) {
    try {
      const doc = await getPendingDocument(documentId);
      if (!doc) {
        results.push({
          documentId,
          status: "error",
          merchantName: "(unknown)",
          total: null,
          currency: "",
          documentType: "invoice",
          reason: "Document not found — it may have already been cleared from the queue.",
        });
        continue;
      }
      results.push(await approveOne(doc));
    } catch (err) {
      // The isolation guarantee: whatever went wrong with this one document, the
      // rest of the batch still gets processed.
      results.push({
        documentId,
        status: "error",
        merchantName: "(unknown)",
        total: null,
        currency: "",
        documentType: "invoice",
        reason: err instanceof Error ? err.message : "Approval failed.",
      });
    }
  }

  const approvedItems = results.filter((r) => r.status === "approved");
  const postedTotals: Record<string, number> = {};
  for (const r of approvedItems) {
    if (r.total === null) continue;
    postedTotals[r.currency] = (postedTotals[r.currency] ?? 0) + r.total;
  }

  return {
    results,
    summary: {
      approved: approvedItems.length,
      blocked: results.filter((r) => r.status === "blocked").length,
      errors: results.filter((r) => r.status === "error").length,
      postedTotals,
      postedLabel: formatPostedTotals(postedTotals),
      approvedWithoutPosting: approvedItems.length > 0 && approvedItems.every((r) => !r.billId),
    },
  };
}
