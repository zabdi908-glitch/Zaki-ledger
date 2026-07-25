"use client";

import { useState } from "react";
import { REVIEWABLE_FIELDS, type InvoiceExtraction, type ReviewableField } from "@/lib/schema";
import { checkTotals, gateApproval } from "@/lib/validation";

/** Parse a review-field string into a number, or null when it isn't one. */
function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Effective confidence per field for the approval gate: a field the human has
 * corrected counts as verified (100%), which is what lets a blocked form unlock
 * live as the accountant fixes a flagged field — no re-submit needed.
 *
 * A field edited to blank is NOT verified — an empty Critical/Important value is
 * clearly not real data (and can happen by accident) — so it keeps its original
 * AI confidence and still gates approval.
 */
function effectiveConfidences(
  extraction: InvoiceExtraction,
  edited: Record<string, string>,
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const original = String((extraction as any)[f].value);
    const value = edited[f];
    const verified = value !== undefined && value !== original && value.trim() !== "";
    out[f] = verified ? 1 : (extraction as any)[f].confidence;
  }
  return out;
}

type ExtractResponse = {
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo?: boolean;
  refinedForSupplier?: string | null;
};

/** Below this, a field is "low confidence" and gets flagged for the human. */
const CONFIDENCE_THRESHOLD = 0.85;

/** Human-readable labels — bookkeepers should never see raw field keys. */
const FIELD_LABELS: Record<ReviewableField, string> = {
  supplierName: "Supplier",
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  currency: "Currency",
  subtotal: "Subtotal",
  tax: "Tax",
  total: "Total",
};

