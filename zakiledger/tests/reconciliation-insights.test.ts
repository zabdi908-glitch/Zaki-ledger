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
} from "../lib/reconciliation-insights";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "../lib/reconciliation-schema";
import { syntheticStatement } from "./fixtures/statement";

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
    auditMemo: null,
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
    expect(suggestCategory(bank(), qb({ accountName: "Software & Hosting" }), [], []).label).toBe("Software & Hosting");
  });
  it("falls back to the most common category this merchant has been matched to before", () => {
    const priorMatch = match({ bankTransactionId: "b-other", qbTransactionId: "q-other" });
    const priorQb = qb({ id: "q-other", accountName: "Office Supplies" });
    const result = suggestCategory(bank({ id: "b2", merchant: "AWS EMEA" }), null, [priorMatch], [priorQb]);
    expect(result.label).toBe("Office Supplies");
  });
  it("falls back to Uncategorised when there is nothing to go on", () => {
    expect(suggestCategory(bank({ merchant: "Totally New Merchant" }), null, [], []).label).toBe("Uncategorised");
  });
});

describe("learned and hardcoded category suggestions", () => {
  it("prefers a learned preference with 3+ approvals over the hardcoded table", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
      preferences: [{ merchantName: "shell 4471", category: "Fuel", approvalCount: 4, lastApproved: "2026-07-01" }],
    });
    expect(rows[0].row.categoryLabel).toBe("Fuel (learned from 4 approvals)");
  });
  it("falls back to the hardcoded UK table below 3 approvals", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
      preferences: [{ merchantName: "shell 4471", category: "Fuel", approvalCount: 2, lastApproved: "2026-07-01" }],
    });
    expect(rows[0].row.categoryLabel).toBe("Motor Expenses (94% suggested)");
  });
});

describe("AI merchant-category fallback", () => {
  it("uses the AI cache when the hardcoded table has nothing", () => {
    const ai = new Map([["totally new merchant", { category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "Totally New Merchant" })], qbTransactions: [], matches: [],
      aiCategories: ai,
    });
    expect(rows[0].row.categoryLabel).toBe("Software & SaaS (88% AI suggested)");
    expect(rows[0].row.categoryReason).toBe("Recurring SaaS billing name.");
  });

  it("prefers the hardcoded table over an AI suggestion when both exist", () => {
    const shellAi = new Map([["shell 4471", { category: "Software & SaaS", confidencePct: 60, reason: "Ambiguous name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
      aiCategories: shellAi,
    });
    expect(rows[0].row.categoryLabel).toBe("Motor Expenses (94% suggested)");
    expect(rows[0].row.categoryReason).toBeUndefined();
  });

  it("falls through to plain Uncategorised when the AI itself couldn't tell", () => {
    const unknownAi = new Map([["totally new merchant", { category: "Uncategorised", confidencePct: 0, reason: "No signal in the name." }]]);
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "Totally New Merchant" })], qbTransactions: [], matches: [],
      aiCategories: unknownAi,
    });
    expect(rows[0].row.categoryLabel).toBe("Uncategorised");
    expect(rows[0].row.categoryReason).toBeUndefined();
  });

  it("leaves categoryReason unset for rows resolved by any other tier", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1", merchant: "SHELL 4471" })], qbTransactions: [], matches: [],
    });
    expect(rows[0].row.categoryReason).toBeUndefined();
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
  it("routes a detected pattern to its own section ahead of the match score", () => {
    expect(sectionFor(match({ flaggedLevel: "red" }), false, "reversal")).toBe("reversal");
    expect(sectionFor(match({ flaggedLevel: "red" }), false, "refund")).toBe("refund");
    expect(sectionFor(match({ flaggedLevel: "red" }), false, "split")).toBe("split");
  });
  it("keeps a confidently matched transfer in ready rather than pulling it out", () => {
    expect(sectionFor(match({ flaggedLevel: "green" }), false, null, ["Transfer"])).toBe("ready");
  });
  it("routes unmatched transfers and recurring charges to their sections", () => {
    expect(sectionFor(null, false, null, ["Transfer"])).toBe("transfer");
    expect(sectionFor(null, false, null, ["Recurring"])).toBe("recurring");
  });
  it("still puts a duplicate in the duplicate section even when a pattern was found", () => {
    expect(sectionFor(match(), true, "refund")).toBe("duplicate");
  });
});

