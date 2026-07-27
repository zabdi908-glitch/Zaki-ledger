import { NextRequest, NextResponse } from "next/server";
import {
  findDuplicateDocument,
  recordConfirmation,
  recordCorrection,
  saveApprovedInvoice,
} from "@/lib/store";
import { REVIEWABLE_FIELDS, type InvoiceExtraction } from "@/lib/schema";
import { postApprovedBill, type PostedBill } from "@/lib/accounting";

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
  try {
    const { extraction, edited, proceedDuplicate } = (await req.json()) as {
      extraction: InvoiceExtraction;
      edited: Record<string, string>;
      proceedDuplicate?: boolean;
    };

    // The approved final value for a field: the human's edit if present,
    // otherwise the AI's proposed value.
    const finalOf = (field: string) =>
      edited[field] ?? String((extraction as any)[field].value);

    const supplierName = finalOf("supplierName");
    const invoiceNumber = finalOf("invoiceNumber");
    // The type is detected at extraction and isn't a reviewable field, so it comes
    // straight off the extraction. Older clients that don't send it get "invoice".
    const documentType = extraction.documentType?.value ?? "invoice";
    const invoiceDate = finalOf("invoiceDate") || null;
    const total = toNumber(finalOf("total"));

    // Duplicate check on the FINAL, human-approved values — catches the case the
    // upload-time check misses: the raw extraction misread the number (or, on a
    // receipt, the merchant/date/total), the human corrected it, and the corrected
    // values now match an existing document.
    // Warn, don't save: return so the UI can prompt proceed/discard.
    if (!proceedDuplicate) {
      const dup = await findDuplicateDocument(documentType, {
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
    const invoiceId = await saveApprovedInvoice({
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
          await recordCorrection({
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
        await recordConfirmation({
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
      posted = await postApprovedBill({
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
