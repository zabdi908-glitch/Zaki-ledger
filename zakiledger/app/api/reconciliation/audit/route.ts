import { NextResponse } from "next/server";
import { listRecentApprovedMatches } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/reconciliation/audit
 * The reconciliation half of Settings' "Audit log" table — merged
 * client-side with /api/corrections' rows. See lib/dashboard.ts for the
 * same real-data-over-mockup-fixtures approach applied to the Dashboard.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const matches = await listRecentApprovedMatches(user.id, 20);
  return NextResponse.json({ matches });
}
