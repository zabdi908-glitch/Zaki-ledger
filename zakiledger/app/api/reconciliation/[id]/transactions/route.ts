import { NextResponse } from "next/server";
import { computeAndPersistMatches, getBankStatement } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/reconciliation/[id]/transactions
 *
 * Runs the matching algorithm against this statement's bank + QB transactions
 * (persisting fresh `auto` matches, never overwriting existing manual/auto
 * ones — see computeAndPersistMatches) and returns everything the review UI
 * needs: both transaction lists, the matches, and what's still unmatched on
 * each side.
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

    return NextResponse.json({
      bankTransactions: result.bankTransactions,
      qbTransactions: result.qbTransactions,
      matches: result.matches,
      unmatchedBank: result.unmatchedBankIds,
      unmatchedQb: result.unmatchedQbIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
