import { beforeAll, describe, expect, it } from "vitest";
import { matchTransactions, scorePair, fuzzyMerchantSimilarity } from "../lib/reconciliation-matching";
import { plainEnglishReason, factorBreakdown } from "../lib/reconciliation-insights";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "../lib/reconciliation-schema";

/**
 * Reconciliation correctness hardening — known-answer repro suite.
 *
 * The 12 bank rows + 1 QB-only row below mirror the controlled live test that
 * exposed matcher defects. Every test asserts the DESIRED accounting-safe
 * behavior using the REAL matching functions (no algorithm mocking), so the
 * first run of this file is expected to FAIL where the current code is wrong.
 *
 * R-number comments map to the hardening brief's required reproduction tests.
 */

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

/** The live known-answer fixture: 12 bank rows + 13 QB rows (incl. Parking Meter and the two 4FB smoke rows). */
const FIXTURE_BANK: BankTransaction[] = [
  bank({ id: "BANK-001", transactionDate: "2026-07-01", merchant: "ACME OFFICE SUPPLIES", amount: -125.4 }),
  bank({ id: "BANK-002", transactionDate: "2026-07-02", merchant: "UBER TRIP 8392", amount: -24.8 }),
  bank({ id: "BANK-003", transactionDate: "2026-07-05", merchant: "STRIPE PAYOUT 48391", amount: 950.0 }),
  bank({ id: "BANK-004", transactionDate: "2026-07-06", merchant: "ADOBE *CREATIVE CLOUD", amount: -54.99 }),
  bank({ id: "BANK-005", transactionDate: "2026-07-07", merchant: "TESCO STORES 4421", amount: -63.17 }),
  bank({ id: "BANK-006", transactionDate: "2026-07-08", merchant: "BRITISH TELECOM", amount: -89.5 }),
  bank({ id: "BANK-007", transactionDate: "2026-07-09", merchant: "TRAINLINE", amount: -42.6 }),
  bank({ id: "BANK-008", transactionDate: "2026-07-10", merchant: "AMAZON EU SARL", amount: -78.25 }),
  bank({ id: "BANK-009", transactionDate: "2026-07-11", merchant: "CLIENT PAYMENT NORTHSTAR LTD", amount: 1200.0 }),
  bank({ id: "BANK-010", transactionDate: "2026-07-12", merchant: "COFFEE SHOP CENTRAL", amount: -6.45 }),
  bank({ id: "BANK-011", transactionDate: "2026-07-13", merchant: "SOFTWARE SUBSCRIPTION XYZ", amount: -35.0 }),
  bank({ id: "BANK-012", transactionDate: "2026-07-14", merchant: "INSURANCE PREMIUM", amount: -210.0 }),
];

const FIXTURE_QB: QbTransaction[] = [
  qb({ id: "QB-001", postedDate: "2026-07-01", description: "Acme Office Supplies", amount: -125.4 }),
  qb({ id: "QB-002", postedDate: "2026-07-03", description: "Uber", amount: -24.8 }),
  qb({ id: "QB-003", postedDate: "2026-07-05", description: "Stripe", amount: 950.0 }),
  qb({ id: "QB-004", postedDate: "2026-07-06", description: "Adobe Creative Cloud", amount: -54.99 }),
  qb({ id: "QB-005", postedDate: "2026-07-07", description: "Tesco", amount: -61.17 }),
  qb({ id: "QB-006", postedDate: "2026-07-08", description: "BT Business", amount: -89.5 }),
  qb({ id: "QB-007", postedDate: "2026-07-09", description: "Trainline.com", amount: -42.6 }),
  qb({ id: "QB-009", postedDate: "2026-07-11", description: "Northstar Ltd", amount: 1200.0 }),
  qb({ id: "QB-010", postedDate: "2026-07-12", description: "Coffee Shop", amount: -6.45 }),
  qb({ id: "QB-011", postedDate: "2026-07-13", description: "Software Subscription XYZ", amount: -35.5 }),
  qb({ id: "QB-012", postedDate: "2026-07-14", description: "Insurance Premium", amount: -210.0 }),
  qb({ id: "QB-ONLY-001", postedDate: "2026-07-10", description: "Parking Meter", amount: -12.0 }),
  qb({ id: "4FB-A", postedDate: "2026-07-16", description: "4FB-CANONICAL-TEST A", amount: 5.0 }),
  qb({ id: "4FB-B", postedDate: "2026-07-16", description: "4FB-CANONICAL-TEST B", amount: -5.0 }),
];

