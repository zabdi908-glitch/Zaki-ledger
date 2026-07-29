import { NextRequest, NextResponse } from "next/server";
import { rejectMatch } from "@/lib/reconciliation-store";
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

    await rejectMatch(user.id, id, body.matchId);

    return NextResponse.json({ rejected: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reject match.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
