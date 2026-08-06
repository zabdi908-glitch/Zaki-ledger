import { z } from "zod/v4";
import type { BankTransaction, QbTransaction } from "./reconciliation-schema";

/**
 * Severity levels for comparison issues surfaced during cross-file review.
 */
export const ComparisonIssueSeveritySchema = z.enum(["info", "warning", "critical"]);
export type ComparisonIssueSeverity = z.infer<typeof ComparisonIssueSeveritySchema>;

/**
 * A transaction found in one source but missing from the other.
 */
export const MissingTransactionSchema = z.object({
  entry: z.custom<BankTransaction | QbTransaction>(),
  source: z.enum(["bank", "qb"]),
  reason: z.string(),
});
export type MissingTransaction = z.infer<typeof MissingTransactionSchema>;

/**
 * A set of duplicate entries detected within a single source.
 */
export const DuplicateTransactionSchema = z.object({
  entries: z.array(z.custom<BankTransaction | QbTransaction>()),
  source: z.enum(["bank", "qb"]),
  reason: z.string(),
});
export type DuplicateTransaction = z.infer<typeof DuplicateTransactionSchema>;

/**
 * A bank/QB pair where the amounts do not align.
 */
export const AmountMismatchSchema = z.object({
  bankTransaction: z.custom<BankTransaction>(),
  qbTransaction: z.custom<QbTransaction>(),
  bankAmount: z.number(),
  qbAmount: z.number(),
  difference: z.number(),
  reason: z.string(),
});
export type AmountMismatch = z.infer<typeof AmountMismatchSchema>;

/**
 * A transaction that could not be matched, with suggested candidates.
 */
export const UnmatchedItemSchema = z.object({
  transaction: z.custom<BankTransaction | QbTransaction>(),
  source: z.enum(["bank", "qb"]),
  possibleMatches: z.array(z.custom<BankTransaction | QbTransaction>()),
  severity: ComparisonIssueSeveritySchema,
});
export type UnmatchedItem = z.infer<typeof UnmatchedItemSchema>;

/**
 * A successful match between a bank transaction and a QB transaction.
 */
export const ComparisonMatchSchema = z.object({
  bankTransaction: z.custom<BankTransaction>(),
  qbTransaction: z.custom<QbTransaction>(),
  matchType: z.enum(["exact", "fuzzy_amount", "fuzzy_merchant", "fuzzy_date"]),
  confidence: z.number(),
});
export type ComparisonMatch = z.infer<typeof ComparisonMatchSchema>;

/**
 * Optional filters for narrowing comparison scope.
 */
export const ComparisonFiltersSchema = z.object({
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
  minAmount: z.number().optional(),
  maxAmount: z.number().optional(),
});
export type ComparisonFilters = z.infer<typeof ComparisonFiltersSchema>;

/**
 * Top-level container returned by a cross-file comparison run.
 */
export const ComparisonResultSchema = z.object({
  matches: z.array(ComparisonMatchSchema),
  missingInBank: z.array(MissingTransactionSchema),
  missingInQb: z.array(MissingTransactionSchema),
  duplicates: z.array(DuplicateTransactionSchema),
  amountMismatches: z.array(AmountMismatchSchema),
  unmatchedItems: z.array(UnmatchedItemSchema),
  summary: z.string(),
});
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;