import { quickBooksConnectionStatus } from "./quickbooks";
import { xeroConnectionStatus } from "./xero";
import {
  getAverageConfidence,
  getMonthlyInvoiceCounts,
  listPendingDocuments,
  listRecentApprovedInvoices,
  recentCorrections,
} from "./store";
import { listRecentApprovedMatches } from "./reconciliation-store";

/**
 * Everything the Dashboard needs, computed from real data — see the plan's
 * "Fidelity vs. real-data gaps" section: the mockup's 245/+12%/fixed chart
 * bars/4 fixed activity strings are all invented numbers with no backing
 * source, so this replaces them with real aggregates instead of copying them
 * verbatim.
 */
export interface DashboardData {
  pendingCount: number;
  avgConfidencePct: number | null;
  extractedThisMonth: number;
  extractedDeltaPct: number | null;
  chartBars: { label: string; heightPct: number }[];
  accounting: { connected: boolean; label: string };
  recentActivity: { text: string; time: string }[];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = ms / 3_600_000;
  if (hours < 1) return "Just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

export async function getDashboardData(userId: string): Promise<DashboardData> {
  // Every source is independently fault-tolerant: this is the screen a user
  // lands on right after logging in, so one flaky query (a schema that
  // isn't provisioned yet, a transient auth hiccup) must degrade that one
  // stat/section to empty rather than 500 the whole page — the same
  // "secondary read never blocks the primary flow" rule the rest of the
  // app already follows (see e.g. refreshPending in the old app/page.tsx).
  const [pending, avgConfidence, monthly, corrections, invoices, matches, qbo, xero] = await Promise.all([
    listPendingDocuments(userId).catch(() => []),
    getAverageConfidence(userId).catch(() => null),
    getMonthlyInvoiceCounts(userId, 6).catch(() => []),
    recentCorrections(userId, 10).catch(() => []),
    listRecentApprovedInvoices(userId, 5).catch(() => []),
    // Reconciliation is a newer feature than the invoices/corrections tables
    // above — its schema may not be provisioned in every environment yet
    // (see the Phase 3 migration in db/schema.sql).
    listRecentApprovedMatches(userId, 5).catch(() => []),
    quickBooksConnectionStatus(userId).catch(() => ({ connected: false })),
    xeroConnectionStatus(userId).catch(() => ({ connected: false })),
  ]);

  const maxCount = Math.max(1, ...monthly.map((m) => m.count));
  const chartBars = monthly.map((m) => ({ label: m.label, heightPct: Math.round((m.count / maxCount) * 100) }));

  const thisMonth = monthly[monthly.length - 1]?.count ?? 0;
  const lastMonth = monthly[monthly.length - 2]?.count ?? 0;
  const extractedDeltaPct = lastMonth > 0 ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null;

  // Fall back to averaging the pending queue's confidences when there's no
  // approved-invoice history yet (getAverageConfidence needs Supabase +
  // approved invoices; a fresh account has neither).
  const avgConfidencePct =
    avgConfidence !== null
      ? Math.round(avgConfidence * 100)
      : pending.length > 0
        ? Math.round((pending.reduce((a, p) => a + p.extraction.overallConfidence, 0) / pending.length) * 100)
        : null;

  const activity = [
    ...corrections.map((c) => ({ text: `Corrected ${c.field} for ${c.supplierName}`, at: c.createdAt })),
    ...invoices.map((i) => ({ text: `Approved ${i.supplierName}`, at: i.createdAt })),
    ...matches.map((m) => ({ text: "Bank transaction reconciled", at: m.approvedAt })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 4)
    .map((a) => ({ text: a.text, time: relativeTime(a.at) }));

  const connected = qbo.connected || xero.connected;

  return {
    pendingCount: pending.length,
    avgConfidencePct,
    extractedThisMonth: thisMonth,
    extractedDeltaPct,
    chartBars,
    accounting: { connected, label: connected ? "Connected ✓" : "Not connected" },
    recentActivity: activity,
  };
}
