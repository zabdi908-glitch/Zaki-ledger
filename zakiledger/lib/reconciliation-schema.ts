import { z } from "zod/v4";
import type { AuditMemo } from "./audit-memo-schema";

/**
 * Types for the bank-reconciliation domain (Phase 3). Kept separate from
 * lib/schema.ts, which is the invoice-extraction domain — different pipeline,
 * different lifecycle, no shared fields worth a common file.
 */

export const FileFormatSchema = z.enum(["csv", "ofx", "pdf"]);
export type FileFormat = z.infer<typeof FileFormatSchema>;

/** How confident a match is, bucketed for the review UI (tomorrow) and for
 * gating auto-post vs. manual review (today's matching algorithm). */
export const FlaggedLevelSchema = z.enum(["green", "yellow", "red"]);
export type FlaggedLevel = z.infer<typeof FlaggedLevelSchema>;

export const MatchedBySchema = z.enum(["auto", "manual"]);
export type MatchedBy = z.infer<typeof MatchedBySchema>;

/**
 * Wrapper types for AI-extracted fields, matching the invoice side
 * (lib/schema.ts). CSV/OFX parsers use these with confidence=1.0 since they
 * are deterministic reads.
 */
const ConfidentString = z.object({
  value: z.string(),
  confidence: z.number(),
  reason: z.string(),
});

const ConfidentNumber = z.object({
  value: z.number(),
  confidence: z.number(),
  reason: z.string(),
});

/** A transaction as read off a bank statement — parser output, pre-persistence. */
export const ParsedBankTransactionSchema = z.object({
  transactionDate: ConfidentString, // ISO 8601 (YYYY-MM-DD)
  postedDate: z.string().nullable(),
  merchant: ConfidentString.nullable(),
  description: ConfidentString.nullable(),
  amount: ConfidentNumber, // signed: positive = debit, negative = credit
  currency: z.string().nullable(),
  transactionId: z.string().nullable(),
  memo: z.string().nullable(),
});
export type ParsedBankTransaction = z.infer<typeof ParsedBankTransactionSchema>;

/** Whole-statement parser output: transactions plus the balances/period a
 * statement header carries, so the upload route can populate
 * `bank_statements` and `bank_transactions` from one parse. */
export const ParsedStatementSchema = z.object({
  transactions: z.array(ParsedBankTransactionSchema),
  openingBalance: z.number().nullable(),
  closingBalance: z.number().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  currency: z.string().nullable(),
  sourceProvider: z.string().nullable().optional(),
  sourceOrganisationId: z.string().nullable().optional(),
  sourceAccountId: z.string().nullable().optional(),
  sourceAccountMetadata: z.record(z.string(), z.string().nullable()).nullable().optional(),
});
export type ParsedStatement = z.infer<typeof ParsedStatementSchema>;

/** A persisted bank transaction — same shape the matching algorithm reads. */
export interface BankTransaction {
  id: string;
  statementId: string;
  transactionDate: string;
  postedDate: string | null;
  merchant: string | null;
  description: string | null;
  amount: number;
  currency: string | null;
  transactionId: string | null;
  memo: string | null;
  externalTransactionId?: string | null;
  sourceProvider?: string | null;
  sourceOrganisationId?: string | null;
  sourceAccountId?: string | null;
  identityFingerprint?: string | null;
  identityFingerprintVersion?: number | null;
}

/** A QB/Xero transaction already posted, regardless of how it got imported. */
export interface QbTransaction {
  id: string;
  qbTransactionId: string | null;
  qbAccountId: string | null;
  postedDate: string;
  amount: number;
  description: string | null;
  accountName: string | null;
  accountType: string | null;
  currency: string | null;
  provider?: string | null;
  organisationId?: string | null;
  externalObjectType?: string | null;
  identityFingerprint?: string | null;
  identityFingerprintVersion?: number | null;
}

/** Input shape for POST /api/reconciliation/qb-transactions — today's stand-in
 * for a live QB/Xero pull (see lib/reconciliation-store.ts saveQbTransactions). */
export const QbTransactionInputSchema = z.object({
  qbTransactionId: z.string().nullable().optional(),
  qbAccountId: z.string().nullable().optional(),
  postedDate: z.string(), // ISO 8601
  amount: z.number(),
  description: z.string().nullable().optional(),
  accountName: z.string().nullable().optional(),
  accountType: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  organisationId: z.string().nullable().optional(),
  externalObjectType: z.string().nullable().optional(),
});
export type QbTransactionInput = z.infer<typeof QbTransactionInputSchema>;

/** One scored match produced by the matching algorithm — not yet persisted. */
export interface ProposedMatch {
  bankTransactionId: string;
  qbTransactionId: string | null; // null when nothing cleared the threshold at all
  confidence: number; // 0-1
  matchReason: string;
  flaggedLevel: FlaggedLevel;
}

export interface MatchResult {
  matches: ProposedMatch[];
  unmatchedBankIds: string[];
  unmatchedQbIds: string[];
}

/** A persisted reconciliation match row. */
export interface ReconciliationMatch {
  id: string;
  statementId: string;
  bankTransactionId: string;
  qbTransactionId: string | null;
  confidence: number | null;
  matchReason: string | null;
  flaggedLevel: FlaggedLevel;
  matchedBy: MatchedBy;
  matchedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  auditMemo: AuditMemo | null;
  /** Supersession evidence (migration 013): non-null only on rows that were
   * superseded by materially stronger evidence or a manual decision. */
  supersededAt: string | null;
  supersededByMatchId: string | null;
  supersedeReason: string | null;
  supersedeOperationId: string | null;
}

export interface ReconciliationReport {
  id: string;
  statementId: string;
  periodStart: string | null;
  periodEnd: string | null;
  bankOpeningBalance: number | null;
  bankClosingBalance: number | null;
  qbOpeningBalance: number | null;
  qbClosingBalance: number | null;
  totalMatched: number;
  totalUnmatchedBank: number;
  totalUnmatchedQb: number;
  variance: number;
  isReconciled: boolean;
  reconciledAt: string | null;
}
