import { formatMoney } from "./currency";
import type { BankTransaction, QbTransaction, ReconciliationMatch } from "./reconciliation-schema";
import { shellColor } from "./shell-theme";
import type { ReviewRow, ReviewSectionKey } from "@/components/review/ReviewBoard";

/**
 * Turns the matching engine's raw output (lib/reconciliation-matching.ts) into
 * the review board's row shape: plain-English copy, badges, sections, and a
 * confidence system, all derived from data the existing endpoints already
 * return — no new tables, no new queries.
 */

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

/** e.g. "amount + date + merchant" -> "Amount, date, and merchant all match." */
export function plainEnglishReason(match: ReconciliationMatch): string {
  if (!match.qbTransactionId || !match.matchReason) {
    return "No accounting entry matches this transaction closely enough to suggest one.";
  }
  const parts = match.matchReason.split(" + ").map((p) => FACTOR_PHRASES[p] ?? p);
  const nouns = parts.map((p) => p.replace(/ matches?( \(.*\))?$/, (m) => m).split(" ")[0]);
  if (parts.length === 1) return `${capitalize(parts[0])}.`;
  if (parts.length === 2) return `${capitalize(nouns[0])} and ${nouns[1]} both match.`;
  const last = nouns[nouns.length - 1];
  return `${capitalize(nouns.slice(0, -1).join(", "))}, and ${last} all match.`;
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
 * store query across statements — out of scope for this pass; see the
 * implementation plan's Task 5 note. */
export function detectBadges(bank: BankTransaction, allBank: BankTransaction[]): string[] {
  const text = `${bank.merchant ?? ""} ${bank.description ?? ""}`;
  const badges: string[] = [];
  if (VAT_RE.test(text)) badges.push("VAT");
  if (PAYROLL_RE.test(text)) badges.push("Payroll");
  if (SUBSCRIPTION_MERCHANTS.test(text)) badges.push("Subscription");
  if (TRANSFER_RE.test(text)) badges.push("Transfer");
  const key = normalizeMerchant(bank);
  if (key && allBank.filter((b) => normalizeMerchant(b) === key).length > 1) badges.push("Recurring");
  return badges;
}

/** Pairs transactions that share a merchant + exact amount within 1 day of
 * each other — the in-statement duplicate-authorization / pre-auth pattern. */
export function detectDuplicates(bank: BankTransaction[]): Map<string, BankTransaction> {
  const result = new Map<string, BankTransaction>();
  for (let i = 0; i < bank.length; i++) {
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i];
      const b = bank[j];
      const sameMerchant = normalizeMerchant(a) !== "" && normalizeMerchant(a) === normalizeMerchant(b);
      const sameAmount = Math.abs(a.amount - b.amount) < 0.005;
      const closeInTime = Math.abs(Date.parse(a.transactionDate) - Date.parse(b.transactionDate)) <= 86400000;
      if (sameMerchant && sameAmount && closeInTime) {
        result.set(a.id, b);
        result.set(b.id, a);
      }
    }
  }
  return result;
}

/** Matched -> the QB account name. Unmatched -> the most common account name
 * this merchant has been matched to elsewhere in this statement. Otherwise
 * "Uncategorised" — a real cross-statement lookup is a follow-up, not needed
 * to ship this screen. */
export function suggestCategory(
  bank: BankTransaction,
  qb: QbTransaction | null,
  matches: ReconciliationMatch[],
  qbTxns: QbTransaction[],
): string {
  if (qb?.accountName) return qb.accountName;
  const key = normalizeMerchant(bank);
  if (!key) return "Uncategorised";
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (!m.qbTransactionId) continue;
    const matchedQb = qbTxns.find((q) => q.id === m.qbTransactionId);
    if (!matchedQb?.accountName) continue;
    counts.set(matchedQb.accountName, (counts.get(matchedQb.accountName) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? "Uncategorised";
}

const FACTOR_WEIGHTS: { key: string[]; label: string; max: number }[] = [
  { key: ["amount"], label: "Amount", max: 40 },
  { key: ["date", "date (pending)"], label: "Date", max: 35 },
  { key: ["merchant", "merchant (partial)"], label: "Merchant", max: 25 },
];

/** Mirrors lib/reconciliation-matching.ts's real AMOUNT_SCORE/DATE_CLOSE_SCORE/
 * MERCHANT_HIGH_SCORE weights (40/35/25) so the panel's breakdown is the
 * engine's actual math, not invented numbers. */
export function factorBreakdown(match: ReconciliationMatch): { label: string; score: number; max: number }[] {
  const reasons = (match.matchReason ?? "").split(" + ");
  return FACTOR_WEIGHTS.map(({ key, label, max }) => ({
    label,
    max,
    score: key.some((k) => reasons.includes(k)) ? max : 0,
  }));
}

export function sectionFor(match: ReconciliationMatch | null, isDuplicate: boolean): ReviewSectionKey {
  if (isDuplicate) return "duplicate";
  if (!match || !match.qbTransactionId) return "issue";
  if (match.flaggedLevel === "green") return "ready";
  if (match.flaggedLevel === "yellow") return "review";
  return "issue";
}

export function buildReviewRows(data: {
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
}): { id: string; row: ReviewRow; matchId: string | null }[] {
  const dupes = detectDuplicates(data.bankTransactions);

  return data.bankTransactions.map((bank) => {
    const match = data.matches.find((m) => m.bankTransactionId === bank.id) ?? null;
    const qb = match?.qbTransactionId ? data.qbTransactions.find((q) => q.id === match.qbTransactionId) ?? null : null;
    const isDuplicate = dupes.has(bank.id);
    const pct = match?.confidence ? Math.round(match.confidence * 100) : 0;
    // Only consider matches whose bank transaction shares this merchant —
    // suggestCategory itself doesn't know about other bank transactions, so
    // the merchant filter has to happen here, at the one place that does.
    const key = normalizeMerchant(bank);
    const sameMerchantMatches = key
      ? data.matches.filter((m) => {
          const otherBank = data.bankTransactions.find((b) => b.id === m.bankTransactionId);
          return otherBank ? normalizeMerchant(otherBank) === key : false;
        })
      : [];
    const category = suggestCategory(bank, qb, sameMerchantMatches, data.qbTransactions);
    const badges = detectBadges(bank, data.bankTransactions);
    const dupeOther = dupes.get(bank.id);

    const row: ReviewRow = {
      id: bank.id,
      section: sectionFor(match, isDuplicate),
      date: formatShortDate(bank.transactionDate),
      title: bank.merchant || bank.description || "(no description)",
      subtitle: qb?.description ?? (match ? "" : "No accounting entry found"),
      amountLabel: `${bank.amount < 0 ? "+" : "−"}${formatMoney(Math.abs(bank.amount), bank.currency)}`,
      amountSubLabel: bank.amount < 0 ? "↑ Money in" : "↓ Money out",
      categoryLabel: category,
      confidencePct: pct,
      confidenceLabel: confidenceLabel(pct),
      confidenceColor: confidenceColor(pct),
      reason: match ? plainEnglishReason(match) : "No accounting entry matches this transaction closely enough to suggest one.",
      badges,
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

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
