import type { BankTransaction, QbTransaction } from "@/lib/reconciliation-schema";
import type {
  ComparisonResult,
  ComparisonMatch,
  ComparisonFilters,
  MissingTransaction,
  DuplicateTransaction,
  AmountMismatch,
  UnmatchedItem,
} from "@/lib/comparison-schema";
import { resolveFuzzyMerchants } from "@/lib/comparison-ai";

function daysBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.abs(Math.round((da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24)));
}

function amountDiffPct(bankAmount: number, qbAmount: number): number {
  const base = Math.abs(qbAmount) || Math.abs(bankAmount) || 1;
  return Math.abs(bankAmount - qbAmount) / base;
}

function merchantMatches(bank: BankTransaction, qb: QbTransaction): boolean {
  const bankMerchant = (bank.merchant || bank.description || "").toLowerCase().trim();
  const qbMerchant = (qb.description || "").toLowerCase().trim();
  if (!bankMerchant || !qbMerchant) return false;
  return bankMerchant === qbMerchant || bankMerchant.includes(qbMerchant) || qbMerchant.includes(bankMerchant);
}

function isExactCriteria(bank: BankTransaction, qb: QbTransaction): boolean {
  return amountDiffPct(bank.amount, qb.amount) <= 0.01 && daysBetween(bank.transactionDate, qb.postedDate) <= 5;
}

function isFuzzyDateCriteria(bank: BankTransaction, qb: QbTransaction): boolean {
  return amountDiffPct(bank.amount, qb.amount) <= 0.01 && daysBetween(bank.transactionDate, qb.postedDate) > 5;
}

function classifyPair(
  bank: BankTransaction,
  qb: QbTransaction,
): { type: "exact" | "fuzzy_date" | "amount_mismatch"; score: number } | null {
  const dateDiff = daysBetween(bank.transactionDate, qb.postedDate);
  const amtDiff = amountDiffPct(bank.amount, qb.amount);

  if (amtDiff <= 0.01 && dateDiff <= 5) {
    return { type: "exact", score: 1.0 };
  }

  if (amtDiff <= 0.01 && dateDiff > 5) {
    return { type: "fuzzy_date", score: 0.7 };
  }

  if (dateDiff <= 5 && amtDiff > 0.01 && amtDiff < 0.05 && merchantMatches(bank, qb)) {
    return { type: "amount_mismatch", score: 0.5 };
  }

  return null;
}

function applyFiltersBank(transactions: BankTransaction[], filters?: ComparisonFilters): BankTransaction[] {
  if (!filters) return transactions;
  return transactions.filter((t) => {
    if (filters.dateStart && t.transactionDate < filters.dateStart) return false;
    if (filters.dateEnd && t.transactionDate > filters.dateEnd) return false;
    if (filters.minAmount !== undefined && t.amount < filters.minAmount) return false;
    if (filters.maxAmount !== undefined && t.amount > filters.maxAmount) return false;
    return true;
  });
}

function applyFiltersQb(transactions: QbTransaction[], filters?: ComparisonFilters): QbTransaction[] {
  if (!filters) return transactions;
  return transactions.filter((t) => {
    if (filters.dateStart && t.postedDate < filters.dateStart) return false;
    if (filters.dateEnd && t.postedDate > filters.dateEnd) return false;
    if (filters.minAmount !== undefined && t.amount < filters.minAmount) return false;
    if (filters.maxAmount !== undefined && t.amount > filters.maxAmount) return false;
    return true;
  });
}

function buildSummary(
  matches: ComparisonMatch[],
  missingInBank: MissingTransaction[],
  duplicates: DuplicateTransaction[],
  amountMismatches: AmountMismatch[],
  unmatchedItems: UnmatchedItem[],
): string {
  return [
    `Matched: ${matches.length}`,
    `Missing in bank: ${missingInBank.length}`,
    `Duplicates: ${duplicates.length}`,
    `Amount mismatches: ${amountMismatches.length}`,
    `Unmatched items: ${unmatchedItems.length}`,
  ].join(", ");
}

/**
 * Deterministic bank-to-QB comparison with no AI.
 *
 * Rules:
 * 1. Filter by date range / amount if provided.
 * 2. Exact amount (±1%) + date (±5 days) → "exact".
 * 3. Amount matches but date differs → "fuzzy_date".
 * 4. Date + merchant match but amount differs (>1%, <5%) → AmountMismatch.
 * 5. Unmatched bank txns → unmatchedItems.
 * 6. Unmatched QB txns → missingInBank.
 * 7. Two+ bank txns matching the same QB txn → DuplicateTransaction.
 */
