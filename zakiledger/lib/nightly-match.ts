import type { QbTransactionInput } from "./reconciliation-schema";
import {
  listBankStatementsForUser,
  saveQbTransactions,
  computeAndPersistMatches,
} from "./reconciliation-store";
import { getValidQboAccess, listQuickBooksPurchases } from "./quickbooks";
import { getValidXeroAccess, listXeroBankTransactions } from "./xero";

export interface NightlyResult {
  statementsProcessed: number;
  matchesFound: number;
  greenCount: number;
  yellowCount: number;
  redCount: number;
  errors: string[];
}

/**
 * Phase 4a: Nightly Match Orchestrator.
 *
 * For every bank statement belonging to the user:
 *  1. Fetches fresh QB/Xero transactions for the statement's period using
 *     stored OAuth tokens (lib/oauth-store.ts).
 *  2. Persists them as `qb_transactions` rows.
 *  3. Runs `computeAndPersistMatches` to auto-match bank transactions.
 *  4. Generates audit memos for new matches (inside computeAndPersistMatches).
 *  5. Writes results to the `reconciliation_matches` table.
 *
 * Returns a summary of what happened across all statements.
 */
export async function runNightlyMatch(userId: string): Promise<NightlyResult> {
  const errors: string[] = [];
  let statementsProcessed = 0;
  let totalMatchesFound = 0;
  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;

  const statements = await listBankStatementsForUser(userId);

  for (const statement of statements) {
    try {
      const periodStart = statement.periodStart;
      const periodEnd = statement.periodEnd;

      if (!periodStart || !periodEnd) {
        errors.push(`Statement ${statement.id} has no period; skipping.`);
        continue;
      }

      const qbInputs: QbTransactionInput[] = [];

      // QuickBooks — gracefully skip if not connected or token is invalid
      const qbAccess = await getValidQboAccess(userId).catch(() => null);
      if (qbAccess) {
        const purchases = await listQuickBooksPurchases(userId, periodStart, periodEnd);
        qbInputs.push(...purchases);
      }

      // Xero — gracefully skip if not connected or token is invalid
      const xeroAccess = await getValidXeroAccess(userId).catch(() => null);
      if (xeroAccess) {
        const xeroTxns = await listXeroBankTransactions(userId, periodStart, periodEnd);
        qbInputs.push(...xeroTxns);
      }

      // Persist fresh accounting-side transactions so the matcher can see them
      if (qbInputs.length > 0) {
        await saveQbTransactions(userId, qbInputs);
      }

      // Run matching for this statement (idempotent — never clobbers manual matches)
      const result = await computeAndPersistMatches(userId, statement.id);

      statementsProcessed++;
      totalMatchesFound += result.matches.length;

      for (const m of result.matches) {
        if (m.flaggedLevel === "green") greenCount++;
        else if (m.flaggedLevel === "yellow") yellowCount++;
        else if (m.flaggedLevel === "red") redCount++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Statement ${statement.id}: ${message}`);
    }
  }

  return {
    statementsProcessed,
    matchesFound: totalMatchesFound,
    greenCount,
    yellowCount,
    redCount,
    errors,
  };
}