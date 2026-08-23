import { NextRequest, NextResponse } from "next/server";
import {
  findDuplicateDocument,
  getPendingDocument,
  recordConfirmation,
  recordCorrection,
  resolvePendingDocument,
  saveApprovedInvoice,
} from "@/lib/store";
import { REVIEWABLE_FIELDS, type DocumentType, type InvoiceExtraction, type ReviewableField } from "@/lib/schema";
import { isSupportedCurrency, unsupportedCurrencyReason } from "@/lib/currency";
import { effectiveConfidence, gateApproval, gateReasonSummary } from "@/lib/validation";
import {
  postApprovedBill,
  type ApprovedBillPostingRequest,
} from "@/lib/accounting";
import type { PostingSubmitResult } from "@/lib/posting-contract";
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
    const {
      extraction,
      edited,
      proceedDuplicate,
      documentType: overriddenType,
      documentId,
      posting,
    } =
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
        /** Exact canonical destination/evidence proposal; never inferred from OAuth. */
        posting?: ApprovedBillPostingRequest;
      };

    if (posting && (!documentId || posting.sourceDocumentId !== documentId)) {
      return NextResponse.json(
        { error: "Posting requires the exact durable source document being approved." },
        { status: 400 },
      );
    }

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
    let pendingDocument = null;
    if (documentId) {
      pendingDocument = await getPendingDocument(user.id, documentId);
      if (pendingDocument?.status === "resolved") {
        return NextResponse.json(
          { error: "Already approved — not posted again." },
          { status: 409 },
        );
      }
    }
    if (posting && !pendingDocument) {
      return NextResponse.json(
        { error: "Posting requires a stored source document owned by the current user." },
        { status: 400 },
      );
    }
    const effectivePosting = posting
      ? { ...posting, synthetic: posting.synthetic === true || pendingDocument?.synthetic === true }
      : undefined;

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

    // --- Re-run the real gate on the FINAL values (Fix 4) ---------------------
    // The review screen used to approve whatever the client sent; editing one
    // low-confidence field cleared the whole document even when other critical
    // fields were still below threshold. Approval must re-judge the document
    // from the human-edited values, so a half-fixed document comes back blocked
    // with the fields that still need attention instead of silently posting.

        // Hard precondition first, same as bulk approve: a currency the platform
    // can't post in cannot be waved through by confidence scores — the list
    // already shows such documents in "Potential Issues" (Fix 3), and this is
    // the server-side backstop for the panel's always-enabled Approve button.
    // (Arithmetic is deliberately NOT a hard stop here: a human who corrects the
    // total to its real value may leave the AI-read subtotal/tax behind, and
    // that edit must still approve — the list flags such rows instead.)
    const finalCurrency = finalOf("currency").trim().toUpperCase();
    if (!isSupportedCurrency(finalCurrency)) {
      return NextResponse.json({
        status: "blocked",
        reason: unsupportedCurrencyReason(finalCurrency),
      });
    }

    // Then the confidence gate. Edited (or explicitly confirmed) fields count as
    // human-verified → 1.0; untouched fields keep the model's raw confidence.
    const confidenceByField = {} as Record<ReviewableField, number>;
    for (const field of REVIEWABLE_FIELDS) {
      const node = (extraction as any)[field] as { value: string | number; confidence: number };
      confidenceByField[field] = effectiveConfidence(
        node.confidence,
        String(node.value),
        edited[field],
        edited[field] !== undefined,
      );
    }
    const gate = gateApproval(confidenceByField, {
      documentType,
      taxItemized: extraction.taxItemized,
      documentTypeConfidence: extraction.documentType?.confidence,
      documentTypeConfirmed: overriddenType !== undefined,
    });
    if (gate.status !== "ready") {
      return NextResponse.json({
        status: "blocked",
        reason: gateReasonSummary(gate, documentType),
        reasons: gate.reasons,
      });
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

    // Posting is a separate, explicit proposal. The approval route never chooses
    // a provider or reads OAuth state; it only calls the compatibility façade,
    // which submits to AuthoritativePostingService and performs no provider I/O.
    let postingResult: PostingSubmitResult | null = null;
    let billError: string | undefined;
    if (effectivePosting) {
      try {
        postingResult = await postApprovedBill(
          user.id,
          {
            documentType,
            supplierName,
            invoiceNumber: invoiceNumber || null,
            invoiceDate,
            currency: finalOf("currency"),
            subtotal: toNumber(finalOf("subtotal")),
            tax: toNumber(finalOf("tax")),
            total,
            lineItems: extraction.lineItems,
          },
          effectivePosting,
        );
      } catch (err) {
        billError = err instanceof Error ? err.message : "Failed to submit posting intent.";
      }
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
      // Provider ids are produced only after adapter execution, which is not
      // implemented in Day 3. Legacy response fields remain null for callers.
      billId: null,
      billPlatform: effectivePosting?.destination?.provider ?? null,
      billError: billError ?? null,
      postingOperationId: postingResult?.operationId ?? null,
      postingState: postingResult?.state ?? "REVIEW",
      postingReasonCodes: postingResult?.reasonCodes ?? ["MISSING_EVIDENCE"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Approve failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
