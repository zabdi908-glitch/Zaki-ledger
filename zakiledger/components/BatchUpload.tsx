"use client";

import { useState } from "react";
import type { ReviewableField } from "@/lib/schema";
import type { BulkItemResult } from "@/lib/bulk-approve";
import BatchResultRow from "./BatchResultRow";
import {
  hasHumanInput,
  isActionable,
  originalValue,
  pendingRow,
  planApproval,
  rowStatus,
  tally,
  tallyLabel,
  type ResultRow,
} from "@/lib/batch-results";

/**
 * Multi-file upload, from picking the files to a finished batch.
 *
 * Three phases on one screen: confirm the selection → watch each file land →
 * work the results. The last of those is the point. A batch of five is almost
 * never five clean documents; it is four clean ones and something smudged, and
 * the smudged one used to be handed off to /pending — a different screen, a
 * different list, the batch you were just looking at gone. So the flagged
 * document is fixed here, in the list it arrived in, and approved from the same
 * place. /pending is still there for anything you'd rather leave.
 *
 * The progress is reported, not animated. /api/extract-batch streams a line per
 * document as it finishes, so "3 of 5 complete" counts documents that are
 * genuinely done. Nothing here moves because a timer said so.
 */

interface Summary {
  total: number;
  succeeded: number;
  failed: number;
  queued: number;
  elapsedMs: number;
}

