import { extractBankStatement } from "./openai";
import { extractBankStatementEscalation } from "./anthropic";
import type { ParsedStatement } from "./reconciliation-schema";

/**
 * PDF bank statement parsing — the reconciliation-side counterpart to
 * lib/extract-pipeline.ts's demo-mode branching: with no OPENAI_API_KEY,
 * the full upload → match → approve flow still works end-to-end against a
 * realistic sample rather than failing outright. Real key = real GPT-4o-mini read
 * (see lib/openai.ts extractBankStatement). If >30 % of transactions come back
 * with both merchant and description null, we escalate to Claude Sonnet
 * (lib/anthropic.ts extractBankStatementEscalation) for a second opinion.
 *
 * Kept separate from lib/bank-parsers.ts on purpose — that module is pure
 * text-in/structured-out with no I/O (so it's trivially unit-testable); this
 * one calls the network.
 */
export async function parsePdfStatement(file: File): Promise<ParsedStatement> {
  if (!process.env.OPENAI_API_KEY) {
    return demoStatement();
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");
  const primary = await extractBankStatement(base64, "application/pdf");

  // Escalation check: if the primary model couldn't read payee info on >30 %
  // of rows, try the expensive escalation model instead.
  const nullCount = primary.transactions.filter(
    (tx) => tx.merchant === null && tx.description === null,
  ).length;
  const nullRatio =
    primary.transactions.length === 0
      ? 0
      : nullCount / primary.transactions.length;

  if (nullRatio > 0.3 && process.env.ANTHROPIC_API_KEY) {
    return extractBankStatementEscalation(base64, "application/pdf");
  }

  return primary;
}

function demoStatement(): ParsedStatement {
  return {
    transactions: [
      { transactionDate: { value: "2026-07-21", confidence: 1.0, reason: "demo fixture" }, postedDate: "2026-07-21", merchant: { value: "AMAZON MKTPLACE", confidence: 1.0, reason: "demo fixture" }, description: { value: "AMAZON MKTPLACE", confidence: 1.0, reason: "demo fixture" }, amount: { value: 233.45, confidence: 1.0, reason: "demo fixture" }, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: { value: "2026-07-20", confidence: 1.0, reason: "demo fixture" }, postedDate: "2026-07-20", merchant: { value: "SQ *BLUE BOTTLE", confidence: 1.0, reason: "demo fixture" }, description: { value: "SQ *BLUE BOTTLE", confidence: 1.0, reason: "demo fixture" }, amount: { value: 18.5, confidence: 1.0, reason: "demo fixture" }, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: { value: "2026-07-19", confidence: 1.0, reason: "demo fixture" }, postedDate: "2026-07-19", merchant: { value: "ADOBE INC", confidence: 1.0, reason: "demo fixture" }, description: { value: "ADOBE INC", confidence: 1.0, reason: "demo fixture" }, amount: { value: 52.99, confidence: 1.0, reason: "demo fixture" }, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: { value: "2026-07-17", confidence: 1.0, reason: "demo fixture" }, postedDate: "2026-07-17", merchant: { value: "COSTCO WHSE #442", confidence: 1.0, reason: "demo fixture" }, description: { value: "COSTCO WHSE #442", confidence: 1.0, reason: "demo fixture" }, amount: { value: 310.76, confidence: 1.0, reason: "demo fixture" }, currency: "GBP", transactionId: null, memo: null },
      { transactionDate: { value: "2026-07-15", confidence: 1.0, reason: "demo fixture" }, postedDate: "2026-07-15", merchant: { value: "PAYROLL DEPOSIT", confidence: 1.0, reason: "demo fixture" }, description: { value: "PAYROLL DEPOSIT", confidence: 1.0, reason: "demo fixture" }, amount: { value: -1200, confidence: 1.0, reason: "demo fixture" }, currency: "GBP", transactionId: null, memo: null },
    ],
    openingBalance: 4200.0,
    closingBalance: 4784.3,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-21",
    currency: "GBP",
  };
}