import { describe, expect, it } from "vitest";
import {
  GREEN_MIN_SCORE,
  SUPERSEDE_MIN_DELTA,
  SUPERSEDE_MIN_NEW_SCORE,
  reservesQbClaim,
  shouldSupersedeAutoMatch,
  supersedeScoreFor,
} from "../lib/reconciliation-matching";
import type { MatchedBy } from "../lib/reconciliation-schema";

/**
 * Deterministic supersession / reservation rule (D2) — pure unit tests.
 *
 * The constants and helpers below are the single source of truth for the
 * "materially stronger later evidence" transition. The SQL implementation in
 * migration 013 (persist_auto_matches_v1) mirrors these numbers exactly, and
 * the DB-gated regression suite verifies the two stay in lock-step.
 *
 * Rule (from docs/RECONCILIATION_DEFECT_REMEDIATION_DESIGN.md):
 *   - reserved claims: approved rows, manual rows, live auto rows with
 *     round(confidence*100) >= 95 (green);
 *   - sub-green unapproved auto rows never reserve their QB row;
 *   - supersession: old is unapproved auto, new score >= 95, and
 *     new score - round(old confidence*100) >= 20.
 */

function auto(confidence: number | null, approved: boolean = false): {
  matchedBy: MatchedBy;
  approvedAt: string | null;
  confidence: number | null;
} {
  return {
    matchedBy: "auto",
    approvedAt: approved ? "2026-08-16T00:00:00.000Z" : null,
    confidence,
  };
}

describe("supersedeScoreFor", () => {
  it("converts confidence to score points with rounding", () => {
    expect(supersedeScoreFor(0.6)).toBe(60);
    expect(supersedeScoreFor(0.95)).toBe(95);
    expect(supersedeScoreFor(0.949)).toBe(95); // fp-noise guard: round, not truncate
    expect(supersedeScoreFor(null)).toBe(0);
  });
});

describe("reservesQbClaim", () => {
  it("approved rows always reserve (any origin)", () => {
    expect(reservesQbClaim(auto(0.6, true))).toBe(true);
    expect(
      reservesQbClaim({ matchedBy: "manual", approvedAt: "x", confidence: 0.1 }),
    ).toBe(true);
  });

  it("manual rows reserve regardless of approval", () => {
    expect(reservesQbClaim({ matchedBy: "manual", approvedAt: null, confidence: 0.6 })).toBe(true);
  });

  it("green auto rows reserve", () => {
    expect(reservesQbClaim(auto(0.95))).toBe(true);
    expect(reservesQbClaim(auto(1.0))).toBe(true);
  });

  it("sub-green unapproved auto rows do NOT reserve", () => {
    expect(reservesQbClaim(auto(0.6))).toBe(false);
    expect(reservesQbClaim(auto(0.944))).toBe(false); // round(94.4) = 94 < 95
    expect(reservesQbClaim(auto(null))).toBe(false);
  });
});

describe("shouldSupersedeAutoMatch (deterministic transition rule)", () => {
  it("weak red holder (60) is superseded by an exact candidate (100)", () => {
    expect(shouldSupersedeAutoMatch(auto(0.6), 100)).toBe(true);
  });

  it("boundary: delta of exactly SUPERSEDE_MIN_DELTA supersedes", () => {
    const newScore = 95;
    const old = 95 - SUPERSEDE_MIN_DELTA; // 75
    expect(shouldSupersedeAutoMatch(auto(old / 100), newScore)).toBe(true);
  });

  it("boundary: delta one point short does NOT supersede", () => {
    const newScore = 95;
    const old = 95 - SUPERSEDE_MIN_DELTA + 1; // 76 -> delta 19
    expect(shouldSupersedeAutoMatch(auto(old / 100), newScore)).toBe(false);
  });

  it("floor: new candidate below SUPERSEDE_MIN_NEW_SCORE never supersedes", () => {
    expect(shouldSupersedeAutoMatch(auto(0.5), SUPERSEDE_MIN_NEW_SCORE - 1)).toBe(false);
  });

  it("green holder is never superseded (equal candidates, delta 0)", () => {
    expect(shouldSupersedeAutoMatch(auto(0.95), 100)).toBe(false);
    expect(shouldSupersedeAutoMatch(auto(1.0), 100)).toBe(false);
  });

  it("a strong review-grade holder (90) is not churned out by a slightly stronger candidate", () => {
    // delta 10 < SUPERSEDE_MIN_DELTA — conservative by design
    expect(shouldSupersedeAutoMatch(auto(0.9), 100)).toBe(false);
  });

  it("approved rows are never superseded, whatever the score", () => {
    expect(shouldSupersedeAutoMatch(auto(0.2, true), 100)).toBe(false);
  });

  it("manual rows are never auto-superseded", () => {
    expect(
      shouldSupersedeAutoMatch({ matchedBy: "manual", approvedAt: null, confidence: 0.2 }, 100),
    ).toBe(false);
  });

  it("null old confidence counts as zero evidence", () => {
    expect(shouldSupersedeAutoMatch(auto(null), 100)).toBe(true);
  });

  it("constants are the documented values (keeps SQL in lock-step)", () => {
    expect(SUPERSEDE_MIN_NEW_SCORE).toBe(GREEN_MIN_SCORE);
    expect(SUPERSEDE_MIN_DELTA).toBe(20);
    expect(GREEN_MIN_SCORE).toBe(95);
  });
});
