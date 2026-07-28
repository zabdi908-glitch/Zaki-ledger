import { NextResponse } from "next/server";
import { listPendingDocuments } from "@/lib/store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/pending — the approval queue: documents read but not yet in the ledger.
 *
 * Returns a trimmed view rather than the whole extraction. The queue only needs
 * to be *identified and chosen* here; the approval itself works from the stored
 * extraction server-side, so there's no reason to ship every confidence score to
 * the browser just to render a checkbox row.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const pending = await listPendingDocuments(user.id);

    return NextResponse.json({
      documents: pending.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        filename: p.filename,
        documentType: p.extraction.documentType?.value ?? "invoice",
        merchantName: p.extraction.supplierName.value,
        invoiceNumber: p.extraction.invoiceNumber.value,
        invoiceDate: p.extraction.invoiceDate.value,
        currency: p.extraction.currency.value,
        total: p.extraction.total.value,
        overallConfidence: p.extraction.overallConfidence,
        // Carried from the last approval attempt, so a document that came back
        // blocked shows why without the human re-running the batch to find out.
        lastOutcome: p.lastOutcome,
        lastReason: p.lastReason,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the queue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
