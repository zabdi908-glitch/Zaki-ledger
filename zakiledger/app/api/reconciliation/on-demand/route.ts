import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  getBankStatement,
  saveQbTransactions,
  computeAndPersistMatches,
} from "@/lib/reconciliation-store";
import { getValidQboAccess, listQuickBooksPurchases } from "@/lib/quickbooks";
import { getValidXeroAccess, listXeroBankTransactions } from "@/lib/xero";
import type { QbTransactionInput } from "@/lib/reconciliation-schema";

export interface OnDemandMatchResponse {
  statementId: string;
  matches: Awaited<ReturnType<typeof computeAndPersistMatches>>["matches"];
  unmatchedBankIds: string[];
  unmatchedQbIds: string[];
  stats: {
    total: number;
    green: number;
    yellow: number;
    red: number;
    unmatched: number;
  };
  syncedFrom: {
    quickBooks: number;
    xero: number;
  };
}

/**
 * POST /api/reconciliation/on-demand
 *
 * On-demand fallback matching for a single statement.
 * Runs the same pipeline as the nightly matcher, scoped to one statement,
 * and returns the match results synchronously (no polling).
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { statementId?: unknown };
  try {
    body = (await req.json()) as { statementId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const statementId = typeof body.statementId === "string" ? body.statementId : null;
  if (!statementId) {
    return NextResponse.json({ error: "Missing statementId in request body." }, { status: 400 });
  }

  try {
    const statement = await getBankStatement(user.id, statementId);
    if (!statement) {
      return NextResponse.json({ error: "Statement not found." }, { status: 404 });
    }

    const qbInputs: QbTransactionInput[] = [];
    let qbSynced = 0;
    let xeroSynced = 0;

    const periodStart = statement.periodStart;
    const periodEnd = statement.periodEnd;

    // 1. QuickBooks — gracefully skip if not connected, token invalid, or no period
    if (periodStart && periodEnd) {
      const qbAccess = await getValidQboAccess(user.id).catch(() => null);
      if (qbAccess) {
        const purchases = await listQuickBooksPurchases(
          user.id,
          periodStart,
          periodEnd,
        );
        qbInputs.push(...purchases);
        qbSynced = purchases.length;
      }

      // 2. Xero — gracefully skip if not connected or token invalid
      const xeroAccess = await getValidXeroAccess(user.id).catch(() => null);
      if (xeroAccess) {
        const xeroTxns = await listXeroBankTransactions(
          user.id,
          periodStart,
          periodEnd,
        );
        qbInputs.push(...xeroTxns);
        xeroSynced = xeroTxns.length;
      }
    }

    // 3. Persist fresh accounting-side transactions so the matcher can see them
    if (qbInputs.length > 0) {
      await saveQbTransactions(user.id, qbInputs);
    }

    // 4. Run matching (idempotent — never clobbers manual matches)
    const result = await computeAndPersistMatches(user.id, statementId);

    // 5. Build stats
    const stats = {
      total: result.matches.length + result.unmatchedBankIds.length,
      green: 0,
      yellow: 0,
      red: 0,
      unmatched: result.unmatchedBankIds.length,
    };

    for (const m of result.matches) {
      if (m.flaggedLevel === "green") stats.green += 1;
      else if (m.flaggedLevel === "yellow") stats.yellow += 1;
      else if (m.flaggedLevel === "red") stats.red += 1;
    }

    const response: OnDemandMatchResponse = {
      statementId,
      matches: result.matches,
      unmatchedBankIds: result.unmatchedBankIds,
      unmatchedQbIds: result.unmatchedQbIds,
      stats,
      syncedFrom: {
        quickBooks: qbSynced,
        xero: xeroSynced,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "On-demand matching failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}