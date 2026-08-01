import type { BankTransaction, QbTransaction, ReconciliationMatch } from "./reconciliation-schema";

/**
 * Client-side mirrors of what the approve/reject endpoints do to the data,
 * so the review page can update instantly and only reconcile with the server
 * response in the background. Kept pure so a failed request can roll back by
 * restoring the previous object.
 */
export interface ReviewData {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  unmatchedBank: string[];
  unmatchedQb: string[];
}

export function applyApprovals(data: ReviewData, matchIds: string[], approvedAt: string): ReviewData {
  const ids = new Set(matchIds);
  return {
    ...data,
    matches: data.matches.map((m) => (ids.has(m.id) ? { ...m, approvedAt } : m)),
  };
}

export function applyRejection(data: ReviewData, matchId: string): ReviewData {
  const rejected = data.matches.find((m) => m.id === matchId);
  return {
    ...data,
    matches: data.matches.filter((m) => m.id !== matchId),
    unmatchedBank: rejected ? [...data.unmatchedBank, rejected.bankTransactionId] : data.unmatchedBank,
  };
}
