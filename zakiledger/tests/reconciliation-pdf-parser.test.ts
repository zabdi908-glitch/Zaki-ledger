import { describe, expect, it } from "vitest";
import { parsePdfStatement } from "@/lib/bank-statement-pdf";

/**
 * Only the demo-mode path is testable here (no ANTHROPIC_API_KEY in CI/dev),
 * same constraint as the invoice-extraction demo tests — the real Claude
 * call (lib/anthropic.ts extractBankStatement) needs a live key and is
 * exercised manually, not in this suite.
 */
describe("parsePdfStatement (demo mode)", () => {
  it("returns a realistic sample statement with no ANTHROPIC_API_KEY set", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const file = new File(["demo-bytes"], "statement.pdf", { type: "application/pdf" });
      const result = await parsePdfStatement(file);

      expect(result.transactions.length).toBeGreaterThan(0);
      for (const t of result.transactions) {
        expect(t.transactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof t.amount).toBe("number");
      }
      expect(result.periodStart).not.toBeNull();
      expect(result.periodEnd).not.toBeNull();
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
