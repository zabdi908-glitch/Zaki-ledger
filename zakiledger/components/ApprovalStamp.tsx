import { color, font } from "@/lib/theme";

/**
 * The signature moment: approving a document doesn't just print a green
 * sentence, it stamps it — the one deliberately theatrical element in an
 * otherwise quiet, paper-flat design. Everything else in the app stays
 * disciplined so this is the thing people remember.
 *
 * Pure CSS: a rotated double-ring box in ink-stamp red, animated in once via
 * the `zl-stamp` keyframe in app/globals.css (which also holds the
 * prefers-reduced-motion override — the class exists precisely so that
 * override can win over an inline style without `!important`).
 */
export default function ApprovalStamp({ detail }: { detail?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <div className="zl-stamp" style={stampBox} aria-hidden="true">
        <span style={stampWord}>Approved</span>
        <span style={stampRule} />
        <span style={stampSub}>ZAKI LEDGER</span>
      </div>
      {detail && (
        <p style={{ margin: 0, fontSize: 14, color: color.inkSoft, flex: "1 1 220px", minWidth: 0 }}>
          {detail}
        </p>
      )}
    </div>
  );
}

const stampBox: React.CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "10px 20px",
  border: `3px solid ${color.stamp}`,
  borderRadius: 10,
  color: color.stamp,
  transform: "rotate(-4deg)",
  boxShadow: `0 0 0 3px ${color.paper}, 0 0 0 4px ${color.stamp}55`,
  flexShrink: 0,
};
const stampWord: React.CSSProperties = {
  fontFamily: font.display,
  fontWeight: 700,
  fontStyle: "italic",
  fontSize: 22,
  letterSpacing: "0.03em",
  lineHeight: 1,
};
const stampRule: React.CSSProperties = {
  width: "70%",
  height: 2,
  background: color.stamp,
  opacity: 0.5,
  margin: "5px 0",
};
const stampSub: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.16em",
  fontFamily: font.body,
};
