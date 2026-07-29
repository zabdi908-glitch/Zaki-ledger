import { shellColor } from "@/lib/shell-theme";

/** Shared "coming soon" screen for Auto-Categorize / Document Portal / Reports & Analytics. */
export default function ComingSoonStub({ phase, title, description }: { phase: string; title: string; description: string }) {
  return (
    <div style={{ maxWidth: 520, margin: "64px auto 0", textAlign: "center" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: shellColor.trackBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 20px",
          fontSize: 20,
          color: shellColor.inkFainter,
        }}
      >
        ⏳
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", color: shellColor.teal, textTransform: "uppercase", marginBottom: 10 }}>
        {phase} · Coming soon
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 12px" }}>{title}</h1>
      <p style={{ fontSize: 15, color: shellColor.inkSoft, lineHeight: 1.5, margin: 0 }}>{description}</p>
    </div>
  );
}
