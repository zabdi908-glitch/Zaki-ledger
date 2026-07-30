import { describe, expect, it } from "vitest";
import {
  buildReviewRows,
  confidenceLabel,
  detectBadges,
  detectDuplicates,
  factorBreakdown,
  plainEnglishReason,
  sectionFor,
  suggestCategory,
} from "@/lib/reconciliation-insights";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "@/lib/reconciliation-schema";

function bank(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "b1",
    statementId: "s1",
    transactionDate: "2026-06-02",
    postedDate: null,
    merchant: "AWS EMEA",
    description: null,
    amount: 412.18,
    currency: "GBP",
    transactionId: null,
    memo: null,
    ...overrides,
  };
}
function qb(overrides: Partial<QbTransaction> = {}): QbTransaction {
  return {
    id: "q1",
    qbTransactionId: null,
    qbAccountId: null,
    postedDate: "2026-06-01",
    amount: 412.18,
    description: "AWS EMEA hosting",
    accountName: "Software & Hosting",
    accountType: "Expense",
    currency: "GBP",
    ...overrides,
  };
}
function match(overrides: Partial<ReconciliationMatch> = {}): ReconciliationMatch {
  return {
    id: "m1",
    statementId: "s1",
    bankTransactionId: "b1",
    qbTransactionId: "q1",
    confidence: 0.99,
    matchReason: "amount + date + merchant",
    flaggedLevel: "green",
    matchedBy: "auto",
    matchedAt: "2026-06-02T00:00:00Z",
    approvedBy: null,
    approvedAt: null,
    ...overrides,
  };
}

describe("confidenceLabel", () => {
  it("labels 99% as Exact match", () => expect(confidenceLabel(99)).toBe("Exact match"));
  it("labels 92% as Strong match", () => expect(confidenceLabel(92)).toBe("Strong match"));
  it("labels 75% as Review recommended", () => expect(confidenceLabel(75)).toBe("Review recommended"));
  it("labels 45% as Insufficient evidence", () => expect(confidenceLabel(45)).toBe("Insufficient evidence"));
});

