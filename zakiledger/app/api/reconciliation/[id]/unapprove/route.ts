import { NextRequest, NextResponse } from "next/server";
import { unapproveMatches } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { z } from "zod/v4";

const BodySchema = z.object({
  matchIds: z.array(z.string()).min(1),
});

/**
 * POST /api/reconciliation/[id]/unapprove
 * Body: { matchIds: [matchId, ...] }
 *
 * Undo for an approval — clears approved_at/approved_by and writes a
 * "match_unapproved" audit-log entry alongside the original "match_approved"
 * one (nothing is deleted; the full history stays intact). Returns how many
 * of the given ids were actually reverted (already-unapproved ids are
 * silently skipped, not an error).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const body = BodySchema.parse(await req.json());

    const reverted = await unapproveMatches(user.id, id, body.matchIds);

    return NextResponse.json({ reverted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to undo approval.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
