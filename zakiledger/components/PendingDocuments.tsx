"use client";

import { useCallback, useEffect, useState } from "react";
import { REVIEWABLE_FIELDS, type DocumentType, type InvoiceExtraction } from "@/lib/schema";
import { fieldLabels } from "@/lib/validation";
import { formatMoney } from "@/lib/currency";
// Type-only: erased at compile time, so the server-side bulk-approve module (and
// its Xero/Supabase chain) never reaches the client bundle.
import type { BulkApproveResult, BulkItemResult } from "@/lib/bulk-approve";

/**
 * The approval queue: everything read but not yet in the ledger.
 *
 * Two ways through it, and the UI keeps them distinct rather than making one a
 * special case of the other:
 *   - **Approve** on a single row, for working down the queue one at a time.
 *   - **Approve Selected**, which only appears at 2+ — below that it would just
 *     be a second, worse button for the row action already sitting right there.
 *
 * Both run the identical server-side decision (`/api/approve/bulk`), so a
 * document gets the same gate whether it was approved alone or in a batch of ten.
 * The single-row button is a batch of one, not a separate code path.
 */

/** A queued document as GET /api/pending renders it. */
export type PendingDoc = {
  id: string;
  createdAt: string;
  filename: string | null;
  documentType: DocumentType;
  merchantName: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  total: number;
  overallConfidence: number;
  lastOutcome: "approved" | "blocked" | "error" | null;
  lastReason: string | null;
};

/** The full extraction behind one row, fetched only when details are opened. */
type PendingDetail = {
  id: string;
  filename: string | null;
  extraction: InvoiceExtraction;
};

/** Above this a read is trusted at a glance; below it the human should look. */
const CONFIDENCE_OK = 0.85;
/** Below this it isn't a soft warning any more — it's a likely problem. */
const CONFIDENCE_POOR = 0.6;

function confidenceChipStyle(confidence: number): React.CSSProperties {
  if (confidence >= CONFIDENCE_OK) return chipOk;
  return confidence >= CONFIDENCE_POOR ? chipWarn : chipBad;
}

