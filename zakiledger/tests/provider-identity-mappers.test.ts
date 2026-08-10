import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/oauth-store", () => ({
  getConnection: vi.fn(async (_userId: string, provider: string) => ({
    userId: _userId,
    provider,
    accessToken: `${provider}-token`,
    refreshToken: "refresh",
    orgId: provider === "quickbooks" ? "realm-123" : "tenant-456",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })),
  isExpired: vi.fn(() => false),
  saveConnection: vi.fn(),
  setConnectionOrgId: vi.fn(),
}));

const { listQuickBooksPurchases } = await import("../lib/quickbooks");
const { listXeroBankTransactions } = await import("../lib/xero");

describe("provider identity mappers", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("carries QuickBooks realm, entity type, transaction ID, and account ID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          QueryResponse: {
            Purchase: [{ Id: "purchase-1", TxnDate: "2026-08-01", TotalAmt: 12.34, AccountRef: { value: "qb-account-1" } }],
          },
        }),
        { status: 200 },
      ),
    );

    const [transaction] = await listQuickBooksPurchases("user-1", "2026-08-01", "2026-08-31");
    expect(transaction).toMatchObject({
      provider: "quickbooks",
      organisationId: "realm-123",
      externalObjectType: "purchase",
      qbTransactionId: "purchase-1",
      qbAccountId: "qb-account-1",
    });
  });

  it("carries Xero tenant, entity type, BankTransactionID, and AccountID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          BankTransactions: [
            {
              BankTransactionID: "bank-transaction-1",
              Type: "SPEND",
              Date: `/Date(${Date.UTC(2026, 7, 1)}+0000)/`,
              Total: 12.34,
              BankAccount: { AccountID: "xero-account-1" },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const [transaction] = await listXeroBankTransactions("user-1", "2026-08-01", "2026-08-31");
    expect(transaction).toMatchObject({
      provider: "xero",
      organisationId: "tenant-456",
      externalObjectType: "bank_transaction",
      qbTransactionId: "bank-transaction-1",
      qbAccountId: "xero-account-1",
    });
  });
});
