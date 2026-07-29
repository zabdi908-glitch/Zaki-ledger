import { NextResponse } from "next/server";
import { getReconciliationReport } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/reconciliation/[id]/report
 *
 * The reconciliation summary a bookkeeper signs off on. 404s until at least
 * one approve call has generated one for this statement.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const report = await getReconciliationReport(user.id, id);
    if (!report) {
      return NextResponse.json(
        { error: "No reconciliation report yet — approve at least one match first." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      period: { start: report.periodStart, end: report.periodEnd },
      bankBalance: { opening: report.bankOpeningBalance, closing: report.bankClosingBalance },
      qbBalance: { opening: report.qbOpeningBalance, closing: report.qbClosingBalance },
      totalMatched: report.totalMatched,
      totalUnmatchedBank: report.totalUnmatchedBank,
      totalUnmatchedQb: report.totalUnmatchedQb,
      variance: report.variance,
      isReconciled: report.isReconciled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
