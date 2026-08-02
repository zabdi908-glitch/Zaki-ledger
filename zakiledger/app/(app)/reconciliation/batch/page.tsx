"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { formatMoney } from "@/lib/currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";
import {
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

type ReviewData = {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  unmatchedBank: string[];
  unmatchedQb: string[];
};

type SortKey = "confidence" | "amountDiff" | "dateGap";
type FilterTier = "all" | "medium" | "low";

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.round(ms / 86_400_000);
}

/** Bank reconciliation, screen 3 of 3 — "Reconciliation Batch Review". */
export default function ReconciliationBatchPage() {
  const queryStatementId = useSearchParams().get("statementId");
  const [statementId, setStatementId] = useState<string | null>(queryStatementId);
  const [resolved, setResolved] = useState(!!queryStatementId);
  const showToast = useShellToast();

  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialCount, setInitialCount] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterTier>("all");
  const [sortBy, setSortBy] = useState<SortKey>("confidence");
  const [sortDesc, setSortDesc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reached from the sidebar (no ?statementId=) — fall back to the user's
  // most recently uploaded statement instead of a dead end.
  useEffect(() => {
    if (queryStatementId) return;
    fetch("/api/reconciliation/latest")
      .then((res) => res.json())
      .then((data) => setStatementId(data.statementId ?? null))
      .catch(() => setStatementId(null))
      .finally(() => setResolved(true));
  }, [queryStatementId]);

  const load = useCallback(async () => {
    if (!statementId) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/transactions`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't load matches.");
        return;
      }
      setReview(data);
      setInitialCount((prev) => prev ?? openMatches(data).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load matches.");
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    if (resolved) load();
  }, [resolved, load]);

  function openMatches(data: ReviewData): ReconciliationMatch[] {
    return data.matches.filter((m) => m.approvedAt === null && m.qbTransactionId !== null);
  }

  const rows = useMemo(() => {
    if (!review) return [];
    let list = openMatches(review).map((m) => {
      const bank = review.bankTransactions.find((b) => b.id === m.bankTransactionId)!;
      const qb = review.qbTransactions.find((q) => q.id === m.qbTransactionId)!;
      const confidence = Math.round((m.confidence ?? 0) * 100);
      const tier = tierFor(confidence);
      return {
        match: m,
        bank,
        qb,
        confidence,
        tier,
        amountDiff: Math.round(Math.abs(bank.amount - qb.amount) * 100) / 100,
        dateGap: daysBetween(bank.transactionDate, qb.postedDate),
      };
    });
    if (filter !== "all") list = list.filter((r) => r.tier.tier === filter);
    const key = sortBy === "confidence" ? "confidence" : sortBy === "amountDiff" ? "amountDiff" : "dateGap";
    list = list.slice().sort((a, b) => (sortDesc ? b[key] - a[key] : a[key] - b[key]));
    return list;
  }, [review, filter, sortBy, sortDesc]);

  function toggleSort(key: SortKey) {
    setSortDesc((prevDesc) => (sortBy === key ? !prevDesc : true));
    setSortBy(key);
  }
  function sortArrow(key: SortKey): string {
    if (sortBy !== key) return "";
    return sortDesc ? " ↓" : " ↑";
  }

  async function approveAll() {
    if (!statementId || rows.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchesToApprove: rows.map((r) => r.match.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error ?? "Approve failed.");
      showToast(`${rows.length} matches approved`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function rejectAll() {
    if (!statementId || rows.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        rows.map((r) =>
          fetch(`/api/reconciliation/${statementId}/reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: r.match.id }),
          }),
        ),
      );
      showToast(`${rows.length} matches rejected`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!resolved || loading) {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation Batch Review</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }
  if (!statementId) {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation Batch Review</h1>
        <p style={pageSubtitle}>No statement uploaded yet — upload a bank statement first.</p>
      </div>
    );
  }
  if (error || !review) {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation Batch Review</h1>
        <p style={{ ...pageSubtitle, color: shellColor.low }}>{error ?? "Something went wrong."}</p>
      </div>
    );
  }

  const reviewed = (initialCount ?? rows.length) - rows.length;
  const reviewedPct = initialCount ? Math.round((reviewed / initialCount) * 100) : 0;

  return (
    <div>
      <h1 style={pageTitle}>Reconciliation Batch Review</h1>
      <p style={{ fontSize: 15, color: shellColor.inkSoft, margin: "0 0 24px" }}>
        {reviewed} of {initialCount ?? rows.length} flagged matches reviewed
      </p>
      <div style={{ ...progressTrack(), marginBottom: 24 }}>
        <div style={progressFill(reviewedPct)} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterTier)}
          style={{ padding: "8px 12px", borderRadius: 7, border: `1px solid ${shellColor.cardBorder}`, fontSize: 13.5, background: shellColor.paper }}
        >
          <option value="all">All confidence</option>
          <option value="medium">Medium (70–95%)</option>
          <option value="low">Low (&lt;70%)</option>
        </select>
        <button style={shellButton("outline")} onClick={() => toggleSort("confidence")}>
          Confidence{sortArrow("confidence")}
        </button>
        <button style={shellButton("outline")} onClick={() => toggleSort("amountDiff")}>
          Amount diff{sortArrow("amountDiff")}
        </button>
        <button style={shellButton("outline")} onClick={() => toggleSort("dateGap")}>
          Date gap{sortArrow("dateGap")}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginBottom: 16 }}>
        <button style={shellButton("outline")} onClick={() => showToast("Open a match individually to edit its fields")}>
          Edit selected ({selected.size})
        </button>
        <button style={busy ? { ...shellButton("dangerOutline"), opacity: 0.6 } : shellButton("dangerOutline")} onClick={rejectAll} disabled={busy}>
          Reject all
        </button>
        <button style={busy ? { ...shellButton("success"), opacity: 0.6 } : shellButton("success")} onClick={approveAll} disabled={busy}>
          Approve all
        </button>
      </div>

      <div style={shellCard({ overflow: "hidden" })}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1.3fr 1fr 1fr 0.9fr 1.3fr",
            gap: 12,
            padding: "12px 20px",
            background: shellColor.page,
            borderBottom: `1px solid ${shellColor.cardBorder}`,
            ...microLabel,
            fontWeight: 600,
          }}
        >
          <div></div>
          <div>Bank / QuickBooks</div>
          <div>Amount diff</div>
          <div>Date gap</div>
          <div>Confidence</div>
          <div></div>
        </div>
        {rows.map((r) => (
          <div
            key={r.match.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1.3fr 1fr 1fr 0.9fr 1.3fr",
              gap: 12,
              padding: "14px 20px",
              borderBottom: `1px solid ${shellColor.trackBg}`,
              alignItems: "center",
              fontSize: 13.5,
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(r.match.id)}
              onChange={(e) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(r.match.id);
                  else next.delete(r.match.id);
                  return next;
                })
              }
            />
            <div>
              <div style={{ fontWeight: 600 }}>{r.bank.merchant || r.bank.description || "(no description)"}</div>
              <div style={{ color: shellColor.inkFainter, fontSize: 12.5 }}>{r.qb.description ?? "(no description)"}</div>
            </div>
            <div style={shellFigures}>{formatMoney(r.amountDiff, r.bank.currency)}</div>
            <div style={shellFigures}>{r.dateGap}d</div>
            <div>
              <span style={pill(r.tier.color, r.tier.bg, "sm")}>
                {r.tier.icon} {r.confidence}%
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={shellButton("outline", "sm")}
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.match.id)) next.delete(r.match.id);
                    else next.add(r.match.id);
                    return next;
                  })
                }
              >
                Select
              </button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>
            All flagged matches reviewed — nice work.
          </div>
        )}
      </div>
    </div>
  );
}
