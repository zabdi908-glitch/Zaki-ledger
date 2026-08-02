"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useShellToast } from "@/components/AppShell";
import ConnectionChip, { useConnectedProvider } from "@/components/ConnectionChip";
import { buildReviewRows } from "@/lib/reconciliation-insights";
import { estimateReviewSeconds, formatEstimate, summarizeSections } from "@/lib/review-summary";
import { SECTIONS } from "@/lib/review-sections";
import type { ReconciliationMatch } from "@/lib/reconciliation-schema";
import {
  disabledOverride,
  pageSubtitle,
  pageTitle,
  progressFill,
  progressTrack,
  shellButton,
  shellCard,
  shellColor,
  shellFigures,
} from "@/lib/shell-theme";

/**
 * Bank reconciliation, screen 1 of 3 — "Upload Statement" from
 * design_handoff_zaki_ledger/. Same idle -> processing -> matched pattern as
 * the mockup, but processing is a real upload + real matching-algorithm run
 * (see lib/reconciliation-store.ts computeAndPersistMatches), not a fake
 * timer.
 *
 * The accounting side (Step 2 below) live-syncs from Xero/QuickBooks when
 * connected (lib/xero.ts listXeroBankTransactions / lib/quickbooks.ts
 * listQuickBooksPurchases), falling back to CSV import when neither is
 * connected — the mockup doesn't show this step at all, so it's folded in
 * as a secondary card beneath the main matched-summary card rather than
 * disrupting the primary upload flow.
 */

type Stage = "idle" | "processing" | "matched";

