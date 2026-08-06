import type { AuditMemo } from "./audit-memo-schema";
import type { ProposedMatch, BankTransaction, QbTransaction } from "./reconciliation-schema";

/**
 * Detects whether the app is running in demo mode (no real Anthropic API key).
 * The Vitest config injects a dummy key for test isolation, so we treat that
 * as demo mode too.
 */
function isDemoMode(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return !key || key === "sk-ant-test-dummy-key";
}

/** Template memos for demo mode — one per flaggedLevel the matching engine emits. */
const DEMO_TEMPLATES: Record<
  string,
  Omit<AuditMemo, "matchId">
> = {
  green: {
    category: "PERFECT_MATCH",
    severity: "info",
    title: "Exact match",
    explanation:
      "Amount, date, and merchant all line up. Nothing to check — approve and post.",
    suggestedAction: "Approve and post.",
    taxRelevant: false,
    ruleReference: "PERFECT_MATCH",
    matchedFields: ["amount", "date", "merchant"],
    mismatchedFields: [],
  },
  yellow: {
    category: "FUZZY_MERCHANT",
    severity: "warning",
    title: "Merchant name differs",
    explanation:
      "Amount and date match, but the merchant names don't align exactly. Check if this is the same supplier listed differently in the bank feed and QuickBooks.",
    suggestedAction:
      "Review the merchant name. If it's the same supplier, approve. If not, reject and match manually.",
    taxRelevant: false,
    ruleReference: "FUZZY_MERCHANT",
    matchedFields: ["amount", "date"],
    mismatchedFields: ["merchant"],
  },
  red: {
    category: "UNMATCHED",
    severity: "critical",
    title: "No clear match found",
    explanation:
      "This transaction couldn't be confidently matched to any QuickBooks entry. You'll need to review it manually.",
    suggestedAction:
      "Check QuickBooks for a missing entry, or create a new one and re-run matching.",
    taxRelevant: false,
    ruleReference: "UNMATCHED",
    matchedFields: [],
    mismatchedFields: ["amount", "date", "merchant"],
  },
};

/**
 * Generates human-readable audit memos for a set of proposed reconciliation matches.
 *
 * **Demo mode** (no API key or dummy test key) returns template memos based on
 * `match.flaggedLevel` so the UI can be exercised without calling Claude.
 *
 * **Full mode** (real API key present) would call Claude to analyse the actual
 * transaction pair and detect patterns such as un-itemised UK VAT (TAX_MISMATCH).
 * That path is a stub for now — it falls back to the same templates.
 */
export async function generateAuditMemos(
  matches: ProposedMatch[],
  _bankTransactions: BankTransaction[],
  _qbTransactions: QbTransaction[],
): Promise<AuditMemo[]> {
  if (matches.length === 0) {
    return [];
  }

  if (isDemoMode()) {
    return matches.map((match) => {
      const template = DEMO_TEMPLATES[match.flaggedLevel] ?? DEMO_TEMPLATES.red;
      return {
        matchId: match.bankTransactionId,
        ...template,
      } satisfies AuditMemo;
    });
  }

  // TODO: Full Claude-backed analysis — detect PERFECT_MATCH, TAX_MISMATCH,
  // FUZZY_MERCHANT, etc. by inspecting the actual transaction data.
  // For now, fall back to the same templates so the UI doesn't break.
  return matches.map((match) => {
    const template = DEMO_TEMPLATES[match.flaggedLevel] ?? DEMO_TEMPLATES.red;
    return {
      matchId: match.bankTransactionId,
      ...template,
    } satisfies AuditMemo;
  });
}