import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/dashboard-pipeline";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/reconciliation/[id]/dashboard
 *
 * Returns everything the reconciliation dashboard needs in one payload:
 * statement metadata, matches grouped by flaggedLevel (green/yellow/red) with
 * their associated transaction details and audit memos, unmatched bank/QB
 * transactions, and the current reconciliation report.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const data = await getDashboardData(user.id, id);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load dashboard data.";
    const status = message === "Statement not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}