"use client";

import { useState } from "react";
import { useShellToast } from "./AppShell";
import {
  effectiveConfidences,
  flagReason,
  isActionable,
  pendingRow,
  planApproval,
  rowDocumentType,
  rowGate,
  rowStatus,
  tally,
  tallyLabel,
  type ResultRow,
  type RowStatus,
} from "@/lib/batch-results";
import { CRITICAL_FIELDS_BY_TYPE, IMPORTANT_FIELDS, fieldLabels } from "@/lib/validation";
import type { DocumentType, ReviewableField } from "@/lib/schema";
import { formatMoney } from "@/lib/currency";
import {
  disabledOverride,
  pill,
  progressFill,
  progressTrack,
  shellButton,
  shellCard,
  shellColor,
  shellFigures,
  tierFor,
} from "@/lib/shell-theme";

/**
 * The post-upload results screen: stream the extraction, then let the human
 * fix and approve documents right here — no round trip through /pending for
 * anything they've actually looked at.
 *
 * All of the "is this ready, which endpoint may approve it" logic lives in
 * lib/batch-results.ts and is tested there. This component only builds rows
 * from the NDJSON stream, renders what those functions say, and calls the
 * two approval endpoints exactly as `planApproval` routes them.
 */

type Stage = "idle" | "processing" | "done";

const FIELD_ORDER: ReviewableField[] = [
  "supplierName",
  "invoiceNumber",
  "invoiceDate",
  "currency",
  "subtotal",
  "tax",
  "total",
];

const STATUS_LABEL: Record<RowStatus, string> = {
  extracting: "Reading…",
  ready: "Ready",
  flagged: "Needs a look",
  failed: "Failed",
  approved: "Approved",
  rejected: "Couldn't approve",
};

function statusPill(status: RowStatus) {
  switch (status) {
    case "approved":
      return pill(shellColor.high, shellColor.highBg, "sm");
    case "ready":
      return pill(shellColor.high, shellColor.highBg, "sm");
    case "flagged":
      return pill(shellColor.medium, shellColor.mediumBg, "sm");
    case "rejected":
    case "failed":
      return pill(shellColor.low, shellColor.lowBg, "sm");
    default:
      return pill(shellColor.inkFaint, shellColor.trackBg, "sm");
  }
}

