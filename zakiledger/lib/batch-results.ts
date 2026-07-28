import {
  REVIEWABLE_FIELDS,
  type DocumentType,
  type InvoiceExtraction,
  type ReviewableField,
} from "./schema";
import {
  effectiveConfidence,
  gateApproval,
  gateReasonSummary,
  type ApprovalGate,
} from "./validation";
import { isSupportedCurrency, unsupportedCurrencyReason } from "./currency";

/**
 * The decision logic behind the post-upload results screen — what each row is,
 * and how a batch of them gets approved.
 *
 * Kept out of the component because it is the part that can be wrong. Whether a
 * flagged document has been fixed, and which endpoint may safely approve it, are
 * judgements with real consequences (a bill posted from a value nobody verified),
 * so they are plain functions over plain data rather than assertions buried in
 * JSX. The component renders what these return.
 *
 * Nothing here re-implements the confidence gate. It calls the same
 * `gateApproval` the review screen, the queue and bulk approve all call, with the
 * same `effectiveConfidence` rule for a human-touched field — so a document that
 * turns green here is green for the identical reason it would be anywhere else.
 */

/** How the read itself went, straight from the /api/extract-batch stream. */
export type ReadState = "extracting" | "success" | "error";

/** How an approval attempt ended, mirroring the server's per-document outcome. */
export type RowOutcome = "approved" | "blocked" | "error";

/** One file's row on the results screen: what came back, plus what the human did. */
export interface ResultRow {
  /** Position in the original file selection — the stream reports out of order. */
  index: number;
  filename: string;
  read: ReadState;
  /** The queue row this became. Null when the read worked but the queue write didn't. */
  documentId?: string | null;
  /** The model's overall confidence in the whole extraction. */
  confidence?: number;
  /** Present whenever the read succeeded — this is what the human edits. */
  extraction?: InvoiceExtraction;
  /** Set when the read succeeded but the document couldn't be queued. */
  queueError?: string | null;
  /** Why the file failed outright. Only when `read` is "error". */
  failure?: string;
  /** Human edits on this screen, keyed by reviewable field. */
  edited: Record<string, string>;
  /** Fields the human affirmed as correct without changing them. */
  affirmed: Record<string, boolean>;
  /** Set once this row has been through an approval attempt. */
  outcome?: RowOutcome;
  /** Why it was blocked or errored; on approval, where the bill landed. */
  outcomeReason?: string;
  /**
   * Armed by an approval attempt that came back as a possible duplicate. The
   * human has been told which document it matches; the next Approve on this row
   * is their answer, and carries past the warning. Cleared by any further edit,
   * since a changed value has to be re-checked against the ledger.
   */
  proceedDuplicate?: boolean;
}

/**
 * What the human sees per row. "flagged" and "ready" are live — editing a field
 * moves a row between them without a round trip, which is the whole point of
 * fixing things here instead of on /pending.
 */
export type RowStatus = "extracting" | "ready" | "flagged" | "failed" | "approved" | "rejected";

/** A fresh row for a file that hasn't been read yet. */
export function pendingRow(filename: string, index: number): ResultRow {
  return { index, filename, read: "extracting", edited: {}, affirmed: {} };
}

/** The value that would be approved for a field: the human's if they set one. */
export function finalValue(row: ResultRow, field: ReviewableField): string {
  const original = String((row.extraction as any)?.[field]?.value ?? "");
  return row.edited[field] ?? original;
}

/** The model's own read of a field, before anything the human did to it. */
export function originalValue(row: ResultRow, field: ReviewableField): string {
  return String((row.extraction as any)?.[field]?.value ?? "");
}

/**
 * Confidence per field as the gate should judge it — the raw read, except where
 * the human has verified the field by editing it or affirming it as correct.
 * Exactly the rule the single-document review screen uses.
 */
export function effectiveConfidences(row: ResultRow): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const node = (row.extraction as any)?.[f] as { value: unknown; confidence: number } | undefined;
    out[f] = effectiveConfidence(
      node?.confidence ?? 0,
      String(node?.value ?? ""),
      row.edited[f],
      row.affirmed[f] === true,
    );
  }
  return out;
}

/** The document type in force: the model's read (nothing overrides it here). */
export function rowDocumentType(row: ResultRow): DocumentType {
  return row.extraction?.documentType?.value ?? "invoice";
}

/** Run the shared confidence gate over a row. Null when there is nothing to gate. */
export function rowGate(row: ResultRow): ApprovalGate | null {
  if (!row.extraction) return null;
  return gateApproval(effectiveConfidences(row), {
    documentType: rowDocumentType(row),
    taxItemized: row.extraction.taxItemized,
    documentTypeConfidence: row.extraction.documentType?.confidence,
  });
}

/**
 * What this row is right now. Recomputed on every render, so the moment a human
 * fixes the merchant name the row stops being flagged — no save, no reload.
 */
export function rowStatus(row: ResultRow): RowStatus {
  if (row.read === "error") return "failed";
  if (row.outcome === "approved") return "approved";
  if (row.outcome) return "rejected"; // blocked or errored on an approval attempt
  if (row.read === "extracting" || !row.extraction) return "extracting";
  return rowGate(row)?.status === "ready" ? "ready" : "flagged";
}

