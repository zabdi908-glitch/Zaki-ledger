"use client";

import { useCallback, useEffect, useState } from "react";
import { REVIEWABLE_FIELDS, type DocumentType, type InvoiceExtraction, type ReviewableField } from "@/lib/schema";
import {
  effectiveConfidence,
  fieldLabels,
  gateApproval,
  gateReasonSummary,
  type ApprovalGate,
} from "@/lib/validation";
import { formatMoney } from "@/lib/currency";
import EditableField from "./EditableField";
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

/**
 * Effective confidence per field once the human's edits are taken into account,
 * and the same approval gate every other screen runs over the result. No
 * "confirm as-is" here — only a typed correction clears a field's confidence.
 */
function effectiveConfidences(
  x: InvoiceExtraction,
  edited: Record<string, string>,
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const node = (x as any)[f] as { value: unknown; confidence: number };
    out[f] = effectiveConfidence(node.confidence, String(node.value), edited[f], false);
  }
  return out;
}

function computeGate(
  x: InvoiceExtraction,
  edited: Record<string, string>,
  documentType: DocumentType,
  documentTypeConfirmed: boolean,
): ApprovalGate {
  return gateApproval(effectiveConfidences(x, edited), {
    documentType,
    taxItemized: x.taxItemized,
    documentTypeConfidence: x.documentType?.confidence,
    documentTypeConfirmed,
  });
}

