import { formatMoney } from "./currency";
import type { DocumentType } from "./schema";
import { gateApproval, reasonText, type ApprovalGate } from "./validation";
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

export function buildQueueRow(item: QueueItem, isDuplicate: boolean): { row: ReviewRow; gate: ApprovalGate } {
  const pct = Math.round(item.overallConfidence * 100);
  // The list endpoint only returns overallConfidence, not per-field — treat
  // every field as at that same confidence for the *list* row's gate/section;
  // the side panel re-fetches the full per-field breakdown from
  // GET /api/pending/[id] and is the source of truth once opened.
  const perField = {
    supplierName: item.overallConfidence,
    invoiceNumber: item.overallConfidence,
    invoiceDate: item.overallConfidence,
    currency: item.overallConfidence,
    subtotal: item.overallConfidence,
    tax: item.overallConfidence,
    total: item.overallConfidence,
  };
  const gate = gateApproval(perField, { documentType: item.documentType });

  const row: ReviewRow = {
    id: item.id,
    section: sectionForGate(gate, isDuplicate),
    date: formatShortDate(item.invoiceDate),
    title: item.merchantName || "(supplier unclear)",
    subtitle: [item.invoiceNumber || null].filter(Boolean).join(" · "),
    amountLabel: formatMoney(item.total, item.currency),
    amountSubLabel: item.documentType === "receipt" ? "🧾 Receipt" : "📄 Invoice",
    categoryLabel: "Uncategorised",
    confidencePct: pct,
    confidenceLabel: confidenceLabel(pct),
    confidenceColor: confidenceColor(pct),
    reason: plainEnglishGateReason(gate, item.documentType),
    badges: [],
  };
  return { row, gate };
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