/** Why a row is flagged, in the same words every other screen uses. */
export function flagReason(row: ResultRow): string | null {
  const gate = rowGate(row);
  if (!gate || gate.status === "ready") return null;
  return gateReasonSummary(gate, rowDocumentType(row));
}

/** True when the human has changed or affirmed anything on this row. */
export function hasHumanInput(row: ResultRow): boolean {
  return REVIEWABLE_FIELDS.some(
    (f) => row.affirmed[f] === true || (row.edited[f] !== undefined && row.edited[f] !== originalValue(row, f)),
  );
}

/** Rows the human may still act on — not failed, not already through approval. */
export function isActionable(row: ResultRow): boolean {
  const status = rowStatus(row);
  return status === "ready" || status === "flagged" || status === "rejected";
}

// --- Approval routing -------------------------------------------------------

/** A row to approve by id, letting the server gate it from the stored extraction. */
export interface QueuedApproval {
  index: number;
  documentId: string;
}

/** A row to approve from the values in front of the human, edits included. */
export interface DirectApproval {
  index: number;
  /** Optional: present unless the queue write failed. Clears the queue entry. */
  documentId: string | null;
  extraction: InvoiceExtraction;
  edited: Record<string, string>;
  documentType: DocumentType;
}

export interface ApprovePlan {
  queued: QueuedApproval[];
  direct: DirectApproval[];
  /** Rows that were asked for but can't be approved, and why. */
  skipped: Array<{ index: number; reason: string }>;
}

/**
 * Decide how each requested row gets approved. Two routes, and which one a
 * document takes is decided by whether a human actually looked at it:
 *
 *   - **Untouched** (`queued`) → POST /api/approve/bulk with just the id. The
 *     server re-gates the stored extraction, blocks duplicates and refuses
 *     unpostable currencies. Nobody vouched for this document, so it has to earn
 *     approval on its own — the same bar as approving it later from /pending.
 *
 *   - **Edited or affirmed** (`direct`) → POST /api/approve with the extraction
 *     and the human's values. This is the review screen's route, and it is only
 *     valid because the same thing is true here as there: a person is looking
 *     straight at the field they just corrected. It also records the corrections,
 *     which is the whole reason an edit is worth more than a re-read.
 *
 * A document whose queue write failed has no id to send, so it takes the direct
 * route regardless — otherwise the one failure mode that already cost it its
 * queue entry would cost it its approval too.
 *
 * Both routes refuse a currency we can't post in. Bulk enforces that server-side
 * anyway; the direct route does not, so without this check editing an unrelated
 * field on a JPY receipt would be enough to slip it past the one precondition no
 * amount of reviewing confidence can satisfy.
 */
export function planApproval(rows: ResultRow[], indexes: number[]): ApprovePlan {
  const plan: ApprovePlan = { queued: [], direct: [], skipped: [] };

  for (const index of [...new Set(indexes)]) {
    const row = rows.find((r) => r.index === index);
    if (!row) continue;

    if (row.read !== "success" || !row.extraction) {
      plan.skipped.push({ index, reason: row.failure ?? "This document couldn't be read." });
      continue;
    }
    if (row.outcome === "approved") {
      plan.skipped.push({ index, reason: "Already approved." });
      continue;
    }

    const gate = rowGate(row);
    if (gate && gate.status !== "ready") {
      plan.skipped.push({
        index,
        reason: `Needs review: ${gateReasonSummary(gate, rowDocumentType(row))}`,
      });
      continue;
    }

    const currency = finalValue(row, "currency");
    if (!isSupportedCurrency(currency)) {
      plan.skipped.push({ index, reason: unsupportedCurrencyReason(currency) });
      continue;
    }

    if (hasHumanInput(row) || !row.documentId) {
      plan.direct.push({
        index,
        documentId: row.documentId ?? null,
        extraction: row.extraction,
        // Send every reviewable field, not just the changed ones: the approve
        // route treats an absent key as "unchanged", and it is the values on
        // screen — not a mix of screen and stored — that the human approved.
        edited: Object.fromEntries(REVIEWABLE_FIELDS.map((f) => [f, finalValue(row, f)])),
        documentType: rowDocumentType(row),
      });
    } else {
      plan.queued.push({ index, documentId: row.documentId });
    }
  }

  return plan;
}

/** Running tally for the results header, and the line the human reads at the end. */
export interface ResultTally {
  total: number;
  approved: number;
  ready: number;
  flagged: number;
  failed: number;
  rejected: number;
}

export function tally(rows: ResultRow[]): ResultTally {
  const count = (s: RowStatus) => rows.filter((r) => rowStatus(r) === s).length;
  return {
    total: rows.length,
    approved: count("approved"),
    ready: count("ready"),
    flagged: count("flagged"),
    failed: count("failed"),
    rejected: count("rejected"),
  };
}

/** e.g. "4 approved, 1 failed" — only the parts that actually happened. */
export function tallyLabel(t: ResultTally): string {
  const parts: string[] = [];
  if (t.approved > 0) parts.push(`${t.approved} approved`);
  if (t.ready > 0) parts.push(`${t.ready} ready to approve`);
  if (t.flagged > 0) parts.push(`${t.flagged} need${t.flagged === 1 ? "s" : ""} a look`);
  if (t.rejected > 0) parts.push(`${t.rejected} couldn't be approved`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  return parts.length > 0 ? parts.join(", ") : "nothing to report";
}
