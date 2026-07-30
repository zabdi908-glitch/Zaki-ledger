import type { BankTransaction } from "./reconciliation-schema";

/**
 * Pattern detectors that look at a bank statement on its own — no accounting
 * side, no network, no DB. Each one answers a question an accountant would
 * otherwise answer by eye: "did these two cancel out?", "is this a refund of
 * that?", "are these three parts of one invoice?", "is this the same supplier
 * under a different trading name?".
 *
 * Kept separate from lib/reconciliation-matching.ts (which scores bank vs.
 * accounting pairs) and lib/reconciliation-insights.ts (which turns results
 * into review-board copy): this file is pure detection, fully unit-testable,
 * and returns structured facts rather than sentences.
 *
 * Sign convention throughout, matching ParsedBankTransactionSchema:
 * positive = debit (money out), negative = credit (money in).
 */

/** Amounts inside half a penny of each other are the same amount. */
const AMOUNT_EPSILON = 0.005;
const DAY_MS = 86_400_000;

/** A reversal is a booking backed out — it should still be near the original. */
export const REVERSAL_WINDOW_DAYS = 30;
/** Card refunds routinely take weeks to settle; 90 days covers the long tail. */
export const REFUND_WINDOW_DAYS = 90;
/** Below this, two names aren't worth showing an accountant as "related". */
export const MERCHANT_LINK_THRESHOLD = 0.7;
/** At or above this, we call the resemblance strong rather than loose. */
export const MERCHANT_STRONG_THRESHOLD = 0.85;
/** Two tokens this close count as the same word for token-overlap purposes. */
const TOKEN_MATCH_THRESHOLD = 0.85;

const REFUND_RE = /\b(refund|refunded|credit note|return|returned|rvsl|reversal|chargeback)\b/i;
const TRANSFER_RE = /\btransfer\b|\bxfer\b|to\s+xx\d/i;

/**
 * Words that describe a company's legal form, location, or the payment rail
 * rather than who was paid. Stripping them is what lets "ADOBE CREATIVE CLOUD"
 * and "ADOBE SYSTEMS IRELAND" line up as one supplier.
 */
const NOISE_TOKENS = new Set([
  "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc", "co", "corp", "corporation",
  "company", "group", "holdings", "international", "intl", "global", "worldwide",
  "uk", "gb", "gbr", "usa", "us", "eu", "emea", "ireland", "irl", "europe", "london",
  "services", "service", "systems", "solutions", "technologies", "technology", "web",
  "online", "payments", "payment", "purchase", "pos", "card", "visa", "mastercard",
  "direct", "debit", "dd", "bacs", "faster", "the", "and",
  // What happened to the money, not who received it — "REFUND AMAZON" is a
  // transaction with Amazon, and the brand is the half that identifies it.
  "refund", "refunded", "credit", "note", "return", "returned", "reversal", "rvsl", "chargeback",
]);

export interface TransactionReference {
  /** Canonical form used for grouping, e.g. "INV1003". */
  key: string;
  /** What the statement actually said, e.g. "INV-1003" — safe to show a user. */
  label: string;
}

export interface ReversalPair {
  a: BankTransaction;
  b: BankTransaction;
  reference: TransactionReference | null;
  confidencePct: number;
}

export interface RefundPair {
  /** The original money-out transaction. */
  charge: BankTransaction;
  /** The money-in transaction that gives it back. */
  refund: BankTransaction;
  /** 0-1 resemblance between the two merchant names. */
  similarity: number;
  confidencePct: number;
}

export interface SplitGroup {
  reference: TransactionReference;
  transactions: BankTransaction[];
  /** Signed sum, in the same convention as BankTransaction.amount. */
  total: number;
  /** "in" = received in parts (a combined payment); "out" = paid in parts. */
  direction: "in" | "out";
  confidencePct: number;
}

