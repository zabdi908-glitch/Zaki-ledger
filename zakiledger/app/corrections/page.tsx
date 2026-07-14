"use client";

import { useEffect, useState } from "react";
import type { Correction } from "@/lib/store";

/**
 * The correction ledger, made visible. This is the moat on screen: every human
 * fix is both the audit trail (compliance) and the training data (the flywheel).
 */
export default function CorrectionsPage() {
  const [corrections, setCorrections] = useState<Correction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/corrections")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setCorrections(d.corrections)))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "48px 20px" }}>
      <a href="/" style={{ color: "#1a2b4a", fontSize: 14 }}>← Back</a>
      <h1 style={{ marginBottom: 4, marginTop: 12 }}>Correction ledger</h1>
      <p style={{ color: "#667", marginTop: 0 }}>
        Every human fix, logged. This is both the audit trail and what makes the AI
        smarter for next time.
      </p>

      {error && <p style={{ color: "#c0392b" }}>{error}</p>}

      {corrections && corrections.length === 0 && (
        <p style={emptyStyle}>
          No corrections yet. Approve an invoice after editing a field, and it will
          appear here.
        </p>
      )}

      {corrections && corrections.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Supplier</th>
                <th style={thStyle}>Field</th>
                <th style={thStyle}>AI read</th>
                <th style={thStyle}>Corrected to</th>
                <th style={thStyle}>AI confidence</th>
                <th style={thStyle}>When</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td style={tdStyle}>{c.supplierName}</td>
                  <td style={tdStyle}>{c.field}</td>
                  <td style={{ ...tdStyle, color: "#c0392b" }}>{c.aiValue}</td>
                  <td style={{ ...tdStyle, color: "#1e8449", fontWeight: 600 }}>{c.humanValue}</td>
                  <td style={tdStyle}>{(c.aiConfidence * 100).toFixed(0)}%</td>
                  <td style={{ ...tdStyle, color: "#889", whiteSpace: "nowrap" }}>
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!corrections && !error && <p style={{ color: "#889" }}>Loading…</p>}
    </main>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#fff",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  fontSize: 14,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  background: "#f0f2f5",
  color: "#556",
  fontWeight: 600,
  borderBottom: "1px solid #e3e7eb",
};
const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #eef1f4",
};
const emptyStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  color: "#667",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
