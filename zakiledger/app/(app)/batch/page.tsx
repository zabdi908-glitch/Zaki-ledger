"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { formatMoney } from "@/lib/currency";
import {
  disabledOverride,
  microLabel,
  pageSubtitle,
  pageTitle,
  pill,
  progressFill,
  progressTrack,
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
};

type FilterTier = "all" | "medium" | "low";

/** Batch Review (extraction) — table version of /review, same real data source. */
export default function BatchReviewPage() {
  const showToast = useShellToast();
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialCount, setInitialCount] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterTier>("all");
  const [sortDesc, setSortDesc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

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
      setInitialCount((prev) => prev ?? data.documents.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    let list = items.map((it) => ({ item: it, tier: tierFor(Math.round(it.overallConfidence * 100)) }));
    if (filter !== "all") list = list.filter((r) => r.tier.tier === filter);
    list = list.slice().sort((a, b) => (sortDesc ? b.item.overallConfidence - a.item.overallConfidence : a.item.overallConfidence - b.item.overallConfidence));
    return list;
  }, [items, filter, sortDesc]);

  async function bulkApprove() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/approve/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Approve failed.");
        return;
      }
      const n = selected.size;
      showToast(`${n} ${n === 1 ? "item" : "items"} approved`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function bulkReject() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await Promise.all([...selected].map((id) => fetch(`/api/pending/${id}`, { method: "DELETE" })));
      const n = selected.size;
      showToast(`${n} ${n === 1 ? "item" : "items"} rejected`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 style={pageTitle}>Batch Review</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }

  const reviewed = (initialCount ?? items.length) - items.length;
  const reviewedPct = initialCount ? Math.round((reviewed / initialCount) * 100) : 0;
  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div>
      <h1 style={pageTitle}>Batch Review</h1>
      <p style={{ fontSize: 15, color: shellColor.inkSoft, margin: "0 0 24px" }}>
        {reviewed} of {initialCount ?? items.length} flagged items reviewed
      </p>
      <div style={{ ...progressTrack(), marginBottom: 24 }}>
        <div style={progressFill(reviewedPct)} />
      </div>
      {error && <p style={{ ...shellCard({ padding: "12px 16px", marginBottom: 16 }), color: shellColor.low }}>{error}</p>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterTier)}
            style={{ padding: "8px 12px", borderRadius: 7, border: `1px solid ${shellColor.cardBorder}`, fontSize: 13.5, background: shellColor.paper }}
          >
            <option value="all">All confidence</option>
            <option value="medium">Medium (70–95%)</option>
            <option value="low">Low (&lt;70%)</option>
          </select>
          <button style={shellButton("outline")} onClick={() => setSortDesc((d) => !d)}>
            Sort: {sortDesc ? "Lowest confidence first" : "Highest confidence first"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={selected.size === 0 || busy ? { ...shellButton("success"), ...disabledOverride() } : shellButton("success")}
            disabled={selected.size === 0 || busy}
            onClick={bulkApprove}
          >
            Approve selected ({selected.size})
          </button>
          <button
            style={selected.size === 0 || busy ? { ...shellButton("dangerOutline"), ...disabledOverride() } : shellButton("dangerOutline")}
            disabled={selected.size === 0 || busy}
            onClick={bulkReject}
          >
            Reject selected
          </button>
        </div>
      </div>

      <div style={shellCard({ overflow: "hidden" })}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1.4fr 1fr 1fr 1fr 1.3fr 1.6fr",
            gap: 12,
            padding: "12px 20px",
            background: shellColor.page,
            borderBottom: `1px solid ${shellColor.cardBorder}`,
            ...microLabel,
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.item.id)))}
          />
          <div>Merchant</div>
          <div>Invoice #</div>
          <div>Date</div>
          <div>Amount</div>
          <div>Confidence</div>
          <div>Actions</div>
        </div>
        {rows.map(({ item, tier }) => (
          <div
            key={item.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1.4fr 1fr 1fr 1fr 1.3fr 1.6fr",
              gap: 12,
              padding: "14px 20px",
              borderBottom: `1px solid ${shellColor.trackBg}`,
              alignItems: "center",
              fontSize: 13.5,
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={(e) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                })
              }
            />
            <div style={{ fontWeight: 600 }}>{item.merchantName || "(no merchant)"}</div>
            <div style={{ ...shellFigures, color: shellColor.inkSoft }}>{item.invoiceNumber || "N/A"}</div>
            <div style={{ ...shellFigures, color: shellColor.inkSoft }}>{item.invoiceDate}</div>
            <div style={{ ...shellFigures, fontWeight: 600 }}>{formatMoney(item.total, item.currency)}</div>
            <div>
              <span style={pill(tier.color, tier.bg, "sm")}>
                {tier.icon} {Math.round(item.overallConfidence * 100)}%
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={shellButton("success", "sm")}
                onClick={async () => {
                  const res = await fetch("/api/approve/bulk", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ documentIds: [item.id] }),
                  });
                  if (res.ok) {
                    showToast("Approved");
                    await load();
                  }
                }}
              >
                Approve
              </button>
              <button
                style={shellButton("dangerOutline", "sm")}
                onClick={async () => {
                  await fetch(`/api/pending/${item.id}`, { method: "DELETE" });
                  showToast("Rejected");
                  await load();
                }}
              >
                Reject
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>
            All flagged items reviewed — nice work.
          </div>
        )}
      </div>
    </div>
  );
}
