import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropicMock = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: anthropicMock.parse };
  },
}));

const { resolveFuzzyMerchants } = await import("../lib/comparison-ai");
import type { BankTransaction, QbTransaction } from "../lib/reconciliation-schema";

beforeEach(() => {
  anthropicMock.parse.mockReset();
  vi.unstubAllEnvs();
});

function bankTx(overrides: Partial<BankTransaction> & Pick<BankTransaction, "id">): BankTransaction {
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

function qbTx(overrides: Partial<QbTransaction> & Pick<QbTransaction, "id">): QbTransaction {
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

describe("resolveFuzzyMerchants", () => {
  it("demo mode: returns empty array when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "AMZN MKTP" })],
      [qbTx({ id: "q1", description: "Amazon Web Services" })],
    );
    expect(result).toEqual([]);
    expect(anthropicMock.parse).not.toHaveBeenCalled();
  });

  it("returns empty array when no unmatched bank transactions are provided", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const result = await resolveFuzzyMerchants([], [qbTx({ id: "q1", description: "Amazon" })]);
    expect(result).toEqual([]);
    expect(anthropicMock.parse).not.toHaveBeenCalled();
  });

  it("schema validation: returns parsed matches on a clean response", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        matches: [
          {
            bankTransactionId: "b1",
            qbTransactionId: "q1",
            resolvedBankMerchant: "Amazon",
            resolvedQbMerchant: "Amazon Web Services",
            confidence: 0.92,
            explanation: "AMZN MKTP is a known Amazon abbreviation.",
          },
        ],
      },
    });

    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "AMZN MKTP" })],
      [qbTx({ id: "q1", description: "Amazon Web Services" })],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      bankTransactionId: "b1",
      qbTransactionId: "q1",
      resolvedBankMerchant: "Amazon",
      resolvedQbMerchant: "Amazon Web Services",
      confidence: 0.92,
      explanation: "AMZN MKTP is a known Amazon abbreviation.",
    });
  });

  it("filters out unknown bankTransactionIds returned by Claude", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        matches: [
          {
            bankTransactionId: "unknown-bank",
            qbTransactionId: "q1",
            resolvedBankMerchant: "Amazon",
            resolvedQbMerchant: "AWS",
            confidence: 0.8,
            explanation: "Match.",
          },
        ],
      },
    });

    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "AMZN MKTP" })],
      [qbTx({ id: "q1", description: "Amazon Web Services" })],
    );

    expect(result).toEqual([]);
  });

  it("filters out unknown qbTransactionIds returned by Claude", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        matches: [
          {
            bankTransactionId: "b1",
            qbTransactionId: "unknown-qb",
            resolvedBankMerchant: "Amazon",
            resolvedQbMerchant: "AWS",
            confidence: 0.8,
            explanation: "Match.",
          },
        ],
      },
    });

    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "AMZN MKTP" })],
      [qbTx({ id: "q1", description: "Amazon Web Services" })],
    );

    expect(result).toEqual([]);
  });

  it("accepts null qbTransactionId for uncertain matches", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        matches: [
          {
            bankTransactionId: "b1",
            qbTransactionId: null,
            resolvedBankMerchant: "AMZN MKTP",
            resolvedQbMerchant: "Unknown",
            confidence: 0.2,
            explanation: "No clear QB match found.",
          },
        ],
      },
    });

    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "AMZN MKTP" })],
      [qbTx({ id: "q1", description: "Amazon Web Services" })],
    );

    expect(result).toHaveLength(1);
    expect(result[0].qbTransactionId).toBeNull();
    expect(result[0].confidence).toBe(0.2);
  });

  it("returns empty array, not a throw, when the API call fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockRejectedValueOnce(new Error("rate limited"));
    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "SQ* ACME" })],
      [qbTx({ id: "q1", description: "Square - ACME" })],
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when parsed_output is undefined", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    anthropicMock.parse.mockResolvedValueOnce({ parsed_output: undefined });
    const result = await resolveFuzzyMerchants(
      [bankTx({ id: "b1", merchant: "TFL" })],
      [qbTx({ id: "q1", description: "Transport for London" })],
    );
    expect(result).toEqual([]);
  });
});