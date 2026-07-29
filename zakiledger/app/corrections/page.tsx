"use client";

import { useEffect, useState } from "react";
import type { Correction } from "@/lib/store";
import { banner, card, color, figures, font } from "@/lib/theme";

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
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "48px 22px 72px" }}>
      <a href="/" style={{ color: color.inkSoft, fontSize: 14, fontWeight: 600 }}>
        ← Back
      </a>
      <h1
        style={{
          marginBottom: 6,
          marginTop: 14,
          color: color.ink,
          fontFamily: font.display,
          fontWeight: 600,
          fontSize: 30,
        }}
      >
        Correction ledger
      </h1>
      <p style={{ color: color.inkSoft, marginTop: 0, marginBottom: 28, lineHeight: 1.6 }}>
        Every human fix, logged. This is both the audit trail and what makes the AI smarter for
        next time.
      </p>

      {error && <p style={banner("bad")}>{error}</p>}

      {corrections && corrections.length === 0 && (
        <p style={emptyStyle}>
          No corrections yet. Approve an invoice after editing a field, and it will appear here.
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
                <th style={{ ...thStyle, textAlign: "right" }}>AI confidence</th>
                <th style={thStyle}>When</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td style={{ ...tdStyle, fontFamily: font.display, fontWeight: 600 }}>
                    {c.supplierName}
                  </td>
                  <td style={tdStyle}>{c.field}</td>
                  <td style={{ ...tdStyle, color: color.stampDeep }}>{c.aiValue}</td>
                  <td style={{ ...tdStyle, color: color.forestDeep, fontWeight: 600 }}>{c.humanValue}</td>
                  <td style={{ ...tdStyle, textAlign: "right", ...figures }}>
                    {(c.aiConfidence * 100).toFixed(0)}%
                  </td>
                  <td style={{ ...tdStyle, color: color.inkFaint, whiteSpace: "nowrap", ...figures }}>
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!corrections && !error && <p style={{ color: color.inkFaint }}>Loading…</p>}
    </main>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: color.paper,
  borderRadius: 16,
  overflow: "hidden",
  border: `1px solid ${color.paperLine}`,
  fontSize: 14,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  background: color.paperAlt,
  color: color.inkSoft,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  borderBottom: `1px solid ${color.paperLine}`,
};
const tdStyle: React.CSSProperties = {
  padding: "11px 16px",
  borderBottom: `1px solid ${color.paperAlt}`,
  color: color.ink,
};
const emptyStyle: React.CSSProperties = card({ marginTop: 24, color: color.inkSoft });