export default function BatchUpload({
  files,
  onCancel,
  onDone,
}: {
  files: File[];
  /** Back out before uploading, or leave the results screen once finished. */
  onCancel: () => void;
  /** Fired whenever the queue may have changed, so the parent can recount. */
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ResultRow[] | null>(null); // null = not started
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /** Row indexes ticked for a batch approve. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Row indexes currently being approved. */
  const [busy, setBusy] = useState<Set<number>>(new Set());
  /** Rows that couldn't be approved at all, keyed by index — shown once, above. */
  const [skipped, setSkipped] = useState<Array<{ filename: string; reason: string }>>([]);
  /** Leaving with unconfirmed edits needs a second click, so it isn't an accident. */
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const completed = rows ? rows.filter((r) => r.read !== "extracting").length : 0;

  async function upload() {
    setRunning(true);
    setError(null);
    setSummary(null);
    // Everything is in flight the moment the request opens — the server reads up
    // to EXTRACT_CONCURRENCY at once and the client can't tell which, so showing
    // them all as reading is the honest state rather than inventing an order.
    setRows(files.map((f, i) => pendingRow(f.name, i)));

    const form = new FormData();
    for (const f of files) form.append("files", f);

    try {
      const res = await fetch("/api/extract-batch", { method: "POST", body: form });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Upload failed.");
        setRunning(false);
        return;
      }

      // Read the NDJSON stream, applying each line as it arrives. A chunk can end
      // mid-line, so the tail is held back until its newline shows up.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // incomplete tail

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // a malformed line must not take down the whole upload
          }

          if (msg.type === "result") {
            setRows((prev) => {
              if (!prev) return prev;
              const next = [...prev];
              next[msg.index] = {
                index: msg.index,
                filename: msg.filename,
                read: msg.status === "error" ? "error" : "success",
                documentId: msg.documentId,
                confidence: msg.confidence,
                extraction: msg.extraction,
                queueError: msg.queueError,
                failure: msg.status === "error" ? msg.reason : undefined,
                edited: {},
                affirmed: {},
              };
              return next;
            });
          } else if (msg.type === "summary") {
            setSummary(msg as Summary);
          } else if (msg.type === "fatal") {
            setError(msg.error ?? "Batch extraction failed.");
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setRunning(false);
      onDone();
    }
  }

  /**
   * Commit one field on one row. An unchanged value is not a no-op — it is the
   * human affirming the AI read it right, which clears the gate and gets recorded
   * as a confirmation rather than a correction.
   */
  function editField(index: number, field: ReviewableField, value: string) {
    setRows((prev) => {
      if (!prev) return prev;
      return prev.map((r) => {
        if (r.index !== index) return r;
        const unchanged = value === originalValue(r, field);
        return {
          ...r,
          edited: { ...r.edited, [field]: value },
          affirmed: { ...r.affirmed, [field]: unchanged },
          // A row that came back blocked has just been changed; let it be retried
          // rather than leaving it frozen on a stale reason. The duplicate arming
          // goes with it — different values, so the ledger has to be asked again.
          outcome: undefined,
          outcomeReason: undefined,
          proceedDuplicate: false,
        };
      });
    });
  }

  /**
   * Approve a set of rows. Untouched documents go through the server-side bulk
   * gate by id; documents the human edited or confirmed go through the review
   * route with their values, which is also what records the corrections. See
   * `planApproval` for why the split exists.
   */
  async function approve(indexes: number[]) {
    if (!rows || indexes.length === 0) return;
    const plan = planApproval(rows, indexes);

    setBusy(new Set([...plan.queued, ...plan.direct].map((p) => p.index)));
    setError(null);
    setSkipped(
      plan.skipped.map((s) => ({
        filename: rows.find((r) => r.index === s.index)?.filename ?? `file ${s.index + 1}`,
        reason: s.reason,
      })),
    );

    try {
      if (plan.queued.length > 0) {
        const res = await fetch("/api/approve/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentIds: plan.queued.map((q) => q.documentId) }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Approve failed.");
        } else {
          const byId = new Map<string, BulkItemResult>(
            (data.results as BulkItemResult[]).map((r) => [r.documentId, r]),
          );
          for (const q of plan.queued) {
            const result = byId.get(q.documentId);
            if (!result) continue;
            applyOutcome(q.index, result.status, outcomeText(result));
          }
        }
      }

      // One request per edited document — the review route approves one document
      // and one set of human values, which is exactly what each of these is.
      for (const d of plan.direct) {
        const row = rows.find((r) => r.index === d.index);
        try {
          const res = await fetch("/api/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              extraction: d.extraction,
              edited: d.edited,
              documentType: d.documentType,
              documentId: d.documentId ?? undefined,
              // Armed by an earlier attempt that came back as a duplicate: the
              // human clicked Approve again after being told, which is the answer.
              proceedDuplicate: row?.proceedDuplicate === true,
            }),
          });
          const data = await res.json();

          if (!res.ok) {
            applyOutcome(d.index, "error", data.error ?? "Approve failed.");
            continue;
          }
          if (data.status === "duplicate") {
            applyOutcome(
              d.index,
              "blocked",
              `Possible duplicate of a ${data.duplicate.documentType ?? "document"} already ` +
                `processed on ${new Date(data.duplicate.processedOn).toLocaleDateString("en-GB")}. ` +
                `Click Approve again to post it anyway.`,
              { arm: true },
            );
            continue;
          }
          applyOutcome(d.index, "approved", approvedText(data));
        } catch (e) {
          applyOutcome(d.index, "error", e instanceof Error ? e.message : "Approve failed.");
        }
      }
    } finally {
      setBusy(new Set());
      // Approved documents have left the queue.
      setSelected((prev) => new Set([...prev].filter((i) => !indexes.includes(i))));
      onDone();
    }
  }

  function applyOutcome(
    index: number,
    outcome: ResultRow["outcome"],
    reason: string,
    opts: { arm?: boolean } = {},
  ) {
    setRows((prev) =>
      prev
        ? prev.map((r) =>
            r.index === index
              ? {
                  ...r,
                  outcome,
                  outcomeReason: reason,
                  proceedDuplicate: opts.arm === true,
                }
              : r,
          )
        : prev,
    );
  }

  function selectRow(index: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  /** Leave the results screen. Anything unapproved is still queued on /pending. */
  function leave() {
    const unsaved = rows?.some((r) => isActionable(r) && hasHumanInput(r)) ?? false;
    if (unsaved && !confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    onCancel();
  }

  // --- Before upload: confirm the selection. -------------------------------
  if (rows === null) {
    return (
      <section style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#1a2b4a", marginBottom: 4 }}>
          Ready to upload {files.length} file{files.length === 1 ? "" : "s"}
        </div>
        <ul style={fileList}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} style={fileListItem}>
              {f.name}
              <span style={{ color: "#8892a0" }}> · {(f.size / 1024).toFixed(0)} KB</span>
            </li>
          ))}
        </ul>
        {error && <p style={errorNote}>{error}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button style={primaryBtn} onClick={upload}>
            Upload {files.length} file{files.length === 1 ? "" : "s"}
          </button>
          <button style={secondaryBtn} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    );
  }

  const pct = rows.length > 0 ? Math.round((completed / rows.length) * 100) : 0;
  const counts = tally(rows);
  // Only rows a batch approve could actually do something with.
  const selectable = rows.filter((r) => isActionable(r));
  const selectedApprovable = [...selected].filter((i) => {
    const row = rows.find((r) => r.index === i);
    return row !== undefined && rowStatus(row) !== "flagged" && isActionable(row);
  });
  const working = busy.size > 0;

  return (
    <section style={card}>
      {/* --- Progress, until the batch is in ------------------------------- */}
      {!summary ? (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a2b4a", marginBottom: 8 }}>
            Processing {rows.length} file{rows.length === 1 ? "" : "s"}… ({completed} of{" "}
            {rows.length} complete)
          </div>
          <div style={progressTrack}>
            <div style={{ ...progressFill, width: `${pct}%` }} />
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a2b4a", marginBottom: 4 }}>
            {summary.total} file{summary.total === 1 ? "" : "s"}: {tallyLabel(counts)}
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#8892a0" }}>
            Read in {(summary.elapsedMs / 1000).toFixed(1)}s.
            {counts.flagged > 0 && (
              <>
                {" "}
                Click an amber field to fix it, then the checkmark to confirm — the document turns
                green and can be approved here.
              </>
            )}
          </p>
        </>
      )}

      {error && <p style={errorNote}>{error}</p>}

      {skipped.length > 0 && (
        <div style={skippedNote}>
          <strong>Not approved:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {skipped.map((s, i) => (
              <li key={i}>
                {s.filename} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- One row per file, updating as each lands --------------------- */}
      <div style={{ marginTop: 12 }}>
        {rows.map((r) => (
          <BatchResultRow
            key={`${r.filename}-${r.index}`}
            row={r}
            selected={selected.has(r.index)}
            onSelect={selectRow}
            onEdit={editField}
            onApprove={(i) => approve([i])}
            busy={busy.has(r.index)}
          />
        ))}
      </div>

      {/* --- Batch actions ------------------------------------------------ */}
      {summary && (
        <>
          {selectable.length > 0 && (
            <div style={batchBar}>
              <button
                style={linkBtn}
                onClick={() =>
                  setSelected(
                    selected.size === selectable.length
                      ? new Set()
                      : new Set(selectable.map((r) => r.index)),
                  )
                }
              >
                {selected.size === selectable.length ? "Clear selection" : "Select all"}
              </button>
              <button
                style={
                  selectedApprovable.length === 0 || working
                    ? { ...primaryBtn, opacity: 0.45, cursor: "not-allowed" }
                    : primaryBtn
                }
                onClick={() => approve(selectedApprovable)}
                disabled={selectedApprovable.length === 0 || working}
              >
                {working ? "Approving…" : `✓ Bulk Approve Selected (${selectedApprovable.length})`}
              </button>
            </div>
          )}
          {selected.size > selectedApprovable.length && (
            <p style={mutedNote}>
              {selected.size - selectedApprovable.length} selected document
              {selected.size - selectedApprovable.length === 1 ? "" : "s"} still need
              {selected.size - selectedApprovable.length === 1 ? "s" : ""} an amber field fixed or
              confirmed before it can be approved.
            </p>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            {confirmingLeave ? (
              <div style={confirmBar}>
                <span style={{ flex: 1 }}>
                  You&apos;ve edited fields that haven&apos;t been approved. Leaving discards those
                  edits — the documents stay in the queue as they were read.
                </span>
                <button style={secondaryBtn} onClick={onCancel}>
                  Leave anyway
                </button>
                <button style={linkBtn} onClick={() => setConfirmingLeave(false)}>
                  Stay
                </button>
              </div>
            ) : (
              <>
                <button style={secondaryBtn} onClick={leave} disabled={working}>
                  {counts.flagged + counts.ready + counts.rejected > 0
                    ? "Send to Queue for Later"
                    : "Upload more"}
                </button>
                {counts.flagged + counts.ready + counts.rejected > 0 && (
                  <a href="/pending" style={primaryLink}>
                    Review the queue →
                  </a>
                )}
              </>
            )}
          </div>
          {!confirmingLeave && counts.flagged + counts.ready + counts.rejected > 0 && (
            <p style={mutedNote}>
              Everything read successfully is already in the approval queue, so nothing is lost by
              leaving — only the edits made on this screen.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** What a bulk result says to the human, whichever way it went. */
function outcomeText(result: BulkItemResult): string {
  if (result.status === "approved") {
    return result.billId
      ? `Approved — posted as a draft bill to ${result.billPlatform === "quickbooks" ? "QuickBooks" : "Xero"} (ID ${result.billId}).`
      : "Approved and recorded in the ledger.";
  }
  return result.reason ?? "Couldn't be approved.";
}

/** The same, for the single-document approve route's response shape. */
function approvedText(data: {
  correctionsRecorded?: number;
  billId?: string | null;
  billPlatform?: string | null;
  billError?: string | null;
}): string {
  const base =
    data.correctionsRecorded && data.correctionsRecorded > 0
      ? `Approved — ${data.correctionsRecorded} correction${data.correctionsRecorded === 1 ? "" : "s"} recorded.`
      : "Approved and recorded in the ledger.";
  if (data.billId) {
    return `${base} Posted as a draft bill to ${data.billPlatform === "quickbooks" ? "QuickBooks" : "Xero"} (ID ${data.billId}).`;
  }
  if (data.billError) return `${base} (Couldn't post to the accounting platform: ${data.billError})`;
  return base;
}

// --- styles -----------------------------------------------------------------
const card: React.CSSProperties = {
  marginTop: 24,
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  border: "1px solid #eef1f4",
};
const fileList: React.CSSProperties = {
  margin: "10px 0 0",
  padding: 0,
  listStyle: "none",
  fontSize: 13,
  color: "#445",
};
const fileListItem: React.CSSProperties = {
  padding: "4px 0",
  borderBottom: "1px solid #f4f6f8",
};
const progressTrack: React.CSSProperties = {
  height: 8,
  borderRadius: 999,
  background: "#eef1f4",
  overflow: "hidden",
};
const progressFill: React.CSSProperties = {
  height: "100%",
  background: "#1e8449",
  borderRadius: 999,
  transition: "width 200ms ease",
};
const batchBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  marginTop: 14,
  paddingTop: 14,
  borderTop: "1px solid #eef1f4",
};
const primaryBtn: React.CSSProperties = {
  padding: "11px 22px",
  background: "#1e8449",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
const primaryLink: React.CSSProperties = {
  display: "inline-block",
  padding: "11px 22px",
  background: "#1a2b4a",
  color: "#fff",
  borderRadius: 10,
  fontWeight: 600,
  fontSize: 15,
  textDecoration: "none",
};
const secondaryBtn: React.CSSProperties = {
  padding: "11px 22px",
  background: "#fff",
  color: "#1a2b4a",
  border: "1px solid #d5dbdb",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 15,
};
const linkBtn: React.CSSProperties = {
  padding: "6px 14px",
  background: "#fff",
  color: "#1a2b4a",
  border: "1px solid #d5dbdb",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};
const errorNote: React.CSSProperties = {
  margin: "12px 0 0",
  padding: "10px 14px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 14,
};
const skippedNote: React.CSSProperties = {
  margin: "12px 0 0",
  padding: "10px 14px",
  background: "#fef9e7",
  border: "1px solid #f7dc6f",
  borderRadius: 8,
  color: "#7d6608",
  fontSize: 13,
};
const confirmBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  padding: "12px 14px",
  background: "#fff8ec",
  border: "1px solid #f0c986",
  borderRadius: 10,
  color: "#7d4a00",
  fontSize: 13,
  fontWeight: 600,
};
const mutedNote: React.CSSProperties = {
  margin: "10px 0 0",
  fontSize: 13,
  color: "#8892a0",
};
