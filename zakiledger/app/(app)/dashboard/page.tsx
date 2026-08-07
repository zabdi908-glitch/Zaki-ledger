import { Suspense } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { getDashboardData } from "@/lib/dashboard";
import { pageSubtitle, pageTitle, shellButton, shellCard, shellColor } from "@/lib/shell-theme";
import MonthlyVolume from "@/components/dashboard/MonthlyVolume";
import AccountingTile from "@/components/dashboard/AccountingTile";

/**
 * Dashboard — server component, real aggregates (see lib/dashboard.ts) in
 * place of the mockup's fixed 245/+12%/60-72-68-85-78-100 numbers.
 *
 * ISR: regenerate at most once per minute. Dashboard summaries are stale-
 * tolerant, and 60s gives us a near-zero TTFB on cached hits.
 */
export const revalidate = 60;

export default async function DashboardPage() {
  const user = await getSessionUser();
  const data = await getDashboardData(user?.id ?? "demo-user");
  const monthLabel = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  const volumeData = data.chartBars.map((b) => ({ label: b.label, value: b.heightPct }));

  return (
    <div>
      <h1 style={pageTitle}>Dashboard</h1>
      <p style={pageSubtitle}>Overview for {monthLabel}</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 32 }}>
        <StatTile
          label="Items extracted"
          value={String(data.extractedThisMonth)}
          note={
            data.extractedDeltaPct !== null
              ? `${data.extractedDeltaPct >= 0 ? "↑" : "↓"} ${Math.abs(data.extractedDeltaPct)}% vs last month`
              : "This month"
          }
          noteColor={data.extractedDeltaPct !== null && data.extractedDeltaPct >= 0 ? "oklch(50% 0.14 155)" : shellColor.inkSoft}
        />
        <StatTile
          label="Pending review"
          value={String(data.pendingCount)}
          note={data.pendingCount > 0 ? "Needs your attention" : "All caught up"}
          noteColor="oklch(52% 0.15 80)"
        />
        <StatTile
          label="Avg. confidence"
          value={data.avgConfidencePct !== null ? `${data.avgConfidencePct}%` : "—"}
          note="Across all items"
          noteColor={shellColor.inkSoft}
        />
        <Suspense fallback={<StatTileSkeleton />}>
          <AccountingTile />
        </Suspense>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <MonthlyVolume data={volumeData} />
        <div style={shellCard({ padding: 24 })}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 16px" }}>Quick actions</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
            <Link href="/upload" style={{ ...shellButton("primary"), textAlign: "left", textDecoration: "none" }}>
              Upload invoices or receipts →
            </Link>
            <Link href="/batch" style={{ ...shellButton("outline"), textAlign: "left", textDecoration: "none" }}>
              Review {data.pendingCount} pending items →
            </Link>
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: shellColor.inkSoft }}>Recent activity</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {data.recentActivity.length === 0 && (
              <div style={{ fontSize: 13, color: shellColor.inkFaint }}>Nothing yet — upload your first document to get started.</div>
            )}
            {data.recentActivity.map((act, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: shellColor.ink }}>{act.text}</span>
                <span style={{ color: "oklch(60% 0.01 240)" }}>{act.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, note, noteColor }: { label: string; value: string; note: string; noteColor: string }) {
  return (
    <div style={{ background: shellColor.paper, border: `1px solid ${shellColor.cardBorder}`, borderRadius: 10, padding: 20 }}>
      <div style={{ fontSize: 13, color: shellColor.inkSoft, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "var(--font-mono)" }}>{value}</div>
      <div style={{ fontSize: 12.5, color: noteColor, marginTop: 4 }}>{note}</div>
    </div>
  );
}

function StatTileSkeleton() {
  return (
    <div style={{ background: shellColor.paper, border: `1px solid ${shellColor.cardBorder}`, borderRadius: 10, padding: 20 }}>
      <div style={{ height: 16, width: 90, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 8 }} />
      <div style={{ height: 32, width: 60, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 4 }} />
      <div style={{ height: 14, width: 120, background: shellColor.cardBorder, borderRadius: 4 }} />
    </div>
  );
}
