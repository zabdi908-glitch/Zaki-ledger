"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MatchWithDetails, DashboardData } from "@/lib/dashboard-pipeline";
import { formatMoney } from "@/lib/currency";
import {
  disabledOverride,
  pageTitle,
  pageSubtitle,
  shellButton,
  shellCard,
  shellColor,
  shellFigures,
} from "@/lib/shell-theme";
import ConnectionChip from "@/components/ConnectionChip";
import TabBar, { type TabItem } from "@/components/reconciliation/tab-bar";
import MatchList from "@/components/reconciliation/match-list";
import { useShellToast } from "@/components/AppShell";

type LoadingState = "idle" | "loading" | "error";

export default function ReconciliationDashboardPage() {
  const params = useParams();
  const statementId = typeof params.id === "string" ? params.id : null;
  const showToast = useShellToast();

  const [data, setData] = useState<DashboardData | null>(null);
  const [state, setState] = useState<LoadingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"perfect" | "review" | "exceptions">("perfect");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkResults, setBulkResults] = useState<{ approved: number; errors: number } | null>(null);
  const [isRematching, setIsRematching] = useState(false);

  const load = useCallback(async () => {
    if (!statementId) {
      setState("error");
      setError("No statement ID provided.");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/dashboard`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Failed to load dashboard data.");
        setState("error");
        return;
      }
      setData(json as DashboardData);
      setState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data.");
      setState("error");
    }
  }, [statementId]);

  useEffect(() => {
    load();
  }, [load]);

  const report = data?.report;

  const summary = useMemo(() => {
    if (!data) return null;
    const matchedTotal = report?.totalMatched ?? 0;
    const unmatched = report?.totalUnmatchedBank ?? 0;
    const variance = report?.variance ?? 0;
    return { matchedTotal, unmatched, variance };
  }, [data, report]);

  const tabs: TabItem[] = useMemo(() => {
    if (!data) return [];
    return [
      {
        key: "perfect",
        label: "Perfect",
        count: data.greenMatches.length,
        color: shellColor.high,
        bgColor: shellColor.highBg,
      },
      {
        key: "review",
        label: "Review",
        count: data.yellowMatches.length,
        color: shellColor.medium,
        bgColor: shellColor.mediumBg,
      },
      {
        key: "exceptions",
        label: "Exceptions",
        count: data.redMatches.length,
        color: shellColor.low,
        bgColor: shellColor.lowBg,
      },
    ];
  }, [data]);

  const activeMatches = useMemo(() => {
    if (!data) return [];
    switch (activeTab) {
      case "perfect":
        return data.greenMatches;
      case "review":
        return data.yellowMatches;
      case "exceptions":
        return data.redMatches;
    }
  }, [data, activeTab]);

  // Reset selection when tab changes
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkResults(null);
  }, [activeTab]);

  async function handleApprove(matchId: string) {
    if (!statementId || !data) return;
    // Optimistic: remove from local list
    setData((prev) => {
      if (!prev) return prev;
      const filterOut = (m: MatchWithDetails[]) => m.filter((x) => x.match.id !== matchId);
      return {
        ...prev,
        greenMatches: filterOut(prev.greenMatches),
        yellowMatches: filterOut(prev.yellowMatches),
        redMatches: filterOut(prev.redMatches),
      };
    });
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchesToApprove: [matchId] }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Approve failed — restored.");
        await load();
      }
    } catch {
      showToast("Approve failed — restored.");
      await load();
    }
  }

  async function handleReject(matchId: string) {
    if (!statementId || !data) return;
    // Optimistic: remove from local list
    setData((prev) => {
      if (!prev) return prev;
      const filterOut = (m: MatchWithDetails[]) => m.filter((x) => x.match.id !== matchId);
      return {
        ...prev,
        greenMatches: filterOut(prev.greenMatches),
        yellowMatches: filterOut(prev.yellowMatches),
        redMatches: filterOut(prev.redMatches),
      };
    });
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Reject failed — restored.");
        await load();
      }
    } catch {
      showToast("Reject failed — restored.");
      await load();
    }
  }

  function handleManualMatch(match: MatchWithDetails) {
    // For now, show a toast — inline manual matching UI is a follow-up
    showToast(`Manual match for ${match.bankTransaction.merchant ?? match.bankTransaction.description ?? "transaction"}`);
  }

  function handleToggleSelect(matchId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(matchId)) {
        next.delete(matchId);
      } else {
        next.add(matchId);
      }
      return next;
    });
  }

  function handleSelectAll() {
    const allSelected = activeMatches.every((m) => selectedIds.has(m.match.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(activeMatches.map((m) => m.match.id)));
    }
  }

  async function handleBulkApprove() {
    if (!statementId || !data || selectedIds.size === 0) return;
    setIsBulkProcessing(true);
    setBulkResults(null);

    // Optimistic: remove selected from local lists
    setData((prev) => {
      if (!prev) return prev;
      const filterOut = (m: MatchWithDetails[]) => m.filter((x) => !selectedIds.has(x.match.id));
      return {
        ...prev,
        greenMatches: filterOut(prev.greenMatches),
        yellowMatches: filterOut(prev.yellowMatches),
        redMatches: filterOut(prev.redMatches),
      };
    });

    const idsToApprove = Array.from(selectedIds);

    try {
      const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchesToApprove: idsToApprove }),
      });

      if (res.ok) {
        setBulkResults({ approved: idsToApprove.length, errors: 0 });
        showToast(`${idsToApprove.length} matches approved and synced.`);
      } else {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? "Some approvals failed.");
        setBulkResults({ approved: 0, errors: idsToApprove.length });
        await load();
      }
    } catch {
      showToast("Bulk approve failed — restored.");
      setBulkResults({ approved: 0, errors: idsToApprove.length });
      await load();
    } finally {
      setIsBulkProcessing(false);
      setSelectedIds(new Set());
      // Clear bulk results after a delay
      setTimeout(() => setBulkResults(null), 4000);
    }
  }

  async function handleRematch() {
    if (!statementId) return;
    setIsRematching(true);
    try {
      const res = await fetch("/api/reconciliation/on-demand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(json.error ?? "Re-match failed.");
        return;
      }
      const { stats } = json as { stats: { total: number; green: number; yellow: number; red: number; unmatched: number } };
      showToast(`Re-matched: ${stats.green} green, ${stats.yellow} yellow, ${stats.red} red, ${stats.unmatched} unmatched.`);
      await load();
    } catch {
      showToast("Re-match failed.");
    } finally {
      setIsRematching(false);
    }
  }

  if (state === "loading") {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }

  if (!statementId) {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation</h1>
        <p style={pageSubtitle}>No statement selected.</p>
        <ConnectionChip />
      </div>
    );
  }

  if (state === "error" || !data) {
    return (
      <div>
        <h1 style={pageTitle}>Reconciliation</h1>
        <p style={{ ...pageSubtitle, color: shellColor.low }}>{error ?? "Something went wrong."}</p>
      </div>
    );
  }

  const { statement } = data;
  const currency = statement.currency;

  return (
    <div>
      <h1 style={pageTitle}>Reconciliation</h1>

      {/* Statement metadata header */}
      <div style={{ ...shellCard({ padding: "16px 20px", marginBottom: 20 }), display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Statement
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink }}>
            {statement.fileName ?? "Unnamed statement"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Period
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink }}>
            {statement.periodStart && statement.periodEnd
              ? `${new Date(statement.periodStart).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} – ${new Date(statement.periodEnd).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
              : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Transactions
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink, ...shellFigures }}>
            {statement.transactionCount}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Currency
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink }}>
            {currency ?? "—"}
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <button
            style={isRematching ? { ...shellButton("outline", "sm"), ...disabledOverride() } : shellButton("outline", "sm")}
            onClick={handleRematch}
            disabled={isRematching}
          >
            {isRematching ? "Matching…" : "Run Matching Now"}
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {summary && (
        <div style={{ ...shellCard({ padding: "16px 20px", marginBottom: 20 }), display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
          <SummaryItem label="Matched total" value={formatMoney(summary.matchedTotal, currency)} />
          <SummaryItem label="Unmatched" value={formatMoney(summary.unmatched, currency)} />
          <SummaryItem label="Variance" value={formatMoney(summary.variance, currency)} />
        </div>
      )}

      <TabBar tabs={tabs} activeTab={activeTab} onTabChange={(k) => setActiveTab(k as typeof activeTab)} />

      <div style={{ marginTop: 20 }}>
        <MatchList
          matches={activeMatches}
          onApprove={handleApprove}
          onReject={handleReject}
          onManualMatch={handleManualMatch}
          emptyMessage={`No ${activeTab} matches.`}
          showBulkActions={activeTab === "perfect"}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onSelectAll={handleSelectAll}
          onBulkApprove={handleBulkApprove}
          isBulkProcessing={isBulkProcessing}
          bulkResults={bulkResults}
        />
      </div>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: shellColor.inkFaint, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: shellColor.ink, ...shellFigures }}>{value}</div>
    </div>
  );
}