import type {
  BankTransaction,
  FlaggedLevel,
  MatchResult,
  ProposedMatch,
  QbTransaction,
} from "./reconciliation-schema";

/**
 * The Phase 3 matching algorithm: score every (bank transaction, QB
 * transaction) pair on amount + date + merchant, then greedily assign the
 * highest-scoring pairs first. Pure function — no DB/network — so it's fully
 * unit-testable and identical whether the QB side came from today's manual
 * import or tomorrow's live sync.
 */

/** Amount matches within 1% of the bank amount, or a penny — whichever is bigger. */
export const AMOUNT_TOLERANCE_PCT = 0.01;
export const AMOUNT_MIN_TOLERANCE = 0.01;

export const DATE_CLOSE_DAYS = 2;
/** Wider window for transactions that posted to the bank later than QB — the
 * "pending clears after a few days" case, scored lower than an exact-day match. */
export const DATE_PENDING_DAYS = 5;

/**
 * Merchant similarity thresholds, calibrated for `fuzzyMerchantSimilarity`'s
 * token-Dice metric (0-1) rather than the brief's illustrative 0.8/0.5
 * edit-distance-style numbers — those don't transfer across algorithms, so
 * these are picked so "Vendor X" vs "Vendor X Inc" clears MERCHANT_HIGH and a
 * same-category-different-merchant pair lands below MERCHANT_MEDIUM.
 */
export const MERCHANT_HIGH_THRESHOLD = 0.6;
export const MERCHANT_MEDIUM_THRESHOLD = 0.3;

export const AMOUNT_SCORE = 40;
export const DATE_CLOSE_SCORE = 35;
export const DATE_PENDING_SCORE = 15;
export const MERCHANT_HIGH_SCORE = 25;
export const MERCHANT_MEDIUM_SCORE = 10;

/** Confidence buckets — from the brief's "Confidence-Scored Matching" spec:
 * 95%+ auto-match, 70-95% review, below 70% manual review. */
export const GREEN_MIN_SCORE = 95;
export const YELLOW_MIN_SCORE = 70;

function normalizeMerchantTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Token-overlap (Dice coefficient) similarity, 0-1. Handles "Vendor X" vs
 * "Vendor X Inc" style variation without a fuzzy-string dependency: shared
 * words count regardless of order or extra trailing words like "Inc"/"Ltd".
 */
export function fuzzyMerchantSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const tokensA = normalizeMerchantTokens(a);
  const tokensB = normalizeMerchantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;

  return (2 * intersection) / (setA.size + setB.size);
}

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function bucketScore(score: number): FlaggedLevel {
  if (score >= GREEN_MIN_SCORE) return "green";
  if (score >= YELLOW_MIN_SCORE) return "yellow";
  return "red";
}

/**
 * Score one bank/QB pair. Currency mismatch: with no FX-rate source today
 * (that's tomorrow's live-sync scope), a pair in two different known
 * currencies simply doesn't earn the amount score rather than risking a
 * false match — it can still match on date + merchant alone, just not reach
 * green without a human confirming the conversion.
 */
export function scorePair(bank: BankTransaction, qb: QbTransaction): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const sameCurrency = !bank.currency || !qb.currency || bank.currency === qb.currency;
  if (sameCurrency) {
    const tolerance = Math.max(Math.abs(bank.amount) * AMOUNT_TOLERANCE_PCT, AMOUNT_MIN_TOLERANCE);
    if (Math.abs(bank.amount - qb.amount) <= tolerance) {
      score += AMOUNT_SCORE;
      reasons.push("amount");
    }
  }

  const dateDiffDays = daysBetween(bank.transactionDate, qb.postedDate);
  if (dateDiffDays <= DATE_CLOSE_DAYS) {
    score += DATE_CLOSE_SCORE;
    reasons.push("date");
  } else if (dateDiffDays <= DATE_PENDING_DAYS) {
    score += DATE_PENDING_SCORE;
    reasons.push("date (pending)");
  }

  const merchantScore = fuzzyMerchantSimilarity(bank.merchant ?? bank.description, qb.description);
  if (merchantScore > MERCHANT_HIGH_THRESHOLD) {
    score += MERCHANT_HIGH_SCORE;
    reasons.push("merchant");
  } else if (merchantScore > MERCHANT_MEDIUM_THRESHOLD) {
    score += MERCHANT_MEDIUM_SCORE;
    reasons.push("merchant (partial)");
  }

  return { score, reasons };
}

/**
 * A candidate needs at least one amount or merchant signal. Date proximity
 * alone is not evidence of an accounting match — without this floor, any QB
 * row posted in the same week as a bank row becomes a junk red "match"
 * (hardening invariant E; the live 4FB smoke rows exposed exactly this).
 */
function hasEvidenceSignal(reasons: string[]): boolean {
  return reasons.includes("amount") || reasons.includes("merchant") || reasons.includes("merchant (partial)");
}

/**
 * Match every bank transaction against every QB transaction and return the
 * best assignment. Candidates are scored independently, then claimed
 * greedily highest-score-first — this is what makes duplicate QB entries
 * (brief edge case: "same merchant/amount/date, two QB entries") resolve
 * correctly: the best-scoring bank/QB pair claims the QB row, and a
 * second bank transaction competing for the same row falls through to its
 * next-best (unclaimed) candidate, or to unmatched if none remain, rather
 * than both silently claiming the same QB transaction.
 *
 * Strongest-evidence-first is deliberate, NOT maximum-weight bipartite
 * matching (hardening invariant C): max-weight would sacrifice a 100-point
 * pair to unlock two weaker pairs, which is the opposite of accounting
 * safety. Fewer, stronger matches beat more, weaker matches.
 */
export function matchTransactions(bankTxns: BankTransaction[], qbTxns: QbTransaction[]): MatchResult {
  interface Candidate {
    bankId: string;
    qbId: string;
    score: number;
    reason: string;
  }

  const candidates: Candidate[] = [];
  for (const bank of bankTxns) {
    for (const qb of qbTxns) {
      const { score, reasons } = scorePair(bank, qb);
      if (score > 0 && hasEvidenceSignal(reasons)) {
        candidates.push({ bankId: bank.id, qbId: qb.id, score, reason: reasons.join(" + ") });
      }
    }
  }

  // Full deterministic order: score desc, then bank id, then qb id — the
  // assignment must not depend on bank input order (hardening invariant D).
  candidates.sort((a, b) => b.score - a.score || a.bankId.localeCompare(b.bankId) || a.qbId.localeCompare(b.qbId));

  const matchedBankIds = new Set<string>();
  const claimedQbIds = new Set<string>();
  const matches: ProposedMatch[] = [];

  for (const c of candidates) {
    if (matchedBankIds.has(c.bankId) || claimedQbIds.has(c.qbId)) continue;
    matchedBankIds.add(c.bankId);
    claimedQbIds.add(c.qbId);
    matches.push({
      bankTransactionId: c.bankId,
      qbTransactionId: c.qbId,
      confidence: Math.min(c.score / 100, 1),
      matchReason: c.reason,
      flaggedLevel: bucketScore(c.score),
    });
  }

  return {
    matches,
    unmatchedBankIds: bankTxns.filter((b) => !matchedBankIds.has(b.id)).map((b) => b.id),
    unmatchedQbIds: qbTxns.filter((q) => !claimedQbIds.has(q.id)).map((q) => q.id),
  };
}
