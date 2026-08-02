"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useShellToast } from "@/components/AppShell";
import ConnectionChip from "@/components/ConnectionChip";
import { formatMoney } from "@/lib/currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";
import { buildReviewRows, factorBreakdown } from "@/lib/reconciliation-insights";
import { applyApprovals, applyRejection, type ReviewData as BaseReviewData } from "@/lib/review-optimistic";
import { GL_CATEGORIES } from "@/lib/merchant-categories";
import type { InvoiceSuggestion } from "@/lib/invoice-matching";
import type { StoredInvoiceMatch } from "@/lib/invoice-match-store";
import { ledgerImpact } from "@/lib/ledger-impact";
import type { MerchantPreference } from "@/lib/decision-store";
import ReviewBoard, { type ReviewRow } from "@/components/review/ReviewBoard";
import { SECTIONS } from "@/lib/review-sections";
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

/** The transactions endpoint's payload widened with Group C's invoice-match
 * fields — the base ReviewData type stays narrow because review-optimistic's
 * applyApprovals/applyRejection only ever touch matches/unmatchedBank. */
type ReviewData = BaseReviewData & {
  invoiceSuggestions: InvoiceSuggestion[];
  invoiceMatches: StoredInvoiceMatch[];
};

type ReportData = {
  totalMatched: number;
  totalUnmatchedBank: number;
  totalUnmatchedQb: number;
  variance: number;
  isReconciled: boolean;
};

/**
 * Approved rows drop out of `board` itself (its useMemo filters matches down
 * to `approvedAt === null` after an optimistic update), so the board's
 * "already approved" set is always empty. Hoisted to a constant because a
 * fresh Set on every render would invalidate every memo inside ReviewBoard
 * that depends on it.
 */
