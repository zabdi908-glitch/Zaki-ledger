import { NextResponse } from "next/server";
import { deletePendingDocument, getPendingDocument } from "@/lib/store";

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

/**
 * DELETE /api/pending/[id] — drop a queued document without approving it.
 *
 * The way out of the queue for a duplicate or a misfired upload, which otherwise
 * has none: approving is the only other exit, and approving a duplicate is the
 * thing we're trying to avoid. Irreversible, hence the confirmation in the UI.
 *
 * Refuses a document that already reached the ledger — see deletePendingDocument.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const outcome = await deletePendingDocument(id);

    if (outcome === "not_found") {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    if (outcome === "already_resolved") {
      return NextResponse.json(
        {
          error:
            "This document has already been approved, so it can't be deleted — " +
            "its record links the approved bill back to what was read.",
        },
        { status: 409 },
      );
    }

    console.log(`[pending-queue] deleted ${id}`);
    return NextResponse.json({ status: "deleted", documentId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete the document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
