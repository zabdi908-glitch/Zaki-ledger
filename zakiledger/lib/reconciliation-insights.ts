import { formatMoney } from "./currency";
import {
  AMOUNT_SCORE,
  DATE_CLOSE_SCORE,
  DATE_PENDING_SCORE,
  MERCHANT_HIGH_SCORE,
  MERCHANT_MEDIUM_SCORE,
} from "./reconciliation-matching";
import {
  detectDuplicates,
  detectMerchantLinks,
  detectRefunds,
  detectReversals,
  detectSplitGroups,
  MERCHANT_STRONG_THRESHOLD,
  type MerchantLink,
  type RefundPair,
  type ReversalPair,
  type SplitGroup,
} from "./reconciliation-detectors";
import { suggestMerchantCategory } from "./merchant-categories";
import type { MerchantPreference } from "./decision-store";
import type { MerchantAiCategory } from "./merchant-ai";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "./reconciliation-schema";
import { shellColor } from "./shell-theme";
import type { ReviewDetection, ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";

/**
 * Turns the matching engine's raw output (lib/reconciliation-matching.ts) and
 * the pattern detectors (lib/reconciliation-detectors.ts) into the review
 * board's row shape: plain-English copy, badges, sections, and a confidence
 * system, all derived from data the existing endpoints already return — no new
 * tables, no new queries.
 *
 * Every sentence produced here is written for an accountant. The detectors
 * measure name resemblance and date gaps; this file only ever reports what
 * those measurements mean ("supplier names are highly similar"), never how
 * they were arrived at.
 */

export { detectDuplicates };

export function confidenceLabel(pct: number): string {
  if (pct >= 98) return "Exact match";
  if (pct >= 90) return "Strong match";
  if (pct >= 65) return "Review recommended";
  return "Insufficient evidence";
}

export function confidenceColor(pct: number): string {
  if (pct >= 90) return shellColor.high;
  if (pct >= 65) return shellColor.medium;
  return shellColor.low;
}

const FACTOR_PHRASES: Record<string, string> = {
  amount: "amount matches",
  date: "date matches",
  "date (pending)": "date is close (pending clearance)",
  merchant: "merchant matches",
  "merchant (partial)": "merchant partially matches",
};

/** e.g. "amount + date + merchant (partial)" -> "Amount matches, date matches,
 * and merchant partially matches." Every factor is stated at the strength the
 * engine actually credited it — a partial merchant match must never read as a
 * full match (hardening invariant H). */
export function plainEnglishReason(match: ReconciliationMatch): string {
  if (!match.qbTransactionId || !match.matchReason) {
    return "No accounting entry matches this transaction closely enough to suggest one.";
  }
  const parts = match.matchReason.split(" + ").map((p) => FACTOR_PHRASES[p] ?? p);
  if (parts.length === 1) return `${capitalize(parts[0])}.`;
  if (parts.length === 2) return `${capitalize(parts[0])}, and ${parts[1]}.`;
  return `${capitalize(parts.slice(0, -1).join(", "))}, and ${parts[parts.length - 1]}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const VAT_RE = /\bHMRC\b|\bVAT\b/i;
const PAYROLL_RE = /payroll|wages|salary/i;
const TRANSFER_RE = /\btransfer\b|\bxfer\b|to\s+xx\d/i;
const SUBSCRIPTION_MERCHANTS = /adobe|google workspace|microsoft 365|zoom|slack|notion|dropbox|figma|aws|amazon web/i;

function normalizeMerchant(t: BankTransaction): string {
  return (t.merchant ?? t.description ?? "").trim().toLowerCase();
}

/** Badges derivable from a single statement's data. Cross-statement
 * recurrence (a stronger "this happens every month" claim) would need a new
 * store query across statements — out of scope for this pass. */
export function detectBadges(
  bank: BankTransaction,
  allBank: BankTransaction[],
  /** Merchant key -> how many transactions carry it. Supplied by callers that
   * badge a whole statement, so the count is tallied once instead of rescanned
   * for every row; computed here when absent. */
  merchantCounts?: Map<string, number>,
): string[] {
  const text = `${bank.merchant ?? ""} ${bank.description ?? ""}`;
  const badges: string[] = [];
  if (VAT_RE.test(text)) badges.push("VAT");
  if (PAYROLL_RE.test(text)) badges.push("Payroll");
  if (SUBSCRIPTION_MERCHANTS.test(text)) badges.push("Subscription");
  if (TRANSFER_RE.test(text)) badges.push("Transfer");
  const key = normalizeMerchant(bank);
  const counts = merchantCounts ?? countMerchants(allBank);
  if (key && (counts.get(key) ?? 0) > 1) badges.push("Recurring");
  return badges;
}

function countMerchants(bank: BankTransaction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of bank) {
    const key = normalizeMerchant(t);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Resolution order: a learned merchant preference (3+ approvals) beats
 * everything, since it is the accountant's own past decision. Below that:
 * the matched QB account name -> the most common account name this merchant
 * has been matched to elsewhere in this statement -> the hardcoded UK
 * merchant table -> a live AI classification (cached, see lib/merchant-ai.ts)
 * for merchants the hardcoded table doesn't recognise -> "Uncategorised". A
 * real cross-statement lookup is a follow-up, not needed to ship this
 * screen. */
export function suggestCategory(
  bank: BankTransaction,
  qb: QbTransaction | null,
  matches: ReconciliationMatch[],
  qbTxns: QbTransaction[],
  /** Accounting entries indexed by id. Callers categorising a whole statement
   * pass theirs so it is built once rather than per row. */
  qbById?: Map<string, QbTransaction>,
  /** Merchant key (normalised) -> the learned preference. Callers
   * categorising a whole statement pass theirs so it is built once. */
  preferences?: Map<string, MerchantPreference>,
  /** Merchant key (normalised) -> a cached AI classification. Callers
   * categorising a whole statement pass theirs so it is built once. */
  aiCategories?: Map<string, MerchantAiCategory>,
): { label: string; reason?: string } {
  const key = normalizeMerchant(bank);
  const pref = key ? preferences?.get(key) : undefined;
  if (pref && pref.approvalCount >= 3) return { label: `${pref.category} (learned from ${pref.approvalCount} approvals)` };

  if (qb?.accountName) return { label: qb.accountName };
  if (!key) return { label: "Uncategorised" };
  const index = qbById ?? new Map(qbTxns.map((q) => [q.id, q]));
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (!m.qbTransactionId) continue;
    const matchedQb = index.get(m.qbTransactionId);
    if (!matchedQb?.accountName) continue;
    counts.set(matchedQb.accountName, (counts.get(matchedQb.accountName) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return { label: top[0] };

  const hardcoded = suggestMerchantCategory(bank.merchant ?? bank.description);
  if (hardcoded) return { label: `${hardcoded.category} (${hardcoded.confidencePct}% suggested)` };

  const ai = aiCategories?.get(key);
  if (ai && ai.category !== "Uncategorised") {
    return { label: `${ai.category} (${ai.confidencePct}% AI suggested)`, reason: ai.reason };
  }

  return { label: "Uncategorised" };
}

const FACTOR_WEIGHTS: { key: string; partialKey: string | null; label: string; max: number; partial: number }[] = [
  { key: "amount", partialKey: null, label: "Amount", max: AMOUNT_SCORE, partial: AMOUNT_SCORE },
  { key: "date", partialKey: "date (pending)", label: "Date", max: DATE_CLOSE_SCORE, partial: DATE_PENDING_SCORE },
  { key: "merchant", partialKey: "merchant (partial)", label: "Merchant", max: MERCHANT_HIGH_SCORE, partial: MERCHANT_MEDIUM_SCORE },
];

/** Mirrors lib/reconciliation-matching.ts's real weights (40/35/25) AND the
 * engine's partial credits (15 for a pending date, 10 for a partial merchant)
 * so the panel's breakdown sums to the actual confidence — the engine's math,
 * not invented numbers (hardening invariant H). */
export function factorBreakdown(match: ReconciliationMatch): { label: string; score: number; max: number }[] {
  const reasons = (match.matchReason ?? "").split(" + ");
  return FACTOR_WEIGHTS.map(({ key, partialKey, label, max, partial }) => ({
    label,
    max,
    score: reasons.includes(key) ? max : partialKey && reasons.includes(partialKey) ? partial : 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Detection findings -> review copy                                   */
/* ------------------------------------------------------------------ */

export type DetectionKind = "reversal" | "refund" | "split" | "merchant";

export interface TransactionDetection {
  kind: DetectionKind;
  detection: ReviewDetection;
  /** Badge shown on the row for this finding. */
  badge: string;
  relatedIds: string[];
}

/** Money as the review board shows it: "+" for money in, "−" for money out. */
function signedMoney(t: BankTransaction): string {
  return `${t.amount < 0 ? "+" : "−"}${formatMoney(Math.abs(t.amount), t.currency)}`;
}

function absMoney(t: BankTransaction): string {
  return formatMoney(Math.abs(t.amount), t.currency);
}

function merchantName(t: BankTransaction): string {
  return t.merchant || t.description || "(no description)";
}

/** "on the same day" / "1 day apart" / "3 days apart" — never a raw number of
 * milliseconds, and never a bare 0. */
function dayGapPhrase(a: BankTransaction, b: BankTransaction): string {
  const days = Math.round(Math.abs(Date.parse(a.transactionDate) - Date.parse(b.transactionDate)) / 86_400_000);
  if (days === 0) return "on the same day";
  return `${days} ${days === 1 ? "day" : "days"} apart`;
}

function nameEvidence(similarity: number): string {
  if (similarity >= 0.99) return "Supplier names are identical once formatting is ignored.";
  if (similarity >= MERCHANT_STRONG_THRESHOLD) return "Supplier names are highly similar.";
  return "Supplier names are loosely similar.";
}

function reversalDetection(pair: ReversalPair, self: BankTransaction): TransactionDetection {
  const other = pair.a.id === self.id ? pair.b : pair.a;
  const evidence = [
    "Amounts are equal and opposite.",
    pair.reference
      ? `Both lines quote reference ${pair.reference.label}.`
      : "Both lines name the same supplier.",
    `Transactions occurred ${dayGapPhrase(self, other)}.`,
  ];
  return {
    kind: "reversal",
    badge: "Reversal",
    relatedIds: [other.id],
    detection: {
      title: "Possible reversal",
      summary: pair.reference
        ? "Transactions share the same reference and opposite amounts, so they cancel each other out."
        : "Transactions name the same supplier with opposite amounts, so they cancel each other out.",
      lines: [
        { label: "Transaction A", value: signedMoney(pair.a) },
        { label: "Transaction B", value: signedMoney(pair.b) },
      ],
      footer: { label: "Net effect", value: formatMoney(0, self.currency) },
      evidence,
      confidencePct: pair.confidencePct,
      suggestedAction: { text: "Approve both — they cancel out, net effect on the books is nil.", kind: "approve" },
      kind: "reversal",
    },
  };
}

function refundDetection(pair: RefundPair, self: BankTransaction): TransactionDetection {
  const other = pair.charge.id === self.id ? pair.refund : pair.charge;
  return {
    kind: "refund",
    badge: "Refund",
    relatedIds: [other.id],
    detection: {
      title: "Refund detected",
      summary: "Matching amount and related merchant name — this appears to give back an earlier charge.",
      lines: [
        { label: "Original charge", value: absMoney(pair.charge) },
        { label: "Refund", value: absMoney(pair.refund) },
        { label: "Charged to", value: merchantName(pair.charge) },
        { label: "Refunded by", value: merchantName(pair.refund) },
      ],
      footer: { label: "Net effect", value: formatMoney(pair.charge.amount + pair.refund.amount, self.currency) },
      evidence: [
        "Amounts match exactly.",
        nameEvidence(pair.similarity),
        `Transactions occurred ${dayGapPhrase(pair.charge, pair.refund)}.`,
      ],
      confidencePct: pair.confidencePct,
      suggestedAction: { text: "Confirm the pair, then approve both charge and refund.", kind: "approve" },
      kind: "refund",
    },
  };
}

/**
 * One invoice settled in parts. Money in is a client paying us in instalments
 * ("combined payment"); money out is us paying a bill in instalments ("split
 * payment"). Same detection, but an accountant reads and acts on the two
 * differently, so they are labelled differently.
 */
function splitDetection(group: SplitGroup): TransactionDetection {
  const incoming = group.direction === "in";
  const total = formatMoney(Math.abs(group.total), group.transactions[0]?.currency ?? null);
  return {
    kind: "split",
    badge: "Split payment",
    relatedIds: group.transactions.map((t) => t.id),
    detection: {
      title: incoming ? "Combined payment" : "Possible split payment",
      summary: incoming
        ? `${group.transactions.length} payments quote reference ${group.reference.label}, so they look like one invoice settled in parts.`
        : `${group.transactions.length} payments quote reference ${group.reference.label}, so they look like one bill paid in parts.`,
      lines: [
        { label: "Reference", value: group.reference.label },
        ...group.transactions.map((t) => ({
          label: formatShortDate(t.transactionDate),
          value: absMoney(t),
        })),
      ],
      footer: { label: incoming ? "Total received" : "Combined amount", value: total },
      evidence: [
        `Every transaction quotes reference ${group.reference.label}.`,
        incoming ? "All parts are money in." : "All parts are money out.",
        `${group.transactions.length} transactions add up to ${total}.`,
      ],
      confidencePct: group.confidencePct,
      suggestedAction: {
        text: incoming
          ? "Approve all parts as one invoice settled in instalments."
          : "Approve all parts as one bill paid in instalments.",
        kind: "approve",
      },
      kind: "split",
    },
  };
}

function merchantDetection(link: MerchantLink): TransactionDetection {
  const pct = Math.round(link.similarity * 100);
  return {
    kind: "merchant",
    badge: "Related merchant",
    relatedIds: [link.b.id],
    detection: {
      title: "Possible related merchant",
      summary:
        link.similarity >= MERCHANT_STRONG_THRESHOLD
          ? "These two supplier names look like the same business trading under different names."
          : "These two supplier names may be the same business — worth confirming before categorising.",
      lines: [
        { label: "Merchant A", value: merchantName(link.a) },
        { label: "Merchant B", value: merchantName(link.b) },
      ],
      footer: { label: "Similarity", value: `${pct}%` },
      evidence: [nameEvidence(link.similarity), "Both appear on this statement."],
      confidencePct: link.confidencePct,
      suggestedAction: { text: "Confirm these are the same business before categorising.", kind: "review" },
      kind: "merchant",
    },
  };
}

/**
 * Run every detector and keep, per transaction, the single most decisive
 * finding. Order is deliberate: a reversal explains a transaction completely,
 * a refund nearly so, a split explains how it relates to its siblings, and a
 * merchant resemblance is only ever a hint. Showing an accountant two
 * competing explanations for one line costs more time than it saves.
 */
export function buildDetections(bank: BankTransaction[]): Map<string, TransactionDetection> {
  const found = new Map<string, TransactionDetection>();

  const reversals = detectReversals(bank);
  const reversedIds = new Set(reversals.flatMap((p) => [p.a.id, p.b.id]));
  for (const pair of reversals) {
    found.set(pair.a.id, reversalDetection(pair, pair.a));
    found.set(pair.b.id, reversalDetection(pair, pair.b));
  }

  for (const pair of detectRefunds(bank, reversedIds)) {
    if (!found.has(pair.charge.id)) found.set(pair.charge.id, refundDetection(pair, pair.charge));
    if (!found.has(pair.refund.id)) found.set(pair.refund.id, refundDetection(pair, pair.refund));
  }

  for (const group of detectSplitGroups(bank, reversedIds)) {
    const detection = splitDetection(group);
    for (const t of group.transactions) {
      if (!found.has(t.id)) found.set(t.id, { ...detection, relatedIds: group.transactions.filter((o) => o.id !== t.id).map((o) => o.id) });
    }
  }

  for (const [id, link] of detectMerchantLinks(bank)) {
    if (!found.has(id)) found.set(id, merchantDetection(link));
  }

  return found;
}

/**
 * Which review section a transaction belongs in. A detected pattern outranks
 * the match score: knowing a line is a reversal tells an accountant what to do
 * with it, whereas "82% confident" only tells them to look. Duplicates come
 * first because they are the one finding that may mean money left twice.
 */
export function sectionFor(
  match: ReconciliationMatch | null,
  isDuplicate: boolean,
  detectionKind?: DetectionKind | null,
  badges: string[] = [],
): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (detectionKind === "reversal") return "reversal";
  if (detectionKind === "refund") return "refund";
  if (detectionKind === "split") return "split";
  // A confident match is approvable whatever else is true of it — a recurring
  // subscription that reconciles cleanly should not be pulled out of the bulk
  // approve queue just for being recurring.
  if (match?.qbTransactionId && match.flaggedLevel === "green") return "ready";
  if (badges.includes("Transfer")) return "transfer";
  if (badges.includes("Recurring")) return "recurring";
  if (!match || !match.qbTransactionId) return "issue";
  if (match.flaggedLevel === "yellow") return "review";
  return "issue";
}

export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  preferences?: MerchantPreference[];
  aiCategories?: Map<string, MerchantAiCategory>;
}): { id: string; row: ReviewRow; matchId: string | null }[] {
  const dupes = detectDuplicates(data.bankTransactions);
  const detections = buildDetections(data.bankTransactions);

  // Indexes built once for the whole statement. Every lookup below used to be
  // a scan inside the per-row map, which made the cost of rendering the board
  // grow with the square of the statement's size.
  const bankById = new Map(data.bankTransactions.map((b) => [b.id, b]));
  const qbById = new Map(data.qbTransactions.map((q) => [q.id, q]));
  const merchantCounts = countMerchants(data.bankTransactions);
  const preferencesByMerchant = new Map((data.preferences ?? []).map((p) => [p.merchantName, p]));
  const matchByBankId = new Map<string, ReconciliationMatch>();
  // Only matches whose bank transaction shares a merchant are relevant to that
  // merchant's category, and suggestCategory can't do that filtering itself —
  // it never sees the bank side. So the grouping happens here, once.
  const matchesByMerchant = new Map<string, ReconciliationMatch[]>();
  for (const m of data.matches) {
    if (!matchByBankId.has(m.bankTransactionId)) matchByBankId.set(m.bankTransactionId, m);
    const otherBank = bankById.get(m.bankTransactionId);
    if (!otherBank) continue;
    const otherKey = normalizeMerchant(otherBank);
    if (!otherKey) continue;
    const bucket = matchesByMerchant.get(otherKey);
    if (bucket) bucket.push(m);
    else matchesByMerchant.set(otherKey, [m]);
  }

  return data.bankTransactions.map((bank) => {
    const match = matchByBankId.get(bank.id) ?? null;
    const qb = match?.qbTransactionId ? qbById.get(match.qbTransactionId) ?? null : null;
    const isDuplicate = dupes.has(bank.id);
    const found = detections.get(bank.id) ?? null;
    const key = normalizeMerchant(bank);
    const sameMerchantMatches = key ? matchesByMerchant.get(key) ?? [] : [];
    const { label: categoryLabel, reason: categoryReason } = suggestCategory(
      bank, qb, sameMerchantMatches, data.qbTransactions, qbById, preferencesByMerchant, data.aiCategories,
    );
    const badges = detectBadges(bank, data.bankTransactions, merchantCounts);
    if (isDuplicate) badges.unshift("Duplicate");
    if (found) badges.unshift(found.badge);
    const dupeOther = dupes.get(bank.id);

    // A found pattern carries its own confidence; without one we fall back to
    // how well the transaction matched an accounting entry.
    const matchPct = match?.confidence ? Math.round(match.confidence * 100) : 0;
    const pct = isDuplicate ? 99 : found?.detection.confidencePct ?? matchPct;

    const row: ReviewRow = {
      id: bank.id,
      section: sectionFor(match, isDuplicate, found?.kind, badges),
      date: formatShortDate(bank.transactionDate),
      title: merchantName(bank),
      subtitle: qb?.description ?? (match ? "" : "No accounting entry found"),
      amountLabel: signedMoney(bank),
      amountSubLabel: bank.amount < 0 ? "↑ Money in" : "↓ Money out",
      categoryLabel,
      categoryReason,
      confidencePct: pct,
      confidenceLabel: confidenceLabel(pct),
      confidenceColor: confidenceColor(pct),
      reason: found
        ? found.detection.summary
        : match
          ? plainEnglishReason(match)
          : "No accounting entry matches this transaction closely enough to suggest one.",
      badges,
      // Approving reconciles a bank line against an accounting entry, so a
      // line with no match has nothing to approve. Saying that on the control
      // is clearer than letting the click do nothing.
      approvable: match !== null,
      notApprovableReason: "No accounting entry matched yet — match this transaction before approving.",
      detection: found?.detection ?? (isDuplicate && dupeOther ? duplicateDetection(bank, dupeOther) : undefined),
      comparePair: dupeOther
        ? {
            aLabel: "This transaction",
            a: `${formatShortDate(bank.transactionDate)} · ${formatMoney(bank.amount, bank.currency)}`,
            bLabel: "Possible duplicate",
            b: `${formatShortDate(dupeOther.transactionDate)} · ${formatMoney(dupeOther.amount, dupeOther.currency)}`,
          }
        : undefined,
    };

    return { id: bank.id, row, matchId: match?.id ?? null };
  });
}

function duplicateDetection(self: BankTransaction, other: BankTransaction): ReviewDetection {
  return {
    title: "Possible duplicate",
    summary: "Two transactions with the same supplier and amount, charged within a day of each other.",
    lines: [
      { label: formatShortDate(self.transactionDate), value: absMoney(self) },
      { label: formatShortDate(other.transactionDate), value: absMoney(other) },
    ],
    footer: { label: "Combined amount", value: formatMoney(Math.abs(self.amount) + Math.abs(other.amount), self.currency) },
    evidence: [
      "Amounts match exactly.",
      "Supplier names are identical.",
      `Transactions occurred ${dayGapPhrase(self, other)}.`,
    ],
    confidencePct: 99,
    suggestedAction: {
      text: "Reject the second transaction — it looks like the same charge processed twice.",
      kind: "reject",
    },
  };
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