function matchByIds(result: ReturnType<typeof matchTransactions>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of result.unmatchedBankIds) map.set(b, null);
  for (const m of result.matches) map.set(m.bankTransactionId, m.qbTransactionId);
  return map;
}

function expectFixture(
  result: ReturnType<typeof matchTransactions>,
  assignments: Record<string, string | null>,
): void {
  const byBank = matchByIds(result);
  for (const [bankId, qbId] of Object.entries(assignments)) {
    expect(byBank.get(bankId), `bank ${bankId}`).toBe(qbId);
  }
  expect(result.matches.length + result.unmatchedBankIds.length).toBe(FIXTURE_BANK.length);
}

describe("R1-R7: known-answer fixture (matcher level)", () => {
  it("R1: Amazon must NOT take QB-009 Northstar — junk candidate must stay unmatched", () => {
    const result = matchTransactions(
      [bank({ id: "BANK-008", transactionDate: "2026-07-10", merchant: "AMAZON EU SARL", amount: -78.25 })],
      [qb({ id: "QB-009", postedDate: "2026-07-13", description: "Northstar Ltd", amount: 1200.0 })],
    );
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedBankIds).toEqual(["BANK-008"]);
    expect(result.unmatchedQbIds).toEqual(["QB-009"]);
  });

  it("R2/R3: Northstar +1200 selects QB-009, Coffee -6.45 selects QB-010", () => {
    const result = matchTransactions(FIXTURE_BANK, FIXTURE_QB);
    const byBank = matchByIds(result);
    expect(byBank.get("BANK-009")).toBe("QB-009");
    expect(byBank.get("BANK-010")).toBe("QB-010");
  });

  it("R7: 4FB test rows never displace stronger in-scope candidates", () => {
    const result = matchTransactions(FIXTURE_BANK, FIXTURE_QB);
    const byBank = matchByIds(result);
    expect(byBank.get("BANK-009")).not.toBe("4FB-A");
    expect(byBank.get("BANK-009")).not.toBe("4FB-B");
    expect(byBank.get("BANK-010")).not.toBe("4FB-A");
    expect(byBank.get("BANK-010")).not.toBe("4FB-B");
    expect(result.matches.some((m) => m.qbTransactionId === "4FB-A")).toBe(false);
    expect(result.matches.some((m) => m.qbTransactionId === "4FB-B")).toBe(false);
  });

  it("full fixture: expected assignment matrix", () => {
    const result = matchTransactions(FIXTURE_BANK, FIXTURE_QB);
    expectFixture(result, {
      "BANK-001": "QB-001", // ACME -> Acme, exact
      "BANK-002": "QB-002", // Uber, date-shifted
      "BANK-003": "QB-003", // Stripe
      "BANK-004": "QB-004", // Adobe
      "BANK-005": "QB-005", // Tesco, amount mismatch -> review
      "BANK-006": "QB-006", // BT
      "BANK-007": "QB-007", // Trainline
      "BANK-008": null, // Amazon -> UNMATCHED
      "BANK-009": "QB-009", // Northstar
      "BANK-010": "QB-010", // Coffee
      "BANK-011": "QB-011", // Software, amount mismatch -> review
      "BANK-012": "QB-012", // Insurance
    });
    expect(result.unmatchedQbIds).toContain("QB-ONLY-001"); // Parking Meter QB-only
    expect(result.unmatchedQbIds).toContain("4FB-A");
    expect(result.unmatchedQbIds).toContain("4FB-B");
  });

  it("R4/R5: a QB row is assigned at most once within a run", () => {
    const qbIds = new Set<string>();
    const result = matchTransactions(FIXTURE_BANK, FIXTURE_QB);
    for (const m of result.matches) {
      expect(qbIds.has(m.qbTransactionId!)).toBe(false);
      qbIds.add(m.qbTransactionId!);
    }
  });

  it("R6: reordering bank input rows must not change assignments", () => {
    const original = matchTransactions(FIXTURE_BANK, FIXTURE_QB);
    const reversed = matchTransactions([...FIXTURE_BANK].reverse(), FIXTURE_QB);
    const shuffled = matchTransactions(
      [...FIXTURE_BANK].sort((a, b) => b.amount - a.amount), // amount order: another deterministic permutation
      FIXTURE_QB,
    );
    const qbReversed = matchTransactions(FIXTURE_BANK, [...FIXTURE_QB].reverse());
    const o = matchByIds(original);
    for (const [bankId, qbId] of o) {
      expect(matchByIds(reversed).get(bankId), `reversed ${bankId}`).toBe(qbId);
      expect(matchByIds(shuffled).get(bankId), `shuffled ${bankId}`).toBe(qbId);
      expect(matchByIds(qbReversed).get(bankId), `qb-reversed ${bankId}`).toBe(qbId);
    }
  });

  it("R6b: tied evidence resolves deterministically, not by input order", () => {
    // Two bank rows with identical evidence for one QB row. Whichever wins,
    // the result must not flip when the input order flips.
    const tiedBank = (id: string) => bank({ id, transactionDate: "2026-07-15", merchant: "Shared Co", amount: 100 });
    const sharedQb = qb({ id: "q1", postedDate: "2026-07-15", description: "Shared Co", amount: 100 });
    const ab = matchTransactions([tiedBank("A"), tiedBank("B")], [sharedQb]);
    const ba = matchTransactions([tiedBank("B"), tiedBank("A")], [sharedQb]);
    expect(matchByIds(ab)).toEqual(matchByIds(ba));
  });
});

