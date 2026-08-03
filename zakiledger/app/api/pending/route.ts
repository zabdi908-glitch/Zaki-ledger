import { NextResponse } from "next/server";
import { listPendingDocuments } from "@/lib/store";
import { requireUser } from "@/lib/auth";

/**
 * GET /api/pending — the approval queue: documents read but not yet in the ledger.
 *
 * Returns a trimmed view rather than the whole extraction. The approval itself
 * works from the stored extraction server-side, so the full document (line
 * items, raw values) stays on the detail endpoint. But the list row's approval
 * gate is honest only if it sees REAL per-field confidence and the postability
 * preconditions — gating on the overall score alone hid genuine blockers (a 61%
 * merchant read behind a 78% average, an unpostable currency behind a 93%
 * overall) — so those scalars ship here.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const pending = await listPendingDocuments(user.id);

    return NextResponse.json({
      documents: pending.map((p) => {
        const x = p.extraction;
        return {
          id: p.id,
          createdAt: p.createdAt,
          filename: p.filename,
          documentType: x.documentType?.value ?? "invoice",
          merchantName: x.supplierName.value,
          invoiceNumber: x.invoiceNumber.value,
          invoiceDate: x.invoiceDate.value,
          currency: x.currency.value,
          total: x.total.value,
          // Per-field raw values + confidence, so the list row can run the REAL
          // gate and preconditions (Fix 3): "Ready to Approve" must reflect what
          // will actually post. The full extraction is still the detail
          // endpoint's job — this is a trimmed view, not the whole document.
          subtotal: x.subtotal.value,
          tax: x.tax.value,
          taxItemized: x.taxItemized,
          documentTypeConfidence: x.documentType?.confidence ?? 1,
          perFieldConfidence: {
            supplierName: x.supplierName.confidence,
            invoiceNumber: x.invoiceNumber.confidence,
            invoiceDate: x.invoiceDate.confidence,
            currency: x.currency.confidence,
            subtotal: x.subtotal.confidence,
            tax: x.tax.confidence,
            total: x.total.confidence,
          },
          overallConfidence: x.overallConfidence,
          // Carried from the last approval attempt, so a document that came back
          // blocked shows why without the human re-running the batch to find out.
          lastOutcome: p.lastOutcome,
          lastReason: p.lastReason,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the queue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