describe("buildReviewRows detections", () => {
  it("explains a reversal pair with a net effect of zero and no leftover issue rows", () => {
    const a = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1003", amount: -1750, transactionDate: "2026-06-02" });
    const b = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1003", amount: 1750, transactionDate: "2026-06-04" });
    const rows = buildReviewRows({ bankTransactions: [a, b], qbTransactions: [], matches: [] });
    expect(rows.map((r) => r.row.section)).toEqual(["reversal", "reversal"]);
    expect(rows[0].row.detection?.title).toBe("Possible reversal");
    expect(rows[0].row.detection?.footer).toEqual({ label: "Net effect", value: "£0.00" });
  });

  it("explains a refund using the original charge", () => {
    const charge = bank({ id: "b1", merchant: "AMZN MKTPLACE UK", amount: 123.45, transactionDate: "2026-06-02" });
    const refund = bank({ id: "b2", merchant: "REFUND AMAZON", amount: -123.45, transactionDate: "2026-06-09" });
    const rows = buildReviewRows({ bankTransactions: [charge, refund], qbTransactions: [], matches: [] });
    expect(rows.every((r) => r.row.section === "refund")).toBe(true);
    expect(rows[0].row.detection?.lines).toContainEqual({ label: "Original charge", value: "£123.45" });
    expect(rows[0].row.detection?.evidence).toContain("Amounts match exactly.");
  });

  it("groups a split payment and shows the combined amount", () => {
    const a = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1001", amount: -1000, transactionDate: "2026-06-02" });
    const b = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1001", amount: -500, transactionDate: "2026-06-06" });
    const rows = buildReviewRows({ bankTransactions: [a, b], qbTransactions: [], matches: [] });
    expect(rows.every((r) => r.row.section === "split")).toBe(true);
    expect(rows[0].row.detection?.footer).toEqual({ label: "Total received", value: "£1500.00" });
  });

  it("duplicate detection suggests rejecting the second transaction", () => {
    const dupeA = bank({ id: "b1", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const dupeB = bank({ id: "b2", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const rows = buildReviewRows({ bankTransactions: [dupeA, dupeB], qbTransactions: [], matches: [] });
    const det = rows[0].row.detection;
    expect(det?.suggestedAction?.kind).toBe("reject");
    expect(det?.suggestedAction?.text).toMatch(/second transaction|likely.*duplicate/i);
  });

  it("reversal detection suggests approving both as nil net effect", () => {
    const revA = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1003", amount: -1750, transactionDate: "2026-06-02" });
    const revB = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1003", amount: 1750, transactionDate: "2026-06-04" });
    const rows = buildReviewRows({ bankTransactions: [revA, revB], qbTransactions: [], matches: [] });
    expect(rows[0].row.detection?.suggestedAction?.kind).toBe("approve");
  });

  it("never shows an accountant how the resemblance was measured", () => {
    const a = bank({ id: "b1", merchant: "MICROSOFT 365", amount: 12, transactionDate: "2026-06-02" });
    const b = bank({ id: "b2", merchant: "MICROSOFT*365", amount: 40, transactionDate: "2026-06-20" });
    const rows = buildReviewRows({ bankTransactions: [a, b], qbTransactions: [], matches: [] });
    const copy = JSON.stringify(rows).toLowerCase();
    for (const jargon of ["levenshtein", "dice", "fuzzy", "edit distance", "token"]) {
      expect(copy).not.toContain(jargon);
    }
    expect(rows[0].row.detection?.title).toBe("Possible related merchant");
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

/**
 * Approving reconciles a bank line against an accounting entry, so a line with
 * no match has nothing to approve. The review page filters those out before
 * calling the approve endpoint — if the row does not also say it is
 * unapprovable, the button renders enabled and does nothing when clicked.
 */
describe("rows report whether approving them can do anything", () => {
  it("marks a matched transaction approvable", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank()],
      qbTransactions: [qb()],
      matches: [match()],
    });
    expect(rows[0].matchId).toBe("m1");
    expect(rows[0].row.approvable).toBe(true);
  });

  it("marks a transaction with no accounting entry unapprovable, with a reason", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b9", merchant: "UNKNOWN VENDOR" })],
      qbTransactions: [],
      matches: [],
    });
    expect(rows[0].matchId).toBeNull();
    expect(rows[0].row.approvable).toBe(false);
    expect(rows[0].row.notApprovableReason).toBeTruthy();
  });

  it("keeps matchId and approvable consistent across a mixed statement", () => {
    const rows = buildReviewRows({
      bankTransactions: [bank({ id: "b1" }), bank({ id: "b2", merchant: "NO MATCH LTD", amount: 55 })],
      qbTransactions: [qb()],
      matches: [match({ bankTransactionId: "b1" })],
    });
    for (const r of rows) expect(r.row.approvable).toBe(r.matchId !== null);
  });
});

describe("buildReviewRows cost on a full statement", () => {
  it("stays well inside a frame budget for 400 transactions", () => {
    const bankTransactions = syntheticStatement(400);
    const qbTransactions = Array.from({ length: 400 }, (_, i) => qb({ id: `q${i}`, amount: 100 + i }));
    const matches = bankTransactions.map((b, i) =>
      match({ id: `m${i}`, bankTransactionId: b.id, qbTransactionId: `q${i}` }),
    );
    const started = performance.now();
    buildReviewRows({ bankTransactions, qbTransactions, matches });
    // The per-row scans this replaced made the same input take seconds, which
    // is what made clicking a row feel like the button had not registered.
    expect(performance.now() - started).toBeLessThan(600);
  });
});
