import { NextRequest, NextResponse } from "next/server";
import { listBankTransactions, listMatchesForStatement, rejectMatch } from "@/lib/reconciliation-store";
import { recordDecision } from "@/lib/decision-store";
import { requireUser } from "@/lib/auth";
import { z } from "zod/v4";

const BodySchema = z.object({
  matchId: z.string(),
});

/**
 * POST /api/reconciliation/[id]/reject
 * Body: { matchId }
 *
 * The human decided a proposed match is wrong — clears it so the bank
 * transaction returns to unmatched. Refuses (400) if the match is already
 * approved; approved matches are part of the immutable audit trail.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    // Looked up before rejectMatch removes the row, so the decision log still
    // knows which bank transaction and merchant this was about.
    const matches = await listMatchesForStatement(user.id, id);
    const match = matches.find((m) => m.id === body.matchId);

    await rejectMatch(user.id, id, body.matchId);

    // A decision-log failure must never fail the rejection itself — no
    // preference bump here, a rejection says the match was wrong, not that
    // the category was.
    try {
      if (match) {
        const bankTxns = await listBankTransactions(user.id, id);
        const bank = bankTxns.find((b) => b.id === match.bankTransactionId);
        await recordDecision(user.id, {
          statementId: id,
          matchId: body.matchId,
          bankTransactionId: match.bankTransactionId,
          decisionType: "reject",
          merchantName: bank?.merchant ?? bank?.description ?? null,
          suggestedCategory: null,
          userChoiceCategory: null,
        });
      }
    } catch (logErr) {
      console.warn("Failed to log reject decision:", logErr);
    }

    return NextResponse.json({ rejected: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject match.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