/** True once the human has typed a real change into at least one field. */
function hasEdits(x: InvoiceExtraction, edited: Record<string, string>): boolean {
  return REVIEWABLE_FIELDS.some((f) => {
    const original = String((x as any)[f].value);
    return edited[f] !== undefined && edited[f] !== original;
  });
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
  /** Edits made in the open row's detail panel, keyed by reviewable field. */
  const [edited, setEdited] = useState<Record<string, string>>({});
  /**
   * The human settled an uncertain invoice-vs-receipt classification for the open
   * row — mirrors app/page.tsx's type-confirm flow. The type isn't a field the
   * human edits in place, so without this a low-confidence classification has no
   * way to clear the gate: editing every visible field still leaves Rule 0
   * (documentType confidence) blocking the row forever.
   */
  const [typeConfirmed, setTypeConfirmed] = useState(false);
  const [typeOverride, setTypeOverride] = useState<DocumentType | null>(null);
  /** A direct approve came back as a possible duplicate — armed to proceed anyway. */
  const [duplicateWarning, setDuplicateWarning] = useState<{ id: string; message: string } | null>(
    null,
  );
  /** Ids currently being approved — disables their row button and the batch one. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** The row whose delete is awaiting confirmation, and the one being deleted. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Transient success line ("Document deleted"). */
  const [notice, setNotice] = useState<string | null>(null);

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
   *
   * Exception: if the row currently open for editing is part of this batch AND
   * the human actually touched it (edited a field or confirmed the document
   * type), it cannot go through the plain bulk endpoint — that re-checks the
   * ORIGINAL unedited read against the strict, no-human-present gate and blocks
   * it, silently discarding the edit. So that one document is sent through the
   * same edited-review route the single-row Approve button uses, first; the
   * rest of the batch still goes through bulk, unaffected.
   */
  async function approve(ids: string[]) {
    if (ids.length === 0) return;
    const touchedId =
      openId && detail && detail.id === openId && ids.includes(openId) &&
      (hasEdits(detail.extraction, edited) || typeConfirmed)
        ? openId
        : null;
    const bulkIds = ids.filter((id) => id !== touchedId);

    setBusy(new Set(ids));
    setError(null);
    try {
      if (touchedId) await approveDirect(touchedId, false);

      if (bulkIds.length > 0) {
        const res = await fetch("/api/approve/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentIds: bulkIds }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Approve failed.");
          return;
        }
        setResults(data.results);
        setSummary(data.summary);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed.");
    } finally {
      setBusy(new Set());
      // Approved documents leave the queue; blocked and errored ones stay, now
      // carrying the reason they came back with.
      await refresh();
    }
  }

  /** Commit one field's edit in the open detail panel. */
  function commitEdit(field: ReviewableField, value: string) {
    setEdited((prev) => ({ ...prev, [field]: value }));
    // A changed value invalidates any duplicate warning from a previous attempt —
    // it has to be checked against the ledger again.
    setDuplicateWarning(null);
  }

  /**
   * Approve the open document with its edits, via the same review route the
   * batch-upload screen uses. This is the only way an edit from /pending reaches
   * the server — an untouched row still goes through `approve()` below.
   */
  async function approveDirect(id: string, proceedDuplicate: boolean) {
    if (!detail || detail.id !== id) return;
    setBusy(new Set([id]));
    setError(null);
    setDuplicateWarning(null);
    try {
      const x = detail.extraction;
      // The human's confirmed/overridden type wins over the model's guess — same
      // rule /api/approve applies for the main upload screen.
      const documentType = typeOverride ?? x.documentType?.value ?? "invoice";
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: id,
          extraction: x,
          edited: Object.fromEntries(
            REVIEWABLE_FIELDS.map((f) => [f, edited[f] ?? String((x as any)[f].value)]),
          ),
          documentType,
          proceedDuplicate,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Approve failed.");
        return;
      }
      if (data.status === "duplicate") {
        const processedOn = new Date(data.duplicate.processedOn).toLocaleDateString("en-GB");
        setDuplicateWarning({
          id,
          message:
            `Possible duplicate of a ${data.duplicate.documentType ?? "document"} already ` +
            `processed on ${processedOn}.`,
        });
        return;
      }
      setOpenId(null);
      setDetail(null);
      setEdited({});
      setTypeConfirmed(false);
      setTypeOverride(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed.");
    } finally {
      setBusy(new Set());
      await refresh();
    }
  }

  /**
   * Delete a queued document. Only ever reached from the confirmation step —
   * there is no undo, so the click that destroys is never the first click.
   */
  async function confirmDelete(id: string) {
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/pending/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't delete the document.");
        return;
      }
      setNotice("Document deleted");
      // Drop it locally as well as refetching, so the row goes the instant the
      // request lands rather than after the round trip.
      setDocs((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the document.");
    } finally {
      setDeletingId(null);
      setConfirmingDelete(null);
      await refresh();
    }
  }

  async function toggleDetail(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      setEdited({});
      setTypeConfirmed(false);
      setTypeOverride(null);
      setDuplicateWarning(null);
      return;
    }
    setOpenId(id);
    setDetail(null); // clear the previous row's data so it can't render under this one
    setEdited({}); // a different document's edits don't carry over
    setTypeConfirmed(false);
    setTypeOverride(null);
    setDuplicateWarning(null);
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
      {notice && <p style={noticeStyle}>✓ {notice}</p>}

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
            // Edits (or a settled document-type classification) only exist for the
            // row whose detail panel is open — this is what decides whether
            // Approve goes through the direct review route (with the human's
            // values) or the untouched bulk route (by id alone).
            const rowExtraction = isOpen && detail && detail.id === d.id ? detail.extraction : null;
            const rowEdited = rowExtraction !== null && hasEdits(rowExtraction, edited);
            const rowTouched = rowEdited || typeConfirmed;
            const rowDocumentType: DocumentType =
              typeOverride ?? rowExtraction?.documentType?.value ?? d.documentType;
            const rowGate =
              rowExtraction && rowTouched
                ? computeGate(rowExtraction, edited, rowDocumentType, typeConfirmed)
                : null;
            const rowBlocked = rowGate !== null && rowGate.status !== "ready";
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

                    {/* The destructive action is never the first click: asking
                        replaces the row's buttons until it's answered, so there
                        is nothing to mis-click while the question is open. */}
                    {confirmingDelete === d.id ? (
                      <div style={confirmBar}>
                        <span style={{ flex: 1 }}>
                          Delete this document? It won&apos;t be recoverable.
                        </span>
                        <button
                          style={deletingId === d.id ? { ...dangerSmall, opacity: 0.5 } : dangerSmall}
                          onClick={() => confirmDelete(d.id)}
                          disabled={deletingId === d.id}
                        >
                          {deletingId === d.id ? "Deleting…" : "Yes, delete"}
                        </button>
                        <button style={linkBtn} onClick={() => setConfirmingDelete(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : duplicateWarning?.id === d.id ? (
                      <div style={confirmBar}>
                        <span style={{ flex: 1 }}>
                          {duplicateWarning.message} Approve again to post it anyway.
                        </span>
                        <button
                          style={busy.has(d.id) ? { ...dangerSmall, opacity: 0.5 } : dangerSmall}
                          onClick={() => approveDirect(d.id, true)}
                          disabled={busy.has(d.id)}
                        >
                          {busy.has(d.id) ? "Approving…" : "Approve anyway"}
                        </button>
                        <button style={linkBtn} onClick={() => setDuplicateWarning(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                        <button
                          style={
                            working || rowBlocked
                              ? { ...approveSmall, opacity: 0.5, cursor: "not-allowed" }
                              : approveSmall
                          }
                          onClick={() => (rowTouched ? approveDirect(d.id, false) : approve([d.id]))}
                          disabled={working || rowBlocked}
                          title={
                            rowBlocked
                              ? gateReasonSummary(rowGate!, rowDocumentType) || "Fix the flagged field first"
                              : "Approve this document now"
                          }
                        >
                          {busy.has(d.id) ? "Approving…" : "✓ Approve"}
                        </button>
                        <button style={linkBtn} onClick={() => toggleDetail(d.id)}>
                          {isOpen ? "Hide details" : "View details"}
                        </button>
                        <button
                          style={deleteBtn}
                          onClick={() => {
                            setConfirmingDelete(d.id);
                            setNotice(null);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}

                    {isOpen && (
                      <DetailPanel
                        documentId={d.id}
                        detail={detail}
                        edited={edited}
                        onEdit={commitEdit}
                        typeConfirmed={typeConfirmed}
                        typeOverride={typeOverride}
                        onConfirmType={(t, detectedType) => {
                          setTypeOverride(t === detectedType ? null : t);
                          setTypeConfirmed(true);
                        }}
                      />
                    )}
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

/**
 * The full extraction behind one row: every field, editable in place. Click a
 * value to correct it — the confidence chip flips to "✓ edited" immediately, and
 * an edit that clears the last flagged field unblocks this row's Approve button
 * without a round trip, same as the batch-upload screen.
 */
function DetailPanel({
  documentId,
  detail,
  edited,
  onEdit,
  typeConfirmed,
  typeOverride,
  onConfirmType,
}: {
  documentId: string;
  detail: PendingDetail | null;
  edited: Record<string, string>;
  onEdit: (field: ReviewableField, value: string) => void;
  typeConfirmed: boolean;
  typeOverride: DocumentType | null;
  onConfirmType: (chosen: DocumentType, detectedType: DocumentType) => void;
}) {
  if (!detail || detail.id !== documentId) {
    return <p style={mutedNote}>Loading details…</p>;
  }

  const x = detail.extraction;
  const detectedType = x.documentType?.value ?? "invoice";
  const type = typeOverride ?? detectedType;
  const typeConfidence = x.documentType?.confidence ?? 1;
  const labels = fieldLabels(type);
  const confidences = effectiveConfidences(x, edited);
  const gate =
    hasEdits(x, edited) || typeConfirmed ? computeGate(x, edited, type, typeConfirmed) : null;

  return (
    <div style={detailPanel}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={confidenceChipStyle(typeConfidence)}>
          Document type{" "}
          {typeOverride ? "· set by you" : typeConfirmed ? "· confirmed" : `${(typeConfidence * 100).toFixed(0)}%`}
        </span>
        {!x.taxItemized && <span style={chipMuted}>No tax broken out</span>}
      </div>

      {/* An uncertain classification blocks approval, because the type decides
          which fields are required and how duplicates are matched. The type
          isn't an editable field, so without this the block is a deadlock —
          editing every visible field still leaves this row stuck. */}
      {typeConfidence < 0.8 && !typeConfirmed && (
        <div style={typePickerStyle}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Is this an invoice or a receipt?</div>
          <p style={{ margin: "0 0 10px", fontSize: 13 }}>
            We read it as a <strong>{detectedType}</strong> but only at{" "}
            {(typeConfidence * 100).toFixed(0)}% confidence. This decides which fields are
            required, so please confirm before approving.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {(["invoice", "receipt"] as DocumentType[]).map((t) => (
              <button
                key={t}
                style={t === detectedType ? approveSmall : linkBtn}
                onClick={() => onConfirmType(t, detectedType)}
              >
                {t === "receipt" ? "🧾 Receipt" : "📄 Invoice"}
              </button>
            ))}
          </div>
        </div>
      )}

      {gate && gate.status !== "ready" && (
        <p style={rowBlockedNote}>⚠️ {gateReasonSummary(gate, type)}</p>
      )}

      {REVIEWABLE_FIELDS.map((f) => {
        const node = (x as any)[f] as { value: unknown; confidence: number };
        const original = String(node.value);
        // A field the document never stated is not a failed read — show it as
        // absent rather than as a 0% score the human can never satisfy.
        const absent = original.trim() === "" || node.confidence === 0;
        return (
          <EditableField
            key={f}
            label={labels[f]}
            value={edited[f] ?? original}
            original={original}
            confidence={confidences[f]}
            absent={absent}
            edited={edited[f] !== undefined && edited[f] !== original}
            affirmed={false}
            onCommit={(v) => onEdit(f, v)}
          />
        );
      })}

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
const typePickerStyle: React.CSSProperties = {
  margin: "0 0 12px",
  padding: "10px 12px",
  background: "#fef9e7",
  border: "1px solid #f7dc6f",
  borderRadius: 8,
  color: "#7d6608",
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
const deleteBtn: React.CSSProperties = {
  padding: "5px 12px",
  background: "#fff",
  color: "#c0392b",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 12,
};
const dangerSmall: React.CSSProperties = {
  padding: "6px 14px",
  background: "#c0392b",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};
const confirmBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 10,
  padding: "10px 12px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 13,
  fontWeight: 600,
};
const noticeStyle: React.CSSProperties = {
  margin: "0 0 14px",
  padding: "10px 14px",
  background: "#e8f8f0",
  border: "1px solid #a9dfbf",
  borderRadius: 8,
  color: "#1e6b45",
  fontSize: 14,
  fontWeight: 600,
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