describe("R9/R10: amount-mismatch safety", () => {
  it("R9: Tesco amount mismatch stays review-level, never green/auto-approved", () => {
    const { score } = scorePair(
      bank({ id: "BANK-005", transactionDate: "2026-07-07", merchant: "TESCO STORES 4421", amount: -63.17 }),
      qb({ id: "QB-005", postedDate: "2026-07-07", description: "Tesco", amount: -61.17 }),
    );
    expect(score).toBeLessThan(70);
    const result = matchTransactions(
      [bank({ id: "BANK-005", transactionDate: "2026-07-07", merchant: "TESCO STORES 4421", amount: -63.17 })],
      [qb({ id: "QB-005", postedDate: "2026-07-07", description: "Tesco", amount: -61.17 })],
    );
    expect(result.matches[0]?.flaggedLevel).not.toBe("green");
  });

  it("R10: Software amount mismatch stays review-level, never green/auto-approved", () => {
    const { score } = scorePair(
      bank({ id: "BANK-011", transactionDate: "2026-07-13", merchant: "SOFTWARE SUBSCRIPTION XYZ", amount: -35.0 }),
      qb({ id: "QB-011", postedDate: "2026-07-13", description: "Software Subscription XYZ", amount: -35.5 }),
    );
    expect(score).toBeLessThan(70);
  });

  it("sign mismatch earns no amount credit", () => {
    const { score } = scorePair(
      bank({ id: "b1", transactionDate: "2026-07-15", merchant: "ACME", amount: 100 }),
      qb({ id: "q1", postedDate: "2026-07-15", description: "ACME", amount: -100 }),
    );
    expect(score).toBeLessThan(95); // date + merchant only; the +100 vs -100 spread must not pass
  });
});

