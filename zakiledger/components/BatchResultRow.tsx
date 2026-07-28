"use client";

import { useState } from "react";
import { REVIEWABLE_FIELDS, type ReviewableField } from "@/lib/schema";
import { fieldLabels } from "@/lib/validation";
import { formatMoney } from "@/lib/currency";
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

/** Below this a field is shown amber — the read wants a human's eyes. */
const CONFIDENCE_THRESHOLD = 0.85;

export default function BatchResultRow({
  row,
  selected,
  onSelect,
  onEdit,
  onApprove,
  busy,
}: {
  row: ResultRow;
  selected: boolean;
  onSelect: (index: number, checked: boolean) => void;
  /** Commit a field: the human's value, plus whether they affirmed it unchanged. */
  onEdit: (index: number, field: ReviewableField, value: string) => void;
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
              <span style={{ fontWeight: 700, whiteSpace: "nowrap", fontSize: 13 }}>
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
            <FieldTable row={row} onEdit={onEdit} />
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
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #eef1f4" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4 }}>
            LINE ITEMS
          </div>
          {x.lineItems.map((li, i) => (
            <div key={i} style={lineItemRow}>
              <span>
                {li.description}
                {li.quantity > 1 ? ` × ${li.quantity}` : ""}
              </span>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                {formatMoney(li.amount, finalValue(row, "currency"))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One field: reads as text until clicked, then becomes an input with a checkmark.
 *
 * The checkmark is what commits, and committing an unchanged value is meaningful
 * rather than a no-op — it is the human saying "the AI read this right", which
 * clears the gate AND records a confirmation instead of a correction. Typing a new
 * value is the other half: a correction, which is what the tool learns from.
 */
function EditableField({
  label,
  value,
  original,
  confidence,
  absent,
  edited,
  affirmed,
  onCommit,
}: {
  label: string;
  value: string;
  original: string;
  confidence: number;
  absent: boolean;
  edited: boolean;
  affirmed: boolean;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const low = !absent && confidence < CONFIDENCE_THRESHOLD;

  function open() {
    setDraft(value);
    setEditing(true);
  }

  function commit() {
    onCommit(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ ...fieldRow, background: "#fffdf5", alignItems: "center" }}>
        <span style={fieldLabelStyle}>{label}</span>
        <input
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label={label}
          style={fieldInput}
        />
        <button style={commitBtn} onClick={commit} title="Confirm this value" aria-label={`Confirm ${label}`}>
          ✓
        </button>
        <button style={cancelBtn} onClick={() => setEditing(false)} aria-label={`Cancel editing ${label}`}>
          ✕
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...fieldRow, background: low ? "#fef9e7" : "transparent" }}>
      <span style={fieldLabelStyle}>{label}</span>
      <button style={fieldValueBtn} onClick={open} title="Click to edit">
        {value.trim() === "" ? <span style={{ color: "#8892a0" }}>not stated</span> : value}
      </button>
      {edited ? (
        <span style={chipVerified} title={`AI read: ${original || "(nothing)"}`}>
          ✓ edited
        </span>
      ) : affirmed ? (
        <span style={chipVerified}>✓ confirmed</span>
      ) : absent ? (
        <span style={chipMuted}>—</span>
      ) : (
        <span style={low ? chipLow : chipOk}>
          {low ? "⚠ check" : "✓"} {(confidence * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

function icon(status: RowStatus): string {
  switch (status) {
    case "approved":
      return "✅";
    case "ready":
      return "✅";
    case "flagged":
      return "⚠️";
    case "failed":
      return "❌";
    case "rejected":
      return "⚠️";
    default:
      return "⏳";
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
    padding: "12px 14px",
    marginBottom: 8,
    borderRadius: 8,
    fontSize: 14,
    border: "1px solid #e6eaee",
    background: "#fff",
    color: "#445",
  };
  if (status === "approved" || status === "ready") {
    return { ...base, background: "#e8f8f0", border: "1px solid #a9dfbf", color: "#1e6b45" };
  }
  if (status === "flagged" || status === "rejected") {
    return { ...base, background: "#fef9e7", border: "1px solid #f7dc6f", color: "#7d6608" };
  }
  if (status === "failed") {
    return { ...base, background: "#fdecea", border: "1px solid #e6b0aa", color: "#c0392b" };
  }
  return base;
}

const fieldPanel: React.CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  background: "#fff",
  border: "1px solid #eef1f4",
  borderRadius: 8,
  color: "#445",
};
const fieldRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 6px",
  borderRadius: 6,
  fontSize: 13,
  minHeight: 32,
};
const fieldLabelStyle: React.CSSProperties = {
  width: 130,
  flexShrink: 0,
  color: "#8892a0",
};
const fieldValueBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: "left",
  padding: "3px 6px",
  background: "transparent",
  border: "1px dashed transparent",
  borderRadius: 6,
  color: "#1a2b4a",
  fontWeight: 600,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "text",
};
const fieldInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid #f0c986",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
};
const commitBtn: React.CSSProperties = {
  flexShrink: 0,
  padding: "4px 10px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 13,
};
const cancelBtn: React.CSSProperties = {
  flexShrink: 0,
  padding: "4px 9px",
  background: "#fff",
  color: "#8892a0",
  border: "1px solid #d5dbdb",
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 13,
};
const lineItemRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  fontSize: 12,
  color: "#556",
  padding: "3px 6px",
};
const chipBase: React.CSSProperties = {
  flexShrink: 0,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  whiteSpace: "nowrap",
};
const chipOk: React.CSSProperties = { ...chipBase, background: "#e8f8f0", color: "#1e8449" };
const chipLow: React.CSSProperties = { ...chipBase, background: "#fdecea", color: "#c0392b" };
const chipMuted: React.CSSProperties = { ...chipBase, background: "#f4f6f8", color: "#8892a0" };
const chipVerified: React.CSSProperties = { ...chipBase, background: "#1e8449", color: "#fff" };
const approveSmall: React.CSSProperties = {
  padding: "6px 14px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};
const linkBtn: React.CSSProperties = {
  padding: "5px 12px",
  background: "#fff",
  color: "#1a2b4a",
  border: "1px solid #d5dbdb",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 12,
};
