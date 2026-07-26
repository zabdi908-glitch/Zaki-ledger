"use client";

import { useEffect, useState } from "react";
import { REVIEWABLE_FIELDS, type InvoiceExtraction, type ReviewableField } from "@/lib/schema";
import { checkTotals, effectiveConfidence, gateApproval } from "@/lib/validation";

type PlatformStatus = { configured: boolean; connected: boolean };
type ConnectionsStatus = { xero: PlatformStatus; quickbooks: PlatformStatus };

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
  affirmed: Record<string, boolean>,
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const original = String((extraction as any)[f].value);
    out[f] = effectiveConfidence((extraction as any)[f].confidence, original, edited[f], affirmed[f] === true);
  }
  return out;
}

type ExtractResponse = {
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo?: boolean;
  refinedForSupplier?: string | null;
  /** Reviewable fields whose confidence was lifted by this supplier's track record. */
  calibratedFields?: string[];
  /** Per-field track record for this supplier: how many prior confirmed reads + their confidence. */
  supplierMemory?: Record<string, { count: number; confidence: number }>;
  /** Set when an invoice with the same supplier + number was already processed. */
  duplicate?: {
    supplierName: string;
    invoiceNumber: string;
    processedOn: string; // ISO timestamp of the earlier invoice
    existingId: string;
  } | null;
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
  // The human explicitly chose to proceed past a duplicate warning.
  const [proceedDuplicate, setProceedDuplicate] = useState(false);
  // Fields the human affirmed as-is (correct despite low confidence) — clears the
  // gate without an edit, so approve records a confirmation, not a correction.
  const [affirmed, setAffirmed] = useState<Record<string, boolean>>({});
  // A duplicate discovered at approve time (on the final, human-approved values).
  const [approveDuplicate, setApproveDuplicate] = useState<ExtractResponse["duplicate"] | null>(null);
  const [connections, setConnections] = useState<ConnectionsStatus | null>(null);
  // Set to "xero"/"quickbooks" right after returning from a successful OAuth flow.
  const [justConnected, setJustConnected] = useState<string | null>(null);

  async function refreshConnections() {
    try {
      const res = await fetch("/api/connections");
      if (res.ok) setConnections(await res.json());
    } catch {
      /* status is best-effort; the upload flow works regardless */
    }
  }

  useEffect(() => {
    refreshConnections();
    // Surface the ?connected=… flag the OAuth callback redirects back with.
    const connected = new URLSearchParams(window.location.search).get("connected");
    if (connected) {
      setJustConnected(connected);
      window.history.replaceState(null, "", window.location.pathname); // clean the URL
    }
  }, []);

  /** Reset back to the empty upload state (used by the duplicate "Discard"). */
  function discard() {
    setResult(null);
    setEdited({});
    setApproved(null);
    setError(null);
    setProceedDuplicate(false);
    setAffirmed({});
    setApproveDuplicate(null);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setApproved(null);
    setProceedDuplicate(false);
    setAffirmed({});
    setApproveDuplicate(null);

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

  async function onApprove(forceProceed = false) {
    if (!result) return;
    const proceed = forceProceed || proceedDuplicate;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction: result.extraction, edited, proceedDuplicate: proceed }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Approve failed.");

    // Approve-time duplicate: the final (human-corrected) values matched an existing
    // invoice the raw extraction missed. Prompt, don't save — the human decides.
    if (data.status === "duplicate") {
      setApproveDuplicate(data.duplicate);
      return;
    }
    setApproveDuplicate(null);

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
  const confidences = result ? effectiveConfidences(result.extraction, edited, affirmed) : null;
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

      <p style={{ color: "#556", marginTop: 0, marginBottom: 20 }}>
        The AI drafts every field with a confidence score. You check and approve in one click —
        nothing is saved without you.{" "}
        <a href="/corrections" style={{ color: "#1a2b4a", fontWeight: 600 }}>
          View the correction ledger →
        </a>
      </p>

      {/* Accounting connections — where approved invoices post as draft bills. */}
      <section style={connBarStyle}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4 }}>
          ACCOUNTING
        </span>
        <ConnectionControl name="Xero" path="/api/xero/connect" status={connections?.xero} />
        <ConnectionControl name="QuickBooks" path="/api/quickbooks/connect" status={connections?.quickbooks} />
      </section>

      {justConnected && (
        <p style={learnedStyle}>
          ✅ Connected to <strong>{justConnected === "quickbooks" ? "QuickBooks" : "Xero"}</strong>.
          Approved invoices will now post there as draft bills.
        </p>
      )}

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

      {result?.calibratedFields && result.calibratedFields.length > 0 && (
        <p style={learnedStyle}>
          📈 Confidence raised on{" "}
          <strong>
            {result.calibratedFields
              .map((f) => FIELD_LABELS[f as ReviewableField] ?? f)
              .join(", ")}
          </strong>{" "}
          from this supplier&apos;s confirmed-correct history.
        </p>
      )}

      {/* Duplicate warning — decide before reviewing. Never auto-resolved. */}
      {result?.duplicate && !proceedDuplicate && (
        <section style={dupCardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#7d4a00", marginBottom: 6 }}>
            ⚠️ Possible duplicate
          </div>
          <p style={{ margin: "0 0 14px", color: "#6b4b1a", fontSize: 14 }}>
            This looks like a duplicate of an invoice already processed on{" "}
            <strong>{new Date(result.duplicate.processedOn).toLocaleDateString()}</strong> — same
            supplier (<strong>{result.duplicate.supplierName}</strong>) and invoice number (
            <strong>{result.duplicate.invoiceNumber}</strong>).
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={approveBtn} onClick={() => setProceedDuplicate(true)}>
              Proceed anyway
            </button>
            <button style={discardBtn} onClick={discard}>
              Discard
            </button>
          </div>
        </section>
      )}

      {result && (!result.duplicate || proceedDuplicate) && (
        <section style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4, marginBottom: 16 }}>
            REVIEW &amp; APPROVE
          </div>
          {REVIEWABLE_FIELDS.map((f) => {
            // After the Total field, show a live subtotal + tax = total check.
            // It recomputes from the edited values, so fixing a number clears it.
            const totals = f === "total" ? checkTotals(parseNum(edited.subtotal), parseNum(edited.tax), parseNum(edited.total)) : null;
            const mem = result.supplierMemory?.[f];
            const eff = confidences ? confidences[f] : (result.extraction as any)[f].confidence;
            const low = eff < CONFIDENCE_THRESHOLD; // still below the review bar
            const original = String((result.extraction as any)[f].value);
            const affirmedAsIs = affirmed[f] === true && (edited[f] ?? original) === original;
            return (
              <div key={f}>
                <Field
                  label={FIELD_LABELS[f]}
                  confidence={eff}
                  value={edited[f] ?? ""}
                  onChange={(v) => setEdited((prev) => ({ ...prev, [f]: v }))}
                />
                {/* Confirm-as-is: affirm a correct-but-low read without editing it,
                    so it clears the gate AND records a confirmation (not a reset). */}
                {low && (
                  <button
                    style={confirmAsIsBtn}
                    onClick={() => setAffirmed((prev) => ({ ...prev, [f]: true }))}
                  >
                    ✓ Confirm this is correct
                  </button>
                )}
                {affirmedAsIs && !low && (
                  <p style={affirmedNoteStyle}>✓ Confirmed correct as-is</p>
                )}
                {mem && (
                  <p style={memoryNoteStyle}>
                    🧠 Seen {mem.count}× before from this supplier · confidence {(mem.confidence * 100).toFixed(0)}%
                  </p>
                )}
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

          {/* Approve-time duplicate: the corrected values matched an existing
              invoice the raw extraction missed. Decide before it's saved/posted. */}
          {approveDuplicate ? (
            <section style={dupCardStyle}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#7d4a00", marginBottom: 6 }}>
                ⚠️ Possible duplicate
              </div>
              <p style={{ margin: "0 0 14px", color: "#6b4b1a", fontSize: 14 }}>
                After your corrections, this matches an invoice already processed on{" "}
                <strong>{new Date(approveDuplicate.processedOn).toLocaleDateString()}</strong> — same
                supplier (<strong>{approveDuplicate.supplierName}</strong>) and invoice number (
                <strong>{approveDuplicate.invoiceNumber}</strong>).
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={approveBtn} onClick={() => { setApproveDuplicate(null); onApprove(true); }}>
                  Approve anyway
                </button>
                <button style={discardBtn} onClick={discard}>
                  Discard
                </button>
              </div>
            </section>
          ) : (
            /* Blocked hides the button entirely — a critical field must be fixed
               first. "review" still lets the human override ("Approve anyway"). */
            gate?.status !== "blocked" && (
              <button style={approveBtn} onClick={() => onApprove()}>
                {gate?.status === "review" ? "Approve anyway" : "✓ Approve"}
              </button>
            )
          )}
          {approved && <p style={{ color: "#1e8449", fontWeight: 600, marginBottom: 0 }}>{approved}</p>}
        </section>
      )}
    </main>
  );
}

function ConnectionControl({
  name,
  path,
  status,
}: {
  name: string;
  path: string;
  status?: PlatformStatus;
}) {
  if (!status) return <span style={connMutedStyle}>{name} …</span>; // still loading
  if (status.connected) return <span style={connOkStyle}>✓ {name} connected</span>;
  if (!status.configured) return <span style={connMutedStyle}>{name} — not configured</span>;
  // Configured but not connected: a plain link that kicks off the OAuth redirect.
  return (
    <a href={path} style={connBtnStyle}>
      Connect {name}
    </a>
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
const confirmAsIsBtn: React.CSSProperties = {
  margin: "-6px 0 12px",
  padding: "5px 12px",
  background: "#fff",
  color: "#1e8449",
  border: "1px solid #a9dfbf",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 12,
};
const affirmedNoteStyle: React.CSSProperties = {
  margin: "-6px 0 12px",
  color: "#1e8449",
  fontSize: 12,
  fontWeight: 600,
};
const memoryNoteStyle: React.CSSProperties = {
  margin: "-8px 0 14px",
  color: "#6b5bd0",
  fontSize: 12,
  fontWeight: 600,
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
const dupCardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  background: "#fff8ec",
  border: "1px solid #f0c986",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};
const discardBtn: React.CSSProperties = {
  padding: "11px 22px",
  background: "#fff",
  color: "#8a5a00",
  border: "1px solid #e0b877",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
const connBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  marginBottom: 24,
};
const connBtnStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "6px 14px",
  background: "#1a2b4a",
  color: "#fff",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 13,
  textDecoration: "none",
};
const connOkStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "#e8f8f0",
  color: "#1e8449",
  border: "1px solid #a9dfbf",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 13,
};
const connMutedStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "#f4f6f8",
  color: "#8892a0",
  border: "1px solid #e6eaee",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 13,
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