/** e.g. "Invoice date not detected (0%)" or "Tax low confidence (34%)". */
function reasonText(field: ReviewableField, confidence: number): string {
  const pct = Math.round(confidence * 100);
  return `${FIELD_LABELS[field]} ${pct === 0 ? "not detected" : "low confidence"} (${pct}%)`;
}

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setApproved(null);

    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/extract", { method: "POST", body: form });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      return;
    }
    setResult(data);
    const initial: Record<string, string> = {};
    for (const f of REVIEWABLE_FIELDS) initial[f] = String((data.extraction as any)[f].value);
    setEdited(initial);
  }

  async function onApprove() {
    if (!result) return;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction: result.extraction, edited }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Approve failed.");

    const base =
      data.correctionsRecorded > 0
        ? `Approved. ${data.correctionsRecorded} correction(s) recorded — the tool just got smarter.`
        : "Approved. No corrections needed — the AI got it all right.";

    // Surface where the invoice landed once an accounting platform is connected.
    let bill = "";
    if (data.billId) {
      const platform = data.billPlatform === "quickbooks" ? "QuickBooks" : "Xero";
      bill = ` Posted as a draft bill to ${platform} (ID ${data.billId}).`;
    } else if (data.billError) {
      bill = ` (Couldn't post to the accounting platform: ${data.billError})`;
    }
    setApproved(base + bill);
  }

  // Recomputed every render, so editing a flagged field re-evaluates live —
  // both the gate below and the per-field confidence badges read from this map.
  const confidences = result ? effectiveConfidences(result.extraction, edited) : null;
  const gate = confidences ? gateApproval(confidences) : null;

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "40px 20px 64px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={markStyle}>ZL</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#1a2b4a", lineHeight: 1.1 }}>
            Zaki Ledger
          </div>
          <div style={{ fontSize: 13, color: "#8892a0" }}>
            AI invoice entry for bookkeepers
          </div>
        </div>
      </header>

      <p style={{ color: "#556", marginTop: 0, marginBottom: 24 }}>
        The AI drafts every field with a confidence score. You check and approve in one click —
        nothing is saved without you.{" "}
        <a href="/corrections" style={{ color: "#1a2b4a", fontWeight: 600 }}>
          View the correction ledger →
        </a>
      </p>

      <label style={loading ? { ...btnStyle, opacity: 0.7 } : btnStyle}>
        {loading ? "Reading invoice…" : "＋ Upload invoice (PDF or image)"}
        <input type="file" accept="application/pdf,image/*" onChange={onUpload} hidden disabled={loading} />
      </label>

      {error && <p style={{ color: "#c0392b", marginTop: 16 }}>{error}</p>}

      {/* Cold-open explainer — helps a first-time visitor understand it instantly. */}
      {!result && !loading && !error && (
        <section style={howCardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4 }}>
            HOW IT WORKS
          </div>
          <ol style={{ margin: "12px 0 0", paddingLeft: 0, listStyle: "none" }}>
            {[
              ["1", "Upload", "Drop in an invoice or receipt — PDF or a photo."],
              ["2", "Review", "Each field is scored: green means sure, amber means check. Fix anything wrong."],
              ["3", "Approve & it learns", "One click. Every correction makes the next read sharper."],
            ].map(([n, t, d]) => (
              <li key={n} style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                <span style={stepNumStyle}>{n}</span>
                <span style={{ fontSize: 14, color: "#445" }}>
                  <strong style={{ color: "#1a2b4a" }}>{t}.</strong> {d}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {result?.demo && (
        <p style={demoStyle}>
          🧪 <strong>Demo mode</strong> — this is a sample invoice. Add an API key to extract from
          your own uploads.
        </p>
      )}

      {result?.refinedForSupplier && (
        <p style={learnedStyle}>
          🧠 Refined using what we&apos;ve learned from past corrections for{" "}
          <strong>{result.refinedForSupplier}</strong>.
        </p>
      )}

      {result && (
        <section style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4, marginBottom: 16 }}>
            REVIEW &amp; APPROVE
          </div>
          {REVIEWABLE_FIELDS.map((f) => {
            // After the Total field, show a live subtotal + tax = total check.
            // It recomputes from the edited values, so fixing a number clears it.
            const totals = f === "total" ? checkTotals(parseNum(edited.subtotal), parseNum(edited.tax), parseNum(edited.total)) : null;
            return (
              <div key={f}>
                <Field
                  label={FIELD_LABELS[f]}
                  confidence={confidences ? confidences[f] : (result.extraction as any)[f].confidence}
                  value={edited[f] ?? ""}
                  onChange={(v) => setEdited((prev) => ({ ...prev, [f]: v }))}
                />
                {totals &&
                  (totals.ok ? (
                    <p style={totalsOkStyle}>✓ Totals check out</p>
                  ) : (
                    <p style={totalsBadStyle}>
                      ❌ Totals don&apos;t add up — expected {totals.expected.toFixed(2)}, found{" "}
                      {totals.found.toFixed(2)}
                    </p>
                  ))}
              </div>
            );
          })}
          {/* Confidence gate — sits alongside the arithmetic check above. */}
          {gate && gate.status !== "ready" && (
            <div style={gate.status === "blocked" ? gateBlockedStyle : gateReviewStyle}>
              <div style={{ fontWeight: 700 }}>
                {gate.status === "blocked" ? "❌ Human Review Required" : "⚠ Review Required"}
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {gate.reasons.map((r) => (
                  <li key={r.field}>{reasonText(r.field, r.confidence)}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Blocked hides the button entirely — a critical field must be fixed
              first. "review" still lets the human override ("Approve anyway"). */}
          {gate?.status !== "blocked" && (
            <button style={approveBtn} onClick={onApprove}>
              {gate?.status === "review" ? "Approve anyway" : "✓ Approve"}
            </button>
          )}
          {approved && <p style={{ color: "#1e8449", fontWeight: 600, marginBottom: 0 }}>{approved}</p>}
        </section>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  confidence,
  onChange,
}: {
  label: string;
  value: string;
  confidence: number;
  onChange: (v: string) => void;
}) {
  const low = confidence < CONFIDENCE_THRESHOLD;
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#556", marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={low ? chipLow : chipOk}>
          {low ? "⚠ check" : "✓"} {(confidence * 100).toFixed(0)}%
        </span>
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 8,
          fontSize: 15,
          boxSizing: "border-box",
          border: `1px solid ${low ? "#e6b0aa" : "#d5dbdb"}`,
          background: low ? "#fdf2f0" : "#fff",
          outline: "none",
        }}
      />
    </div>
  );
}

const markStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  borderRadius: 10,
  background: "#1a2b4a",
  color: "#fff",
  fontWeight: 700,
  fontSize: 15,
  letterSpacing: 0.5,
};
const btnStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "12px 20px",
  background: "#1a2b4a",
  color: "#fff",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
const howCardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  border: "1px solid #eef1f4",
};
const stepNumStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: "50%",
  background: "#eef2ff",
  color: "#1a2b4a",
  fontWeight: 700,
  fontSize: 13,
};
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  border: "1px solid #eef1f4",
};
const demoStyle: React.CSSProperties = {
  marginTop: 20,
  background: "#eef2ff",
  border: "1px solid #c7d2fe",
  color: "#3730a3",
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 14,
};
const learnedStyle: React.CSSProperties = {
  marginTop: 20,
  background: "#e8f8f0",
  border: "1px solid #a9dfbf",
  color: "#1e6b45",
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 14,
};
const totalsOkStyle: React.CSSProperties = {
  margin: "-6px 0 14px",
  color: "#1e8449",
  fontSize: 13,
  fontWeight: 600,
};
const totalsBadStyle: React.CSSProperties = {
  margin: "-6px 0 14px",
  padding: "8px 12px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 13,
  fontWeight: 600,
};
const gateBlockedStyle: React.CSSProperties = {
  margin: "4px 0 16px",
  padding: "12px 14px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 14,
};
const gateReviewStyle: React.CSSProperties = {
  margin: "4px 0 16px",
  padding: "12px 14px",
  background: "#fef9e7",
  border: "1px solid #f7dc6f",
  borderRadius: 8,
  color: "#7d6608",
  fontSize: 14,
};
const chipOk: React.CSSProperties = {
  background: "#e8f8f0",
  color: "#1e8449",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};
const chipLow: React.CSSProperties = {
  background: "#fdecea",
  color: "#c0392b",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};
const approveBtn: React.CSSProperties = {
  marginTop: 8,
  marginBottom: 12,
  padding: "11px 22px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
