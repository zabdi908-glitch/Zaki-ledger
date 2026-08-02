import { NextResponse } from "next/server";
import { computeAndPersistMatches, getBankStatement } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { matchInvoices } from "@/lib/invoice-matching";
import { listInvoiceMatches } from "@/lib/invoice-match-store";
import { listApprovedInvoicesForMatching } from "@/lib/store";

/**
 * GET /api/reconciliation/[id]/transactions
 *
 * Runs the matching algorithm against this statement's bank + QB transactions
 * (persisting fresh `auto` matches, never overwriting existing manual/auto
 * ones — see computeAndPersistMatches) and returns everything the review UI
 * needs: both transaction lists, the matches, and what's still unmatched on
 * each side. Also computes fresh invoice-match suggestions for every bank
 * line that doesn't already have a confirmed one (Group C).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const statement = await getBankStatement(user.id, id);
    if (!statement) {
      return NextResponse.json({ error: "Statement not found." }, { status: 404 });
    }

    const result = await computeAndPersistMatches(user.id, id);

    const invoices = await listApprovedInvoicesForMatching(user.id);
    const confirmed = await listInvoiceMatches(user.id, result.bankTransactions.map((b) => b.id));
    const confirmedBankIds = new Set(confirmed.map((c) => c.bankTransactionId));
    const invoiceSuggestions = matchInvoices(
      result.bankTransactions.filter((b) => !confirmedBankIds.has(b.id)),
      invoices,
    );

    return NextResponse.json({
      bankTransactions: result.bankTransactions,
      qbTransactions: result.qbTransactions,
      matches: result.matches,
      unmatchedBank: result.unmatchedBankIds,
      unmatchedQb: result.unmatchedQbIds,
      invoiceSuggestions,
      invoiceMatches: confirmed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
