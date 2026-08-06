import type {
  BankTransaction,
  QbTransaction,
  ReconciliationMatch,
  ReconciliationReport,
} from "./reconciliation-schema";
import type { AuditMemo } from "./audit-memo-schema";
import type { BankStatementMeta } from "./reconciliation-store";
import {
  getBankStatement,
  listBankTransactions,
  listQbTransactionsForPeriod,
  listMatchesForStatement,
  getReconciliationReport,
} from "./reconciliation-store";

/**
 * A match enriched with its related transaction rows and the audit memo the
 * matching algorithm (or manual override) generated for it.
 */
export interface MatchWithDetails {
  match: ReconciliationMatch;
  bankTransaction: BankTransaction;
  qbTransaction: QbTransaction | null;
  auditMemo: AuditMemo | null;
}

/**
 * Everything the reconciliation dashboard needs in one shape, fetched in a
 * single call so the UI can render every tab (green / yellow / red / unmatched
 * bank / unmatched QB / report) without further round-trips.
 */
export interface DashboardData {
  statement: BankStatementMeta;
  greenMatches: MatchWithDetails[];
  yellowMatches: MatchWithDetails[];
  redMatches: MatchWithDetails[];
  unmatchedBank: BankTransaction[];
  unmatchedQb: QbTransaction[];
  report: ReconciliationReport | null;
}

/**
 * Fetches all data for the reconciliation dashboard in one call.
 *
 * Groups matches by their `flaggedLevel` and looks up the associated bank
 * transaction (always present) and QB transaction (may be null for unmatched
 * bank rows that the algorithm couldn't pair). Unmatched transactions are the
 * bank/QB rows that do **not** appear in any match.
 */
export async function getDashboardData(
  userId: string,
  statementId: string,
): Promise<DashboardData> {
  const statement = await getBankStatement(userId, statementId);
  if (!statement) throw new Error("Statement not found.");

  const [bankTransactions, matches, report] = await Promise.all([
    listBankTransactions(userId, statementId),
    listMatchesForStatement(userId, statementId),
    getReconciliationReport(userId, statementId),
  ]);

  const qbTransactions = await listQbTransactionsForPeriod(
    userId,
    statement.periodStart,
    statement.periodEnd,
  );

  // Index for fast lookup
  const bankById = new Map(bankTransactions.map((t) => [t.id, t]));
  const qbById = new Map(qbTransactions.map((t) => [t.id, t]));

  // Build MatchWithDetails, grouping by flaggedLevel
  const greenMatches: MatchWithDetails[] = [];
  const yellowMatches: MatchWithDetails[] = [];
  const redMatches: MatchWithDetails[] = [];

  const matchedBankIds = new Set<string>();
  const matchedQbIds = new Set<string>();

  for (const match of matches) {
    const bankTransaction = bankById.get(match.bankTransactionId);
    if (!bankTransaction) continue; // stale reference, skip

    matchedBankIds.add(match.bankTransactionId);
    if (match.qbTransactionId) {
      matchedQbIds.add(match.qbTransactionId);
    }

    const detail: MatchWithDetails = {
      match,
      bankTransaction,
      qbTransaction: match.qbTransactionId ? qbById.get(match.qbTransactionId) ?? null : null,
      auditMemo: match.auditMemo ?? null,
    };

    if (match.flaggedLevel === "green") greenMatches.push(detail);
    else if (match.flaggedLevel === "yellow") yellowMatches.push(detail);
    else if (match.flaggedLevel === "red") redMatches.push(detail);
  }

  // Unmatched = rows not referenced by any match
  const unmatchedBank = bankTransactions.filter((t) => !matchedBankIds.has(t.id));
  const unmatchedQb = qbTransactions.filter((t) => !matchedQbIds.has(t.id));

  return {
    statement,
    greenMatches,
    yellowMatches,
    redMatches,
    unmatchedBank,
    unmatchedQb,
    report,
  };
}