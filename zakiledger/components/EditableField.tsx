"use client";

import { useState } from "react";

/**
 * One field: reads as text until clicked, then becomes an input with a checkmark.
 *
 * The checkmark is what commits, and committing an unchanged value is meaningful
 * rather than a no-op — it is the human saying "the AI read this right", which
 * clears the gate AND records a confirmation instead of a correction. Typing a new
 * value is the other half: a correction, which is what the tool learns from.
 *
 * Shared between the batch-upload results screen and the /pending queue's detail
 * panel — one interaction for editing an extracted field, wherever it's shown.
 */

/** Below this a field is shown amber — the read wants a human's eyes. */
const CONFIDENCE_THRESHOLD = 0.85;

export default function EditableField({
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

// --- styles -----------------------------------------------------------------
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
