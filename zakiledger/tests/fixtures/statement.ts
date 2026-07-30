import type { BankTransaction } from "@/lib/reconciliation-schema";

/**
 * A statement whose supplier names come from a realistic vocabulary — a real
 * one reuses a modest set of suppliers with varying legal-form and payment-rail
 * suffixes, which is the shape the detectors' comparison cache is built around.
 * A fixture of one repeated brand, or of 400 unique ones, would each measure
 * something the product never sees.
 */
const BRANDS = [
  "AMAZON", "ADOBE", "GOOGLE", "MICROSOFT", "STRIPE", "SLACK", "NOTION", "FIGMA", "DROPBOX", "ZOOM",
  "BRITISH GAS", "THAMES WATER", "VODAFONE", "EE MOBILE", "SAINSBURYS", "TESCO", "WAITROSE", "SHELL",
  "BP FUEL", "UBER", "DELIVEROO", "MONZO", "STARLING", "XERO", "QUICKBOOKS", "DPD", "ROYAL MAIL",
  "HERTZ", "TRAINLINE", "GITHUB",
];
const SUFFIXES = ["LTD", "UK", "EMEA", "SERVICES", "PAYMENTS", "", "DIRECT DEBIT", "ONLINE"];

export function syntheticStatement(n: number): BankTransaction[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    statementId: "s1",
    transactionDate: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
    postedDate: null,
    merchant: `${BRANDS[i % BRANDS.length]} ${SUFFIXES[i % SUFFIXES.length]}`.trim(),
    description: null,
    amount: (i % 2 === 0 ? 1 : -1) * (100 + i),
    currency: "GBP",
    transactionId: null,
    memo: null,
  }));
}
