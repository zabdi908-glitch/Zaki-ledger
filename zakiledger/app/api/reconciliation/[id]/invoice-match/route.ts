import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { saveInvoiceMatch } from "@/lib/invoice-match-store";
import { recordDecision } from "@/lib/decision-store";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { resolveTenantClientEntityIdForWrite } from "@/lib/tenant-context";
import { z } from "zod/v4";

const BodySchema = z.object({
  bankTransactionId: z.string(),
  invoiceId: z.string(),
  confidencePct: z.number(),
  matchedBy: z.enum(["reference", "amount_date"]),
});

/**
 * POST /api/reconciliation/[id]/invoice-match
 * Body: { bankTransactionId, invoiceId, confidencePct, matchedBy }
 *
 * Confirms a suggested bank-line -> invoice match (Group C Task 1's fuzzy
 * suggestion, accepted by the human). Logged in the decision log same as
 * approve/reject so the learning engine sees it too.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    const matchId = await saveInvoiceMatch(user.id, {
      bankTransactionId: body.bankTransactionId,
      invoiceId: body.invoiceId,
      confidencePct: body.confidencePct,
      matchedBy: body.matchedBy,
    });

    // A decision-log failure must never fail the confirmation itself — the
    // invoice match is already committed by the time we get here.
    try {
      const clientEntityId = await resolveTenantClientEntityIdForWrite(user.id);
      await recordDecision(user.id, clientEntityId, {
        statementId: id,
        matchId: null,
        bankTransactionId: body.bankTransactionId,
        decisionType: "accept_suggestion",
        merchantName: null,
        suggestedCategory: null,
        userChoiceCategory: null,
      });
    } catch (logErr) {
      console.warn("Failed to log invoice-match decision:", logErr);
    }

    return NextResponse.json({ ok: true, id: matchId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to confirm invoice match.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
