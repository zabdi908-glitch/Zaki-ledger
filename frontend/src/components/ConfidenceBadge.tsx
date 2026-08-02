interface Props {
  confidence: number;
  showLabel?: boolean;
}

export default function ConfidenceBadge({ confidence, showLabel = true }: Props) {
  let config = { bg: 'bg-red-100', text: 'text-red-700', label: 'Low', icon: '✕' };
  if (confidence >= 95) config = { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'High', icon: '✓' };
  else if (confidence >= 70) config = { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Medium', icon: '!' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${config.bg} ${config.text}`}>
      <span>{config.icon}</span>
      {showLabel && <span>{config.label} confidence</span>}
      <span className="font-mono">{confidence}%</span>
    </span>
  );
}
