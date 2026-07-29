"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { formatMoney } from "@/lib/currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";
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

type ReviewData = {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  unmatchedBank: string[];
  unmatchedQb: string[];
};

type ReportData = {
  totalMatched: number;
  totalUnmatchedBank: number;
  totalUnmatchedQb: number;
  variance: number;
  isReconciled: boolean;
};

/**
 * Bank reconciliation, screen 2 of 3 — "Review Matches". Unlike the mockup
 * (which treats >=95% confidence matches as already "matched" with no card
 * needed), every real match — green included — requires an explicit approve
 * to enter the immutable audit trail (see rejectMatch's docstring in
 * lib/reconciliation-store.ts). So every still-open bank transaction gets a
 * card here; a green one just clears in one click via bulk-select.
 */
export default function ReconciliationReviewPage() {
  const queryStatementId = useSearchParams().get("statementId");
  const [statementId, setStatementId] = useState<string | null>(queryStatementId);
  // True once we know the statement id we're loading (or that there isn't
  // one) — separate from `loading`, which covers the transactions fetch.
  const [resolved, setResolved] = useState(!!queryStatementId);
  const showToast = useShellToast();

  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialOpenCount, setInitialOpenCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [report, setReport] = useState<ReportData | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);

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
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load matches.");
        return;
      }
      setReview(data);
      setInitialOpenCount((prev) => prev ?? openCount(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load matches.");
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    if (resolved) load();
  }, [resolved, load]);

  function openCount(data: ReviewData): number {
    const unapproved = data.matches.filter((m) => m.approvedAt === null).length;
    return unapproved + data.unmatchedBank.length;
  }

  async function pickMatch(bankTransactionId: string, qbTransactionId: string) {
    if (!statementId) return;
    setBusyIds((prev) => new Set([...prev, bankTransactionId]));
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankTransactionId, qbTransactionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't create the match.");
        return;
      }
      await load();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(bankTransactionId);
        return next;
      });
    }
  }

  async function rejectOne(matchId: string) {
    if (!statementId) return;
    setBusyIds((prev) => new Set([...prev, matchId]));
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't reject the match.");
        return;
      }
      await load();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(matchId);
        return next;
      });
    }
  }

  async function approveSelected() {
    if (!statementId || selected.size === 0) return;
    setApproving(true);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchesToApprove: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Approve failed.");
        return;
      }
      const n = selected.size;
      setSelected(new Set());
      await load();
      showToast(`${n} ${n === 1 ? "match" : "matches"} approved`);
    } finally {
      setApproving(false);
    }
  }

  async function generateReport() {
    if (!statementId) return;
    setGeneratingReport(true);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/report`);
      const data = await res.json();
      if (res.ok) setReport(data);
    } finally {
      setGeneratingReport(false);
    }
  }

  if (!resolved || loading) {
    return (
      <div>
        <h1 style={pageTitle}>Review Matches</h1>
        <p style={pageSubtitle}>Loading…</p>
      </div>
    );
  }
  if (!statementId) {
    return (
      <div>
        <h1 style={pageTitle}>Review Matches</h1>
        <p style={pageSubtitle}>No statement uploaded yet — upload a bank statement first.</p>
      </div>
    );
  }
  if (error || !review) {
    return (
      <div>
        <h1 style={pageTitle}>Review Matches</h1>
        <p style={{ ...pageSubtitle, color: shellColor.low }}>{error ?? "Something went wrong."}</p>
      </div>
    );
  }

  const openBankIds = new Set([
    ...review.matches.filter((m) => m.approvedAt === null).map((m) => m.bankTransactionId),
    ...review.unmatchedBank,
  ]);
  const openBanks = review.bankTransactions.filter((b) => openBankIds.has(b.id));
  const reviewed = (initialOpenCount ?? openBanks.length) - openBanks.length;
  const reviewedPct = initialOpenCount ? Math.round((reviewed / initialOpenCount) * 100) : 0;

  const eligibleMatchIds = review.matches.filter((m) => m.approvedAt === null && m.qbTransactionId !== null).map((m) => m.id);
  const reportCurrency = review.bankTransactions[0]?.currency ?? null;

  return (
    <div>
      <h1 style={pageTitle}>Review Matches</h1>
      <p style={{ fontSize: 14, color: shellColor.inkSoft, margin: "0 0 16px" }}>
        {reviewed} of {initialOpenCount ?? openBanks.length} flagged matches reviewed
      </p>
      <div style={{ ...progressTrack(), marginBottom: 20 }}>
        <div style={progressFill(reviewedPct)} />
      </div>

      {eligibleMatchIds.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <button
            style={selected.size === 0 || approving ? { ...shellButton("success"), ...disabledOverride() } : shellButton("success")}
            onClick={approveSelected}
            disabled={selected.size === 0 || approving}
          >
            {approving ? "Approving…" : `Approve selected (${selected.size})`}
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {openBanks.map((bank) => {
          const match = review.matches.find((m) => m.bankTransactionId === bank.id && m.approvedAt === null) ?? null;
          const qb = match?.qbTransactionId ? review.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null : null;
          const busy = busyIds.has(bank.id) || (match ? busyIds.has(match.id) : false);
          const t = match ? tierFor((match.confidence ?? 0) * 100) : null;

          return (
            <div key={bank.id} style={shellCard({ padding: "20px 24px" })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {match && (
                    <input
                      type="checkbox"
                      checked={selected.has(match.id)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(match.id);
                          else next.delete(match.id);
                          return next;
                        })
                      }
                      aria-label={`Select ${bank.description ?? bank.merchant ?? "transaction"}`}
                    />
                  )}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: shellColor.inkSoft, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    Needs review
                  </span>
                </div>
                {t && <span style={pill(t.color, t.bg)}>{t.icon} {((match!.confidence ?? 0) * 100).toFixed(0)}%</span>}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                <div style={{ borderRight: `1px solid ${shellColor.trackBg}`, paddingRight: 24 }}>
                  <div style={{ ...microLabel, marginBottom: 6 }}>Bank transaction</div>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                    {bank.merchant || bank.description || "(no description)"}
                  </div>
                  <div style={{ fontSize: 13, color: shellColor.inkSoft, ...shellFigures }}>
                    {bank.transactionDate} · {formatMoney(bank.amount, bank.currency)}
                  </div>
                </div>
                <div>
                  <div style={{ ...microLabel, marginBottom: 6 }}>QuickBooks entry</div>
                  {qb ? (
                    <>
                      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{qb.description ?? "(no description)"}</div>
                      <div style={{ fontSize: 13, color: shellColor.inkSoft, ...shellFigures }}>
                        {qb.postedDate} · {formatMoney(qb.amount, qb.currency)}
                      </div>
                    </>
                  ) : review.qbTransactions.length === 0 ? (
                    <div style={{ fontSize: 13, color: shellColor.inkFaint }}>No accounting transactions on file yet</div>
                  ) : (
                    <select
                      disabled={busy}
                      defaultValue=""
                      onChange={(e) => e.target.value && pickMatch(bank.id, e.target.value)}
                      aria-label={`Match for ${bank.description ?? bank.merchant ?? "this transaction"}`}
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        borderRadius: 8,
                        border: `1px solid ${shellColor.cardBorder}`,
                        fontSize: 13,
                        fontFamily: shellFigures.fontFamily,
                        background: shellColor.paper,
                        color: shellColor.ink,
                      }}
                    >
                      <option value="">— choose a match —</option>
                      {review.qbTransactions.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.postedDate} · {q.description ?? "(no description)"} · {formatMoney(q.amount, q.currency)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {match?.matchReason && (
                <div style={{ marginTop: 12, padding: "10px 14px", background: shellColor.page, borderRadius: 8, fontSize: 13, color: shellColor.inkSoft }}>
                  {match.matchReason}
                </div>
              )}

              {match && (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button
                    style={busy ? { ...shellButton("success"), ...disabledOverride() } : shellButton("success")}
                    disabled={busy}
                    onClick={() =>
                      fetch(`/api/reconciliation/${statementId}/approve`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ matchesToApprove: [match.id] }),
                      }).then(async (res) => {
                        const data = await res.json();
                        if (!res.ok) return setError(data.error ?? "Approve failed.");
                        await load();
                      })
                    }
                  >
                    Approve match
                  </button>
                  <button
                    style={busy ? { ...shellButton("dangerOutline"), ...disabledOverride() } : shellButton("dangerOutline")}
                    disabled={busy}
                    onClick={() => rejectOne(match.id)}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {openBanks.length === 0 && (
          <div style={shellCard({ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 })}>
            All matches reviewed — ready to generate the reconciliation report.
          </div>
        )}
      </div>

      {openBanks.length === 0 && (
        <button
          style={{ ...shellButton("primary", "lg"), marginTop: 20 }}
          onClick={generateReport}
          disabled={generatingReport}
        >
          {generatingReport ? "Generating…" : "Generate reconciliation report"}
        </button>
      )}

      {report && (
        <div style={shellCard({ padding: 24, marginTop: 20 })}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Reconciliation report</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
            <ReportStat label="Matched" value={formatMoney(report.totalMatched, reportCurrency)} />
            <ReportStat label="Unmatched (bank)" value={formatMoney(report.totalUnmatchedBank, reportCurrency)} />
            <ReportStat label="Unmatched (accounting)" value={formatMoney(report.totalUnmatchedQb, reportCurrency)} />
            <ReportStat label="Variance" value={formatMoney(report.variance, reportCurrency)} />
          </div>
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            <span style={pill(report.isReconciled ? shellColor.high : shellColor.inkFaint, report.isReconciled ? shellColor.highBg : shellColor.trackBg)}>
              {report.isReconciled ? "Fully reconciled" : "Partially reconciled"}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: shellColor.inkFaint, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: shellColor.ink, ...shellFigures }}>{value}</div>
    </div>
  );
}
