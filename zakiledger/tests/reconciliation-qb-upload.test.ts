import { describe, expect, it } from "vitest";
import { parseCsvStatement, parsedTransactionsToQbInputs } from "@/lib/bank-parsers";

describe("parsedTransactionsToQbInputs", () => {
  it("maps a parsed CSV statement onto the QB/Xero import shape", () => {
    const csv = [
      "Date,Description,Amount,Currency",
      "15/07/2026,Vendor X,100.00,GBP",
      "16/07/2026,Vendor Y,-42.50,GBP",
    ].join("\n");

    const parsed = parseCsvStatement(csv);
    const inputs = parsedTransactionsToQbInputs(parsed.transactions);

    expect(inputs).toEqual([
      { postedDate: "2026-07-15", amount: -100, description: "Vendor X", currency: "GBP" },
      { postedDate: "2026-07-16", amount: 42.5, description: "Vendor Y", currency: "GBP" },
    ]);
  });

  it("falls back to merchant when description is absent", () => {
    const inputs = parsedTransactionsToQbInputs([
      {
        transactionDate: { value: "2026-01-01", confidence: 1.0, reason: "test" },
        postedDate: null,
        merchant: { value: "Fallback Merchant", confidence: 1.0, reason: "test" },
        description: null,
        amount: { value: 10, confidence: 1.0, reason: "test" },
        currency: null,
        transactionId: null,
        memo: null,
      },
    ]);

    expect(inputs[0].description).toBe("Fallback Merchant");
  });
});
