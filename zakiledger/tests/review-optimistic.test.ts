import { describe, expect, it } from "vitest";
import { applyApprovals, applyRejection } from "../lib/review-optimistic";
import type { ReconciliationMatch } from "../lib/reconciliation-schema";

function match(id: string, bankId: string): ReconciliationMatch {
  return {
    id, statementId: "s1", bankTransactionId: bankId, qbTransactionId: `qb-${id}`,
    confidence: 0.98, matchReason: "amount + date + merchant", flaggedLevel: "green",
    matchedBy: "auto", matchedAt: "2026-08-01T00:00:00Z", approvedBy: null, approvedAt: null,
    auditMemo: null,
    supersededAt: null, supersededByMatchId: null, supersedeReason: null, supersedeOperationId: null,
  };
}

const data = {
  bankTransactions: [], qbTransactions: [],
  matches: [match("m1", "b1"), match("m2", "b2")],
  unmatchedBank: [], unmatchedQb: [],
};

describe("applyApprovals", () => {
  it("stamps approvedAt on the listed matches only", () => {
    const next = applyApprovals(data, ["m1"], "2026-08-01T12:00:00Z");
    expect(next.matches.find((m) => m.id === "m1")?.approvedAt).toBe("2026-08-01T12:00:00Z");
    expect(next.matches.find((m) => m.id === "m2")?.approvedAt).toBeNull();
  });
  it("does not mutate the input", () => {
    applyApprovals(data, ["m1"], "2026-08-01T12:00:00Z");
    expect(data.matches[0].approvedAt).toBeNull();
  });
});

describe("applyRejection", () => {
  it("removes the match and moves its bank transaction to unmatchedBank", () => {
    const next = applyRejection(data, "m1");
    expect(next.matches.map((m) => m.id)).toEqual(["m2"]);
    expect(next.unmatchedBank).toContain("b1");
  });
});