const NO_APPROVED_IDS: Set<string> = new Set();

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
  const [preferences, setPreferences] = useState<MerchantPreference[]>([]);
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
      const [res, prefsRes] = await Promise.all([
        fetch(`/api/reconciliation/${statementId}/transactions`),
        fetch("/api/reconciliation/preferences"),
      ]);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load matches.");
        return;
      }
      setReview(data);
      setInitialOpenCount((prev) => prev ?? openCount(data));
      if (prefsRes.ok) {
        const prefsData = await prefsRes.json();
        setPreferences(prefsData.preferences ?? []);
      }
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
      preferences,
    });
    const suggestionsByBankId = new Map(review.invoiceSuggestions.map((s) => [s.bankTransactionId, s]));
    const confirmedByBankId = new Map(review.invoiceMatches.map((m) => [m.bankTransactionId, m]));
    // A row already carries a badge (Duplicate, Refund, ...) from its own
    // detection; an invoice match is additive information about the same row,
    // not a competing classification, so it's appended rather than unshifted.
    const rows = built.map((b) => {
      if (!suggestionsByBankId.has(b.id) && !confirmedByBankId.has(b.id)) return b.row;
      return { ...b.row, badges: [...b.row.badges, "Invoice match"] };
    });
    return {
      openBanks,
      rows,
      rowsById: new Map(built.map((b) => [b.id, b])),
      suggestionsByBankId,
      confirmedByBankId,
    };
  }, [review, preferences]);

  function openCount(data: ReviewData): number {
    const unapproved = data.matches.filter((m) => m.approvedAt === null).length;
    return unapproved + data.unmatchedBank.length;
  }

  async function rejectOne(matchId: string) {
    if (!statementId) return;
    // applyRejection's return type is the base ReviewData shape (it only
    // touches matches/unmatchedBank); the spread it does internally preserves
    // invoiceSuggestions/invoiceMatches at runtime, so this cast is safe.
    setReview((prev) => (prev ? (applyRejection(prev, matchId) as ReviewData) : prev));
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      if (!res.ok) {
        // Resync from the server rather than restoring a snapshot — a second
        // write may have landed while this one was in flight, and a snapshot
        // rollback would silently discard that one too.
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Couldn't reject the match — restored.");
        await load();
      }
    } catch {
      // Network failure (offline, DNS, aborted) — fetch/json rejected instead
      // of resolving with !res.ok, so the resync has to happen here too.
      showToast("Couldn't reject the match — restored.");
      await load();
    }
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
    setReview((prev) => (prev ? (applyApprovals(prev, matchIds, new Date().toISOString()) as ReviewData) : prev));
    showToast(`${matchIds.length} ${matchIds.length === 1 ? "match" : "matches"} approved`);
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchesToApprove: matchIds }),
      });
      if (!res.ok) {
        // Resync from the server rather than restoring a snapshot — a second
        // write may have landed while this one was in flight, and a snapshot
        // rollback would silently discard that one too (and never reconcile
        // the optimistic approvedAt guess with the server's real value).
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Approve failed — restored.");
        await load();
      }
    } catch {
      // Network failure (offline, DNS, aborted) — fetch/json rejected instead
      // of resolving with !res.ok, so the resync has to happen here too.
      showToast("Approve failed — restored.");
      await load();
    }
  }

  async function matchInvoice(suggestion: InvoiceSuggestion) {
    if (!statementId) return;
    try {
      const res = await fetch(`/api/reconciliation/${statementId}/invoice-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransactionId: suggestion.bankTransactionId,
          invoiceId: suggestion.invoiceId,
          confidencePct: suggestion.confidencePct,
          matchedBy: suggestion.matchedBy,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Couldn't confirm the invoice match.");
        return;
      }
      const { id } = await res.json();
      // Optimistic: move the suggestion into invoiceMatches so the card
      // switches from "Match invoice" to "Matched" without a refetch.
      setReview((prev) =>
        prev
          ? {
              ...prev,
              invoiceSuggestions: prev.invoiceSuggestions.filter((s) => s.bankTransactionId !== suggestion.bankTransactionId),
              invoiceMatches: [
                ...prev.invoiceMatches,
                {
                  id,
                  bankTransactionId: suggestion.bankTransactionId,
                  invoiceId: suggestion.invoiceId,
                  confidencePct: suggestion.confidencePct,
                  matchedBy: suggestion.matchedBy,
                  status: "matched",
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );
      showToast(`Invoice ${suggestion.invoiceNumber} matched`);
    } catch {
      showToast("Couldn't confirm the invoice match.");
    }
  }

  async function setDefaultCategory(merchantName: string, category: string) {
    try {
      const res = await fetch("/api/reconciliation/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantName, category }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Couldn't save the default category.");
        return;
      }
      showToast("Default category saved for this merchant");
      await load();
    } catch {
      showToast("Couldn't save the default category.");
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
        <ConnectionChip />
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
  const { openBanks, rows, rowsById, suggestionsByBankId, confirmedByBankId } = board;
  const reviewed = (initialOpenCount ?? openBanks.length) - openBanks.length;
  const reviewedPct = initialOpenCount ? Math.round((reviewed / initialOpenCount) * 100) : 0;
  const reportCurrency = review.bankTransactions[0]?.currency ?? null;

  return (
    <div>
      <h1 style={pageTitle}>Review Matches</h1>
      <p style={{ fontSize: 14, color: shellColor.inkSoft, margin: "0 0 16px" }}>
        {reviewed} of {initialOpenCount ?? openBanks.length} flagged matches reviewed
      </p>
      <ConnectionChip />
      <div style={{ ...progressTrack(), marginBottom: 20 }}>
        <div style={progressFill(reviewedPct)} />
      </div>

      {review.qbTransactions.length === 0 && (
        <div style={shellCard({ padding: "16px 20px", marginBottom: 20, borderLeft: `3px solid ${shellColor.medium}` })}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            No accounting entries to match against
          </div>
          <p style={{ margin: 0, fontSize: 13.5, color: shellColor.inkSoft }}>
            Every transaction will sit in &ldquo;Potential Issues&rdquo; until there is something to reconcile it with.{" "}
            <Link href="/reconciliation" style={{ color: shellColor.ink, fontWeight: 600 }}>
              Sync from Xero/QuickBooks or import a CSV →
            </Link>
          </p>
        </div>
      )}

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
                suggestion={suggestionsByBankId.get(bank.id)}
                confirmedInvoiceMatch={confirmedByBankId.get(bank.id)}
                onSetDefaultCategory={(category) => setDefaultCategory(bank.merchant ?? bank.description ?? "", category)}
                onApprove={() => boardApprove([row.id], rowsById)}
                onReject={() => match && rejectOne(match.id)}
                onMatchInvoice={(s) => matchInvoice(s)}
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

/** Strips a category label's parenthetical tag, e.g. "Fuel (learned from 4
 * approvals)" -> "Fuel" — the dropdown shows the plain GL category, not the
 * explanation of how it was suggested. */
function bareCategory(categoryLabel: string): string {
  return categoryLabel.replace(/\s*\(.*\)$/, "");
}

function ReconciliationPanelBody({
  bank,
  qb,
  match,
  row,
  suggestion,
  confirmedInvoiceMatch,
  onApprove,
  onReject,
  onSetDefaultCategory,
  onMatchInvoice,
}: {
  bank: BankTransaction;
  qb: QbTransaction | null;
  match: ReconciliationMatch | null;
  row: ReviewRow;
  suggestion?: InvoiceSuggestion;
  confirmedInvoiceMatch?: StoredInvoiceMatch;
  onApprove: () => void;
  onReject: () => void;
  onSetDefaultCategory: (category: string) => void;
  onMatchInvoice: (suggestion: InvoiceSuggestion) => void;
}) {
  const factors = match ? factorBreakdown(match) : [];
  const currentCategory = bareCategory(row.categoryLabel);
  const categoryOptions = GL_CATEGORIES.includes(currentCategory) ? GL_CATEGORIES : [currentCategory, ...GL_CATEGORIES];
  return (
    <>
      {(suggestion || confirmedInvoiceMatch) && (
        <div style={{ marginBottom: 24 }}>
          <SectionLabel>Possible invoice match</SectionLabel>
          <div style={{ background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
            {suggestion ? (
              <>
                <KV label="Invoice" value={suggestion.invoiceNumber} />
                <KV label="Customer" value={suggestion.supplierName} />
                <KV label="Amount" value={formatMoney(suggestion.total ?? 0, bank.currency)} />
                <KV label="Confidence" value={`${suggestion.confidencePct}%`} />
                <div style={{ fontSize: 12.5, color: shellColor.inkSoft, padding: "8px 0" }}>{suggestion.reason}</div>
                <button style={{ ...shellButton("success", "sm"), marginTop: 6 }} onClick={() => onMatchInvoice(suggestion)}>
                  Match invoice
                </button>
              </>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13.5, color: shellColor.inkSoft }}>Matched to an invoice</span>
                <span style={pill(shellColor.high, shellColor.highBg)}>Matched</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint, marginBottom: 10 }}>
          Transaction details
        </div>
        <KV label="Date" value={row.date} />
        <KV label="Description" value={bank.merchant || bank.description || "(no description)"} />
        <KV label="Amount" value={row.amountLabel} />
        <KV label="Direction" value={row.amountSubLabel} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "6px 0", borderBottom: `1px dashed ${shellColor.cardBorder}` }}>
          <span style={{ color: shellColor.inkSoft }}>Suggested category</span>
          <select
            value={currentCategory}
            onChange={(e) => onSetDefaultCategory(e.target.value)}
            style={{ fontWeight: 600, fontSize: 13.5, border: `1px solid ${shellColor.cardBorder}`, borderRadius: 6, padding: "3px 6px" }}
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
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
          {row.detection.suggestedAction && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${shellColor.cardBorder}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
                Suggested action
              </div>
              <div style={{ fontSize: 13.5, marginBottom: 10 }}>{row.detection.suggestedAction.text}</div>
              {row.detection.suggestedAction.kind !== "review" && (
                <button
                  style={shellButton(row.detection.suggestedAction.kind === "approve" ? "success" : "dangerOutline", "sm")}
                  onClick={row.detection.suggestedAction.kind === "approve" ? onApprove : onReject}
                  disabled={!match}
                >
                  Accept suggestion
                </button>
              )}
            </div>
          )}
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

      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Ledger impact</SectionLabel>
        <div style={{ fontSize: 13.5, lineHeight: 1.6, background: shellColor.page, borderRadius: 10, padding: "14px 16px" }}>
          {ledgerImpact({
            amount: bank.amount,
            currency: bank.currency,
            category: currentCategory,
            invoiceNumber: suggestion?.invoiceNumber,
            supplierName: suggestion?.supplierName,
            detectionKind: row.detection?.kind ?? null,
          }).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
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

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 28,
          position: "sticky",
          bottom: 0,
          background: shellColor.paper,
          paddingTop: 14,
          paddingBottom: 14,
          borderTop: `1px solid ${shellColor.cardBorder}`,
        }}
      >
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
