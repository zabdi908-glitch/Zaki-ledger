import { formatMoney } from "./currency";

/**
 * The GL outcome of approving a line, in the language an accountant thinks
 * in. Deliberately rule-based and short: one or two sentences, GL names not
 * codes, magnitude only (the sign is already said in words).
 */
export function ledgerImpact(input: {
  amount: number;
  currency: string | null;
  category: string;
  invoiceNumber?: string;
  supplierName?: string;
  detectionKind?: "reversal" | "refund" | "split" | "merchant" | null;
}): string[] {
  const money = formatMoney(Math.abs(input.amount), input.currency);
  if (input.detectionKind === "reversal") return ["No net ledger impact — the pair cancels out."];
  if (input.detectionKind === "refund") return [`Reverse earlier charge: ${money} back to ${input.category}`];
  if (input.invoiceNumber) {
    return [`Mark invoice ${input.invoiceNumber} as paid.`, `Reduce Debtors (A/R): ${money}`];
  }
  if (input.category === "VAT Control Account") return [`Reduce VAT liability: ${money}`];
  if (input.category === "PAYE/NI Liability") return [`Reduce PAYE/NI liability: ${money}`];
  if (input.category === "Transfer") return ["Money moved between your own accounts — no profit-and-loss impact."];
  if (input.category === "Uncategorised") return ["Set a category to see the ledger impact."];
  return [`Increase ${input.category}: ${money}`];
}
