import { NextRequest, NextResponse } from "next/server";
import { isQuickBooksConnected, listQuickBooksPurchases } from "@/lib/quickbooks";
import { isXeroConnected, listXeroBankTransactions } from "@/lib/xero";
import { getBankStatement, saveQbTransactions } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import { z } from "zod/v4";

const BodySchema = z.object({
  statementId: z.string(),
});

/** Today, minus `days`, as YYYY-MM-DD (UTC). */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * POST /api/reconciliation/qb-transactions/sync
 * Body: { statementId }
 *
 * The live-sync counterpart to POST /api/reconciliation/qb-transactions/upload
 * (the CSV stand-in) — pulls the accounting side straight from whichever
 * platform is connected, for the uploaded statement's own period. One
 * provider at a time, same rule as bill-posting (lib/accounting.ts prefers
 * Xero, only tries QuickBooks when Xero isn't connected).
 *
 * Falls back to the last 90 days when the statement has no detected period
 * (a plain transaction CSV rarely states one — see saveBankStatement) rather
 * than refusing outright.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const { statementId } = BodySchema.parse(await req.json());
    const statement = await getBankStatement(user.id, statementId);
    if (!statement) {
      return NextResponse.json({ error: "Statement not found." }, { status: 404 });
    }

    const periodStart = statement.periodStart ?? daysAgo(90);
    const periodEnd = statement.periodEnd ?? today();

    const xeroConnected = await isXeroConnected(user.id);
    const qboConnected = !xeroConnected && (await isQuickBooksConnected(user.id));

    if (!xeroConnected && !qboConnected) {
      return NextResponse.json(
        { error: "Connect Xero or QuickBooks first (Settings) to sync accounting transactions live." },
        { status: 400 },
      );
    }

    const transactions = xeroConnected
      ? await listXeroBankTransactions(user.id, periodStart, periodEnd)
      : await listQuickBooksPurchases(user.id, periodStart, periodEnd);

    if (transactions.length === 0) {
      return NextResponse.json({ imported: 0, provider: xeroConnected ? "xero" : "quickbooks" });
    }

    const imported = await saveQbTransactions(user.id, transactions);
    return NextResponse.json({ imported, provider: xeroConnected ? "xero" : "quickbooks" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync accounting transactions.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