export default function BatchUpload() {
  const showToast = useShellToast();
  const [stage, setStage] = useState<Stage>("idle");
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<ResultRow[]>([]);
  /** index → filename of the earlier row it duplicates (same batch, or already-processed history). */
  const [duplicateOf, setDuplicateOf] = useState<Map<number, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setError(null);
    setStage("processing");
    setSelected(new Set());
    setExpanded(new Set());
    setDuplicateOf(new Map());
    setTotal(files.length);
    setRows(files.map((f, i) => pendingRow(f.name || `file-${i + 1}`, i)));

    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/extract-batch", { method: "POST", body: form });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Upload failed.");
        setStage("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "result") {
            setRows((prev) => {
              const next = [...prev];
              next[evt.index] = {
                ...next[evt.index],
                read: evt.status === "error" ? "error" : "success",
                documentId: evt.documentId ?? null,
                confidence: evt.confidence,
                extraction: evt.extraction,
                queueError: evt.queueError ?? null,
                failure: evt.status === "error" ? evt.reason : undefined,
              };
              return next;
            });
            if (evt.duplicate) {
              const processedOn = new Date(evt.duplicate.processedOn).toLocaleDateString("en-GB");
              setDuplicateOf((prev) => new Map(prev).set(evt.index, `a document processed on ${processedOn}`));
            }
          } else if (evt.type === "duplicate") {
            const matchFilename = files[evt.matchIndex]?.name ?? `file ${evt.matchIndex + 1}`;
            setDuplicateOf((prev) => new Map(prev).set(evt.index, matchFilename));
          } else if (evt.type === "fatal") {
            setError(evt.error);
          }
        }
      }
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setStage("idle");
    }
  }

  function toggleExpanded(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleSelected(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function updateRow(index: number, patch: Partial<ResultRow>) {
    setRows((prev) => prev.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  }

  function editField(index: number, field: ReviewableField, value: string) {
    const row = rows.find((r) => r.index === index);
    if (!row) return;
    updateRow(index, { edited: { ...row.edited, [field]: value } });
  }

  function affirmField(index: number, field: ReviewableField) {
    const row = rows.find((r) => r.index === index);
    if (!row) return;
    updateRow(index, { affirmed: { ...row.affirmed, [field]: true } });
  }

  function confirmType(index: number, type?: DocumentType) {
    const row = rows.find((r) => r.index === index);
    if (!row) return;
    updateRow(index, { typeConfirmed: true, typeOverride: type ?? undefined });
  }

  /** Run the approve plan for these indexes, hitting whichever endpoint each row is routed to. */
  async function runApproval(indexes: number[]) {
    if (indexes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const plan = planApproval(rows, indexes);
      const next = new Map<number, Partial<ResultRow>>();

      if (plan.queued.length > 0) {
        const res = await fetch("/api/approve/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentIds: plan.queued.map((q) => q.documentId) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? "Approve failed.");
        } else {
          const byId = new Map((data.results ?? []).map((r: any) => [r.documentId, r]));
          for (const q of plan.queued) {
            const r = byId.get(q.documentId) as any;
            if (!r) continue;
            next.set(q.index, {
              outcome: r.status,
              outcomeReason: r.reason ?? (r.status === "approved" ? "Approved" : undefined),
            });
          }
        }
      }

      for (const d of plan.direct) {
        const sourceRow = rows.find((r) => r.index === d.index);
        const res = await fetch("/api/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            extraction: d.extraction,
            edited: d.edited,
            documentType: d.documentType,
            documentId: d.documentId ?? undefined,
            proceedDuplicate: sourceRow?.proceedDuplicate === true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === "approved") {
          next.set(d.index, { outcome: "approved", outcomeReason: "Approved", proceedDuplicate: false });
        } else if (data.status === "duplicate") {
          const processedOn = data.duplicate?.processedOn
            ? new Date(data.duplicate.processedOn).toLocaleDateString("en-GB")
            : "an earlier upload";
          next.set(d.index, {
            outcome: "blocked",
            outcomeReason: `Possible duplicate of a document processed on ${processedOn} — Approve again to confirm it's not.`,
            proceedDuplicate: true,
          });
        } else {
          next.set(d.index, {
            outcome: "error",
            outcomeReason: data.error ?? "Couldn't approve — needs a closer look.",
            proceedDuplicate: false,
          });
        }
      }

      if (plan.skipped.length > 0) {
        const reasons = [...new Set(plan.skipped.map((s) => s.reason))];
        setError((prev) => prev ?? `${plan.skipped.length} document(s) couldn't be approved: ${reasons.join("; ")}`);
      }

      if (next.size > 0) {
        setRows((prev) => prev.map((r) => (next.has(r.index) ? { ...r, ...next.get(r.index) } : r)));
        const approvedCount = [...next.values()].filter((v) => v.outcome === "approved").length;
        if (approvedCount > 0) {
          showToast(`${approvedCount} ${approvedCount === 1 ? "document" : "documents"} approved`);
        }
      }
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }

  async function discard(index: number) {
    const row = rows.find((r) => r.index === index);
    if (!row) return;
    setBusy(true);
    try {
      if (row.documentId) {
        const res = await fetch(`/api/pending/${row.documentId}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(data.error ?? "Couldn't discard — try again.");
          return;
        }
      }
      setRows((prev) => prev.filter((r) => r.index !== index));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
      showToast("Discarded");
    } finally {
      setBusy(false);
    }
  }

  const t = tally(rows);
  const selectableIndexes = rows.filter((r) => isActionable(r) && r.read === "success").map((r) => r.index);
  const allSelected = selectableIndexes.length > 0 && selectableIndexes.every((i) => selected.has(i));

  return (
    <div>
      <h1 style={{ fontSize: 32, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" }}>Upload &amp; Extract</h1>
      <p style={{ fontSize: 15, color: shellColor.inkSoft, margin: "0 0 32px" }}>
        Drop invoices or receipts to extract data automatically
      </p>

      {stage === "idle" && (
        <div>
          <label
            style={{
              display: "block",
              border: `2px dashed ${shellColor.cardBorder}`,
              borderRadius: 14,
              padding: "64px 24px",
              textAlign: "center",
              cursor: "pointer",
              background: shellColor.paper,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Drag &amp; drop files here</div>
            <div style={{ fontSize: 14, color: shellColor.inkSoft, marginBottom: 20 }}>
              or click to browse — PDF or images, up to 25MB each
            </div>
            <span style={shellButton("primary", "lg")}>Choose files</span>
            <input type="file" accept="application/pdf,image/*" multiple onChange={onPick} hidden />
          </label>
          {error && <p style={{ ...shellCard({ padding: "12px 16px", marginTop: 16 }), color: shellColor.low }}>{error}</p>}
        </div>
      )}

      {stage === "processing" && (
        <div style={shellCard({ padding: 48, textAlign: "center" })}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
            Extracting data from {total} file{total === 1 ? "" : "s"}…
          </div>
          <div style={{ ...progressTrack(), maxWidth: 420, margin: "0 auto" }}>
            <div style={progressFill(Math.round((rows.filter((r) => r.read !== "extracting").length / Math.max(total, 1)) * 100))} />
          </div>
        </div>
      )}

      {stage === "done" && (
        <div>
          {error && <p style={{ ...shellCard({ padding: "12px 16px", marginBottom: 16 }), color: shellColor.low }}>{error}</p>}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 14, color: shellColor.inkSoft }}>{tallyLabel(t)}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={selected.size === 0 || busy ? { ...shellButton("success"), ...disabledOverride() } : shellButton("success")}
                disabled={selected.size === 0 || busy}
                onClick={() => runApproval([...selected])}
              >
                Approve selected ({selected.size})
              </button>
              <button
                style={shellButton("outline")}
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(selectableIndexes))
                }
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((row) => (
              <ResultRowCard
                key={row.index}
                row={row}
                duplicateOf={duplicateOf.get(row.index) ?? null}
                selected={selected.has(row.index)}
                expanded={expanded.has(row.index)}
                busy={busy}
                onToggleSelected={() => toggleSelected(row.index)}
                onToggleExpanded={() => toggleExpanded(row.index)}
                onEditField={(field, value) => editField(row.index, field, value)}
                onAffirmField={(field) => affirmField(row.index, field)}
                onConfirmType={(type) => confirmType(row.index, type)}
                onApprove={() => runApproval([row.index])}
                onDiscard={() => discard(row.index)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRowCard({
  row,
  duplicateOf,
  selected,
  expanded,
  busy,
  onToggleSelected,
  onToggleExpanded,
  onEditField,
  onAffirmField,
  onConfirmType,
  onApprove,
  onDiscard,
}: {
  row: ResultRow;
  /** Filename or description of what this row duplicates, when it does. */
  duplicateOf: string | null;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onEditField: (field: ReviewableField, value: string) => void;
  onAffirmField: (field: ReviewableField) => void;
  onConfirmType: (type?: DocumentType) => void;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  const status = rowStatus(row);
  const gate = rowGate(row);
  const pct = Math.round((row.confidence ?? 0) * 100);
  const documentType = rowDocumentType(row);
  const labels = fieldLabels(documentType);
  const critical = CRITICAL_FIELDS_BY_TYPE[documentType];
  const actionable = isActionable(row);

  return (
    <div style={shellCard({ padding: "16px 20px" })}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {actionable ? (
          <input type="checkbox" checked={selected} onChange={onToggleSelected} />
        ) : (
          <div style={{ width: 13 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.extraction?.supplierName.value || row.filename}
          </div>
          <div style={{ fontSize: 12.5, color: shellColor.inkFaint }}>{row.filename}</div>
        </div>
        {row.extraction && (
          <div style={{ ...shellFigures, fontSize: 13.5, fontWeight: 600 }}>
            {formatMoney(row.extraction.total.value, row.extraction.currency.value)}
          </div>
        )}
        {row.read === "success" && (
          <span style={pill(tierFor(pct).color, tierFor(pct).bg, "sm")}>
            {tierFor(pct).icon} {pct}%
          </span>
        )}
        <span style={statusPill(status)}>{STATUS_LABEL[status]}</span>
        {row.read === "success" && (
          <button style={shellButton("outline", "sm")} onClick={onToggleExpanded}>
            {expanded ? "Hide" : "Details"}
          </button>
        )}
      </div>

      {status === "failed" && (
        <div style={{ marginTop: 10, fontSize: 13, color: shellColor.low }}>{row.failure}</div>
      )}

      {duplicateOf && (
        <div style={{ marginTop: 10 }}>
          <span style={pill(shellColor.dupe, shellColor.dupeBg, "sm")}>⧉ Possible duplicate of {duplicateOf}</span>
        </div>
      )}

      {row.queueError && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: shellColor.medium }}>
          Couldn't add this to the bulk queue ({row.queueError}) — approve it here instead.
        </div>
      )}

      {(status === "flagged" || status === "rejected") && row.outcomeReason && (
        <div style={{ marginTop: 10, fontSize: 13, color: shellColor.low }}>{row.outcomeReason}</div>
      )}
      {status === "flagged" && !row.outcomeReason && (
        <div style={{ marginTop: 10, fontSize: 13, color: shellColor.medium }}>{flagReason(row)}</div>
      )}

      {gate?.reasons.some((r) => r.field === "documentType") && (
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 13, color: shellColor.inkSoft }}>Which is this?</span>
          <button style={shellButton("outline", "sm")} onClick={() => onConfirmType("invoice")}>
            Invoice
          </button>
          <button style={shellButton("outline", "sm")} onClick={() => onConfirmType("receipt")}>
            Receipt
          </button>
        </div>
      )}

      {expanded && row.extraction && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${shellColor.cardBorder}` }}>
          {FIELD_ORDER.filter((f) => !(f === "invoiceNumber" && documentType === "receipt")).map((field) => {
            const node = row.extraction![field] as { value: string | number; confidence: number };
            const effective = effectiveConfidences(row)[field];
            const fieldPct = Math.round(effective * 100);
            const isCritical = critical.includes(field);
            const isImportant = IMPORTANT_FIELDS.includes(field);
            const current = row.edited[field] ?? String(node.value);
            return (
              <div key={field} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                  <span>
                    {labels[field]} {isCritical ? "(Critical)" : isImportant ? "(Important)" : ""}
                  </span>
                  <span style={shellFigures}>{fieldPct}%</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    defaultValue={current}
                    onBlur={(e) => {
                      if (e.target.value !== String(node.value)) onEditField(field, e.target.value);
                    }}
                    style={{ flex: 1, padding: "6px 9px", borderRadius: 7, border: `1px solid ${shellColor.cardBorder}`, fontSize: 12.5 }}
                  />
                  <button style={shellButton("outline", "sm")} onClick={() => onAffirmField(field)}>
                    ✓ Confirm
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {actionable && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            style={busy ? { ...shellButton("success", "sm"), ...disabledOverride() } : shellButton("success", "sm")}
            disabled={busy}
            onClick={onApprove}
          >
            {row.proceedDuplicate ? "Approve anyway" : "Approve"}
          </button>
          <button
            style={busy ? { ...shellButton("dangerOutline", "sm"), ...disabledOverride() } : shellButton("dangerOutline", "sm")}
            disabled={busy}
            onClick={onDiscard}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