describe("R12: explanation truthfulness", () => {
  it("merchant (partial) is disclosed, not claimed as a full match", () => {
    const match: ReconciliationMatch = {
      id: "m1",
      statementId: "stmt-1",
      bankTransactionId: "BANK-003",
      qbTransactionId: "QB-003",
      confidence: 0.85,
      matchReason: "amount + date + merchant (partial)",
      flaggedLevel: "yellow",
      matchedBy: "auto",
      matchedAt: "2026-07-05T00:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
      auditMemo: null,
    };
    const text = plainEnglishReason(match);
    expect(text.toLowerCase()).not.toContain("merchant all match");
    expect(text.toLowerCase()).toContain("partially");
  });

  it("factor breakdown credits partial scores, not the max for each factor", () => {
    const match: ReconciliationMatch = {
      id: "m1",
      statementId: "stmt-1",
      bankTransactionId: "BANK-003",
      qbTransactionId: "QB-003",
      confidence: 0.85,
      matchReason: "amount + date + merchant (partial)",
      flaggedLevel: "yellow",
      matchedBy: "auto",
      matchedAt: "2026-07-05T00:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
      auditMemo: null,
    };
    const factors = factorBreakdown(match);
    const total = factors.reduce((s, f) => s + f.score, 0);
    expect(total).toBe(85); // 40 amount + 35 date + 10 partial merchant — not 100
    const merchantFactor = factors.find((f) => f.label === "Merchant");
    expect(merchantFactor?.score).toBe(10);
  });

  it("date (pending) is disclosed as pending, not a full date match", () => {
    const match: ReconciliationMatch = {
      id: "m1",
      statementId: "stmt-1",
      bankTransactionId: "b1",
      qbTransactionId: "q1",
      confidence: 0.5,
      matchReason: "amount + date (pending)",
      flaggedLevel: "red",
      matchedBy: "auto",
      matchedAt: "2026-07-05T00:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
      auditMemo: null,
    };
    const text = plainEnglishReason(match);
    expect(text.toLowerCase()).toContain("pending");
    const dateFactor = factorBreakdown(match).find((f) => f.label === "Date");
    expect(dateFactor?.score).toBe(15);
  });
});

/* ------------------------------------------------------------------ */
/* Adversarial cases — deterministic expected behavior                  */
/* ------------------------------------------------------------------ */

