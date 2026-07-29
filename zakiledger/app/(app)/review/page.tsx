"use client";

import { useCallback, useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { formatMoney } from "@/lib/currency";
import {
  disabledOverride,
  pageSubtitle,
  pageTitle,
  pill,
  shellButton,
  shellCard,
  shellColor,
  shellFigures,
  tierFor,
} from "@/lib/shell-theme";

type PendingItem = {
  id: string;
  documentType: "invoice" | "receipt";
  merchantName: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  total: number;
  overallConfidence: number;
  lastOutcome: "approved" | "blocked" | "error" | null;
  lastReason: string | null;
};

/**
 * Review & Edit — the mockup's simplified model exactly: one confidence
 * score per document, only the merchant name is editable inline. Under the
 * hood this still calls the real approve/delete endpoints (so posting to
 * Xero/QuickBooks and correction-tracking keep working), it's just that the
 * rich per-field review UI (lib/schema.ts's REVIEWABLE_FIELDS, duplicate
 * detection, type confirmation) isn't surfaced here anymore — see the plan's
 * decision to match the mockup's UX over the current richer flow.
 */
export default function ReviewPage() {
  const showToast = useShellToast();
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/pending");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load the queue.");
        return;
      }
      setItems(data.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setBusy(id: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function approve(id: string) {
    setBusy(id, true);
    try {
      const res = await fetch("/api/approve/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [id] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Approve failed.");
        return;
      }
      const result = data.results?.[0];
      if (result?.status === "approved") {
        showToast("Approved");
        await load();
      } else {
        setError(result?.reason ?? "Couldn't approve — needs a closer look.");
        await load();
      }
    } finally {
      setBusy(id, false);
    }
  }

  function startEdit(item: PendingItem) {
    setEditingId(item.id);
    setEditingValue(item.merchantName);
  }

  async function saveEdit(id: string) {
    setBusy(id, true);
    try {
      const detailRes = await fetch(`/api/pending/${id}`);
      const detail = await detailRes.json();
      if (!detailRes.ok) {
        setError(detail.error ?? "Couldn't load the document.");
        return;
      }
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extraction: detail.extraction,
          edited: { supplierName: editingValue },
          documentType: detail.extraction.documentType?.value,
          documentId: id,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== "approved") {
        setError(data.error ?? "Couldn't save — needs a closer look.");
        return;
      }
      showToast("Approved");
      setEditingId(null);
      await load();
    } finally {
      setBusy(id, false);
    }
  }

  async function reject(id: string) {
    if (confirmRejectId !== id) {
      setConfirmRejectId(id);
      return;
    }
    setConfirmRejectId(null);
    setBusy(id, true);
    try {
      const res = await fetch(`/api/pending/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't reject the document.");
        return;
      }
      showToast("Rejected");
      await load();
    } finally {
      setBusy(id, false);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 style={pageTitle}>Review & Edit</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={pageTitle}>Review & Edit</h1>
      <p style={pageSubtitle}>{items.length} item{items.length === 1 ? "" : "s"} need your attention before posting</p>
      {error && <p style={{ ...shellCard({ padding: "12px 16px", marginBottom: 20 }), color: shellColor.low }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {items.map((item) => {
          const confidence = Math.round(item.overallConfidence * 100);
          const t = tierFor(confidence);
          const editing = editingId === item.id;
          const busy = busyIds.has(item.id);
          const reason = item.lastReason ?? (t.tier !== "high" ? "Confidence below the auto-approve threshold." : null);

          return (
            <div key={item.id} style={shellCard({ padding: "20px 24px" })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  {editing ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <input
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        style={{
                          fontSize: 17,
                          fontWeight: 600,
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: `1px solid ${shellColor.teal}`,
                          outline: "none",
                        }}
                      />
                      <button
                        style={busy ? { ...shellButton("primary", "sm"), ...disabledOverride() } : shellButton("primary", "sm")}
                        disabled={busy}
                        onClick={() => saveEdit(item.id)}
                      >
                        Save
                      </button>
                      <button style={shellButton("outline", "sm")} onClick={() => setEditingId(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 17, fontWeight: 600 }}>{item.merchantName || "(no merchant)"}</span>
                      <span onClick={() => startEdit(item)} style={{ cursor: "pointer", color: shellColor.inkFainter, fontSize: 13 }}>
                        ✎ edit
                      </span>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 20, fontSize: 13.5, color: shellColor.inkSoft, ...shellFigures }}>
                    <span>{item.invoiceNumber || "N/A"}</span>
                    <span>{item.invoiceDate}</span>
                    <span style={{ fontWeight: 600, color: shellColor.ink }}>{formatMoney(item.total, item.currency)}</span>
                    <span style={{ color: shellColor.inkFaint }}>{item.documentType === "receipt" ? "Receipt" : "Invoice"}</span>
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 24 }}>
                  <span style={pill(t.color, t.bg)}>
                    {t.icon} {t.label} <span style={shellFigures}>{confidence}%</span>
                  </span>
                </div>
              </div>

              {reason && (
                <div style={{ marginTop: 12, padding: "10px 14px", background: shellColor.page, borderRadius: 8, fontSize: 13, color: shellColor.inkSoft }}>
                  Why flagged: {reason}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  style={busy ? { ...shellButton("success"), ...disabledOverride() } : shellButton("success")}
                  disabled={busy}
                  onClick={() => approve(item.id)}
                >
                  Approve
                </button>
                <button style={shellButton("outline")} onClick={() => startEdit(item)} disabled={busy}>
                  Edit
                </button>
                <button
                  style={busy ? { ...shellButton("dangerOutline"), ...disabledOverride() } : shellButton("dangerOutline")}
                  disabled={busy}
                  onClick={() => reject(item.id)}
                >
                  {confirmRejectId === item.id ? "Click again to confirm" : "Reject"}
                </button>
              </div>
            </div>
          );
        })}

        {items.length === 0 && (
          <div style={shellCard({ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 })}>
            Nothing waiting for review — nice work.
          </div>
        )}
      </div>
    </div>
  );
}