export function compareBankToQb(
  bankTransactions: BankTransaction[],
  qbTransactions: QbTransaction[],
  filters?: ComparisonFilters,
): ComparisonResult {
  const banks = applyFiltersBank(bankTransactions, filters);
  const qbs = applyFiltersQb(qbTransactions, filters);

  const matchedBankIds = new Set<string>();
  const matchedQbIds = new Set<string>();
  const matches: ComparisonMatch[] = [];
  const amountMismatches: AmountMismatch[] = [];

  const scoredPairs: Array<{
    bank: BankTransaction;
    qb: QbTransaction;
    type: "exact" | "fuzzy_date" | "amount_mismatch";
    score: number;
  }> = [];

  for (const bank of banks) {
    for (const qb of qbs) {
      const result = classifyPair(bank, qb);
      if (result) {
        scoredPairs.push({ bank, qb, ...result });
      }
    }
  }

  scoredPairs.sort((a, b) => b.score - a.score);

  for (const pair of scoredPairs) {
    if (matchedBankIds.has(pair.bank.id) || matchedQbIds.has(pair.qb.id)) {
      continue;
    }

    if (pair.type === "amount_mismatch") {
      amountMismatches.push({
        bankTransaction: pair.bank,
        qbTransaction: pair.qb,
        bankAmount: pair.bank.amount,
        qbAmount: pair.qb.amount,
        difference: pair.bank.amount - pair.qb.amount,
        reason: `Amount differs by ${(amountDiffPct(pair.bank.amount, pair.qb.amount) * 100).toFixed(2)}% (bank: ${pair.bank.amount}, QB: ${pair.qb.amount})`,
      });
      matchedBankIds.add(pair.bank.id);
      matchedQbIds.add(pair.qb.id);
    } else {
      matches.push({
        bankTransaction: pair.bank,
        qbTransaction: pair.qb,
        matchType: pair.type,
        confidence: pair.type === "exact" ? 1.0 : 0.75,
      });
      matchedBankIds.add(pair.bank.id);
      matchedQbIds.add(pair.qb.id);
    }
  }

  const duplicates: DuplicateTransaction[] = [];
  const duplicateBankIds = new Set<string>();

  for (const qb of qbs) {
    if (!matchedQbIds.has(qb.id)) continue;

    const dupes = banks.filter(
      (bank) =>
        !matchedBankIds.has(bank.id) &&
        !duplicateBankIds.has(bank.id) &&
        (isExactCriteria(bank, qb) || isFuzzyDateCriteria(bank, qb)),
    );

    if (dupes.length > 0) {
      duplicates.push({
        entries: dupes,
        source: "bank",
        reason: `Multiple bank transactions match QB transaction ${qb.id}`,
      });
      for (const d of dupes) duplicateBankIds.add(d.id);
    }
  }

  const unmatchedItems: UnmatchedItem[] = [];
  for (const bank of banks) {
    if (matchedBankIds.has(bank.id) || duplicateBankIds.has(bank.id)) continue;

    const possibleMatches = qbs.filter((qb) => amountDiffPct(bank.amount, qb.amount) <= 0.1);
    unmatchedItems.push({
      transaction: bank,
      source: "bank",
      possibleMatches,
      severity: possibleMatches.length > 0 ? "warning" : "info",
    });
  }

  const missingInBank: MissingTransaction[] = [];
  for (const qb of qbs) {
    if (!matchedQbIds.has(qb.id)) {
      missingInBank.push({
        entry: qb,
        source: "qb",
        reason: "No matching bank transaction found",
      });
    }
  }

  return {
    matches,
    missingInBank,
    missingInQb: [],
    duplicates,
    amountMismatches,
    unmatchedItems,
    summary: buildSummary(matches, missingInBank, duplicates, amountMismatches, unmatchedItems),
  };
}

/**
 * Async bank-to-QB comparison that runs deterministic matching first,
 * then calls Claude Sonnet to resolve fuzzy merchant mismatches among
 * the unmatched items. The pure `compareBankToQb()` is preserved for
 * deterministic testing.
 */
export async function compareBankToQbWithAI(
  bankTransactions: BankTransaction[],
  qbTransactions: QbTransaction[],
  filters?: ComparisonFilters,
): Promise<ComparisonResult> {
  const deterministic = compareBankToQb(bankTransactions, qbTransactions, filters);

  const unmatchedBank = deterministic.unmatchedItems.map((u) => u.transaction as BankTransaction);
  const unmatchedQb = deterministic.missingInBank.map((m) => m.entry as QbTransaction);

  const fuzzyMatches = await resolveFuzzyMerchants(unmatchedBank, unmatchedQb);

  const fuzzyMatchMap = new Map(
    fuzzyMatches
      .filter((m) => m.qbTransactionId !== null)
      .map((m) => [m.bankTransactionId, m.qbTransactionId!]),
  );

  const resolvedMatches: ComparisonMatch[] = [];
  const resolvedUnmatchedItems: UnmatchedItem[] = [];
  const resolvedMissingInBank: MissingTransaction[] = [];
  const resolvedMatchedBankIds = new Set(deterministic.matches.map((m) => m.bankTransaction.id));
  const resolvedMatchedQbIds = new Set(deterministic.matches.map((m) => m.qbTransaction.id));

  for (const unmatched of deterministic.unmatchedItems) {
    const bankId = unmatched.transaction.id;
    const matchedQbId = fuzzyMatchMap.get(bankId);

    if (matchedQbId) {
      const qb = qbTransactions.find((q) => q.id === matchedQbId);
      const bank = bankTransactions.find((b) => b.id === bankId);
      if (qb && bank) {
        resolvedMatches.push({
          bankTransaction: bank,
          qbTransaction: qb,
          matchType: "fuzzy_merchant",
          confidence: fuzzyMatches.find((m) => m.bankTransactionId === bankId)?.confidence ?? 0.6,
        });
        resolvedMatchedBankIds.add(bankId);
        resolvedMatchedQbIds.add(matchedQbId);
        continue;
      }
    }

    resolvedUnmatchedItems.push(unmatched);
  }

  for (const missing of deterministic.missingInBank) {
    if (!resolvedMatchedQbIds.has(missing.entry.id)) {
      resolvedMissingInBank.push(missing);
    }
  }

  const allMatches = [...deterministic.matches, ...resolvedMatches];

  return {
    ...deterministic,
    matches: allMatches,
    unmatchedItems: resolvedUnmatchedItems,
    missingInBank: resolvedMissingInBank,
    summary: buildSummary(allMatches, resolvedMissingInBank, deterministic.duplicates, deterministic.amountMismatches, resolvedUnmatchedItems),
  };
}
