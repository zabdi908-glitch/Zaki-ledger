import { NextRequest, NextResponse } from "next/server";
import { QbTransactionInputSchema } from "@/lib/reconciliation-schema";
import { saveQbTransactions } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { z } from "zod/v4";

const BodySchema = z.object({
  transactions: z.array(QbTransactionInputSchema),
});

/**
 * POST /api/reconciliation/qb-transactions
 * Body: { transactions: QbTransactionInput[] }
 *
 * Not in the brief's endpoint list — added because there's no live QB/Xero
 * sync yet (that's tomorrow's session), and `qb_transactions` needs some way
 * to get populated today for the matching algorithm to have anything to
 * match against. Tomorrow's live sync calls `saveQbTransactions` directly
 * instead of using this route.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const body = BodySchema.parse(await req.json());
    const count = await saveQbTransactions(user.id, body.transactions);
    return NextResponse.json({ imported: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to import QB transactions.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
