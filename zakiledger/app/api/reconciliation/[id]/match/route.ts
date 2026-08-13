import { NextRequest, NextResponse } from "next/server";
import { createManualMatch } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { z } from "zod/v4";

const BodySchema = z.object({
  bankTransactionId: z.string(),
  qbTransactionId: z.string(),
});

/**
 * POST /api/reconciliation/[id]/match
 * Body: { bankTransactionId, qbTransactionId }
 *
 * The human override: pick the QB transaction yourself when the algorithm
 * got it wrong (or flagged it red/didn't match at all). Always wins over
 * whatever auto-matching decided for that bank transaction.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    const match = await createManualMatch(user.id, id, body.bankTransactionId, body.qbTransactionId);

    return NextResponse.json({
      matchId: match.id,
      confidence: match.confidence,
      flaggedLevel: match.flaggedLevel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create manual match.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
