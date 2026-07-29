import { NextRequest, NextResponse } from "next/server";
import { approveMatches } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { z } from "zod/v4";

const BodySchema = z.object({
  matchesToApprove: z.array(z.string()).min(1),
});

/**
 * POST /api/reconciliation/[id]/approve
 * Body: { matchesToApprove: [matchId, ...] }
 *
 * Approves a subset of matches (partial reconciliation is allowed by design
 * — see the brief), writes an immutable audit-log entry per match, and
 * (re)generates the statement's reconciliation report from current totals.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    const report = await approveMatches(user.id, id, body.matchesToApprove, user.id);

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
