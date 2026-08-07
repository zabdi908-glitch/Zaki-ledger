import { shellColor, shellCard } from "@/lib/shell-theme";

export default function DashboardLoading() {
  return (
    <div>
      <div style={{ height: 36, width: 180, background: shellColor.cardBorder, borderRadius: 6, marginBottom: 8 }} />
      <div style={{ height: 20, width: 220, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 32 }} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 32 }}>
        <StatTileSkeleton />
        <StatTileSkeleton />
        <StatTileSkeleton />
        <StatTileSkeleton />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <div style={shellCard({ padding: 24 })}>
          <div style={{ height: 20, width: 160, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 16 }} />
          <div style={{ height: 160, background: shellColor.cardBorder, borderRadius: 6 }} />
        </div>
        <div style={shellCard({ padding: 24 })}>
          <div style={{ height: 20, width: 100, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 16 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
            <div style={{ height: 36, background: shellColor.cardBorder, borderRadius: 6 }} />
            <div style={{ height: 36, background: shellColor.cardBorder, borderRadius: 6 }} />
          </div>
          <div style={{ height: 16, width: 90, background: shellColor.cardBorder, borderRadius: 4, marginBottom: 12 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ height: 18, background: shellColor.cardBorder, borderRadius: 4 }} />
            <div style={{ height: 18, background: shellColor.cardBorder, borderRadius: 4 }} />
            <div style={{ height: 18, background: shellColor.cardBorder, borderRadius: 4 }} />
            <div style={{ height: 18, background: shellColor.cardBorder, borderRadius: 4 }} />
          </div>
        </div>
      </div>
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