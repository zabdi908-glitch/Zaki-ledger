import { NextRequest, NextResponse } from "next/server";
import { recordCorrection } from "@/lib/store";
import { REVIEWABLE_FIELDS, type InvoiceExtraction } from "@/lib/schema";

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
    const { extraction, edited } = (await req.json()) as {
      extraction: InvoiceExtraction;
      edited: Record<string, string>;
    };

    const supplierName = edited.supplierName ?? extraction.supplierName.value;
    const corrections = [];

    for (const field of REVIEWABLE_FIELDS) {
      const aiValue = String((extraction as any)[field].value);
      const humanValue = edited[field];
      if (humanValue !== undefined && humanValue !== aiValue) {
        corrections.push(
          recordCorrection({
            supplierName,
            field,
            aiValue,
            humanValue,
            aiConfidence: (extraction as any)[field].confidence,
          }),
        );
      }
    }

    // TODO (Month 3): post the approved invoice to Xero here.
    return NextResponse.json({
      status: "approved",
      correctionsRecorded: corrections.length,
      corrections,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Approve failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
