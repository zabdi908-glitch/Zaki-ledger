"use client";

import { useState } from "react";
import { button, chip, color, figures, font } from "@/lib/theme";

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
      <div style={{ ...fieldRow, background: color.goldTint, alignItems: "center" }}>
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
    <div style={{ ...fieldRow, background: low ? color.goldTint : "transparent" }}>
      <span style={fieldLabelStyle}>{label}</span>
      <button style={fieldValueBtn} onClick={open} title="Click to edit">
        {value.trim() === "" ? <span style={{ color: color.inkFaint }}>not stated</span> : value}
      </button>
      {edited ? (
        <span style={chip("verified")} title={`AI read: ${original || "(nothing)"}`}>
          ✓ edited
        </span>
      ) : affirmed ? (
        <span style={chip("verified")}>✓ confirmed</span>
      ) : absent ? (
        <span style={chip("muted")}>—</span>
      ) : (
        <span style={{ ...chip(low ? "warn" : "ok"), ...figures }}>
          {low ? "check" : "✓"} {(confidence * 100).toFixed(0)}%
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
  padding: "5px 7px",
  borderRadius: 6,
  fontSize: 13,
  minHeight: 34,
};
const fieldLabelStyle: React.CSSProperties = {
  width: 130,
  flexShrink: 0,
  color: color.inkSoft,
};
const fieldValueBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: "left",
  padding: "3px 6px",
  background: "transparent",
  border: "1px dashed transparent",
  borderRadius: 6,
  color: color.ink,
  fontWeight: 600,
  fontSize: 13,
  fontFamily: font.body,
  cursor: "text",
};
const fieldInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "5px 8px",
  borderRadius: 6,
  border: `1px solid ${color.gold}`,
  fontSize: 13,
  fontFamily: font.body,
  outline: "none",
};
const commitBtn: React.CSSProperties = { ...button("success", "sm"), flexShrink: 0, padding: "4px 10px" };
const cancelBtn: React.CSSProperties = { ...button("outline", "sm"), flexShrink: 0, padding: "4px 9px" };
