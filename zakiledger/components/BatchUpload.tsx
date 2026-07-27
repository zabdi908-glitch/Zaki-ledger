"use client";

import { useState } from "react";

/**
 * Multi-file upload: confirm the selection, read them in parallel, watch each one
 * land, then see what happened per file.
 *
 * The progress here is reported, not animated. /api/extract-batch streams a line
 * per document as it finishes, so "3 of 5 complete" is a count of documents that
 * are genuinely done. Nothing on this screen moves because a timer said so.
 */

type FileState = "waiting" | "extracting" | "success" | "flagged" | "error";

interface RowState {
  filename: string;
  state: FileState;
  /** Why it's flagged or why it failed. */
  detail?: string;
  documentId?: string | null;
  confidence?: number;
  queueError?: string | null;
}

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
  /** Back out before uploading. */
  onCancel: () => void;
  /** Fired once the batch finishes, so the parent can refresh the queue count. */
  onDone: () => void;
}) {
  const [rows, setRows] = useState<RowState[] | null>(null); // null = not started
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const completed = rows ? rows.filter((r) => r.state !== "waiting" && r.state !== "extracting").length : 0;

  async function upload() {
    setRunning(true);
    setError(null);
    setSummary(null);
    // Everything is in flight the moment the request opens — the server reads up
    // to EXTRACT_CONCURRENCY at once and the client can't tell which, so showing
    // them all as "extracting" is the honest state rather than inventing an order.
    setRows(files.map((f) => ({ filename: f.name, state: "extracting" })));

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
                filename: msg.filename,
                state:
                  msg.status === "error" ? "error" : msg.gate === "ready" ? "success" : "flagged",
                detail: msg.status === "error" ? msg.reason : msg.warning,
                documentId: msg.documentId,
                confidence: msg.confidence,
                queueError: msg.queueError,
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

  return (
    <section style={card}>
      {/* --- Progress ------------------------------------------------------- */}
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
            {summary.total} file{summary.total === 1 ? "" : "s"} uploaded: {summary.succeeded}{" "}
            succeeded, {summary.failed} failed
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#8892a0" }}>
            Read in {(summary.elapsedMs / 1000).toFixed(1)}s.
          </p>
        </>
      )}

      {error && <p style={errorNote}>{error}</p>}

      {/* --- Per-file rows, updating as each lands -------------------------- */}
      <div style={{ marginTop: 12 }}>
        {rows.map((r, i) => (
          <div key={`${r.filename}-${i}`} style={rowStyle(r.state)}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{icon(r.state)} {r.filename}</strong>
              <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>
                {label(r)}
              </span>
              {r.queueError && (
                <span style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                  Couldn&apos;t be added to the queue: {r.queueError}
                </span>
              )}
            </span>
            {r.confidence !== undefined && (
              <span style={{ fontWeight: 700, whiteSpace: "nowrap", fontSize: 13 }}>
                {(r.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
        ))}
      </div>

      {summary && (
        <>
          <p style={{ margin: "14px 0 0", fontSize: 14, color: "#1e6b45", fontWeight: 600 }}>
            {summary.queued > 0
              ? `All ${summary.queued} successful extraction${summary.queued === 1 ? "" : "s"} added to the pending queue.`
              : "Nothing was added to the pending queue."}
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            {summary.queued > 0 && (
              <a href="/pending" style={primaryLink}>
                Review the queue →
              </a>
            )}
            <button style={secondaryBtn} onClick={onCancel} disabled={running}>
              Upload more
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function icon(state: FileState): string {
  switch (state) {
    case "success":
      return "✅";
    case "flagged":
      return "⚠️";
    case "error":
      return "❌";
    default:
      return "⏳";
  }
}

function label(r: RowState): string {
  switch (r.state) {
    case "success":
      return "extracted successfully";
    case "flagged":
      return r.detail ?? "extracted — needs a look before approval";
    case "error":
      return r.detail ?? "couldn't extract this document";
    default:
      return "extracting…";
  }
}

// --- styles -----------------------------------------------------------------
function rowStyle(state: FileState): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 14px",
    marginBottom: 8,
    borderRadius: 8,
    fontSize: 14,
    border: "1px solid #e6eaee",
    background: "#fff",
    color: "#445",
  };
  if (state === "success") {
    return { ...base, background: "#e8f8f0", border: "1px solid #a9dfbf", color: "#1e6b45" };
  }
  if (state === "flagged") {
    return { ...base, background: "#fef9e7", border: "1px solid #f7dc6f", color: "#7d6608" };
  }
  if (state === "error") {
    return { ...base, background: "#fdecea", border: "1px solid #e6b0aa", color: "#c0392b" };
  }
  return base;
}

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
const errorNote: React.CSSProperties = {
  margin: "12px 0 0",
  padding: "10px 14px",
  background: "#fdecea",
  border: "1px solid #e6b0aa",
  borderRadius: 8,
  color: "#c0392b",
  fontSize: 14,
};