describe("adversarial matching cases", () => {
  it("1. two bank rows compete for one QB row: deterministic winner, loser unmatched", () => {
    const q = qb({ id: "q1", postedDate: "2026-07-15", description: "Shared Co", amount: 100 });
    const a = bank({ id: "A", transactionDate: "2026-07-15", merchant: "Shared Co", amount: 100 });
    const b = bank({ id: "B", transactionDate: "2026-07-15", merchant: "Shared Co", amount: 100 });

    for (const order of [[a, b], [b, a]] as const) {
      const result = matchTransactions([...order], [q]);
      const byBank = matchByIds(result);
      expect(byBank.get("A")).toBe("q1"); // deterministic: bankId asc breaks the tie
      expect(byBank.get("B")).toBeNull();
      expect(result.matches).toHaveLength(1);
    }
  });

  it("2. weak candidate never steals a QB row from an exact candidate", () => {
    const q = qb({ id: "q1", postedDate: "2026-07-15", description: "Exact Co", amount: 100 });
    const exact = bank({ id: "exact", transactionDate: "2026-07-15", merchant: "Exact Co", amount: 100 });
    const weak = bank({ id: "weak", transactionDate: "2026-07-15", merchant: "Something Else", amount: 100 });

    for (const order of [[exact, weak], [weak, exact]] as const) {
      const result = matchTransactions([...order], [q]);
      expect(matchByIds(result).get("exact")).toBe("q1");
      expect(result.unmatchedBankIds).toContain("weak");
    }
  });

  it("4. same amount and date but different merchant: review, not auto-approve", () => {
    const result = matchTransactions(
      [bank({ id: "b1", transactionDate: "2026-07-15", merchant: "Acme Ltd", amount: 100 })],
      [qb({ id: "q1", postedDate: "2026-07-15", description: "XYZ Corp", amount: 100 })],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].flaggedLevel).toBe("yellow"); // 40 amount + 35 date = 75
    expect(result.matches[0].flaggedLevel).not.toBe("green");
  });

  it("5. same merchant and date but wildly different amount: review, not auto-approve", () => {
    const result = matchTransactions(
      [bank({ id: "b1", transactionDate: "2026-07-15", merchant: "Shared Co", amount: 100 })],
      [qb({ id: "q1", postedDate: "2026-07-15", description: "Shared Co", amount: 9999 })],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].flaggedLevel).toBe("red"); // 25 merchant + 35 date = 60
    expect(result.matches[0].flaggedLevel).not.toBe("green");
    expect(result.matches[0].confidence).toBe(0.6);
  });

  it("6. debit vs credit sign mismatch never reaches green", () => {
    const result = matchTransactions(
      [bank({ id: "b1", transactionDate: "2026-07-15", merchant: "Acme", amount: 100 })],
      [qb({ id: "q1", postedDate: "2026-07-15", description: "Acme", amount: -100 })],
    );
    expect(result.matches[0]?.flaggedLevel).not.toBe("green");
  });

  it("date proximity alone is never a candidate (junk-date guard)", () => {
    const result = matchTransactions(
      [bank({ id: "b1", transactionDate: "2026-07-15", merchant: "Totally Unrelated Ltd", amount: 10 })],
      [qb({ id: "q1", postedDate: "2026-07-15", description: "Different Business", amount: 5000 })],
    );
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedBankIds).toEqual(["b1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Store level: two-phase upload simulation + cross-statement reuse    */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const {
  saveBankStatement,
  saveQbTransactions,
  computeAndPersistMatches,
  approveMatches,
  rejectMatch,
} = await import("../lib/reconciliation-store");

function freshUser(): string {
  return crypto.randomUUID();
}

function parsedTxn(
  date: string,
  description: string,
  amount: number,
): Parameters<typeof saveBankStatement>[3]["transactions"][number] {
  return {
    transactionDate: { value: date, confidence: 1.0, reason: "test" },
    postedDate: null,
    merchant: { value: description, confidence: 1.0, reason: "test" },
    description: { value: description, confidence: 1.0, reason: "test" },
    amount: { value: amount, confidence: 1.0, reason: "test" },
    currency: "GBP",
    transactionId: null,
    memo: null,
  };
}

describe("store: two-phase upload (live-test simulation)", () => {
  it("late-arriving QB data must not leave junk matches or a stolen QB row", async () => {
    const userId = freshUser();

    // Phase 1: bank statement uploaded; QB pool holds only the two 4FB smoke rows.
    const statement = await saveBankStatement(userId, "fixture.csv", "csv", {
      transactions: [
        parsedTxn("2026-07-10", "AMAZON EU SARL", -78.25),
        parsedTxn("2026-07-11", "CLIENT PAYMENT NORTHSTAR LTD", 1200.0),
        parsedTxn("2026-07-12", "COFFEE SHOP CENTRAL", -6.45),
      ],
      openingBalance: 0,
      closingBalance: 1115.3,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    await saveQbTransactions(userId, [
      { postedDate: "2026-07-16", amount: 5.0, description: "4FB-CANONICAL-TEST A" },
      { postedDate: "2026-07-16", amount: -5.0, description: "4FB-CANONICAL-TEST B" },
    ]);

    const phase1 = await computeAndPersistMatches(userId, statement.id);
    // No date-only junk: Northstar must not be welded to a 4FB smoke row.
    expect(phase1.matches).toHaveLength(0);
    expect(phase1.unmatchedBankIds).toHaveLength(3);

    // Phase 2: real QB data arrives (Northstar + Coffee).
    await saveQbTransactions(userId, [
      { postedDate: "2026-07-11", amount: 1200.0, description: "Northstar Ltd" },
      { postedDate: "2026-07-12", amount: -6.45, description: "Coffee Shop" },
    ]);

    const phase2 = await computeAndPersistMatches(userId, statement.id);
    const byBank = new Map(phase2.matches.map((m) => [m.bankTransactionId, m.qbTransactionId]));
    expect(byBank.size).toBe(2);
    expect(phase2.matches.some((m) => m.qbTransactionId?.startsWith("4FB"))).toBe(false);
    expect(phase2.unmatchedBankIds).toHaveLength(1); // Amazon stays unmatched
    expect(phase2.unmatchedQbIds).toHaveLength(2); // both 4FB rows stay unmatched
  });
});

describe("store: QB reuse across statements (R4/R5/R8)", () => {
  it("an approved QB row is not auto-reused by a later statement", async () => {
    const userId = freshUser();

    const statement1 = await saveBankStatement(userId, "s1.csv", "csv", {
      transactions: [parsedTxn("2026-07-15", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    await saveQbTransactions(userId, [{ postedDate: "2026-07-15", amount: 100, description: "Vendor X" }]);

    const run1 = await computeAndPersistMatches(userId, statement1.id);
    expect(run1.matches).toHaveLength(1);
    await approveMatches(userId, statement1.id, [run1.matches[0].id], userId);

    // Second statement, same period, another bank line with the same evidence.
    const statement2 = await saveBankStatement(userId, "s2.csv", "csv", {
      transactions: [parsedTxn("2026-07-16", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    const run2 = await computeAndPersistMatches(userId, statement2.id);

    // The QB row already carries an approved match — it must not be reused.
    expect(run2.matches).toHaveLength(0);
    expect(run2.unmatchedBankIds).toHaveLength(1);
  });

  it("an unapproved auto match also consumes its QB row (one-to-one)", async () => {
    const userId = freshUser();

    const statement1 = await saveBankStatement(userId, "s1.csv", "csv", {
      transactions: [parsedTxn("2026-07-15", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    await saveQbTransactions(userId, [{ postedDate: "2026-07-15", amount: 100, description: "Vendor X" }]);
    const run1 = await computeAndPersistMatches(userId, statement1.id);
    expect(run1.matches).toHaveLength(1);

    const statement2 = await saveBankStatement(userId, "s2.csv", "csv", {
      transactions: [parsedTxn("2026-07-16", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    const run2 = await computeAndPersistMatches(userId, statement2.id);
    expect(run2.matches).toHaveLength(0);
    expect(run2.unmatchedBankIds).toHaveLength(1);
  });

  it("8. rejecting a match frees its QB row for re-matching", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "s1.csv", "csv", {
      transactions: [parsedTxn("2026-07-15", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    await saveQbTransactions(userId, [{ postedDate: "2026-07-15", amount: 100, description: "Vendor X" }]);

    const run1 = await computeAndPersistMatches(userId, statement.id);
    expect(run1.matches).toHaveLength(1);
    await rejectMatch(userId, statement.id, run1.matches[0].id);

    const run2 = await computeAndPersistMatches(userId, statement.id);
    // The rejected pairing is gone, so auto-matching may propose it again.
    expect(run2.matches).toHaveLength(1);
  });

  it("9. a QB row outside the padded statement window is never a candidate", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "s1.csv", "csv", {
      transactions: [parsedTxn("2026-07-15", "Vendor X", 100)],
      openingBalance: 0,
      closingBalance: -100,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    await saveQbTransactions(userId, [{ postedDate: "2026-01-01", amount: 100, description: "Vendor X" }]);

    const run = await computeAndPersistMatches(userId, statement.id);
    expect(run.matches).toHaveLength(0);
    expect(run.unmatchedBankIds).toHaveLength(1);
  });
});
