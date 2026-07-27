import { NextRequest, NextResponse } from "next/server";
import { bulkApprove } from "@/lib/bulk-approve";

/**
 * POST /api/approve/bulk
 * Body: { documentIds: string[] } — ids from the pending queue (GET /api/pending).
 *
 * Approves each document independently and returns one result per id plus a
 * summary. A per-document failure is a result, not an HTTP error: the whole point
 * is that one bad document doesn't cost the other nine their approval. A 4xx/5xx
 * here means the request itself was unusable.
 */
export async function POST(req: NextRequest) {
  try {
    const { documentIds } = (await req.json()) as { documentIds?: unknown };

    if (!Array.isArray(documentIds) || documentIds.some((id) => typeof id !== "string")) {
      return NextResponse.json(
        { error: "documentIds must be an array of document ids." },
        { status: 400 },
      );
    }
    if (documentIds.length === 0) {
      return NextResponse.json({ error: "No documents selected." }, { status: 400 });
    }

    const { results, summary } = await bulkApprove(documentIds as string[]);
    console.log(
      `[bulk-approve] ${documentIds.length} submitted → ${summary.approved} approved, ` +
        `${summary.blocked} blocked, ${summary.errors} error(s), posted ${summary.postedLabel}`,
    );

    return NextResponse.json({ results, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bulk approve failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
