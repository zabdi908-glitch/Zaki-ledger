import { extractBankStatement } from "./anthropic";
import type { ParsedStatement } from "./reconciliation-schema";

/**
 * PDF bank statement parsing — the reconciliation-side counterpart to
 * lib/extract-pipeline.ts's demo-mode branching: with no ANTHROPIC_API_KEY,
 * the full upload → match → approve flow still works end-to-end against a
 * realistic sample rather than failing outright. Real key = real Claude read
 * (see lib/anthropic.ts extractBankStatement).
 *
 * Kept separate from lib/bank-parsers.ts on purpose — that module is pure
 * text-in/structured-out with no I/O (so it's trivially unit-testable); this
 * one calls the network.
 */
export async function parsePdfStatement(file: File): Promise<ParsedStatement> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return demoStatement();
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");
  return extractBankStatement(base64, "application/pdf");
}

function demoStatement(): ParsedStatement {
  return {
    transactions: [
      { transactionDate: "2026-07-21", postedDate: "2026-07-21", merchant: "AMAZON MKTPLACE", description: "AMAZON MKTPLACE", amount: 233.45, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: "2026-07-20", postedDate: "2026-07-20", merchant: "SQ *BLUE BOTTLE", description: "SQ *BLUE BOTTLE", amount: 18.5, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: "2026-07-19", postedDate: "2026-07-19", merchant: "ADOBE INC", description: "ADOBE INC", amount: 52.99, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: "2026-07-17", postedDate: "2026-07-17", merchant: "COSTCO WHSE #442", description: "COSTCO WHSE #442", amount: 310.76, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: "2026-07-15", postedDate: "2026-07-15", merchant: "PAYROLL DEPOSIT", description: "PAYROLL DEPOSIT", amount: -1200, currency: "GBP", transactionId: null, memo: null },
    ],
    openingBalance: 4200.0,
    closingBalance: 4784.3,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-21",
    currency: "GBP",
  };
}
