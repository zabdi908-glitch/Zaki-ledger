"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * Order matters: the accountant works top to bottom, so the sections that can
 * be cleared fastest come first, then the ones where we can say exactly what
 * happened, and only then the residual pile that still needs investigating.
 */
/**
 * This page drops approved rows by refetching rather than by tracking them
 * client-side, so the board's "already approved" set is always empty. Hoisted
 * to a constant because a fresh Set on every render would invalidate every
 * memo inside ReviewBoard that depends on it.
 */
const NO_APPROVED_IDS: Set<string> = new Set();

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
    key: "refund",
    title: "Refunds",
    accentColor: shellColor.refund,
    description: "Money back from a supplier that matches an earlier charge. Confirm the pair, then approve both.",
  },
  {
    key: "reversal",
    title: "Reversals",
    accentColor: shellColor.reversal,
    description: "Equal and opposite transactions that cancel each other out. Net effect on the books is nil.",
  },
  {
    key: "split",
    title: "Split Payments",
    accentColor: shellColor.split,
    description: "Several transactions quoting one invoice reference — one bill or payment settled in parts.",
  },
  {
    key: "transfer",
    title: "Transfers",
    accentColor: shellColor.transfer,
    description: "Money moving between your own accounts rather than in or out of the business.",
  },
  {
    key: "recurring",
    title: "Recurring Transactions",
    accentColor: shellColor.recurring,
    description: "Charges from a supplier that appears more than once on this statement.",
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

  /**
   * The whole board's derived state, rebuilt only when the fetched data
   * changes. This is deliberately one memo above the early returns: it runs
   * every detector over every transaction, so recomputing it on each render —
   * which is what selecting a row or opening the panel would otherwise cause —
   * is what made the page feel unresponsive on a full statement.
   */
  const board = useMemo(() => {
    if (!review) return null;
    const openBankIds = new Set([
      ...review.matches.filter((m) => m.approvedAt === null).map((m) => m.bankTransactionId),
      ...review.unmatchedBank,
    ]);
    const openBanks = review.bankTransactions.filter((b) => openBankIds.has(b.id));
    const built = buildReviewRows({
      bankTransactions: openBanks,
      qbTransactions: review.qbTransactions,
      matches: review.matches.filter((m) => m.approvedAt === null),
    });
    return {
      openBanks,
      rows: built.map((b) => b.row),
      rowsById: new Map(built.map((b) => [b.id, b])),
    };
  }, [review]);

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
    // A transaction with no accounting entry has no match to approve. Saying
    // so beats the button looking broken, which is what a silent return here
    // looked like to anyone clicking it.
    if (matchIds.length === 0) {
      showToast(
        bankIds.length === 1
          ? "Nothing to approve — this transaction has no accounting entry to match. Find it a match first."
          : "Nothing to approve — none of the selected transactions have an accounting entry to match.",
      );
      return;
    }
    if (matchIds.length < bankIds.length) {
      showToast(`${bankIds.length - matchIds.length} skipped — no accounting entry to match yet.`);
    }
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

  if (!board) return null;
  const { openBanks, rows, rowsById } = board;
  const reviewed = (initialOpenCount ?? openBanks.length) - openBanks.length;
  const reviewedPct = initialOpenCount ? Math.round((reviewed / initialOpenCount) * 100) : 0;
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

      {openBanks.length > 0 && (
        <ReviewBoard
          rows={rows}
          sections={SECTIONS}
          approvedIds={NO_APPROVED_IDS}
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

      {row.detection && (
        <div style={{ marginBottom: 24 }}>
          <SectionLabel>Detection results</SectionLabel>
          <div style={{ background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 14.5, fontWeight: 600 }}>{row.detection.title}</span>
              <span style={{ ...pill(row.confidenceColor, shellColor.paper), whiteSpace: "nowrap" }}>
                {row.detection.confidencePct}% confident
              </span>
            </div>
            {row.detection.lines.map((line, i) => (
              <KV key={`${line.label}-${i}`} label={line.label} value={line.value} />
            ))}
            {row.detection.footer && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700, paddingTop: 10 }}>
                <span>{row.detection.footer.label}</span>
                <span style={shellFigures}>{row.detection.footer.value}</span>
              </div>
            )}
          </div>
        </div>
      )}

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

      {row.detection && row.detection.evidence.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SectionLabel>Supporting evidence</SectionLabel>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7, color: shellColor.inkSoft }}>
            {row.detection.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
      {children}
    </div>
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
