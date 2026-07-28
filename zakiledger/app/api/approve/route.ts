import { NextRequest, NextResponse } from "next/server";
import {
  findDuplicateDocument,
  getPendingDocument,
  recordConfirmation,
  recordCorrection,
  resolvePendingDocument,
  saveApprovedInvoice,
} from "@/lib/store";
import { REVIEWABLE_FIELDS, type DocumentType, type InvoiceExtraction } from "@/lib/schema";
import { postApprovedBill, type PostedBill } from "@/lib/accounting";
import { requireUser } from "@/lib/auth";

/** Parse a human-facing string into a number, or null when it isn't one. */
function toNumber(s: string): number | null {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * POST /api/approve
 * Body: { extraction, edited } where `extraction` is what the AI produced and
 * `edited` is the human-approved values (string map keyed by reviewable field).
 *
 * This is where the moat gets fed: for every field the human changed, we append
 * a row to the correction ledger. That ledger is both the audit trail and the
 * training data for the next extraction.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { extraction, edited, proceedDuplicate, documentType: overriddenType, documentId } =
      (await req.json()) as {
        extraction: InvoiceExtraction;
        edited: Record<string, string>;
        proceedDuplicate?: boolean;
        /** Set when the human confirmed or corrected a low-confidence classification. */
        documentType?: DocumentType;
        /**
         * The pending-queue row this document came from, when the client has one.
         * Optional: the approval works entirely from `extraction`, and this only
         * clears the queue entry so a document approved here doesn't linger in the
         * bulk queue to be approved a second time.
         */
        documentId?: string;
      };

    // The approved final value for a field: the human's edit if present,
    // otherwise the AI's proposed value.
    const finalOf = (field: string) =>
      edited[field] ?? String((extraction as any)[field].value);

    // A document already resolved must not be posted a second time — the same
    // guard lib/bulk-approve.ts's approveOne() already applies for the bulk
    // route. Without it, two concurrent Approve clicks on the same document (a
    // slow connection, an impatient double-click, two browser tabs) each pass
    // the duplicate check below before either has written anything — it's a
    // TOCTOU race, not a UI-only glitch — and both save an invoice and post a
    // real bill to Xero/QuickBooks.
    if (documentId) {
      const existing = await getPendingDocument(user.id, documentId);
      if (existing?.status === "resolved") {
        return NextResponse.json(
          { error: "Already approved — not posted again." },
          { status: 409 },
        );
      }
    }

    const supplierName = finalOf("supplierName");
    const invoiceNumber = finalOf("invoiceNumber");
    // The human's confirmed/overridden type wins over the model's guess; fall back
    // to the extraction, then to "invoice" for older clients that send neither.
    const documentType: DocumentType =
      overriddenType ?? extraction.documentType?.value ?? "invoice";
    const invoiceDate = finalOf("invoiceDate") || null;
    const total = toNumber(finalOf("total"));

    // Duplicate check on the FINAL, human-approved values — catches the case the
    // upload-time check misses: the raw extraction misread the number (or, on a
    // receipt, the merchant/date/total), the human corrected it, and the corrected
    // values now match an existing document.
    // Warn, don't save: return so the UI can prompt proceed/discard.
    if (!proceedDuplicate) {
      const dup = await findDuplicateDocument(user.id, documentType, {
        supplierName,
        invoiceNumber,
        invoiceDate,
        total,
      });
      console.log(
        `[duplicate-check] approve-time type=${documentType} supplier="${supplierName}" ` +
          `invoiceNumber="${invoiceNumber}" date="${invoiceDate ?? ""}" total=${total} ` +
          `match=${dup ? `${dup.id} (processed ${dup.createdAt})` : "none"}`,
      );
      if (dup) {
        return NextResponse.json({
          status: "duplicate",
          duplicate: {
            documentType,
            supplierName,
            invoiceNumber,
            processedOn: dup.createdAt,
            existingId: dup.id,
          },
        });
      }
    }

    // Persist the human-approved document first, so corrections can link to it.
    const invoiceId = await saveApprovedInvoice(user.id, {
      documentType,
      supplierName,
      invoiceNumber,
      invoiceDate,
      currency: finalOf("currency"),
      subtotal: toNumber(finalOf("subtotal")),
      tax: toNumber(finalOf("tax")),
      total,
      overallConfidence: extraction.overallConfidence,
    });

    // Feed the moat, both halves of it:
    //  - changed field    → a correction (teaches us where we were wrong)
    //  - unchanged field  → a confirmation (teaches us where we're reliably right,
    //                        so confidence can trend up on a proven track record)
    const corrections = [];
    let confirmationsRecorded = 0;
    for (const field of REVIEWABLE_FIELDS) {
      const aiValue = String((extraction as any)[field].value);
      const humanValue = edited[field];
      const changed = humanValue !== undefined && humanValue !== aiValue;

      if (changed) {
        corrections.push(
          await recordCorrection(user.id, {
            invoiceId: invoiceId ?? undefined,
            supplierName,
            field,
            aiValue,
            humanValue,
            aiConfidence: (extraction as any)[field].confidence,
          }),
        );
      } else if (aiValue.trim() !== "" && (extraction as any)[field].confidence > 0) {
        // Approved exactly as read — a correct read is a learning signal too.
        //
        // Two kinds of non-read are excluded, because "nothing detected" isn't
        // something to gain trust in:
        //   - an empty value (e.g. a receipt with no receipt number), and
        //   - a zero-confidence value, which is how the model reports a field the
        //     document never stated. Numeric zeros matter here: a receipt with no
        //     VAT breakdown yields tax/subtotal of 0, which stringify to "0" and
        //     would otherwise sail past the empty check and be logged as a
        //     confirmed-correct read. That would build a per-merchant track record
        //     out of absences, and calibration would later inflate a genuinely
        //     uncertain tax read on the strength of it.
        await recordConfirmation(user.id, {
          invoiceId: invoiceId ?? undefined,
          supplierName,
          field,
          value: aiValue,
          // The confidence the human saw and accepted (already calibrated) — this
          // becomes the established-trust floor once the pattern is proven.
          confidence: (extraction as any)[field].confidence,
        });
        confirmationsRecorded += 1;
      }
    }

    // Post the approved invoice as a draft bill to whichever accounting platform
    // is connected (Xero ACCPAY / QuickBooks Bill). When neither is connected —
    // the default demo state — `posted` is null and approval still succeeds.
    // A failure here shouldn't lose the human's approval, so it's non-fatal: we
    // report it back rather than throwing.
    let posted: PostedBill | null = null;
    let billError: string | undefined;
    try {
      posted = await postApprovedBill(user.id, {
        documentType,
        supplierName,
        // A receipt often has no number; the providers already omit the field
        // rather than sending a blank one.
        invoiceNumber: invoiceNumber || null,
        invoiceDate,
        currency: finalOf("currency"),
        subtotal: toNumber(finalOf("subtotal")),
        tax: toNumber(finalOf("tax")),
        total,
        lineItems: extraction.lineItems,
      });
    } catch (err) {
      billError = err instanceof Error ? err.message : "Failed to post bill.";
    }

    // Clear the queue entry, if this came from one — it's in the ledger now, so it
    // must not still be selectable in a bulk batch.
    //
    // Non-fatal, and the ordering is why: by this point the invoice is saved, the
    // corrections are recorded and the bill is posted. Letting a bookkeeping write
    // on the queue throw here would turn a completed approval into a 500 and tell
    // the human their work was lost when it plainly wasn't. Worst case the document
    // lingers in the queue, where bulk approve's already-approved check catches it.
    if (documentId) {
      try {
        await resolvePendingDocument(user.id, documentId, { outcome: "approved", invoiceId });
      } catch (err) {
        console.error(
          `[pending-queue] approved ${invoiceId} but could not clear queue entry ` +
            `${documentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return NextResponse.json({
      status: "approved",
      invoiceId,
      correctionsRecorded: corrections.length,
      confirmationsRecorded,
      corrections,
      billId: posted?.billId ?? null,
      billPlatform: posted?.platform ?? null,
      billError: billError ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Approve failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