export default function PendingDocuments({
  /** Shows the demo-seed control. The parent knows whether we're in demo mode. */
  demo = false,
}: {
  demo?: boolean;
}) {
  const [docs, setDocs] = useState<PendingDoc[] | null>(null); // null = still loading
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BulkItemResult[] | null>(null);
  const [summary, setSummary] = useState<BulkApproveResult["summary"] | null>(null);
  /** Which row is expanded, and the detail once it has arrived. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PendingDetail | null>(null);
  /** Ids currently being approved — disables their row button and the batch one. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  /**
   * Reload the queue and drop any selection that no longer exists. Approved
   * documents are gone from the server's list, and a stale id left in the
   * selection would come back as "not found" on the next batch.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pending");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load the queue.");
        setDocs([]);
        return;
      }
      setError(null);
      setDocs(data.documents);
      const live = new Set<string>((data.documents as PendingDoc[]).map((d) => d.id));
      setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the queue.");
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Approve a set of documents. One document or ten, it's the same request to the
   * same endpoint — the batch of one is not a special case.
   */
  async function approve(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(new Set(ids));
    setError(null);
    try {
      const res = await fetch("/api/approve/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Approve failed.");
        return;
      }
      setResults(data.results);
      setSummary(data.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed.");
    } finally {
      setBusy(new Set());
      // Approved documents leave the queue; blocked and errored ones stay, now
      // carrying the reason they came back with.
      await refresh();
    }
  }

  async function toggleDetail(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null); // clear the previous row's data so it can't render under this one
    try {
      const res = await fetch(`/api/pending/${id}`);
      const data = await res.json();
      if (res.ok) setDetail(data);
      else setError(data.error ?? "Couldn't load the details.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the details.");
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function seedDemoBatch() {
    await fetch("/api/pending/demo", { method: "POST" });
    setResults(null);
    setSummary(null);
    await refresh();
  }

  const working = busy.size > 0;

  if (docs === null) {
    return <p style={mutedNote}>Loading the queue…</p>;
  }

  return (
    <div>
      {error && <p style={errorNote}>{error}</p>}

      {/* --- Empty state ---------------------------------------------------- */}
      {docs.length === 0 ? (
        <div style={emptyStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a2b4a", marginBottom: 4 }}>
            No pending documents
          </div>
          <p style={{ margin: 0, color: "#8892a0", fontSize: 14 }}>
            Everything read so far has been approved. Upload an invoice or receipt and it will
            appear here for approval.
          </p>
          {demo && (
            <button style={{ ...linkBtn, marginTop: 14 }} onClick={seedDemoBatch}>
              🧪 Load a demo batch (5 documents)
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={queueHeader}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4 }}>
              {docs.length} DOCUMENT{docs.length === 1 ? "" : "S"} WAITING
            </span>
            <button
              style={linkBtn}
              onClick={() =>
                setSelected(
                  selected.size === docs.length ? new Set() : new Set(docs.map((d) => d.id)),
                )
              }
            >
              {selected.size === docs.length ? "Clear selection" : "Select all"}
            </button>
          </div>

          {docs.map((d) => {
            const isSelected = selected.has(d.id);
            const isOpen = openId === d.id;
            return (
              <div key={d.id} style={isSelected ? rowSelected : row}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(d.id)}
                    aria-label={`Select ${d.merchantName}`}
                    style={{ marginTop: 4, flexShrink: 0, width: 16, height: 16 }}
                  />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ fontWeight: 700, color: "#1a2b4a" }}>
                        {d.merchantName || "(unknown)"}
                      </span>
                      <span style={{ fontWeight: 700, color: "#1a2b4a", whiteSpace: "nowrap" }}>
                        {Number.isFinite(d.total) ? formatMoney(d.total, d.currency) : "—"}
                      </span>
                    </div>

                    <div style={metaRow}>
                      <span style={d.documentType === "receipt" ? badgeReceipt : badgeInvoice}>
                        {d.documentType === "receipt" ? "🧾 Receipt" : "📄 Invoice"}
                      </span>
                      <span style={confidenceChipStyle(d.overallConfidence)}>
                        {(d.overallConfidence * 100).toFixed(0)}% confidence
                      </span>
                      {d.invoiceDate && <span style={metaText}>{d.invoiceDate}</span>}
                      {d.invoiceNumber && <span style={metaText}>{d.invoiceNumber}</span>}
                      {d.filename && <span style={metaText}>{d.filename}</span>}
                    </div>

                    {/* Why it came back from a previous approval attempt. */}
                    {d.lastReason && (
                      <p style={d.lastOutcome === "error" ? rowErrorNote : rowBlockedNote}>
                        {d.lastOutcome === "error" ? "❌" : "⚠️"} {d.lastReason}
                      </p>
                    )}

                    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                      <button
                        style={working ? { ...approveSmall, opacity: 0.5 } : approveSmall}
                        onClick={() => approve([d.id])}
                        disabled={working}
                      >
                        {busy.has(d.id) ? "Approving…" : "✓ Approve"}
                      </button>
                      <button style={linkBtn} onClick={() => toggleDetail(d.id)}>
                        {isOpen ? "Hide details" : "View details"}
                      </button>
                    </div>

                    {isOpen && <DetailPanel documentId={d.id} detail={detail} />}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Only from 2 up: at 1 this would duplicate the row button above. */}
          {selected.size >= 2 && (
            <button
              style={working ? { ...approveBtn, opacity: 0.5 } : approveBtn}
              onClick={() => approve([...selected])}
              disabled={working}
            >
              {working ? "Approving…" : `✓ Approve Selected (${selected.size})`}
            </button>
          )}
          {selected.size === 1 && (
            <p style={mutedNote}>
              Select one more to approve as a batch, or use the ✓ Approve button on the document
              itself.
            </p>
          )}
        </>
      )}

      {/* --- Results of the last approval run ------------------------------- */}
      {summary && results && (
        <section style={{ marginTop: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8892a0", letterSpacing: 0.4 }}>
            LAST RUN
          </div>
          <div style={summaryStyle}>
            {summary.approved} approved, {summary.blocked} blocked, {summary.errors} error
            {summary.errors === 1 ? "" : "s"} | {summary.postedLabel} posted
          </div>
          {summary.approvedWithoutPosting && (
            <p style={mutedNote}>
              Recorded in the ledger — no accounting platform is connected, so nothing was sent to
              Xero or QuickBooks.
            </p>
          )}
          {results.map((r) => (
            <ResultRow key={r.documentId} result={r} />
          ))}
        </section>
      )}
    </div>
  );
}

/** The full extraction behind one row: every field, with the confidence for it. */
function DetailPanel({
  documentId,
  detail,
}: {
  documentId: string;
  detail: PendingDetail | null;
}) {
  if (!detail || detail.id !== documentId) {
    return <p style={mutedNote}>Loading details…</p>;
  }

  const x = detail.extraction;
  const type = x.documentType?.value ?? "invoice";
  const labels = fieldLabels(type);

  return (
    <div style={detailPanel}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={confidenceChipStyle(x.documentType?.confidence ?? 1)}>
          Document type {((x.documentType?.confidence ?? 1) * 100).toFixed(0)}%
        </span>
        {!x.taxItemized && <span style={chipMuted}>No tax broken out</span>}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {REVIEWABLE_FIELDS.map((f) => {
            const node = (x as any)[f] as { value: unknown; confidence: number };
            const value = String(node.value);
            // A field the document never stated is not a failed read — show it as
            // absent rather than as a 0% score the human can never satisfy.
            const absent = value.trim() === "" || node.confidence === 0;
            return (
              <tr key={f}>
                <td style={detailLabel}>{labels[f]}</td>
                <td style={detailValue}>
                  {absent ? <span style={{ color: "#8892a0" }}>not stated</span> : value}
                </td>
                <td style={{ padding: "6px 0", textAlign: "right" }}>
                  {absent ? (
                    <span style={chipMuted}>—</span>
                  ) : (
                    <span style={confidenceChipStyle(node.confidence)}>
                      {(node.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {x.lineItems.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#8892a0", marginBottom: 4 }}>
            LINE ITEMS
          </div>
          {x.lineItems.map((li, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span style={{ color: "#445" }}>
                {li.description} {li.quantity > 1 ? `× ${li.quantity}` : ""}
              </span>
              <span style={{ color: "#1a2b4a", fontWeight: 600 }}>
                {formatMoney(li.amount, x.currency.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One document's outcome. Colour AND icon, never colour alone — the distinction
 * has to survive a colourblind reader and a black-and-white print.
 */
function ResultRow({ result }: { result: BulkItemResult }) {
  const style =
    result.status === "approved"
      ? resultApproved
      : result.status === "blocked"
        ? resultBlocked
        : resultError;
  const icon = result.status === "approved" ? "✅" : result.status === "blocked" ? "⚠️" : "❌";

  return (
    <div style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <strong>
          {icon} {result.merchantName}
        </strong>
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
          {result.total === null ? "—" : formatMoney(result.total, result.currency)}
        </span>
      </div>
      {result.reason && <div style={{ marginTop: 4, fontSize: 13 }}>{result.reason}</div>}
      {result.status === "approved" && result.billId && (
        <div style={{ marginTop: 4, fontSize: 13 }}>
          Posted as a draft bill to {result.billPlatform === "quickbooks" ? "QuickBooks" : "Xero"}{" "}
          (ID {result.billId}).
        </div>
      )}
    </div>
  );
}

// --- styles -----------------------------------------------------------------
const queueHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
};
const row: React.CSSProperties = {
  padding: "14px 16px",
  marginBottom: 10,
  border: "1px solid #e6eaee",
  borderRadius: 10,
  background: "#fff",
};
const rowSelected: React.CSSProperties = {
  ...row,
  borderColor: "#a9c4df",
  background: "#f5f9fd",
};
const metaRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 6,
};
const metaText: React.CSSProperties = { fontSize: 12, color: "#8892a0" };
const badgeInvoice: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  background: "#eef2ff",
  color: "#3730a3",
  fontSize: 12,
  fontWeight: 700,
};
const badgeReceipt: React.CSSProperties = {
  ...badgeInvoice,
  background: "#f3e8ff",
  color: "#6b21a8",
};
const chipOk: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  background: "#e8f8f0",
  color: "#1e8449",
  fontSize: 12,
  fontWeight: 600,
};
const chipWarn: React.CSSProperties = {
  ...chipOk,
  background: "#fef9e7",
  color: "#7d6608",
};
const chipBad: React.CSSProperties = {
  ...chipOk,
  background: "#fdecea",
  color: "#c0392b",
};
const chipMuted: React.CSSProperties = {
  ...chipOk,
  background: "#f4f6f8",
  color: "#8892a0",
};
const rowBlockedNote: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12,
  color: "#7d6608",
};
const rowErrorNote: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12,
  color: "#c0392b",
};
const detailPanel: React.CSSProperties = {
  marginTop: 12,
  padding: "12px 14px",
  background: "#fafbfc",
  border: "1px solid #eef1f4",
  borderRadius: 8,
};
const detailLabel: React.CSSProperties = {
  padding: "6px 8px 6px 0",
  color: "#8892a0",
  whiteSpace: "nowrap",
};
const detailValue: React.CSSProperties = {
  padding: "6px 8px 6px 0",
  color: "#1a2b4a",
  fontWeight: 600,
  width: "100%",
};
const emptyStyle: React.CSSProperties = {
  padding: "28px 24px",
  textAlign: "center",
  background: "#fff",
  border: "1px dashed #d5dbdb",
  borderRadius: 12,
};
const summaryStyle: React.CSSProperties = {
  margin: "8px 0 12px",
  padding: "10px 14px",
  background: "#f4f6f8",
  border: "1px solid #e6eaee",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 700,
  color: "#1a2b4a",
};
const resultBase: React.CSSProperties = {
  padding: "10px 14px",
  marginBottom: 8,
  borderRadius: 8,
  fontSize: 14,
};
const resultApproved: React.CSSProperties = {
  ...resultBase,
  background: "#e8f8f0",
  border: "1px solid #a9dfbf",
  color: "#1e6b45",
};
const resultBlocked: React.CSSProperties = {
  ...resultBase,
  background: "#fef9e7",
  border: "1px solid #f7dc6f",
  color: "#7d6608",
};
const resultError: React.CSSProperties = {
  ...resultBase,
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  color: "#c0392b",
};
const approveBtn: React.CSSProperties = {
  marginTop: 8,
  padding: "11px 22px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
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
const mutedNote: React.CSSProperties = {
  margin: "10px 0 0",
  fontSize: 13,
  color: "#8892a0",
};
const errorNote: React.CSSProperties = {
  margin: "0 0 14px",
  padding: "10px 14px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 14,
};
