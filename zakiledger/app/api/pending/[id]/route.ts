import { NextResponse } from "next/server";
import { getPendingDocument } from "@/lib/store";

/**
 * GET /api/pending/[id] — one queued document in full, including every field's
 * value and confidence.
 *
 * Separate from the list endpoint on purpose: the list renders a row per document
 * and only needs identity, so shipping every confidence score for every queued
 * document just to draw checkboxes would be waste. "View details" is the moment
 * the human actually wants the breakdown, so that's when it's fetched.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const doc = await getPendingDocument(id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }

    return NextResponse.json({
      id: doc.id,
      createdAt: doc.createdAt,
      filename: doc.filename,
      status: doc.status,
      lastOutcome: doc.lastOutcome,
      lastReason: doc.lastReason,
      extraction: doc.extraction,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
