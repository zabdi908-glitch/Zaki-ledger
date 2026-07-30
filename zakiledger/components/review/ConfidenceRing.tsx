import { ringGeometry, shellColor } from "@/lib/shell-theme";

export default function ConfidenceRing({
  pct,
  size,
  stroke,
  color,
}: {
  pct: number;
  size: number;
  stroke: number;
  color: string;
}) {
  const { radius, circumference, dash } = ringGeometry(pct, size, stroke);
  const center = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={center} cy={center} r={radius} fill="none" stroke={shellColor.trackBg} strokeWidth={stroke} />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circumference}`}
      />
    </svg>
  );
}
