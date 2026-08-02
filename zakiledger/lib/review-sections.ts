import type { ReviewSectionConfig } from "@/components/review/ReviewBoard";
import { shellColor } from "@/lib/shell-theme";

/**
 * Shared section config for the reconciliation review board — moved out of
 * app/(app)/reconciliation/review/page.tsx so the upload screen's dashboard
 * breakdown (Group D) can render the same titles/colors/descriptions without
 * importing across route files.
 *
 * Order matters: the accountant works top to bottom, so the sections that can
 * be cleared fastest come first, then the ones where we can say exactly what
 * happened, and only then the residual pile that still needs investigating.
 */
export const SECTIONS: ReviewSectionConfig[] = [
  {
    key: "ready",
    title: "Ready to Approve",
    accentColor: shellColor.high,
    description: "95%+ confidence — amount, date, and merchant all match. Safe to approve as a batch.",
    showBulkApproveAll: true,
    bulkApprovable: true,
  },
  {
    key: "review",
    title: "Needs Review",
    accentColor: shellColor.medium,
    description: "Below 95% confidence, or missing an accounting match. Worth a quick look before approving.",
  },
  {
    key: "duplicate",
    title: "Possible Duplicates",
    accentColor: shellColor.dupe,
    description: "Two entries that look like the same transaction. Decide whether to keep both or reject one.",
  },
  {
    key: "refund",
    title: "Refunds",
    accentColor: shellColor.refund,
    description: "Money back from a supplier that matches an earlier charge. Confirm the pair, then approve both.",
    bulkApprovable: true,
  },
  {
    key: "reversal",
    title: "Reversals",
    accentColor: shellColor.reversal,
    description: "Equal and opposite transactions that cancel each other out. Net effect on the books is nil.",
    bulkApprovable: true,
  },
  {
    key: "split",
    title: "Split Payments",
    accentColor: shellColor.split,
    description: "Several transactions quoting one invoice reference — one bill or payment settled in parts.",
    bulkApprovable: true,
  },
  {
    key: "transfer",
    title: "Transfers",
    accentColor: shellColor.transfer,
    description: "Money moving between your own accounts rather than in or out of the business.",
  },
  {
    key: "recurring",
    title: "Recurring Transactions",
    accentColor: shellColor.recurring,
    description: "Charges from a supplier that appears more than once on this statement.",
    bulkApprovable: true,
  },
  {
    key: "issue",
    title: "Potential Issues",
    accentColor: shellColor.low,
    description: "No match found, a currency mismatch, or an amount large enough to flag for manual review.",
  },
];
