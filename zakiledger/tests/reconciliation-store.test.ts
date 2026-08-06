import { beforeAll, describe, expect, it } from "vitest";

/**
 * Exercises the in-memory fallback path (no SUPABASE_URL in the test env —
 * same convention as tests/user-isolation.test.ts). Each test uses its own
 * random userId since the in-memory store lives on `globalThis` for the
 * whole file (see lib/reconciliation-store.ts) and several lookups here
 * (e.g. QB transactions by date range) are scoped by userId rather than by
 * statement id, so a shared id would leak state between tests.
 */

beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const {
  saveBankStatement,
  saveQbTransactions,
  computeAndPersistMatches,
  createManualMatch,
  approveMatches,
  unapproveMatches,
  listMatchesForStatement,
  getReconciliationReport,
  getBankStatement,
  listQbTransactionsForPeriod,
} = await import("../lib/reconciliation-store");

function freshUser(): string {
  return crypto.randomUUID();
}

describe("bank reconciliation store (in-memory)", () => {
  it("runs the full flow: upload -> match -> approve -> report", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "statement.csv", "csv", {
      transactions: [
        {
          transactionDate: { value: "2026-07-15", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Vendor X", confidence: 1.0, reason: "test" },
          description: { value: "Vendor X", confidence: 1.0, reason: "test" },
          amount: { value: 100, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
        {
          // 10 days clear of the QB transaction's date below — outside even
          // the pending-clearance window, so this scores 0 on every axis
          // (amount, date, merchant) and stays genuinely unmatched rather
          // than becoming a low-confidence red match.
          transactionDate: { value: "2026-07-25", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Unrelated Merchant", confidence: 1.0, reason: "test" },
          description: { value: "Unrelated Merchant", confidence: 1.0, reason: "test" },
          amount: { value: 42, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
      ],
      openingBalance: 1000,
      closingBalance: 1058,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    expect(statement.transactionCount).toBe(2);

    await saveQbTransactions(userId, [
      {
        postedDate: "2026-07-15",
        amount: 100,
        description: "Vendor X",
      },
    ]);

    const computed = await computeAndPersistMatches(userId, statement.id);
    expect(computed.bankTransactions).toHaveLength(2);
    expect(computed.matches).toHaveLength(1); // only the Vendor X pair clears the threshold
    expect(computed.matches[0].flaggedLevel).toBe("green");
    expect(computed.unmatchedBankIds).toHaveLength(1); // the "Unrelated Merchant" line

    const report = await approveMatches(userId, statement.id, [computed.matches[0].id], userId);
    expect(report.totalMatched).toBe(100);
    expect(report.isReconciled).toBe(false); // one bank line is still unmatched — partial reconciliation

    const fetched = await getReconciliationReport(userId, statement.id);
    expect(fetched?.id).toBe(report.id);
  });

  it("createManualMatch overrides whatever auto-matching decided", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "statement.csv", "csv", {
      transactions: [
        {
          // Placed at the period start, with the QB side (below) at the
          // period end — 30 days apart, so date scores 0 too. Combined with
          // the amount/merchant mismatch, this pair scores 0 on every axis
          // and produces no auto candidate at all.
          transactionDate: { value: "2026-07-01", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Mystery Charge", confidence: 1.0, reason: "test" },
          description: { value: "Mystery Charge", confidence: 1.0, reason: "test" },
          amount: { value: 55, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
      ],
      openingBalance: null,
      closingBalance: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    await saveQbTransactions(userId, [
      { postedDate: "2026-07-31", amount: 999, description: "Something Else Entirely" }, // won't auto-match
    ]);

    const before = await computeAndPersistMatches(userId, statement.id);
    expect(before.matches).toHaveLength(0); // nothing clears the threshold

    const bankTxnId = before.bankTransactions[0].id;
    const qbTxns = await listQbTransactionsForPeriod(userId, "2026-07-01", "2026-07-31");
    const qbTxnId = qbTxns[0].id;

    const manual = await createManualMatch(userId, statement.id, bankTxnId, qbTxnId);
    expect(manual.matchedBy).toBe("manual");
    expect(manual.flaggedLevel).toBe("green");

    const after = await computeAndPersistMatches(userId, statement.id);
    expect(after.matches).toHaveLength(1);
    expect(after.matches[0].matchedBy).toBe("manual"); // untouched by the auto pass
  });

  it("keeps two users' statements and matches invisible to each other", async () => {
    const alice = freshUser();
    const bob = freshUser();

    const aliceStatement = await saveBankStatement(alice, "alice.csv", "csv", {
      transactions: [
        {
          transactionDate: { value: "2026-07-15", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Alice's Vendor", confidence: 1.0, reason: "test" },
          description: { value: "Alice's Vendor", confidence: 1.0, reason: "test" },
          amount: { value: 10, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
      ],
      openingBalance: null,
      closingBalance: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    const bobsView = await getBankStatement(bob, aliceStatement.id);
    expect(bobsView).toBeNull();
  });

  it("unapproveMatches clears approval and returns the count", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "statement.csv", "csv", {
      transactions: [
        {
          transactionDate: { value: "2026-07-15", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Vendor X", confidence: 1.0, reason: "test" },
          description: { value: "Vendor X", confidence: 1.0, reason: "test" },
          amount: { value: 100, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
      ],
      openingBalance: null,
      closingBalance: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    await saveQbTransactions(userId, [{ postedDate: "2026-07-15", amount: 100, description: "Vendor X" }]);
    const computed = await computeAndPersistMatches(userId, statement.id);
    const matchId = computed.matches[0].id;
    await approveMatches(userId, statement.id, [matchId], userId);

    const reverted = await unapproveMatches(userId, statement.id, [matchId]);
    expect(reverted).toBe(1);

    const matches = await listMatchesForStatement(userId, statement.id);
    const reopened = matches.find((m) => m.id === matchId);
    expect(reopened?.approvedAt).toBeNull();
    expect(reopened?.approvedBy).toBeNull();
  });

  it("generates audit memos for auto-matches and manual matches", async () => {
    const userId = freshUser();

    const statement = await saveBankStatement(userId, "statement.csv", "csv", {
      transactions: [
        {
          transactionDate: { value: "2026-07-15", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Vendor X", confidence: 1.0, reason: "test" },
          description: { value: "Vendor X", confidence: 1.0, reason: "test" },
          amount: { value: 100, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
        {
          // Won't auto-match — different amount, date, merchant
          transactionDate: { value: "2026-07-01", confidence: 1.0, reason: "test" },
          postedDate: null,
          merchant: { value: "Mystery Charge", confidence: 1.0, reason: "test" },
          description: { value: "Mystery Charge", confidence: 1.0, reason: "test" },
          amount: { value: 55, confidence: 1.0, reason: "test" },
          currency: "GBP",
          transactionId: null,
          memo: null,
        },
      ],
      openingBalance: null,
      closingBalance: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });

    await saveQbTransactions(userId, [
      { postedDate: "2026-07-15", amount: 100, description: "Vendor X" },
      { postedDate: "2026-07-31", amount: 999, description: "Something Else" },
    ]);

    const computed = await computeAndPersistMatches(userId, statement.id);
    expect(computed.matches).toHaveLength(1);

    // Auto-match should have a green audit memo
    const autoMatch = computed.matches[0];
    expect(autoMatch.auditMemo).not.toBeNull();
    expect(autoMatch.auditMemo?.category).toBe("PERFECT_MATCH");
    expect(autoMatch.auditMemo?.severity).toBe("info");

    // Create a manual match for the unmatched bank transaction
    const bankTxnId = computed.bankTransactions[1].id;
    const qbTxns = await listQbTransactionsForPeriod(userId, "2026-07-01", "2026-07-31");
    const qbTxnId = qbTxns[1].id;

    const manual = await createManualMatch(userId, statement.id, bankTxnId, qbTxnId);
    expect(manual.matchedBy).toBe("manual");
    expect(manual.auditMemo).not.toBeNull();
    expect(manual.auditMemo?.category).toBe("PERFECT_MATCH");
    expect(manual.auditMemo?.severity).toBe("info");
  });
});
