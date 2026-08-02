import { describe, expect, it } from "vitest";
import { estimateReviewSeconds, formatEstimate, summarizeSections } from "../lib/review-summary";

const row = (section: string) => ({ row: { section } }) as never;

describe("summarizeSections", () => {
  it("counts per section and computes ready percentage", () => {
    const s = summarizeSections([row("ready"), row("ready"), row("issue"), row("duplicate")]);
    expect(s.counts.get("ready")).toBe(2);
    expect(s.counts.get("duplicate")).toBe(1);
    expect(s.total).toBe(4);
    expect(s.readyPct).toBe(50);
  });
  it("empty input gives zero percent, not NaN", () => {
    expect(summarizeSections([]).readyPct).toBe(0);
  });
});

describe("estimate", () => {
  it("5s per ready item, 25s per other open item", () => {
    expect(estimateReviewSeconds({ ready: 10, total: 14 })).toBe(10 * 5 + 4 * 25);
  });
  it("formats to whole minutes, rounding up", () => {
    expect(formatEstimate(150)).toBe("Est. ~3 min to review & approve");
    expect(formatEstimate(40)).toBe("Est. under a minute to review & approve");
  });
});
