import { beforeAll, describe, expect, it } from "vitest";
import type { ParsedStatement, QbTransactionInput } from "../lib/reconciliation-schema";

beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const {
  saveBankStatement,
  saveQbTransactions,
  listBankTransactions,
  listQbTransactionsForPeriod,
} = await import("../lib/reconciliation-store");

function user(): string {
  return crypto.randomUUID();
}

function statement(overrides: Partial<ParsedStatement> = {}): ParsedStatement {
  return {
    transactions: [
      {
        transactionDate: { value: "2026-08-01", confidence: 1, reason: "test" },
        postedDate: "2026-08-01",
        merchant: { value: "Tesco", confidence: 1, reason: "test" },
        description: { value: "Tesco store 1", confidence: 1, reason: "test" },
        amount: { value: 20, confidence: 1, reason: "test" },
        currency: "GBP",
        transactionId: null,
        memo: null,
      },
    ],
    openingBalance: null,
    closingBalance: null,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    currency: "GBP",
    ...overrides,
  };
}

function providerTransaction(overrides: Partial<QbTransactionInput> = {}): QbTransactionInput {
  return {
    provider: "quickbooks",
    organisationId: "realm-1",
    externalObjectType: "purchase",
    qbTransactionId: "external-1",
    qbAccountId: "account-1",
    postedDate: "2026-08-01",
    amount: 20,
    description: "Tesco",
    currency: "GBP",
    ...overrides,
  };
}

describe("transitional bank identity", () => {
  it("reuses an exact CSV artifact", async () => {
    const userId = user();
    const parsed = statement();
    const first = await saveBankStatement(userId, "a.csv", "csv", parsed, { sourceArtifactHash: "hash-a" });
    const second = await saveBankStatement(userId, "a.csv", "csv", parsed, { sourceArtifactHash: "hash-a" });

    expect(second.id).toBe(first.id);
    expect(await listBankTransactions(userId, first.id)).toHaveLength(1);
  });

  it("reuses a FITID across overlapping OFX statements and exposes it through both observations", async () => {
    const userId = user();
    const parsed = statement({
      sourceProvider: "ofx",
      sourceAccountId: "opaque-account-a",
      transactions: [{ ...statement().transactions[0], transactionId: "FIT-1" }],
    });
    const first = await saveBankStatement(userId, "july.ofx", "ofx", parsed, { sourceArtifactHash: "ofx-july" });
    const second = await saveBankStatement(userId, "august.ofx", "ofx", parsed, { sourceArtifactHash: "ofx-august" });

    const firstRows = await listBankTransactions(userId, first.id);
    const secondRows = await listBankTransactions(userId, second.id);
    expect(firstRows).toHaveLength(1);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].id).toBe(firstRows[0].id);
    expect(secondRows[0].statementId).toBe(second.id);
  });

  it("does not collide the same FITID across bank accounts or users", async () => {
    const firstUser = user();
    const secondUser = user();
    const forAccount = (sourceAccountId: string) =>
      statement({
        sourceProvider: "ofx",
        sourceAccountId,
        transactions: [{ ...statement().transactions[0], transactionId: "SHARED-FITID" }],
      });

    const a = await saveBankStatement(firstUser, "a.ofx", "ofx", forAccount("account-a"));
    const b = await saveBankStatement(firstUser, "b.ofx", "ofx", forAccount("account-b"));
    const otherUser = await saveBankStatement(secondUser, "a.ofx", "ofx", forAccount("account-a"));

    const [aRow] = await listBankTransactions(firstUser, a.id);
    const [bRow] = await listBankTransactions(firstUser, b.id);
    const [otherRow] = await listBankTransactions(secondUser, otherUser.id);
    expect(new Set([aRow.id, bRow.id, otherRow.id]).size).toBe(3);
  });

  it("does not auto-merge matching CSV rows across different artifacts without account identity", async () => {
    const userId = user();
    const first = await saveBankStatement(userId, "a.csv", "csv", statement(), { sourceArtifactHash: "csv-a" });
    const second = await saveBankStatement(userId, "b.csv", "csv", statement(), { sourceArtifactHash: "csv-b" });
    const [firstRow] = await listBankTransactions(userId, first.id);
    const [secondRow] = await listBankTransactions(userId, second.id);
    expect(secondRow.id).not.toBe(firstRow.id);
  });

  it("preserves genuinely repeated identical rows in one source", async () => {
    const userId = user();
    const row = statement().transactions[0];
    const saved = await saveBankStatement(userId, "repeat.csv", "csv", statement({ transactions: [row, row] }));
    const rows = await listBankTransactions(userId, saved.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });
});

