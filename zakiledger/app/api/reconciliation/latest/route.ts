import { NextResponse } from "next/server";
import { getLatestStatementId } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/reconciliation/latest
 *
 * The Review Matches / Batch Review sidebar links carry no statement id (the
 * sidebar is static nav, not aware of "which statement is open") — this is
 * the fallback they use when the page is reached without a ?statementId=
 * query param, e.g. right after an upload.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const statementId = await getLatestStatementId(user.id);
  return NextResponse.json({ statementId });
}
