"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useShellToast } from "@/components/AppShell";
import { formatMoney } from "@/lib/currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";
import { buildReviewRows, factorBreakdown } from "@/lib/reconciliation-insights";
import ReviewBoard, { type ReviewRow, type ReviewSectionConfig } from "@/components/review/ReviewBoard";
import {
  pageSubtitle,
  pageTitle,
  pill,
  progressFill,
  progressTrack,
  shellButton,
  shellCard,
  shellColor,
  shellFigures,
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

const SECTIONS: ReviewSectionConfig[] = [
  {
    key: "ready",
    title: "Ready to Approve",
    accentColor: shellColor.high,
    description: "95%+ confidence — amount, date, and merchant all match. Safe to approve as a batch.",
    showBulkApproveAll: true,
  },
  {
    key: "review",
    title: "Needs Review",
    accentColor: shellColor.medium,
    description: "Below 95% confidence, or missing an accounting match. Worth a quick look before approving.",
  },
  {
    key: "duplicate",
    title: "Possible Duplicates",
    accentColor: shellColor.dupe,
    description: "Two entries that look like the same transaction. Decide whether to keep both or reject one.",
  },
  {
    key: "issue",
    title: "Potential Issues",
    accentColor: shellColor.low,
    description: "No match found, a currency mismatch, or an amount large enough to flag for manual review.",
  },
];

/**
 * Bank reconciliation, screen 2 of 3 — "Review Matches". Grouped-sections +
 * side-panel design (design_handoff_zaki_ledger/Transaction Review
 * Mockup.html) built on ReviewBoard; every open bank transaction still
 * requires an explicit approve to enter the immutable audit trail (see
 * rejectMatch's docstring in lib/reconciliation-store.ts) — the "ready"
 * section's bulk button is what makes that fast for the green ones.
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

  async function rejectOne(matchId: string) {
    if (!statementId) return;
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
  }

  async function boardApprove(bankIds: string[], rowsById: Map<string, { matchId: string | null }>) {
    const matchIds = bankIds
      .map((id) => rowsById.get(id)?.matchId)
      .filter((id): id is string => id !== null && id !== undefined);
    if (matchIds.length === 0) return;
    const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchesToApprove: matchIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Approve failed.");
      return;
    }
    await load();
    showToast(`${matchIds.length} ${matchIds.length === 1 ? "match" : "matches"} approved`);
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
  const reportCurrency = review.bankTransactions[0]?.currency ?? null;

  const built = buildReviewRows({
    bankTransactions: openBanks,
    qbTransactions: review.qbTransactions,
    matches: review.matches.filter((m) => m.approvedAt === null),
  });
  const rowsById = new Map(built.map((b) => [b.id, b]));

  return (
    <div>
      <h1 style={pageTitle}>Review Matches</h1>
      <p style={{ fontSize: 14, color: shellColor.inkSoft, margin: "0 0 16px" }}>
        {reviewed} of {initialOpenCount ?? openBanks.length} flagged matches reviewed
      </p>
      <div style={{ ...progressTrack(), marginBottom: 20 }}>
        <div style={progressFill(reviewedPct)} />
      </div>

      {openBanks.length > 0 && (
        <ReviewBoard
          rows={built.map((b) => b.row)}
          sections={SECTIONS}
          approvedIds={new Set()}
          onApprove={(ids) => boardApprove(ids, rowsById)}
          onFlag={(id) => showToast(`${rowsById.get(id)?.row.title ?? "Transaction"} flagged for a second look`)}
          heroTitle="High-confidence matches"
          heroDescription="Every one scored 95%+ on amount, date, and merchant against your accounting records."
          renderPanel={(row) => {
            const entry = rowsById.get(row.id);
            const match = entry?.matchId ? review.matches.find((m) => m.id === entry.matchId) ?? null : null;
            const qb = match?.qbTransactionId ? review.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null : null;
            const bank = openBanks.find((b) => b.id === row.id);
            if (!bank) return null;
            return (
              <ReconciliationPanelBody
                bank={bank}
                qb={qb}
                match={match}
                row={row}
                onApprove={() => boardApprove([row.id], rowsById)}
                onReject={() => match && rejectOne(match.id)}
              />
            );
          }}
        />
      )}

      {openBanks.length === 0 && (
        <div style={shellCard({ padding: 48, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 })}>
          All matches reviewed — ready to generate the reconciliation report.
        </div>
      )}

      {openBanks.length === 0 && (
        <button style={{ ...shellButton("primary", "lg"), marginTop: 20 }} onClick={generateReport} disabled={generatingReport}>
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

function ReconciliationPanelBody({
  bank,
  qb,
  match,
  row,
  onApprove,
  onReject,
}: {
  bank: BankTransaction;
  qb: QbTransaction | null;
  match: ReconciliationMatch | null;
  row: ReviewRow;
  onApprove: () => void;
  onReject: () => void;
}) {
  const factors = match ? factorBreakdown(match) : [];
  return (
    <>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Transaction details
        </div>
        <KV label="Date" value={row.date} />
        <KV label="Description" value={bank.merchant || bank.description || "(no description)"} />
        <KV label="Amount" value={row.amountLabel} />
        <KV label="Direction" value={row.amountSubLabel} />
        <KV label="Suggested category" value={row.categoryLabel} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Suggested match
        </div>
        {qb ? (
          <>
            <KV label="Entry" value={qb.description ?? "(no description)"} />
            <KV label="Date" value={qb.postedDate} />
            <KV label="Amount" value={formatMoney(qb.amount, qb.currency)} />
          </>
        ) : (
          <div style={{ fontSize: 13.5, color: shellColor.inkSoft, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
            No matching accounting entry found yet.
          </div>
        )}
      </div>

      {match && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
            Confidence score
          </div>
          {factors.map((f) => (
            <div key={f.label} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                <span>{f.label}</span>
                <span style={{ ...shellFigures }}>
                  {f.score}/{f.max} pts
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, width: `${(f.score / f.max) * 100}%`, background: row.confidenceColor }} />
              </div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: shellColor.inkFaint, marginTop: 10 }}>
            Zaki scores every match on these three signals, out of 100 points — the same engine that ranks every transaction on this page.
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          AI reasoning
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>{row.reason}</div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 28 }}>
        <button style={{ ...shellButton("dangerOutline", "lg"), flex: 1 }} onClick={onReject} disabled={!match}>
          Reject
        </button>
        <button style={{ ...shellButton("success", "lg"), flex: 1 }} onClick={onApprove} disabled={!match}>
          Approve
        </button>
      </div>
    </>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "6px 0", borderBottom: `1px dashed ${shellColor.cardBorder}` }}>
      <span style={{ color: shellColor.inkSoft }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
