import { NextResponse } from "next/server";
import { sampleBulkBatch } from "@/lib/demo";
import { savePendingDocument } from "@/lib/store";
import { requireUser } from "@/lib/auth";

/**
 * POST /api/pending/demo — seed the queue with the mixed demo batch (3 clean
 * receipts, 1 smudged merchant name, 1 unpostable currency), so bulk approve can
 * be exercised end to end with no API key and no database.
 *
 * Demo-mode only. With a real ANTHROPIC_API_KEY set, the queue is expected to
 * hold real uploads and this refuses — seeded fixtures posting real bills to a
 * connected Xero organisation is not something to leave one fetch away.
 */
export async function POST() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "The demo batch is only available in demo mode (no ANTHROPIC_API_KEY set)." },
      { status: 400 },
    );
  }

  try {
    const ids: string[] = [];
    for (const { filename, extraction } of sampleBulkBatch()) {
      ids.push(await savePendingDocument(user.id, { extraction, filename, synthetic: true }));
    }
    return NextResponse.json({ seeded: ids.length, documentIds: ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to seed the demo batch.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
