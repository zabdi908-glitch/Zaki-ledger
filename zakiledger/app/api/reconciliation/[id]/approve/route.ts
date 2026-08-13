import { NextRequest, NextResponse } from "next/server";
import { approveMatches, listBankTransactions, listMatchesForStatement } from "@/lib/reconciliation-store";
import { bumpMerchantPreference, recordDecision } from "@/lib/decision-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { resolveTenantClientEntityIdForWrite } from "@/lib/tenant-context";
import { z } from "zod/v4";

const BodySchema = z.object({
  matchesToApprove: z.array(z.string()).min(1),
  categories: z.record(z.string(), z.string()).optional(),
});

/**
 * POST /api/reconciliation/[id]/approve
 * Body: { matchesToApprove: [matchId, ...], categories?: { [matchId]: category } }
 *
 * Approves a subset of matches (partial reconciliation is allowed by design
 * — see the brief), writes an immutable audit-log entry per match, and
 * (re)generates the statement's reconciliation report from current totals.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    const report = await approveMatches(user.id, id, body.matchesToApprove, user.id);

    // A decision-log failure must never fail the approval itself — the
    // reconciliation is already committed by the time we get here.
    try {
      const clientEntityId = await resolveTenantClientEntityIdForWrite(user.id);
      const [matches, bankTxns] = await Promise.all([
        listMatchesForStatement(user.id, id),
        listBankTransactions(user.id, id),
      ]);
      const matchById = new Map(matches.map((m) => [m.id, m]));
      const bankById = new Map(bankTxns.map((b) => [b.id, b]));
      for (const matchId of body.matchesToApprove) {
        const match = matchById.get(matchId);
        if (!match) continue;
        const bank = bankById.get(match.bankTransactionId);
        const merchant = bank?.merchant ?? bank?.description ?? null;
        const category = body.categories?.[matchId] ?? null;
        await recordDecision(user.id, clientEntityId, {
          statementId: id,
          matchId,
          bankTransactionId: match.bankTransactionId,
          decisionType: "approve",
          merchantName: merchant,
          suggestedCategory: category,
          userChoiceCategory: null,
        });
        if (merchant && category && category !== "Uncategorised") {
          await bumpMerchantPreference(user.id, merchant, category);
        }
      }
    } catch (logErr) {
      console.warn("Failed to log approve decision(s):", logErr);
    }

    return NextResponse.json({
      reconciled: body.matchesToApprove.length,
      variance: report.variance,
      reportId: report.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to approve matches.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