export interface MerchantLink {
  a: BankTransaction;
  b: BankTransaction;
  /** 0-1. */
  similarity: number;
  confidencePct: number;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export function transactionText(t: BankTransaction): string {
  return `${t.merchant ?? ""} ${t.description ?? ""} ${t.memo ?? ""}`.trim();
}

export function normalizedMerchant(t: BankTransaction): string {
  return (t.merchant ?? t.description ?? "").trim().toLowerCase();
}

function daysBetween(a: BankTransaction, b: BankTransaction): number {
  return Math.abs(Date.parse(a.transactionDate) - Date.parse(b.transactionDate)) / DAY_MS;
}

/** Signed days from `from` to `to` — positive when `to` is later. */
function signedDaysBetween(from: BankTransaction, to: BankTransaction): number {
  return (Date.parse(to.transactionDate) - Date.parse(from.transactionDate)) / DAY_MS;
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_EPSILON;
}

function isTransferLike(t: BankTransaction): boolean {
  return TRANSFER_RE.test(transactionText(t));
}

function looksLikeRefund(t: BankTransaction): boolean {
  return REFUND_RE.test(transactionText(t));
}

const REFERENCE_KEYWORDS: Record<string, string> = {
  INV: "INV",
  INVOICE: "INV",
  REF: "REF",
  REFERENCE: "REF",
  ORDER: "ORD",
  ORD: "ORD",
  PO: "PO",
};

const REFERENCE_RE = /\b(INV|INVOICE|REF|REFERENCE|ORDER|ORD|PO)[\s._#:/-]*([A-Z0-9]{3,})\b/;

/**
 * Pull an invoice/order reference out of a statement line. Keyword-anchored on
 * purpose: a bare number in a description is far more often a card mask or a
 * date than a reference, and grouping on those would invent relationships.
 */
export function extractReference(t: BankTransaction): TransactionReference | null {
  const match = transactionText(t).toUpperCase().match(REFERENCE_RE);
  if (!match) return null;
  const family = REFERENCE_KEYWORDS[match[1]];
  const code = match[2];
  // A code that is only letters is almost always a word that happened to follow
  // the keyword ("REF CUSTOMER"), not a reference.
  if (!/\d/.test(code)) return null;
  return { key: `${family}${code}`, label: match[0].replace(/[\s._#:/]+/g, "-") };
}

/* ------------------------------------------------------------------ */
/* Merchant resemblance                                                */
/* ------------------------------------------------------------------ */

function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokens with legal-form/geography/payment-rail noise removed. Falls back to
 * the raw tokens when stripping would leave nothing to compare. */
function significantTokens(raw: string): string[] {
  const all = tokenize(raw);
  const kept = all.filter((t) => !NOISE_TOKENS.has(t));
  return kept.length > 0 ? kept : all;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** True when every letter of `short` appears in `long` in order — the shape of
 * an abbreviation ("amzn" in "amazon", "mktplace" in "marketplace"). */
function isAbbreviationOf(short: string, long: string): boolean {
  if (short.length < 4 || short.length >= long.length) return false;
  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

/** 0-1 resemblance between two single words. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (isAbbreviationOf(a, b) || isAbbreviationOf(b, a)) return 0.9;
  const longest = Math.max(a.length, b.length);
  return Math.max(0, 1 - editDistance(a, b) / longest);
}

/** Token overlap where near-identical words still count as shared, so
 * "AMZN MKTPLACE" and "AMAZON" overlap on the Amazon token. */
function softDice(tokensA: string[], tokensB: string[]): number {
  const setA = [...new Set(tokensA)];
  const setB = [...new Set(tokensB)];
  if (setA.length === 0 || setB.length === 0) return 0;
  const claimed = new Set<number>();
  let shared = 0;
  for (const ta of setA) {
    for (let i = 0; i < setB.length; i++) {
      if (claimed.has(i)) continue;
      if (tokenSimilarity(ta, setB[i]) >= TOKEN_MATCH_THRESHOLD) {
        claimed.add(i);
        shared++;
        break;
      }
    }
  }
  return (2 * shared) / (setA.length + setB.length);
}

/**
 * 0-1 resemblance between two merchant names, weighted towards the brand word.
 * The brand carries most of the signal ("ADOBE" vs "ADOBE"), while the rest of
 * the name breaks ties between two products from the same brand.
 */
export function merchantSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const brandA = tokensA.find((t) => t.length >= 3) ?? tokensA[0];
  const brandB = tokensB.find((t) => t.length >= 3) ?? tokensB[0];
  const brand = tokenSimilarity(brandA, brandB);
  const overlap = softDice(tokensA, tokensB);
  return Math.min(1, 0.6 * brand + 0.4 * overlap);
}

/* ------------------------------------------------------------------ */
/* Detectors                                                           */
/* ------------------------------------------------------------------ */

/**
 * Two postings of the same charge: same merchant, same amount, within a day.
 * The classic duplicate-authorisation / double-submission pattern.
 */
export function detectDuplicates(bank: BankTransaction[]): Map<string, BankTransaction> {
  const result = new Map<string, BankTransaction>();
  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      const merchant = normalizedMerchant(a);
      if (!merchant || merchant !== normalizedMerchant(b)) continue;
      if (!sameAmount(a.amount, b.amount)) continue;
      if (daysBetween(a, b) > 1) continue;
      result.set(a.id, b);
      result.set(b.id, a);
    }
  }
  return result;
}

/**
 * Transactions that cancel each other out: equal and opposite amounts sharing
 * either an invoice reference or an identical merchant.
 *
 * Transfer-looking lines are deliberately excluded — money leaving one account
 * and arriving in another has the same shape as a reversal but a completely
 * different meaning, and it already has its own review section.
 */
export function detectReversals(bank: BankTransaction[]): ReversalPair[] {
  const pairs: ReversalPair[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      if (claimed.has(a.id) || claimed.has(b.id)) continue;
      if (Math.abs(a.amount) < AMOUNT_EPSILON) continue;
      if (!sameAmount(a.amount + b.amount, 0)) continue;
      if (isTransferLike(a) || isTransferLike(b)) continue;
      if (daysBetween(a, b) > REVERSAL_WINDOW_DAYS) continue;

      const refA = extractReference(a);
      const refB = extractReference(b);
      const sharedReference = refA && refB && refA.key === refB.key ? refA : null;
      const merchant = normalizedMerchant(a);
      const sameMerchant = merchant !== "" && merchant === normalizedMerchant(b);
      if (!sharedReference && !sameMerchant) continue;

      claimed.add(a.id);
      claimed.add(b.id);
      pairs.push({ a, b, reference: sharedReference, confidencePct: sharedReference ? 95 : 88 });
    }
  }
  return pairs;
}

/**
 * A charge given back: a money-out line followed by a money-in line for the
 * same amount from a recognisably related merchant. Pairs already explained by
 * a reversal are skipped so one event never shows up as two findings.
 */
export function detectRefunds(bank: BankTransaction[], reversedIds: Set<string> = new Set()): RefundPair[] {
  const pairs: RefundPair[] = [];
  const claimed = new Set<string>();

  const charges = bank.filter((t) => t.amount > AMOUNT_EPSILON && !reversedIds.has(t.id));
  const credits = bank.filter((t) => t.amount < -AMOUNT_EPSILON && !reversedIds.has(t.id));

  for (const refund of credits) {
    if (claimed.has(refund.id)) continue;
    let best: RefundPair | null = null;

    for (const charge of charges) {
      if (claimed.has(charge.id)) continue;
      if (!sameAmount(Math.abs(charge.amount), Math.abs(refund.amount))) continue;
      const gap = signedDaysBetween(charge, refund);
      if (gap < 0 || gap > REFUND_WINDOW_DAYS) continue;

      const similarity = merchantSimilarity(
        charge.merchant ?? charge.description,
        refund.merchant ?? refund.description,
      );
      // A line that says "REFUND" tells us as much as the name does, so it can
      // carry a weaker name match on its own.
      const threshold = looksLikeRefund(refund) ? 0.45 : MERCHANT_LINK_THRESHOLD;
      if (similarity < threshold) continue;

      const confidencePct = similarity >= MERCHANT_STRONG_THRESHOLD ? 90 : 82;
      if (!best || similarity > best.similarity) best = { charge, refund, similarity, confidencePct };
    }

    if (best) {
      claimed.add(best.charge.id);
      claimed.add(best.refund.id);
      pairs.push(best);
    }
  }
  return pairs;
}

/**
 * Several transactions carrying one invoice reference — an invoice settled in
 * instalments, or a client paying in parts. Requires an explicit reference:
 * grouping on merchant alone would sweep up every unrelated purchase from the
 * same supplier.
 */
export function detectSplitGroups(bank: BankTransaction[], excludedIds: Set<string> = new Set()): SplitGroup[] {
  const byReference = new Map<string, { reference: TransactionReference; transactions: BankTransaction[] }>();

  for (const t of bank) {
    if (excludedIds.has(t.id)) continue;
    const reference = extractReference(t);
    if (!reference) continue;
    const entry = byReference.get(reference.key) ?? { reference, transactions: [] };
    entry.transactions.push(t);
    byReference.set(reference.key, entry);
  }

  const groups: SplitGroup[] = [];
  for (const { reference, transactions } of byReference.values()) {
    if (transactions.length < 2) continue;
    const allOut = transactions.every((t) => t.amount > AMOUNT_EPSILON);
    const allIn = transactions.every((t) => t.amount < -AMOUNT_EPSILON);
    if (!allOut && !allIn) continue;
    const total = transactions.reduce((sum, t) => sum + t.amount, 0);
    groups.push({
      reference,
      transactions,
      total,
      direction: allIn ? "in" : "out",
      confidencePct: 92,
    });
  }
  return groups;
}

/**
 * Merchants that read like the same supplier under different trading names.
 * Identical names are excluded — those are recurring charges, not a naming
 * question. Each transaction keeps only its single closest relative, so the
 * panel shows one clear comparison rather than a list.
 */
export function detectMerchantLinks(bank: BankTransaction[]): Map<string, MerchantLink> {
  const best = new Map<string, MerchantLink>();

  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      const nameA = normalizedMerchant(a);
      const nameB = normalizedMerchant(b);
      if (!nameA || !nameB || nameA === nameB) continue;

      const similarity = merchantSimilarity(a.merchant ?? a.description, b.merchant ?? b.description);
      if (similarity < MERCHANT_LINK_THRESHOLD) continue;
      const confidencePct = Math.round(similarity * 100);

      for (const [self, other] of [[a, b], [b, a]] as const) {
        const current = best.get(self.id);
        if (!current || similarity > current.similarity) {
          best.set(self.id, { a: self, b: other, similarity, confidencePct });
        }
      }
    }
  }
  return best;
}