describe("transitional accounting identity", () => {
  it.each([
    ["quickbooks", "realm-1", "purchase"],
    ["xero", "tenant-1", "bank_transaction"],
  ])("makes repeated %s sync idempotent", async (provider, organisationId, externalObjectType) => {
    const userId = user();
    const input = providerTransaction({ provider, organisationId, externalObjectType });
    expect(await saveQbTransactions(userId, [input])).toBe(1);
    expect(await saveQbTransactions(userId, [input])).toBe(0);
    expect(await listQbTransactionsForPeriod(userId, "2026-08-01", "2026-08-31")).toHaveLength(1);
  });

  it("separates equal external IDs by provider and organisation", async () => {
    const userId = user();
    await saveQbTransactions(userId, [
      providerTransaction({ provider: "quickbooks", organisationId: "realm-a", qbTransactionId: "same" }),
      providerTransaction({ provider: "xero", organisationId: "tenant-a", externalObjectType: "bank_transaction", qbTransactionId: "same" }),
      providerTransaction({ provider: "quickbooks", organisationId: "realm-b", qbTransactionId: "same" }),
    ]);
    expect(await listQbTransactionsForPeriod(userId, "2026-08-01", "2026-08-31")).toHaveLength(3);
  });

  it("reuses exact accounting CSV rows but keeps the same row from a different artifact", async () => {
    const userId = user();
    const row = providerTransaction({
      provider: null,
      organisationId: null,
      externalObjectType: null,
      qbTransactionId: null,
    });
    const options = { provider: "accounting_csv", externalObjectType: "csv_transaction", sourceArtifactHash: "csv-1" };
    expect(await saveQbTransactions(userId, [row], options)).toBe(1);
    expect(await saveQbTransactions(userId, [row], options)).toBe(0);
    expect(await saveQbTransactions(userId, [row], { ...options, sourceArtifactHash: "csv-2" })).toBe(1);
  });

  it("rejects provider and artifact identities that resolve to different rows", async () => {
    const userId = user();
    const optionsA = { sourceArtifactHash: "artifact-a" };
    const optionsB = { sourceArtifactHash: "artifact-b" };
    await saveQbTransactions(userId, [providerTransaction({ qbTransactionId: "provider-a" })], optionsA);
    await saveQbTransactions(userId, [providerTransaction({ qbTransactionId: "provider-b" })], optionsB);

    await expect(
      saveQbTransactions(userId, [providerTransaction({ qbTransactionId: "provider-a" })], optionsB),
    ).rejects.toThrow("Provider identity conflicts with artifact identity");
    expect(await listQbTransactionsForPeriod(userId, "2026-08-01", "2026-08-31")).toHaveLength(2);
  });

  it("uses one canonical row for concurrent provider retries", async () => {
    const userId = user();
    const results = await Promise.all([
      saveQbTransactions(userId, [providerTransaction()]),
      saveQbTransactions(userId, [providerTransaction()]),
    ]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("continues to accept legacy rows with null identity", async () => {
    const userId = user();
    expect(await saveQbTransactions(userId, [{ postedDate: "2026-08-01", amount: 10 }])).toBe(1);
  });
});
