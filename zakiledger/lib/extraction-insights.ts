import { formatMoney, isSupportedCurrency, unsupportedCurrencyReason } from "./currency";
import type { DocumentType, ReviewableField } from "./schema";
import { checkTotals, gateApproval, reasonText, type ApprovalGate } from "./validation";
import { shellColor } from "./shell-theme";
import type { ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";

/**
 * Turns lib/validation.ts's real approval gate into the review board's row
 * shape. This module never re-derives Critical/Important thresholds — it
 * only wraps gateApproval's output in copy and a review-board section.
 */

export function plainEnglishGateReason(gate: ApprovalGate, documentType: DocumentType): string {
  if (gate.status === "ready") return "Every field read with enough confidence to post automatically.";
  return gate.reasons.map((r) => reasonText(r.field, r.confidence, documentType)).join(" ");
}

export function sectionForGate(gate: ApprovalGate, isDuplicate: boolean): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (gate.status === "ready") return "ready";
  if (gate.status === "review") return "review";
  return "issue";
}

export interface QueueItem {
  id: string;
  documentType: DocumentType;
  merchantName: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  total: number;
  overallConfidence: number;
  /**
   * Real per-field confidence, when the list endpoint ships it (Fix 3). Absent
   * for legacy callers, which fall back to overallConfidence per field — the
   * fabrication Bug 3 was about, so the list endpoint now always provides it.
   */
  perFieldConfidence?: Partial<Record<ReviewableField, number>>;
  /** Whether the document breaks out tax — drops tax from the gate and skips
   * the arithmetic check when false. */
  taxItemized?: boolean;
  /** Confidence in the invoice-vs-receipt classification (gated like a critical
   * field — see gateApproval). */
  documentTypeConfidence?: number;
  /** Raw subtotal/tax values, so the list row can run the totals check. */
  subtotal?: number | null;
  tax?: number | null;
}

/** Same supplier + invoice number + total already elsewhere in the queue —
 * the "uploaded twice" case. Receipts (no reliable invoice number) key on
 * supplier + date + total instead. */
export function detectQueueDuplicates(items: QueueItem[]): Map<string, QueueItem> {
  const result = new Map<string, QueueItem>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const sameSupplier = a.merchantName.trim().toLowerCase() === b.merchantName.trim().toLowerCase() && a.merchantName.trim() !== "";
      const sameTotal = Math.abs(a.total - b.total) < 0.005;
      const sameKey =
        a.documentType === "invoice" && a.invoiceNumber.trim() && b.invoiceNumber.trim()
          ? a.invoiceNumber.trim() === b.invoiceNumber.trim()
          : a.invoiceDate === b.invoiceDate;
      if (sameSupplier && sameTotal && sameKey) {
        result.set(a.id, b);
        result.set(b.id, a);
      }
    }
  }
  return result;
}

function confidenceLabel(pct: number): string {
  if (pct >= 95) return "High confidence";
  if (pct >= 70) return "Medium confidence";
  return "Low confidence";
}
function confidenceColor(pct: number): string {
  if (pct >= 95) return shellColor.high;
  if (pct >= 70) return shellColor.medium;
  return shellColor.low;
}

/** Whether a queue item's arithmetic reconciles, when we have the numbers to
 * check. Mirrors bulk-approve's precondition: a doc whose subtotal + tax don't
 * add up must not sit in "Ready to Approve" as if posting were safe. */
function totalsReconcile(item: QueueItem): boolean {
  if (!item.taxItemized) return true; // no tax split to reconcile (common on receipts)
  if (item.subtotal === undefined || item.tax === undefined) return true; // not shipped — can't verify, don't invent a failure
  const check = checkTotals(item.subtotal, item.tax, item.total);
  return check === null || check.ok;
}

export function buildQueueRow(item: QueueItem, isDuplicate: boolean): { row: ReviewRow; gate: ApprovalGate } {
  const pct = Math.round(item.overallConfidence * 100);
  // Real per-field confidence when the list endpoint ships it (GET /api/pending
  // now does, Fix 3). Legacy callers — and the unit tests' minimal QueueItem —
  // fall back to the overall score, which is exactly the fabrication Bug 3 was
  // about: overall 78% ≠ a 61% merchant read, and gating on the average hid the
  // real blocker. The side panel still re-fetches the full per-field breakdown
  // from GET /api/pending/[id] and is the source of truth once opened.
  const fallback = (f: ReviewableField) => item.perFieldConfidence?.[f] ?? item.overallConfidence;
  const perField: Record<ReviewableField, number> = {
    supplierName: fallback("supplierName"),
    invoiceNumber: fallback("invoiceNumber"),
    invoiceDate: fallback("invoiceDate"),
    currency: fallback("currency"),
    subtotal: fallback("subtotal"),
    tax: fallback("tax"),
    total: fallback("total"),
  };
  const gate = gateApproval(perField, {
    documentType: item.documentType,
    taxItemized: item.taxItemized,
    documentTypeConfidence: item.documentTypeConfidence,
  });

  // Approve-time preconditions the confidence gate can't see (mirrored from
  // bulk-approve and now enforced by /api/approve too): an unsupported currency
  // and inconsistent arithmetic are hard stops no matter how confidently the
  // fields were read. A doc failing one of these must not be listed as ready.
  const postable = isSupportedCurrency(item.currency);
  const totalsOk = totalsReconcile(item);

  let section = sectionForGate(gate, isDuplicate);
  if (section === "ready" && (!postable || !totalsOk)) section = "issue";

  const reason =
    [
      postable ? null : unsupportedCurrencyReason(item.currency),
      totalsOk ? null : "Totals don't add up — subtotal + tax doesn't reconcile to the printed total.",
      gate.status === "ready" ? null : plainEnglishGateReason(gate, item.documentType),
    ]
      .filter((s): s is string => !!s)
      .join(" ") || "Every field read with enough confidence to post automatically.";

  const row: ReviewRow = {
    id: item.id,
    section,
    date: formatShortDate(item.invoiceDate),
    title: item.merchantName || "(supplier unclear)",
    subtitle: [item.invoiceNumber || null].filter(Boolean).join(" · "),
    amountLabel: formatMoney(item.total, item.currency),
    amountSubLabel: item.documentType === "receipt" ? "🧾 Receipt" : "📄 Invoice",
    categoryLabel: "Uncategorised",
    confidencePct: pct,
    confidenceLabel: confidenceLabel(pct),
    confidenceColor: confidenceColor(pct),
    reason,
    badges: [],
    // Nothing to review or edit makes this postable — the row's approve control
    // is disabled with the reason on hover, and bulk-approve previews skip it.
    approvable: postable,
    notApprovableReason: postable ? undefined : unsupportedCurrencyReason(item.currency),
  };
  return { row, gate };
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
