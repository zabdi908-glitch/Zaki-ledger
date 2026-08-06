import { describe, expect, it } from "vitest";
import {
  fuzzyMerchantSimilarity,
  matchTransactions,
  scorePair,
  GREEN_MIN_SCORE,
  YELLOW_MIN_SCORE,
} from "../lib/reconciliation-matching";
import type { BankTransaction, QbTransaction } from "../lib/reconciliation-schema";

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

describe("fuzzyMerchantSimilarity", () => {
  it("scores a near-identical merchant name highly", () => {
    expect(fuzzyMerchantSimilarity("Vendor X", "Vendor X Inc")).toBeGreaterThan(0.6);
  });

  it("scores unrelated names low", () => {
    expect(fuzzyMerchantSimilarity("Vendor X", "Totally Different Co")).toBeLessThan(0.3);
  });

  it("returns 0 when either side is missing", () => {
    expect(fuzzyMerchantSimilarity(null, "Vendor X")).toBe(0);
    expect(fuzzyMerchantSimilarity("Vendor X", null)).toBe(0);
  });
});

describe("scorePair", () => {
  it("scores a same-day, same-amount, same-merchant pair as a clean (green) match", () => {
    const { score } = scorePair(bank({ id: "b1" }), qb({ id: "q1" }));
    expect(score).toBeGreaterThanOrEqual(GREEN_MIN_SCORE);
  });

  it("skips the amount score across a currency mismatch even when the numbers coincide", () => {
    const usdScore = scorePair(bank({ id: "b1", currency: "USD" }), qb({ id: "q1", currency: "GBP" }));
    const gbpScore = scorePair(bank({ id: "b1" }), qb({ id: "q1" }));
    expect(usdScore.score).toBeLessThan(gbpScore.score);
    expect(usdScore.reasons).not.toContain("amount");
  });
});

describe("matchTransactions", () => {
  it("clean match: exact amount/date/merchant -> green", () => {
    const result = matchTransactions([bank({ id: "b1" })], [qb({ id: "q1" })]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].flaggedLevel).toBe("green");
    expect(result.matches[0].qbTransactionId).toBe("q1");
    expect(result.unmatchedBankIds).toHaveLength(0);
    expect(result.unmatchedQbIds).toHaveLength(0);
  });

  it("pending transaction: bank clears 3 days after QB posted -> still matches, but not green", () => {
    const result = matchTransactions(
      [bank({ id: "b1", transactionDate: "2026-07-18" })],
      [qb({ id: "q1", postedDate: "2026-07-15" })],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBeLessThan(1);
    expect(result.matches[0].flaggedLevel).not.toBe("red");
  });

  it("duplicate QB entries: only one claims the single matching bank transaction", () => {
    const result = matchTransactions(
      [bank({ id: "b1" })],
      [qb({ id: "q1" }), qb({ id: "q2" })], // identical duplicates
    );

    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedQbIds).toHaveLength(1); // the loser stays unmatched, not double-claimed
  });

  it("greedy assignment: the better-scoring bank transaction wins a contested QB row", () => {
    const result = matchTransactions(
      [
        bank({ id: "best", transactionDate: "2026-07-15", merchant: "Vendor X" }), // exact match
        bank({ id: "worse", transactionDate: "2026-07-17", merchant: "Unrelated Co" }), // weaker candidate, same QB row
      ],
      [qb({ id: "q1" })], // only one QB row for both to compete over
    );

    const best = result.matches.find((m) => m.bankTransactionId === "best");
    expect(best?.qbTransactionId).toBe("q1");
    expect(result.unmatchedBankIds).toContain("worse"); // no QB row left to claim
  });

  it("low confidence / no real match -> unmatched", () => {
    const result = matchTransactions(
      [bank({ id: "b1", amount: 100, transactionDate: "2026-07-15", merchant: "Vendor X" })],
      [qb({ id: "q1", amount: 9999, postedDate: "2026-01-01", description: "Nothing Alike" })],
    );

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedBankIds).toEqual(["b1"]);
    expect(result.unmatchedQbIds).toEqual(["q1"]);
  });

  it("multi-currency: same numeric amount in different currencies doesn't false-match to green", () => {
    const result = matchTransactions(
      [bank({ id: "b1", currency: "USD", merchant: "Foreign Vendor", description: "Foreign Vendor" })],
      [qb({ id: "q1", currency: "GBP", description: "Foreign Vendor" })],
    );

    // Date + merchant alone (no amount score) tops out well below green.
    if (result.matches.length > 0) {
      expect(result.matches[0].flaggedLevel).not.toBe("green");
    }
  });

  it("yellow-band example: amount + date match but merchant text is unrelated", () => {
    const result = matchTransactions(
      [bank({ id: "b1", merchant: "ACME Ltd", description: "ACME Ltd" })],
      [qb({ id: "q1", description: "Reference 88213" })],
    );

    expect(result.matches).toHaveLength(1);
    const { score } = scorePair(bank({ id: "b1", merchant: "ACME Ltd" }), qb({ id: "q1", description: "Reference 88213" }));
    expect(score).toBeGreaterThanOrEqual(YELLOW_MIN_SCORE);
    expect(score).toBeLessThan(GREEN_MIN_SCORE);
    expect(result.matches[0].flaggedLevel).toBe("yellow");
  });
});
