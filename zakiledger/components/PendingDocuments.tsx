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
import { banner, button, card, chip, color, eyebrow, figures, font, radius, typeBadge } from "@/lib/theme";
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
  if (confidence >= CONFIDENCE_OK) return { ...chip("ok"), ...figures };
  return confidence >= CONFIDENCE_POOR ? { ...chip("warn"), ...figures } : { ...chip("bad"), ...figures };
}

/**
 * Effective confidence per field once the human's edits (or an explicit
 * "confirm as-is") are taken into account — same rule the main upload screen
 * applies. A field the model already read correctly shouldn't require the
 * human to retype its own value just to clear the gate; affirming it as-is
 * clears the gate the same way an edit does, and is recorded as a
 * confirmation rather than a correction.
 */
function effectiveConfidences(
  x: InvoiceExtraction,
  edited: Record<string, string>,
  affirmed: Record<string, boolean>,
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const node = (x as any)[f] as { value: unknown; confidence: number };
    out[f] = effectiveConfidence(node.confidence, String(node.value), edited[f], affirmed[f] === true);
  }
  return out;
}

function computeGate(
  x: InvoiceExtraction,
  edited: Record<string, string>,
  affirmed: Record<string, boolean>,
  documentType: DocumentType,
  documentTypeConfirmed: boolean,
): ApprovalGate {
  return gateApproval(effectiveConfidences(x, edited, affirmed), {
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

/** True once the human has affirmed at least one field as correct as-is. */
function hasAffirmations(affirmed: Record<string, boolean>): boolean {
  return REVIEWABLE_FIELDS.some((f) => affirmed[f] === true);
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
   * Fields the human affirmed as-is in the open row — the AI read it right, so
   * there's nothing to retype. Clears the gate exactly like an edit does,
   * without forcing the human to reproduce a value that was already correct.
   */
  const [affirmed, setAffirmed] = useState<Record<string, boolean>>({});
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
   * the human actually touched it (edited a field, confirmed the document
   * type, or affirmed a field as correct as-is), it cannot go through the
   * plain bulk endpoint — that re-checks the ORIGINAL unedited read against the
   * strict, no-human-present gate and blocks it, silently discarding the
   * touch. So that one document is sent through the same edited-review route
   * the single-row Approve button uses, first; the rest of the batch still
   * goes through bulk, unaffected.
   */
  async function approve(ids: string[]) {
    if (ids.length === 0) return;
    const touchedId =
      openId && detail && detail.id === openId && ids.includes(openId) &&
      (hasEdits(detail.extraction, edited) || typeConfirmed || hasAffirmations(affirmed))
        ? openId
        : null;
    const bulkIds = ids.filter((id) => id !== touchedId);

    // Merge into busy rather than replace it: approveDirect (below) also
    // writes this same state, and a second approve firing while an earlier
    // one is still in flight must not make that row's button look free to
    // click again — a double-click here would be a second POST for a document
    // that's still mid-approval, not just a UI glitch.
    setBusy((prev) => new Set([...prev, ...ids]));
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
      // touchedId was already cleared by approveDirect's own finally.
      setBusy((prev) => {
        const next = new Set(prev);
        for (const id of bulkIds) next.delete(id);
        return next;
      });
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

  /** Affirm a field as correct as-is — the AI read it right, nothing to retype. */
  function affirmField(field: ReviewableField) {
    setAffirmed((prev) => ({ ...prev, [field]: true }));
  }

  /**
   * Approve the open document with its edits, via the same review route the
   * batch-upload screen uses. This is the only way an edit from /pending reaches
   * the server — an untouched row still goes through `approve()` below.
   */
  async function approveDirect(id: string, proceedDuplicate: boolean) {
    if (!detail || detail.id !== id) return;
    setBusy((prev) => new Set([...prev, id]));
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
      setAffirmed({});
      setTypeConfirmed(false);
      setTypeOverride(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed.");
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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
      setAffirmed({});
      setTypeConfirmed(false);
      setTypeOverride(null);
      setDuplicateWarning(null);
      return;
    }
    setOpenId(id);
    setDetail(null); // clear the previous row's data so it can't render under this one
    setEdited({}); // a different document's edits don't carry over
    setAffirmed({});
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
          <div style={{ fontSize: 16, fontWeight: 600, color: color.ink, marginBottom: 4, fontFamily: font.display }}>
            No pending documents
          </div>
          <p style={{ margin: 0, color: color.inkSoft, fontSize: 14 }}>
            Everything read so far has been approved. Upload an invoice or receipt and it will
            appear here for approval.
          </p>
          {demo && (
            <button style={{ ...linkBtn, marginTop: 14 }} onClick={seedDemoBatch}>
              Load a demo batch (5 documents)
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={queueHeader}>
            <span style={eyebrow}>
              {docs.length} document{docs.length === 1 ? "" : "s"} waiting
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
            const rowTouched = rowEdited || typeConfirmed || hasAffirmations(affirmed);
            const rowDocumentType: DocumentType =
              typeOverride ?? rowExtraction?.documentType?.value ?? d.documentType;
            const rowGate =
              rowExtraction && rowTouched
                ? computeGate(rowExtraction, edited, affirmed, rowDocumentType, typeConfirmed)
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
                      <span style={{ fontWeight: 700, color: color.ink, fontFamily: font.display }}>
                        {d.merchantName || "(unknown)"}
                      </span>
                      <span style={{ fontWeight: 700, color: color.ink, whiteSpace: "nowrap", ...figures }}>
                        {Number.isFinite(d.total) ? formatMoney(d.total, d.currency) : "—"}
                      </span>
                    </div>

                    <div style={metaRow}>
                      <span style={typeBadge(d.documentType === "receipt" ? "receipt" : "invoice")}>
                        {d.documentType === "receipt" ? "Receipt" : "Invoice"}
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
                        {d.lastReason}
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
                        affirmed={affirmed}
                        onAffirm={affirmField}
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
        <section style={{ marginTop: 28 }}>
          <div style={eyebrow}>Last run</div>
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
  affirmed,
  onAffirm,
  typeConfirmed,
  typeOverride,
  onConfirmType,
}: {
  documentId: string;
  detail: PendingDetail | null;
  edited: Record<string, string>;
  onEdit: (field: ReviewableField, value: string) => void;
  affirmed: Record<string, boolean>;
  onAffirm: (field: ReviewableField) => void;
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
  const confidences = effectiveConfidences(x, edited, affirmed);
  const gate =
    hasEdits(x, edited) || typeConfirmed || hasAffirmations(affirmed)
      ? computeGate(x, edited, affirmed, type, typeConfirmed)
      : null;

  return (
    <div style={detailPanel}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={confidenceChipStyle(typeConfidence)}>
          Document type{" "}
          {typeOverride ? "· set by you" : typeConfirmed ? "· confirmed" : `${(typeConfidence * 100).toFixed(0)}%`}
        </span>
        {!x.taxItemized && <span style={chip("muted")}>No tax broken out</span>}
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
                {t === "receipt" ? "Receipt" : "Invoice"}
              </button>
            ))}
          </div>
        </div>
      )}

      {gate && gate.status !== "ready" && (
        <p style={rowBlockedNote}>{gateReasonSummary(gate, type)}</p>
      )}

      {REVIEWABLE_FIELDS.map((f) => {
        const node = (x as any)[f] as { value: unknown; confidence: number };
        const original = String(node.value);
        // A field the document never stated is not a failed read — show it as
        // absent rather than as a 0% score the human can never satisfy.
        const absent = original.trim() === "" || node.confidence === 0;
        const isEdited = edited[f] !== undefined && edited[f] !== original;
        const isAffirmed = affirmed[f] === true && !isEdited;
        // Below the same bar EditableField uses to shade a field amber — this is
        // when "confirm as-is" actually has something to offer.
        const low = !absent && node.confidence < 0.85;
        return (
          <div key={f}>
            <EditableField
              label={labels[f]}
              value={edited[f] ?? original}
              original={original}
              confidence={confidences[f]}
              absent={absent}
              edited={isEdited}
              affirmed={isAffirmed}
              onCommit={(v) => onEdit(f, v)}
            />
            {/* The AI often reads a field right but timidly — retyping the same
                value just to clear the gate would be busywork. This affirms it
                without an edit, clearing the gate and recording a confirmation
                (not a correction) once approved. */}
            {low && !isEdited && !isAffirmed && (
              <button style={confirmAsIsBtn} onClick={() => onAffirm(f)}>
                ✓ Confirm this is correct
              </button>
            )}
          </div>
        );
      })}

      {x.lineItems.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...eyebrow, marginBottom: 4 }}>Line items</div>
          {x.lineItems.map((li, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
              <span style={{ color: color.inkSoft }}>
                {li.description} {li.quantity > 1 ? `× ${li.quantity}` : ""}
              </span>
              <span style={{ color: color.ink, fontWeight: 600, ...figures }}>
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
  // Colour AND icon, never colour alone — the distinction has to survive a
  // colourblind reader and a black-and-white print. Plain marks rather than
  // emoji, to match the rest of the app's quieter tone.
  const icon = result.status === "approved" ? "✓" : result.status === "blocked" ? "!" : "×";

  return (
    <div style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <strong>
          {icon} {result.merchantName}
        </strong>
        <span style={{ fontWeight: 700, whiteSpace: "nowrap", ...figures }}>
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
  marginBottom: 14,
};
const row: React.CSSProperties = card({ padding: "14px 16px", marginBottom: 10, borderRadius: 12 });
const rowSelected: React.CSSProperties = {
  ...row,
  borderColor: `${color.forest}55`,
  background: color.forestTint,
};
const metaRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 6,
};
const metaText: React.CSSProperties = { fontSize: 12, color: color.inkFaint };
const confirmAsIsBtn: React.CSSProperties = {
  ...button("outline", "sm"),
  margin: "-4px 0 10px",
  color: color.forestDeep,
  border: `1px solid ${color.forest}`,
};
const rowBlockedNote: React.CSSProperties = { margin: "8px 0 0", fontSize: 12, color: color.goldDeep };
const rowErrorNote: React.CSSProperties = { margin: "8px 0 0", fontSize: 12, color: color.stampDeep };
const detailPanel: React.CSSProperties = card({ marginTop: 12, padding: "14px 16px", background: color.paperAlt });
const typePickerStyle: React.CSSProperties = { ...banner("warn"), margin: "0 0 12px" };
const emptyStyle: React.CSSProperties = {
  padding: "32px 24px",
  textAlign: "center",
  background: color.paper,
  border: `1px dashed ${color.paperLine}`,
  borderRadius: radius.lg,
};
const summaryStyle: React.CSSProperties = {
  margin: "8px 0 12px",
  padding: "11px 15px",
  background: color.paperAlt,
  border: `1px solid ${color.paperLine}`,
  borderRadius: radius.sm,
  fontSize: 14,
  fontWeight: 700,
  color: color.ink,
};
const resultApproved: React.CSSProperties = banner("ok");
const resultBlocked: React.CSSProperties = banner("warn");
const resultError: React.CSSProperties = banner("bad");
const approveBtn: React.CSSProperties = { ...button("success"), marginTop: 8 };
const approveSmall: React.CSSProperties = button("success", "sm");
const deleteBtn: React.CSSProperties = {
  ...button("ghost", "sm"),
  color: color.stampDeep,
  border: `1px solid ${color.stamp}44`,
};
const dangerSmall: React.CSSProperties = button("danger", "sm");
const confirmBar: React.CSSProperties = {
  ...banner("bad"),
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 10,
  fontWeight: 600,
};
const noticeStyle: React.CSSProperties = { ...banner("ok"), margin: "0 0 16px", fontWeight: 600 };
const linkBtn: React.CSSProperties = button("ghost", "sm");
const mutedNote: React.CSSProperties = { margin: "10px 0 0", fontSize: 13, color: color.inkSoft };
const errorNote: React.CSSProperties = { ...banner("bad"), margin: "0 0 16px" };