export default function ReconciliationUploadPage() {
  const router = useRouter();
  const showToast = useShellToast();

  const [stage, setStage] = useState<Stage>("idle");
  const [statementId, setStatementId] = useState<string | null>(null);
  const [transactionCount, setTransactionCount] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [qbCount, setQbCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ReturnType<typeof summarizeSections> | null>(null);

  const [qbBusy, setQbBusy] = useState(false);
  const [qbError, setQbError] = useState<string | null>(null);

  const connectedProviderRaw = useConnectedProvider();
  const connectedProvider = connectedProviderRaw === "loading" ? null : connectedProviderRaw;
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function refreshMatchCounts(id: string) {
    const res = await fetch(`/api/reconciliation/${id}/transactions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Couldn't load matches.");
    const matches = data.matches as ReconciliationMatch[];
    const approved = matches.filter((m) => m.approvedAt !== null).length;
    setMatchedCount(approved);
    setQbCount(data.qbTransactions.length);

    // Same open-rows filtering the review page's board memo does, so the
    // breakdown shown here always agrees with what the review screen shows.
    const openMatches = matches.filter((m) => m.approvedAt === null);
    const openBankIds = new Set([...openMatches.map((m) => m.bankTransactionId), ...(data.unmatchedBank as string[])]);
    const openBanks = data.bankTransactions.filter((b: { id: string }) => openBankIds.has(b.id));
    const built = buildReviewRows({
      bankTransactions: openBanks,
      qbTransactions: data.qbTransactions,
      matches: openMatches,
    });
    setSummary(summarizeSections(built));

    return data;
  }

  async function onUploadStatement(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setStage("processing");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/reconciliation/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Upload failed.");
        setStage("idle");
        return;
      }
      setStatementId(data.statementId);
      setTransactionCount(data.transactionCount);
      await refreshMatchCounts(data.statementId);
      setStage("matched");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setStage("idle");
    }
  }

  async function onSync() {
    if (!statementId) return;
    setSyncBusy(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/reconciliation/qb-transactions/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncError(data.error ?? "Sync failed.");
        return;
      }
      showToast(`Synced ${data.imported} transaction${data.imported === 1 ? "" : "s"} from ${data.provider === "xero" ? "Xero" : "QuickBooks"}.`);
      await refreshMatchCounts(statementId);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function onUploadQbCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !statementId) return;

    setQbBusy(true);
    setQbError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/reconciliation/qb-transactions/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQbError(data.error ?? "Import failed.");
        return;
      }
      showToast(`Imported ${data.imported} transaction${data.imported === 1 ? "" : "s"}.`);
      await refreshMatchCounts(statementId);
    } catch (err) {
      setQbError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setQbBusy(false);
    }
  }

  return (
    <div>
      <h1 style={pageTitle}>Bank Reconciliation</h1>
      <p style={pageSubtitle}>Match bank transactions against your QuickBooks ledger</p>
      <ConnectionChip />

      {stage === "idle" && (
        <div>
          <label
            style={{
              display: "block",
              border: `2px dashed ${shellColor.cardBorder}`,
              borderRadius: 14,
              padding: "64px 24px",
              textAlign: "center",
              cursor: "pointer",
              background: shellColor.paper,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Drop your bank statement here</div>
            <div style={{ fontSize: 14, color: shellColor.inkSoft, marginBottom: 20 }}>
              CSV, OFX, or PDF — we&apos;ll match it against your QuickBooks entries
            </div>
            <span style={shellButton("primary", "lg")}>Choose statement</span>
            <input type="file" accept=".csv,.ofx,.qfx,.pdf" onChange={onUploadStatement} hidden />
          </label>
          {error && <p style={{ ...shellCard({ padding: "12px 16px", marginTop: 16 }), color: shellColor.low }}>{error}</p>}
        </div>
      )}

      {stage === "processing" && (
        <div style={shellCard({ padding: 48, textAlign: "center" })}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
            Matching {transactionCount || ""} transactions against QuickBooks…
          </div>
          <div style={{ ...progressTrack(), maxWidth: 420, margin: "0 auto" }}>
            <div style={progressFill(70)} />
          </div>
        </div>
      )}

      {stage === "matched" && statementId && (
        <div>
          <div style={shellCard({ padding: 32, marginBottom: 20 })}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>
              {transactionCount} transactions imported
            </div>
            {matchedCount > 0 && (
              <p style={{ margin: "0 0 12px", fontSize: 13.5, color: shellColor.inkSoft }}>{matchedCount} already approved</p>
            )}
            {summary && (
              <>
                <div style={{ ...progressTrack(), marginBottom: 6 }}>
                  <div style={progressFill(summary.readyPct)} />
                </div>
                <div style={{ fontSize: 13, color: shellColor.inkSoft, marginBottom: 16 }}>
                  {summary.readyPct}% ready to approve · {formatEstimate(estimateReviewSeconds(summary))}
                </div>
                {SECTIONS.filter((s) => (summary.counts.get(s.key) ?? 0) > 0).map((s) => (
                  <button
                    key={s.key}
                    onClick={() => router.push(`/reconciliation/review?statementId=${statementId}&section=${s.key}`)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                      padding: "10px 12px",
                      background: "transparent",
                      border: "none",
                      borderLeft: `3px solid ${s.accentColor}`,
                      marginBottom: 6,
                      cursor: "pointer",
                      fontSize: 14,
                      textAlign: "left",
                    }}
                  >
                    <span>{s.title}</span>
                    <b style={shellFigures}>{summary.counts.get(s.key)}</b>
                  </button>
                ))}
              </>
            )}
            <button
              style={{ ...shellButton("primary", "lg"), marginTop: 14 }}
              onClick={() => router.push(`/reconciliation/review?statementId=${statementId}`)}
            >
              Review matches
            </button>
          </div>

          <div style={shellCard({ padding: 24 })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: shellColor.inkFaint, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Accounting transactions
                </div>
                <p style={{ margin: "8px 0 0", color: shellColor.inkSoft, fontSize: 13.5, maxWidth: 460 }}>
                  {connectedProvider
                    ? `Live-synced from ${connectedProvider === "xero" ? "Xero" : "QuickBooks"}. ${qbCount} on file.`
                    : `No live QuickBooks/Xero connection yet — import a CSV export for this period. ${qbCount} on file.`}
                </p>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {connectedProvider && (
                  <button
                    style={syncBusy ? { ...shellButton("primary", "sm"), ...disabledOverride() } : shellButton("primary", "sm")}
                    onClick={onSync}
                    disabled={syncBusy}
                  >
                    {syncBusy ? "Syncing…" : `Sync from ${connectedProvider === "xero" ? "Xero" : "QuickBooks"}`}
                  </button>
                )}
                <label style={qbBusy ? { ...shellButton("outline", "sm"), ...disabledOverride() } : shellButton("outline", "sm")}>
                  {qbBusy ? "Importing…" : "＋ Import CSV"}
                  <input type="file" accept=".csv" onChange={onUploadQbCsv} hidden disabled={qbBusy} />
                </label>
              </div>
            </div>
            {qbError && <p style={{ marginTop: 12, color: shellColor.low, fontSize: 13.5 }}>{qbError}</p>}
            {syncError && <p style={{ marginTop: 12, color: shellColor.low, fontSize: 13.5 }}>{syncError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
