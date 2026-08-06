import { describe, expect, it } from "vitest";
import { generateAuditMemos } from "../lib/audit-memo-generator";
import { AuditCategorySchema } from "../lib/audit-memo-schema";
import type { ProposedMatch, BankTransaction, QbTransaction } from "../lib/reconciliation-schema";

function match(overrides: Partial<ProposedMatch> & Pick<ProposedMatch, "bankTransactionId">): ProposedMatch {
  return {
    qbTransactionId: "qb-1",
    confidence: 0.95,
    matchReason: "Test match",
    flaggedLevel: "green",
    ...overrides,
  };
}

function bankTx(overrides: Partial<BankTransaction> & Pick<BankTransaction, "id">): BankTransaction {
  return {
    statementId: "stmt-1",
    transactionDate: "2026-07-15",
    postedDate: null,
    merchant: "ACME Ltd",
    description: "ACME Ltd",
    amount: 120,
    currency: "GBP",
    transactionId: null,
    memo: null,
    ...overrides,
  };
}

function qbTx(overrides: Partial<QbTransaction> & Pick<QbTransaction, "id">): QbTransaction {
  return {
    qbTransactionId: null,
    qbAccountId: null,
    postedDate: "2026-07-15",
    amount: 120,
    description: "ACME Ltd",
    accountName: null,
    accountType: null,
    currency: "GBP",
    ...overrides,
  };
}

describe("generateAuditMemos", () => {
  it("returns an empty array when given no matches", async () => {
    const memos = await generateAuditMemos([], [], []);
    expect(memos).toEqual([]);
  });

  it("demo mode green -> PERFECT_MATCH", async () => {
    const memos = await generateAuditMemos(
      [match({ bankTransactionId: "b1", flaggedLevel: "green" })],
      [bankTx({ id: "b1" })],
      [qbTx({ id: "qb-1" })],
    );

    expect(memos).toHaveLength(1);
    expect(memos[0].matchId).toBe("b1");
    expect(memos[0].category).toBe("PERFECT_MATCH");
    expect(memos[0].severity).toBe("info");
    expect(memos[0].matchedFields).toContain("amount");
    expect(memos[0].matchedFields).toContain("date");
    expect(memos[0].matchedFields).toContain("merchant");
    expect(memos[0].mismatchedFields).toHaveLength(0);
  });

  it("demo mode yellow -> FUZZY_MERCHANT", async () => {
    const memos = await generateAuditMemos(
      [match({ bankTransactionId: "b2", flaggedLevel: "yellow" })],
      [bankTx({ id: "b2" })],
      [qbTx({ id: "qb-2" })],
    );

    expect(memos).toHaveLength(1);
    expect(memos[0].matchId).toBe("b2");
    expect(memos[0].category).toBe("FUZZY_MERCHANT");
    expect(memos[0].severity).toBe("warning");
    expect(memos[0].matchedFields).toContain("amount");
    expect(memos[0].matchedFields).toContain("date");
    expect(memos[0].mismatchedFields).toContain("merchant");
  });

  it("demo mode red -> UNMATCHED", async () => {
    const memos = await generateAuditMemos(
      [match({ bankTransactionId: "b3", flaggedLevel: "red" })],
      [bankTx({ id: "b3" })],
      [qbTx({ id: "qb-3" })],
    );

    expect(memos).toHaveLength(1);
    expect(memos[0].matchId).toBe("b3");
    expect(memos[0].category).toBe("UNMATCHED");
    expect(memos[0].severity).toBe("critical");
    expect(memos[0].matchedFields).toHaveLength(0);
    expect(memos[0].mismatchedFields).toContain("amount");
    expect(memos[0].mismatchedFields).toContain("date");
    expect(memos[0].mismatchedFields).toContain("merchant");
  });

  it("produces only valid AuditCategory values", async () => {
    const inputs: ProposedMatch[] = [
      match({ bankTransactionId: "b1", flaggedLevel: "green" }),
      match({ bankTransactionId: "b2", flaggedLevel: "yellow" }),
      match({ bankTransactionId: "b3", flaggedLevel: "red" }),
    ];

    const memos = await generateAuditMemos(inputs, [], []);

    for (const memo of memos) {
      expect(() => AuditCategorySchema.parse(memo.category)).not.toThrow();
    }
  });

  it("handles multiple matches in one call", async () => {
    const memos = await generateAuditMemos(
      [
        match({ bankTransactionId: "b1", flaggedLevel: "green" }),
        match({ bankTransactionId: "b2", flaggedLevel: "yellow" }),
      ],
      [],
      [],
    );

    expect(memos).toHaveLength(2);
    expect(memos[0].category).toBe("PERFECT_MATCH");
    expect(memos[1].category).toBe("FUZZY_MERCHANT");
  });
});