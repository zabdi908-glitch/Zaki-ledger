import { NextRequest, NextResponse } from "next/server";
import {
  findDuplicateInvoice,
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

    // Duplicate check on the FINAL, human-approved values — catches the case the
    // upload-time check misses: the raw extraction misread the number, the human
    // corrected it, and the corrected value now matches an existing invoice.
    // Warn, don't save: return so the UI can prompt proceed/discard.
    if (!proceedDuplicate) {
      const dup = await findDuplicateInvoice(supplierName, invoiceNumber);
      console.log(
        `[duplicate-check] approve-time supplier="${supplierName}" invoiceNumber="${invoiceNumber}" ` +
          `match=${dup ? `${dup.id} (processed ${dup.createdAt})` : "none"}`,
      );
      if (dup) {
        return NextResponse.json({
          status: "duplicate",
          duplicate: {
            supplierName,
            invoiceNumber,
            processedOn: dup.createdAt,
            existingId: dup.id,
          },
        });
      }
    }

    // Persist the human-approved invoice first, so corrections can link to it.
    const invoiceId = await saveApprovedInvoice({
      supplierName,
      invoiceNumber,
      invoiceDate: finalOf("invoiceDate") || null,
      currency: finalOf("currency"),
      subtotal: toNumber(finalOf("subtotal")),
      tax: toNumber(finalOf("tax")),
      total: toNumber(finalOf("total")),
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
      } else if (aiValue.trim() !== "") {
        // Approved exactly as read — a correct read is a learning signal too.
        // Skip empty values: "nothing detected" isn't something to gain trust in.
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
        supplierName,
        invoiceNumber: finalOf("invoiceNumber"),
        invoiceDate: finalOf("invoiceDate") || null,
        currency: finalOf("currency"),
        subtotal: toNumber(finalOf("subtotal")),
        tax: toNumber(finalOf("tax")),
        total: toNumber(finalOf("total")),
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
