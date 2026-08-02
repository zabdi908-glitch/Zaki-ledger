import type { ReviewSectionKey } from "@/components/review/ReviewBoard";

/** One source of truth for "how much work is left" — both the upload screen's
 * breakdown and the review screen's summary read from here, so the numbers an
 * accountant sees never disagree between screens. */
export function summarizeSections(rows: { row: { section: ReviewSectionKey } }[]) {
  const counts = new Map<ReviewSectionKey, number>();
  for (const r of rows) counts.set(r.row.section, (counts.get(r.row.section) ?? 0) + 1);
  const total = rows.length;
  const ready = counts.get("ready") ?? 0;
  return { counts, total, ready, readyPct: total === 0 ? 0 : Math.round((ready / total) * 100) };
}

export function estimateReviewSeconds(s: { ready: number; total: number }): number {
  return s.ready * 5 + (s.total - s.ready) * 25;
}

export function formatEstimate(seconds: number): string {
  if (seconds < 60) return "Est. under a minute to review & approve";
  return `Est. ~${Math.ceil(seconds / 60)} min to review & approve`;
}
