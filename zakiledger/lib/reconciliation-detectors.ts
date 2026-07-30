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

/**
 * Scratch buffers for editDistance. It is called on the order of a million
 * times when scanning a full statement, and allocating a row array per
 * character was costing more than the comparisons themselves. Safe to share:
 * editDistance is synchronous and never re-enters itself.
 */
let editScratch = new Uint32Array(64);

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const width = b.length + 1;
  if (editScratch.length < width) editScratch = new Uint32Array(width * 2);
  const prev = editScratch;
  for (let j = 0; j < width; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    // `diag` carries prev[j-1] across the update, which is what lets one row
    // be updated in place instead of kept alongside its predecessor.
    let diag = prev[0];
    prev[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < width; j++) {
      const above = prev[j];
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(above + 1, prev[j - 1] + 1, diag + cost);
      prev[j] = value;
      diag = above;
    }
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

/**
 * A statement draws its supplier names from a small vocabulary — the same
 * dozen brands recur — while the pair loop asks about them a hundred thousand
 * times. Caching the pure comparison turns almost all of those into lookups.
 * Cleared wholesale rather than evicted per entry: the map only grows with
 * distinct word pairs, so the cap is reached rarely if ever.
 */
const TOKEN_SIMILARITY_CACHE = new Map<string, number>();
const TOKEN_SIMILARITY_CACHE_CAP = 20_000;

/** 0-1 resemblance between two single words. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // Symmetric, so both orderings share one entry.
  const key = a < b ? `${a} ${b}` : `${b} ${a}`;
  const cached = TOKEN_SIMILARITY_CACHE.get(key);
  if (cached !== undefined) return cached;
  let score: number;
  if (isAbbreviationOf(a, b) || isAbbreviationOf(b, a)) {
    score = 0.9;
  } else {
    const longest = Math.max(a.length, b.length);
    score = Math.max(0, 1 - editDistance(a, b) / longest);
  }
  if (TOKEN_SIMILARITY_CACHE.size >= TOKEN_SIMILARITY_CACHE_CAP) TOKEN_SIMILARITY_CACHE.clear();
  TOKEN_SIMILARITY_CACHE.set(key, score);
  return score;
}

/**
 * True when `a` and `b` cannot possibly reach `threshold`, decided without
 * running the edit-distance matrix. editDistance is never smaller than the
 * difference in length, so `1 - lengthGap / longest` is an upper bound on
 * their similarity. Only ever used to reject — never to score — because the
 * bound is not the real value.
 */
function cannotReach(a: string, b: string, threshold: number): boolean {
  if (isAbbreviationOf(a, b) || isAbbreviationOf(b, a)) return false;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return false;
  return 1 - Math.abs(a.length - b.length) / longest < threshold;
}

/** Token overlap where near-identical words still count as shared, so
 * "AMZN MKTPLACE" and "AMAZON" overlap on the Amazon token. */
function softDice(setA: string[], setB: string[]): number {
  if (setA.length === 0 || setB.length === 0) return 0;
  const claimed = new Set<number>();
  let shared = 0;
  for (const ta of setA) {
    for (let i = 0; i < setB.length; i++) {
      if (claimed.has(i)) continue;
      const tb = setB[i];
      if (ta !== tb && cannotReach(ta, tb, TOKEN_MATCH_THRESHOLD)) continue;
      if (tokenSimilarity(ta, tb) >= TOKEN_MATCH_THRESHOLD) {
        claimed.add(i);
        shared++;
        break;
      }
    }
  }
  return (2 * shared) / (setA.length + setB.length);
}

/**
 * The parts of a merchant name that resemblance is measured on. Extracted so
 * callers comparing one name against many can compute it once per name
 * instead of once per pair — tokenising is the expensive half of
 * merchantSimilarity, and it does not depend on what it is compared to.
 */
export interface MerchantProfile {
  /** Deduplicated significant tokens, in order. */
  tokens: string[];
  /** The token carrying the brand, which most of the score rests on. */
  brand: string;
}

export function merchantProfile(raw: string | null | undefined): MerchantProfile | null {
  if (!raw) return null;
  const tokens = [...new Set(significantTokens(raw))];
  if (tokens.length === 0) return null;
  return { tokens, brand: tokens.find((t) => t.length >= 3) ?? tokens[0] };
}

/**
 * 0-1 resemblance between two merchant names, weighted towards the brand word.
 * The brand carries most of the signal ("ADOBE" vs "ADOBE"), while the rest of
 * the name breaks ties between two products from the same brand.
 */
const BRAND_WEIGHT = 0.6;
const OVERLAP_WEIGHT = 0.4;

export function profileSimilarity(a: MerchantProfile | null, b: MerchantProfile | null): number {
  return profileSimilarityAtLeast(a, b, 0);
}

/**
 * As profileSimilarity, but allowed to give up early once the pair provably
 * cannot reach `floor`. Overlap can contribute at most OVERLAP_WEIGHT, so a
 * weak brand caps the whole score — and checking that costs one word
 * comparison against softDice's one per token pair. Any returned value below
 * `floor` is only meaningful as "below floor"; at or above it, it is exact.
 */
export function profileSimilarityAtLeast(
  a: MerchantProfile | null,
  b: MerchantProfile | null,
  floor: number,
): number {
  if (!a || !b) return 0;
  const brand = tokenSimilarity(a.brand, b.brand);
  if (BRAND_WEIGHT * brand + OVERLAP_WEIGHT < floor) return 0;
  const overlap = softDice(a.tokens, b.tokens);
  return Math.min(1, BRAND_WEIGHT * brand + OVERLAP_WEIGHT * overlap);
}

export function merchantSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return profileSimilarity(merchantProfile(a), merchantProfile(b));
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
  // Derived once per transaction rather than once per pair — the inner loop
  // runs n times for the same `a`, and none of this depends on `b`.
  const names = bank.map(normalizedMerchant);
  const times = bank.map((t) => Date.parse(t.transactionDate));
  for (let i = 0; i < bank.length; i++) {
    if (!names[i]) continue;
    for (let j = i + 1; j < bank.length; j++) {
      if (names[i] !== names[j]) continue;
      const a = bank[i];
      const b = bank[j];
      if (!sameAmount(a.amount, b.amount)) continue;
      if (Math.abs(times[i] - times[j]) / DAY_MS > 1) continue;
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
  // Regexes and date parsing are the costly part here and none of it depends
  // on the pair, so it is derived once per transaction up front.
  const names = bank.map(normalizedMerchant);
  const times = bank.map((t) => Date.parse(t.transactionDate));
  const transferLike = bank.map(isTransferLike);
  const references = bank.map(extractReference);

  for (let i = 0; i < bank.length; i++) {
    if (claimed.has(bank[i].id)) continue;
    if (Math.abs(bank[i].amount) < AMOUNT_EPSILON) continue;
    if (transferLike[i]) continue;
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      if (claimed.has(a.id) || claimed.has(b.id)) continue;
      if (!sameAmount(a.amount + b.amount, 0)) continue;
      if (transferLike[j]) continue;
      if (Math.abs(times[i] - times[j]) / DAY_MS > REVERSAL_WINDOW_DAYS) continue;

      const refA = references[i];
      const refB = references[j];
      const sharedReference = refA && refB && refA.key === refB.key ? refA : null;
      const sameMerchant = names[i] !== "" && names[i] === names[j];
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
  // Each charge is name-compared against every candidate credit, so tokenise
  // once per transaction rather than once per pair.
  const profiles = new Map<string, MerchantProfile | null>();
  for (const t of [...charges, ...credits]) profiles.set(t.id, merchantProfile(t.merchant ?? t.description));

  for (const refund of credits) {
    if (claimed.has(refund.id)) continue;
    let best: RefundPair | null = null;
    // A line that says "REFUND" tells us as much as the name does, so it can
    // carry a weaker name match on its own. Depends only on the credit, so it
    // is decided once per refund rather than once per candidate charge.
    const threshold = looksLikeRefund(refund) ? 0.45 : MERCHANT_LINK_THRESHOLD;

    for (const charge of charges) {
      if (claimed.has(charge.id)) continue;
      if (!sameAmount(Math.abs(charge.amount), Math.abs(refund.amount))) continue;
      const gap = signedDaysBetween(charge, refund);
      if (gap < 0 || gap > REFUND_WINDOW_DAYS) continue;

      const similarity = profileSimilarityAtLeast(
        profiles.get(charge.id) ?? null,
        profiles.get(refund.id) ?? null,
        threshold,
      );
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
  // Every transaction is compared against every other, so its name would
  // otherwise be tokenised n-1 times. Profile once, compare many.
  const names = bank.map(normalizedMerchant);
  const profiles = bank.map((t) => merchantProfile(t.merchant ?? t.description));

  for (let i = 0; i < bank.length; i++) {
    if (!names[i] || !profiles[i]) continue;
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      if (!names[j] || names[i] === names[j]) continue;

      const similarity = profileSimilarityAtLeast(profiles[i], profiles[j], MERCHANT_LINK_THRESHOLD);
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
