"use client";

import { useState } from "react";
import { REVIEWABLE_FIELDS, type DocumentType, type ReviewableField } from "@/lib/schema";
import { fieldLabels } from "@/lib/validation";
import { formatMoney } from "@/lib/currency";
import EditableField from "./EditableField";
import { banner, button, color, eyebrow, figures, font } from "@/lib/theme";
import {
  effectiveConfidences,
  finalValue,
  flagReason,
  originalValue,
  rowDocumentType,
  rowStatus,
  type ResultRow,
  type RowStatus,
} from "@/lib/batch-results";

/**
 * One file's row on the results screen.
 *
 * A flagged document opens its fields right here rather than sending the human to
 * /pending. That trip is the thing this replaces: the human is already looking at
 * the batch they just uploaded, and the one field that needs a second pair of eyes
 * is a click away — so making them navigate to another screen, find the row again
 * and re-establish which document it was is pure friction with nothing on the
 * other side of it.
 *
 * The fields are editable but not pre-opened. An amber field is the one being
 * *asked about*; a confident field is still editable, because "the AI was sure and
 * wrong" is a real case and hiding the field would make it unfixable here.
 */

export default function BatchResultRow({
  row,
  selected,
  onSelect,
  onEdit,
  onConfirmType,
  onApprove,
  busy,
}: {
  row: ResultRow;
  selected: boolean;
  onSelect: (index: number, checked: boolean) => void;
  /** Commit a field: the human's value, plus whether they affirmed it unchanged. */
  onEdit: (index: number, field: ReviewableField, value: string) => void;
  /** Settle an uncertain invoice-vs-receipt classification. */
  onConfirmType: (index: number, chosen: DocumentType, detectedType: DocumentType) => void;
  onApprove: (index: number) => void;
  busy: boolean;
}) {
  const status = rowStatus(row);
  /** null = follow the default for this status; true/false = the human decided. */
  const [override, setOverride] = useState<boolean | null>(null);

  // A flagged row opens itself: the field needing attention is the reason this
  // screen exists, so it should not take a click to discover which one it is.
  // Tracked as an override rather than an initial value, so "Hide fields" still
  // works on a row that opened on its own.
  const expanded = override ?? (status === "flagged" && row.read === "success");

  return (
    <div style={rowStyle(status)}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        {/* Only a row that could actually go into a batch gets a checkbox. */}
        {(status === "ready" || status === "flagged" || status === "rejected") && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(row.index, e.target.checked)}
            aria-label={`Select ${row.filename}`}
            style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }}
          />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <strong style={{ wordBreak: "break-word" }}>
              {icon(status)} {row.filename}
            </strong>
            {row.confidence !== undefined && status !== "failed" && (
              <span style={{ fontWeight: 700, whiteSpace: "nowrap", fontSize: 13, ...figures }}>
                {(row.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>

          <div style={{ fontSize: 13, marginTop: 3 }}>{summaryLine(row, status)}</div>

          {row.queueError && (
            <div style={{ fontSize: 12, marginTop: 3 }}>
              Couldn&apos;t be added to the queue ({row.queueError}) — it can still be approved
              here, but it won&apos;t be waiting on /pending if you leave.
            </div>
          )}

          {/* --- The extraction, editable in place ------------------------- */}
          {row.extraction && status !== "approved" && expanded && (
            <>
              {/* An uncertain classification blocks approval on its own, because
                  the type decides which fields are required and how duplicates
                  are matched. It isn't a reviewable field, so fixing every field
                  below can never clear this by itself — without this picker the
                  row would stay stuck amber forever. */}
              {(row.extraction.documentType?.confidence ?? 1) < 0.8 && !row.typeConfirmed && (
                <TypePicker row={row} onConfirmType={onConfirmType} />
              )}
              <FieldTable row={row} onEdit={onEdit} />
            </>
          )}

          {/* --- Row actions ----------------------------------------------- */}
          {row.read === "success" && status !== "approved" && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                style={
                  status === "flagged" || busy
                    ? { ...approveSmall, opacity: 0.45, cursor: "not-allowed" }
                    : approveSmall
                }
                onClick={() => onApprove(row.index)}
                disabled={status === "flagged" || busy}
                title={
                  status === "flagged"
                    ? "Fix or confirm the amber field first"
                    : "Approve this document now"
                }
              >
                {busy ? "Approving…" : "✓ Approve"}
              </button>
              <button style={linkBtn} onClick={() => setOverride(!expanded)}>
                {expanded ? "Hide fields" : "Show fields"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Settle an uncertain invoice-vs-receipt classification for one row. */
function TypePicker({
  row,
  onConfirmType,
}: {
  row: ResultRow;
  onConfirmType: (index: number, chosen: DocumentType, detectedType: DocumentType) => void;
}) {
  const detectedType = rowDocumentType(row);
  const confidence = row.extraction!.documentType?.confidence ?? 1;
  return (
    <div style={typePickerStyle}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Is this an invoice or a receipt?</div>
      <p style={{ margin: "0 0 10px", fontSize: 13 }}>
        We read it as a <strong>{detectedType}</strong> but only at {(confidence * 100).toFixed(0)}%
        confidence. This decides which fields are required, so please confirm before approving.
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        {(["invoice", "receipt"] as DocumentType[]).map((t) => (
          <button
            key={t}
            style={t === detectedType ? approveSmall : linkBtn}
            onClick={() => onConfirmType(row.index, t, detectedType)}
          >
            {t === "receipt" ? "Receipt" : "Invoice"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Every reviewable field, with the amber ones asking to be looked at. */
function FieldTable({
  row,
  onEdit,
}: {
  row: ResultRow;
  onEdit: (index: number, field: ReviewableField, value: string) => void;
}) {
  const type = rowDocumentType(row);
  const labels = fieldLabels(type);
  const confidences = effectiveConfidences(row);
  const x = row.extraction!;

  return (
    <div style={fieldPanel}>
      {REVIEWABLE_FIELDS.map((f) => (
        <EditableField
          key={f}
          label={labels[f]}
          value={finalValue(row, f)}
          original={originalValue(row, f)}
          confidence={confidences[f]}
          // A field the document never stated isn't a failed read. An absent
          // receipt number, or tax on a receipt showing only a gross total, gets a
          // neutral "not stated" rather than an amber warning the human can never
          // satisfy by looking harder at the paper.
          absent={
            originalValue(row, f).trim() === "" ||
            ((x as any)[f].confidence === 0 &&
              (!x.taxItemized ? f === "tax" || f === "subtotal" : false))
          }
          edited={row.edited[f] !== undefined && row.edited[f] !== originalValue(row, f)}
          affirmed={row.affirmed[f] === true}
          onCommit={(v) => onEdit(row.index, f, v)}
        />
      ))}

      {x.lineItems.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${color.paperLine}` }}>
          <div style={{ ...eyebrow, fontSize: 11 }}>Line items</div>
          {x.lineItems.map((li, i) => (
            <div key={i} style={lineItemRow}>
              <span>
                {li.description}
                {li.quantity > 1 ? ` × ${li.quantity}` : ""}
              </span>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", ...figures }}>
                {formatMoney(li.amount, finalValue(row, "currency"))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function icon(status: RowStatus): string {
  // Colour AND mark, never colour alone (see rowStyle below) — the distinction
  // has to survive a colourblind reader and a black-and-white print.
  switch (status) {
    case "approved":
    case "ready":
      return "✓";
    case "flagged":
    case "rejected":
      return "!";
    case "failed":
      return "×";
    default:
      return "…";
  }
}

/** The one line under the filename — what happened, or what is being asked. */
function summaryLine(row: ResultRow, status: RowStatus): string {
  switch (status) {
    case "extracting":
      return "reading…";
    case "failed":
      return row.failure ?? "couldn't extract this document";
    case "approved":
      return row.outcomeReason ?? "approved";
    case "rejected":
      return row.outcomeReason ?? "couldn't be approved";
    case "ready":
      return "Ready to approve — no action needed";
    case "flagged":
      return flagReason(row) ?? "needs a look before approval";
  }
}

// --- styles -----------------------------------------------------------------
function rowStyle(status: RowStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "13px 15px",
    marginBottom: 8,
    borderRadius: 10,
    fontSize: 14,
    border: `1px solid ${color.paperLine}`,
    background: color.paper,
    color: color.inkSoft,
  };
  if (status === "approved" || status === "ready") return { ...base, ...banner("ok") };
  if (status === "flagged" || status === "rejected") return { ...base, ...banner("warn") };
  if (status === "failed") return { ...base, ...banner("bad") };
  return base;
}

const fieldPanel: React.CSSProperties = {
  marginTop: 10,
  padding: "9px 11px",
  background: color.paper,
  border: `1px solid ${color.paperLine}`,
  borderRadius: 8,
  color: color.inkSoft,
};
const typePickerStyle: React.CSSProperties = { ...banner("warn"), marginTop: 10 };
const lineItemRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 12,
  color: color.inkSoft,
  padding: "3px 6px",
};
const approveSmall: React.CSSProperties = button("success", "sm");
const linkBtn: React.CSSProperties = button("ghost", "sm");
