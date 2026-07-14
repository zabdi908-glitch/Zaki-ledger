"use client";

import { useState } from "react";
import { REVIEWABLE_FIELDS, type InvoiceExtraction, type ReviewableField } from "@/lib/schema";

type ExtractResponse = {
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo?: boolean;
  refinedForSupplier?: string | null;
};

/** Below this, a field is "low confidence" and gets flagged for the human. */
const CONFIDENCE_THRESHOLD = 0.85;

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
    // Pre-fill the editable form with the AI's proposed values.
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
    setApproved(
      data.correctionsRecorded > 0
        ? `Approved. ${data.correctionsRecorded} correction(s) recorded — the tool just got smarter.`
        : "Approved. No corrections needed — the AI got it all right.",
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ marginBottom: 4 }}>Zaki Ledger</h1>
      <p style={{ color: "#667", marginTop: 0 }}>
        Upload an invoice. The AI drafts, you approve, it learns.
      </p>

      <label style={btnStyle}>
        {loading ? "Reading invoice…" : "Upload invoice (PDF or image)"}
        <input type="file" accept="application/pdf,image/*" onChange={onUpload} hidden disabled={loading} />
      </label>

      {error && <p style={{ color: "#c0392b" }}>{error}</p>}

      {result?.demo && (
        <p style={demoStyle}>
          🧪 Demo mode — this is a sample invoice (no API key set). Add
          <code> ANTHROPIC_API_KEY</code> to extract from real uploads.
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
          {result.arithmeticMismatch && (
            <p style={warnStyle}>
              ⚠️ Subtotal + tax doesn&apos;t equal total — please double-check the amounts.
            </p>
          )}
          {REVIEWABLE_FIELDS.map((f) => (
            <Field
              key={f}
              name={f}
              confidence={(result.extraction as any)[f].confidence}
              value={edited[f] ?? ""}
              onChange={(v) => setEdited((prev) => ({ ...prev, [f]: v }))}
            />
          ))}
          <button style={approveBtn} onClick={onApprove}>Approve</button>
          {approved && <p style={{ color: "#1e8449", fontWeight: 600 }}>{approved}</p>}
        </section>
      )}
    </main>
  );
}

function Field({
  name,
  value,
  confidence,
  onChange,
}: {
  name: ReviewableField;
  value: string;
  confidence: number;
  onChange: (v: string) => void;
}) {
  const low = confidence < CONFIDENCE_THRESHOLD;
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#556" }}>
        <span>{name}</span>
        <span style={{ color: low ? "#c0392b" : "#1e8449" }}>
          {low ? "⚠ check" : "✓"} {(confidence * 100).toFixed(0)}%
        </span>
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${low ? "#e6b0aa" : "#d5dbdb"}`,
          background: low ? "#fdf2f0" : "#fff",
        }}
      />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "12px 18px",
  background: "#1a2b4a",
  color: "#fff",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
};
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
const demoStyle: React.CSSProperties = {
  marginTop: 20,
  background: "#eef2ff",
  border: "1px solid #c7d2fe",
  color: "#3730a3",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
};
const learnedStyle: React.CSSProperties = {
  marginTop: 20,
  background: "#e8f8f0",
  border: "1px solid #a9dfbf",
  color: "#1e6b45",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
};
const warnStyle: React.CSSProperties = {
  background: "#fef9e7",
  border: "1px solid #f7dc6f",
  padding: "8px 12px",
  borderRadius: 6,
  fontSize: 14,
};
const approveBtn: React.CSSProperties = {
  marginTop: 8,
  padding: "10px 20px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
};
