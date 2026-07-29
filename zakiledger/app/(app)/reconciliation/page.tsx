"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useShellToast } from "@/components/AppShell";
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
 * There's no live QuickBooks/Xero sync yet (that's Phase 3 Session 2), so
 * the accounting side is a CSV import for now — the mockup doesn't show this
 * step at all, so it's folded in as a secondary card beneath the main
 * matched-summary card rather than disrupting the primary upload flow.
 */

type Stage = "idle" | "processing" | "matched";

export default function ReconciliationUploadPage() {
  const router = useRouter();
  const showToast = useShellToast();

  const [stage, setStage] = useState<Stage>("idle");
  const [statementId, setStatementId] = useState<string | null>(null);
  const [transactionCount, setTransactionCount] = useState(0);
  const [matchedCount, setMatchedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [qbCount, setQbCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [qbBusy, setQbBusy] = useState(false);
  const [qbError, setQbError] = useState<string | null>(null);

  async function refreshMatchCounts(id: string) {
    const res = await fetch(`/api/reconciliation/${id}/transactions`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Couldn't load matches.");
    const approved = (data.matches as { approvedAt: string | null }[]).filter((m) => m.approvedAt !== null).length;
    setMatchedCount(approved);
    setPendingCount(data.matches.length - approved + data.unmatchedBank.length);
    setQbCount(data.qbTransactions.length);
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
      const data = await res.json();
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
      const data = await res.json();
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
            <input type="file" accept=".csv,.ofx,.qfx" onChange={onUploadStatement} hidden />
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
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 20 }}>
              {matchedCount} matched ✓ · {pendingCount} need review ⚠
            </div>
            <button
              style={shellButton("primary", "lg")}
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
                  No live QuickBooks/Xero connection yet — import a CSV export for this period. {qbCount} on file.
                </p>
              </div>
              <label style={qbBusy ? { ...shellButton("outline"), ...disabledOverride() } : shellButton("outline")}>
                {qbBusy ? "Importing…" : "＋ Import CSV"}
                <input type="file" accept=".csv" onChange={onUploadQbCsv} hidden disabled={qbBusy} />
              </label>
            </div>
            {qbError && <p style={{ marginTop: 12, color: shellColor.low, fontSize: 13.5 }}>{qbError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
