"use client";

import { useCallback, useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import ReviewBoard, { type ReviewSectionConfig } from "@/components/review/ReviewBoard";
import { buildQueueRow, detectQueueDuplicates, type QueueItem } from "@/lib/extraction-insights";
import { CRITICAL_FIELDS_BY_TYPE, IMPORTANT_FIELDS, checkTotals, fieldLabels } from "@/lib/validation";
import type { InvoiceExtraction, ReviewableField } from "@/lib/schema";
import { pageSubtitle, pageTitle, shellButton, shellColor, shellFigures } from "@/lib/shell-theme";

const SECTIONS: ReviewSectionConfig[] = [
  {
    key: "ready",
    title: "Ready to Approve",
    accentColor: shellColor.high,
    description: "Every critical field cleared 80%+ confidence and the numbers add up. Safe to approve as a batch.",
    showBulkApproveAll: true,
  },
  {
    key: "review",
    title: "Needs Review",
    accentColor: shellColor.medium,
    description: "Tax or currency needs a quick confirmation — the essentials are solid.",
  },
  {
    key: "duplicate",
    title: "Possible Duplicates",
    accentColor: shellColor.dupe,
    description: "Looks like the same document was captured more than once.",
  },
  {
    key: "issue",
    title: "Potential Issues",
    accentColor: shellColor.low,
    description: "A critical field is uncertain, or the numbers don't add up — can't post until it's fixed.",
  },
];

type PendingListItem = {
  id: string;
  documentType: "invoice" | "receipt";
  merchantName: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  total: number;
  overallConfidence: number;
};

/**
 * Review & Edit — grouped-sections + side-panel design
 * (design_handoff_zaki_ledger/Invoice Review Mockup.html) built on
 * ReviewBoard. Sections are driven by lib/validation.ts's real approval
 * gate; the panel fetches full per-field confidence on open and edits post
 * through the existing POST /api/approve, unchanged.
 */
export default function ReviewPage() {
  const showToast = useShellToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Record<string, InvoiceExtraction>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/pending");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't load the queue.");
        return;
      }
      setItems(
        (data.documents as PendingListItem[]).map(
          (d): QueueItem => ({
            id: d.id,
            documentType: d.documentType,
            merchantName: d.merchantName,
            invoiceNumber: d.invoiceNumber,
            invoiceDate: d.invoiceDate,
            currency: d.currency,
            total: d.total,
            overallConfidence: d.overallConfidence,
          }),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ensureDetail = useCallback(
    async (id: string): Promise<InvoiceExtraction | null> => {
      const res = await fetch(`/api/pending/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      setDetail((prev) => ({ ...prev, [id]: data.extraction }));
      return data.extraction as InvoiceExtraction;
    },
    [],
  );

  async function approve(ids: string[]) {
    let approvedCount = 0;
    for (const id of ids) {
      const item = items.find((i) => i.id === id);
      const extraction = detail[id] ?? (await ensureDetail(id));
      if (!extraction || !item) continue;
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraction, edited: {}, documentType: item.documentType, documentId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === "approved") {
        setApprovedIds((prev) => new Set([...prev, id]));
        approvedCount += 1;
      } else if (data.status === "duplicate") {
        setError(`${item.merchantName || "This document"} looks like a duplicate — resolve it before approving.`);
      } else {
        setError(data.error ?? "Couldn't approve — needs a closer look.");
      }
    }
    if (approvedCount > 0) {
      showToast(`${approvedCount} ${approvedCount === 1 ? "document" : "documents"} approved`);
    }
    await load();
  }

  function flag(id: string) {
    const item = items.find((i) => i.id === id);
    showToast(`${item?.merchantName || "Document"} flagged for a second look`);
  }

  async function editField(id: string, field: ReviewableField, newValue: string) {
    const item = items.find((i) => i.id === id);
    const extraction = detail[id] ?? (await ensureDetail(id));
    if (!extraction || !item) return;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction, edited: { [field]: newValue }, documentType: item.documentType, documentId: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "approved") {
      showToast(`${fieldLabels(item.documentType)[field]} corrected — saved for next time`);
      setApprovedIds((prev) => new Set([...prev, id]));
      await load();
    } else {
      // Not ready to fully approve yet (other fields still gating) — update
      // the local copy so the panel's gate recomputes with the corrected value.
      setDetail((prev) => ({
        ...prev,
        [id]: { ...extraction, [field]: { value: newValue, confidence: 1 } } as InvoiceExtraction,
      }));
    }
  }

  if (loading) {
    return (
      <div>
        <h1 style={pageTitle}>Review &amp; Edit</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }

  const openItems = items.filter((i) => !approvedIds.has(i.id));
  const dupes = detectQueueDuplicates(openItems);
  const built = openItems.map((item) => ({ item, ...buildQueueRow(item, dupes.has(item.id)) }));

  return (
    <div>
      <h1 style={pageTitle}>Review &amp; Edit</h1>
      <p style={pageSubtitle}>
        {openItems.length} document{openItems.length === 1 ? "" : "s"} need your attention before posting
      </p>
      {error && <p style={{ color: shellColor.low, marginBottom: 16 }}>{error}</p>}

      {built.length > 0 && (
        <ReviewBoard
          rows={built.map((b) => b.row)}
          sections={SECTIONS}
          approvedIds={new Set()}
          onApprove={approve}
          onFlag={flag}
          heroTitle="Ready to approve"
          heroDescription="Every critical field cleared 80%+ confidence and the numbers add up."
          renderPanel={(row) => {
            const entry = built.find((b) => b.row.id === row.id);
            if (!entry) return null;
            return (
              <ExtractionPanelBody
                item={entry.item}
                extraction={detail[entry.item.id] ?? null}
                onOpen={() => ensureDetail(entry.item.id)}
                onEditField={(field, val) => editField(entry.item.id, field, val)}
                onApprove={() => approve([entry.item.id])}
                onFlag={() => flag(entry.item.id)}
              />
            );
          }}
        />
      )}

      {built.length === 0 && (
        <div style={{ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>
          Nothing waiting for review — nice work.
        </div>
      )}
    </div>
  );
}

function ExtractionPanelBody({
  item,
  extraction,
  onOpen,
  onEditField,
  onApprove,
  onFlag,
}: {
  item: QueueItem;
  extraction: InvoiceExtraction | null;
  onOpen: () => void;
  onEditField: (field: ReviewableField, value: string) => void;
  onApprove: () => void;
  onFlag: () => void;
}) {
  useEffect(() => {
    onOpen();
    // Fetch full field-level detail exactly once, the moment this row's
    // panel mounts — re-running on every render would re-fetch on every
    // keystroke-driven re-render from editField's local state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  if (!extraction) {
    return <div style={{ fontSize: 13.5, color: shellColor.inkSoft }}>Loading document details…</div>;
  }

  const totals = checkTotals(extraction.subtotal.value, extraction.tax.value, extraction.total.value);
  const labels = fieldLabels(item.documentType);
  const critical = CRITICAL_FIELDS_BY_TYPE[item.documentType];
  const fieldOrder: ReviewableField[] = ["supplierName", "invoiceNumber", "invoiceDate", "currency", "subtotal", "tax", "total"];

  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Extraction check
        </div>
        {totals === null ? (
          <div style={{ fontSize: 13.5, color: shellColor.inkSoft }}>No tax breakdown on this document — nothing to cross-check.</div>
        ) : (
          <div
            style={{
              fontSize: 13.5,
              color: totals.ok ? shellColor.high : shellColor.low,
              background: totals.ok ? shellColor.highBg : shellColor.lowBg,
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            {totals.ok
              ? "✓ Numbers add up."
              : `✕ Subtotal + tax (£${totals.expected.toFixed(2)}) doesn't match the printed total (£${totals.found.toFixed(2)}).`}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Field confidence
        </div>
        {fieldOrder
          .filter((f) => !(f === "invoiceNumber" && item.documentType === "receipt"))
          .map((field) => {
            const f = extraction[field] as { value: string | number; confidence: number };
            const pct = Math.round(f.confidence * 100);
            const isCritical = critical.includes(field);
            const isImportant = IMPORTANT_FIELDS.includes(field);
            return (
              <div key={field} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                  <span>
                    {labels[field]} {isCritical ? "(Critical)" : isImportant ? "(Important)" : ""}
                  </span>
                  <span style={shellFigures}>{pct}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden", marginBottom: 6 }}>
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 3,
                      width: `${pct}%`,
                      background: pct >= 80 ? shellColor.high : pct >= 60 ? shellColor.medium : shellColor.low,
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    defaultValue={String(f.value)}
                    onBlur={(e) => {
                      if (e.target.value !== String(f.value)) onEditField(field, e.target.value);
                    }}
                    style={{ flex: 1, padding: "6px 9px", borderRadius: 7, border: `1px solid ${shellColor.cardBorder}`, fontSize: 12.5 }}
                  />
                  <button style={shellButton("outline", "sm")} onClick={() => onEditField(field, String(f.value))}>
                    ✓ Confirm
                  </button>
                </div>
              </div>
            );
          })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 28 }}>
        <button style={{ ...shellButton("dangerOutline", "lg"), flex: 1 }} onClick={onFlag}>
          Flag
        </button>
        <button style={{ ...shellButton("success", "lg"), flex: 1 }} onClick={onApprove}>
          Approve
        </button>
      </div>
    </>
  );
}
