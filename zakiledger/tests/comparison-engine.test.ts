import { describe, expect, it } from "vitest";
import { compareBankToQb } from "@/lib/comparison-engine";
import type { BankTransaction, QbTransaction } from "@/lib/reconciliation-schema";

function bank(overrides: Partial<BankTransaction> & Pick<BankTransaction, "id">): BankTransaction {
  return {
    statementId: "stmt-1",
    transactionDate: "2026-07-15",
    postedDate: null,
    merchant: "Vendor X",
    description: "Vendor X",
    amount: 100,
    currency: "GBP",
    transactionId: null,
    memo: null,
    ...overrides,
  };
}

function qb(overrides: Partial<QbTransaction> & Pick<QbTransaction, "id">): QbTransaction {
  return {
    qbTransactionId: null,
    qbAccountId: null,
    postedDate: "2026-07-15",
    amount: 100,
    description: "Vendor X",
    accountName: null,
    accountType: null,
    currency: "GBP",
    ...overrides,
  };
}

describe("compareBankToQb", () => {
  it("exact match: amount within 1% and date within 5 days", () => {
    const result = compareBankToQb([bank({ id: "b1" })], [qb({ id: "q1" })]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("exact");
    expect(result.matches[0].confidence).toBe(1.0);
    expect(result.matches[0].bankTransaction.id).toBe("b1");
    expect(result.matches[0].qbTransaction.id).toBe("q1");
    expect(result.unmatchedItems).toHaveLength(0);
    expect(result.missingInBank).toHaveLength(0);
  });

  it("extra bank transaction appears in unmatchedItems", () => {
    const result = compareBankToQb(
      [bank({ id: "b1" }), bank({ id: "b2", amount: 999 })],
      [qb({ id: "q1" })],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedItems).toHaveLength(1);
    expect(result.unmatchedItems[0].transaction.id).toBe("b2");
    expect(result.unmatchedItems[0].source).toBe("bank");
  });

  it("extra QB transaction appears in missingInBank", () => {
    const result = compareBankToQb(
      [bank({ id: "b1" })],
      [qb({ id: "q1" }), qb({ id: "q2", amount: 999 })],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.missingInBank).toHaveLength(1);
    expect(result.missingInBank[0].entry.id).toBe("q2");
    expect(result.missingInBank[0].source).toBe("qb");
  });

  it("fuzzy_date: amount matches within 1% but date differs beyond 5 days", () => {
    const result = compareBankToQb(
      [bank({ id: "b1", transactionDate: "2026-07-20" })],
      [qb({ id: "q1", postedDate: "2026-07-01" })],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe("fuzzy_date");
    expect(result.matches[0].confidence).toBe(0.75);
  });

  it("amount mismatch: date and merchant match but amount differs >1% and <5%", () => {
    const result = compareBankToQb(
      [bank({ id: "b1", amount: 103 })],
      [qb({ id: "q1", amount: 100 })],
    );

    expect(result.matches).toHaveLength(0);
    expect(result.amountMismatches).toHaveLength(1);
    expect(result.amountMismatches[0].bankTransaction.id).toBe("b1");
    expect(result.amountMismatches[0].qbTransaction.id).toBe("q1");
    expect(result.amountMismatches[0].difference).toBe(3);
  });

  it("duplicate transaction: two bank txns matching the same QB txn", () => {
    const result = compareBankToQb(
      [bank({ id: "b1" }), bank({ id: "b2", transactionDate: "2026-07-16" })],
      [qb({ id: "q1" })],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].source).toBe("bank");
  });

  it("date filter excludes out-of-range transactions from both sides", () => {
    const result = compareBankToQb(
      [
        bank({ id: "b1", transactionDate: "2026-07-15" }),
        bank({ id: "b2", transactionDate: "2026-08-01" }),
      ],
      [
        qb({ id: "q1", postedDate: "2026-07-15" }),
        qb({ id: "q2", postedDate: "2026-08-01" }),
      ],
      { dateStart: "2026-07-01", dateEnd: "2026-07-31" },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].bankTransaction.id).toBe("b1");
    expect(result.matches[0].qbTransaction.id).toBe("q1");
    expect(result.unmatchedItems).toHaveLength(0);
    expect(result.missingInBank).toHaveLength(0);
  });

  it("empty arrays produce empty result", () => {
    const result = compareBankToQb([], []);

    expect(result.matches).toHaveLength(0);
    expect(result.missingInBank).toHaveLength(0);
    expect(result.unmatchedItems).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.amountMismatches).toHaveLength(0);
    expect(result.summary).toContain("Matched: 0");
  });
});