describe("plainEnglishReason", () => {
  it("turns 'amount + date + merchant' into a full sentence", () => {
    const text = plainEnglishReason(match({ matchReason: "amount + date + merchant" }));
    expect(text.toLowerCase()).toContain("amount");
    expect(text.toLowerCase()).toContain("date");
    expect(text.toLowerCase()).toContain("merchant");
    expect(text.endsWith(".")).toBe(true);
  });
  it("mentions the specific factor when only one matched", () => {
    const text = plainEnglishReason(match({ matchReason: "amount" }));
    expect(text.toLowerCase()).toContain("amount");
    expect(text.toLowerCase()).not.toContain("merchant");
  });
  it("has a fallback sentence when there is no match at all", () => {
    const text = plainEnglishReason(match({ qbTransactionId: null, matchReason: null, confidence: null }));
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("detectBadges", () => {
  it("flags HMRC VAT payments", () => {
    expect(detectBadges(bank({ merchant: "HMRC VAT" }), [])).toContain("VAT");
  });
  it("flags payroll-looking merchants", () => {
    expect(detectBadges(bank({ merchant: "Tom's Payroll Ltd" }), [])).toContain("Payroll");
  });
  it("flags known subscription merchants", () => {
    expect(detectBadges(bank({ merchant: "Adobe Creative Cloud" }), [])).toContain("Subscription");
  });
  it("flags transfer-looking descriptions", () => {
    expect(detectBadges(bank({ merchant: null, description: "TRANSFER TO xx4471" }), [])).toContain("Transfer");
  });
  it("flags recurring when the same merchant appears more than once in the statement", () => {
    const all = [bank({ id: "b1" }), bank({ id: "b2" })];
    expect(detectBadges(all[0], all)).toContain("Recurring");
  });
  it("returns no badges for a plain one-off merchant", () => {
    const all = [bank({ merchant: "Sainsbury's Local" })];
    expect(detectBadges(bank({ merchant: "Sainsbury's Local", description: null }), all)).toEqual(
      expect.not.arrayContaining(["VAT", "Payroll", "Subscription", "Transfer"]),
    );
  });
});

describe("detectDuplicates", () => {
  it("pairs two transactions with the same merchant and amount on the same day", () => {
    const a = bank({ id: "b1", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const b = bank({ id: "b2", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const dupes = detectDuplicates([a, b]);
    expect(dupes.get("b1")?.id).toBe("b2");
    expect(dupes.get("b2")?.id).toBe("b1");
  });
  it("does not pair transactions with different amounts", () => {
    const a = bank({ id: "b1", amount: 18.4 });
    const b = bank({ id: "b2", amount: 22.0 });
    expect(detectDuplicates([a, b]).size).toBe(0);
  });
  it("does not pair a transaction with itself when it's the only one", () => {
    expect(detectDuplicates([bank()]).size).toBe(0);
  });
});

describe("suggestCategory", () => {
  it("uses the matched QB transaction's account name when there is a match", () => {
    expect(suggestCategory(bank(), qb({ accountName: "Software & Hosting" }), [], [])).toBe("Software & Hosting");
  });
  it("falls back to the most common category this merchant has been matched to before", () => {
    const priorMatch = match({ bankTransactionId: "b-other", qbTransactionId: "q-other" });
    const priorQb = qb({ id: "q-other", accountName: "Office Supplies" });
    const result = suggestCategory(bank({ id: "b2", merchant: "AWS EMEA" }), null, [priorMatch], [priorQb]);
    expect(result).toBe("Office Supplies");
  });
  it("falls back to Uncategorised when there is nothing to go on", () => {
    expect(suggestCategory(bank({ merchant: "Totally New Merchant" }), null, [], [])).toBe("Uncategorised");
  });
});

describe("factorBreakdown", () => {
  it("splits a full match reason into Amount/40, Date/35, Merchant/25", () => {
    const bd = factorBreakdown(match({ matchReason: "amount + date + merchant", confidence: 1 }));
    expect(bd).toEqual([
      { label: "Amount", score: 40, max: 40 },
      { label: "Date", score: 35, max: 35 },
      { label: "Merchant", score: 25, max: 25 },
    ]);
  });
  it("zeroes out a factor that isn't in the match reason", () => {
    const bd = factorBreakdown(match({ matchReason: "amount", confidence: 0.4 }));
    expect(bd.find((f) => f.label === "Date")?.score).toBe(0);
    expect(bd.find((f) => f.label === "Amount")?.score).toBe(40);
  });
});

describe("sectionFor", () => {
  it("puts a duplicate in the duplicate section regardless of confidence", () => {
    expect(sectionFor(match({ flaggedLevel: "green" }), true)).toBe("duplicate");
  });
  it("puts a green match in ready", () => {
    expect(sectionFor(match({ flaggedLevel: "green" }), false)).toBe("ready");
  });
  it("puts a yellow match in review", () => {
    expect(sectionFor(match({ flaggedLevel: "yellow" }), false)).toBe("review");
  });
  it("puts a red or missing match in issue", () => {
    expect(sectionFor(match({ flaggedLevel: "red" }), false)).toBe("issue");
    expect(sectionFor(null, false)).toBe("issue");
  });
});

describe("buildReviewRows", () => {
  it("produces one row per open bank transaction with a matching id", () => {
    const rows = buildReviewRows({ bankTransactions: [bank()], qbTransactions: [qb()], matches: [match()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("b1");
    expect(rows[0].matchId).toBe("m1");
    expect(rows[0].row.section).toBe("ready");
    expect(rows[0].row.amountLabel).toContain("412.18");
  });
  it("produces an issue row for an unmatched bank transaction", () => {
    const rows = buildReviewRows({ bankTransactions: [bank({ id: "b9" })], qbTransactions: [], matches: [] });
    expect(rows[0].row.section).toBe("issue");
    expect(rows[0].matchId).toBeNull();
  });
});
