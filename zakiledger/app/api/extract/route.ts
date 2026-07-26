import { NextRequest, NextResponse } from "next/server";
import { extractInvoice } from "@/lib/anthropic";
import { buildHints } from "@/lib/learning";
import { arithmeticMismatch, REVIEWABLE_FIELDS, type InvoiceExtraction } from "@/lib/schema";
import { confirmationCountsForSupplier } from "@/lib/store";
import { calibrateConfidence } from "@/lib/calibration";
import { sampleExtraction } from "@/lib/demo";

/**
 * Raise each reviewable field's confidence by this supplier's confirmation track
 * record, in place. Returns the fields whose score was actually lifted (for UI
 * transparency). No-op when the supplier is unknown or has no history, and never
 * invents confidence for a field we didn't read a value for.
 */
async function calibrateExtractionConfidence(
  extraction: InvoiceExtraction,
): Promise<string[]> {
  const supplier = extraction.supplierName.value.trim();
  if (!supplier) return [];

  const counts = await confirmationCountsForSupplier(supplier);
  const calibrated: string[] = [];

  for (const field of REVIEWABLE_FIELDS) {
    const n = counts[field] ?? 0;
    if (n <= 0) continue;

    const node = (extraction as any)[field] as { value: unknown; confidence: number };
    if (String(node.value).trim() === "") continue;

    const boosted = calibrateConfidence(node.confidence, n);
    if (boosted > node.confidence) {
      node.confidence = boosted;
      calibrated.push(field);
    }
  }

  return calibrated;
}

/**
 * POST /api/extract
 * Body: multipart form with a single "file" (invoice PDF or image).
 * Returns the structured extraction + which fields need human attention.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    // Demo mode: with no Anthropic key, return a realistic sample so the full
    // review → approve → learn flow works with zero setup. Real key = real Claude.
    const demo = !process.env.ANTHROPIC_API_KEY;

    let extraction;
    // When set, the extraction was refined using this supplier's own correction history.
    let refinedForSupplier: string | undefined;

    if (demo) {
      extraction = sampleExtraction();
    } else {
      const buffer = Buffer.from(await file.arrayBuffer());
      const base64 = buffer.toString("base64");
      const mediaType = file.type || "application/pdf";

      // Pass 1 — first read using recent cross-supplier corrections. We can't
      // target a supplier's hints yet because we don't know the supplier until
      // the model reads the document.
      const generalHints = await buildHints();
      extraction = await extractInvoice(base64, mediaType, generalHints);

      // Pass 2 — per-supplier learning. Now that we know the supplier, if we hold
      // corrections specific to THEM, re-extract with those targeted hints so the
      // tool applies what it learned from this vendor's past invoices.
      //
      // This costs a second vision call, so it only fires when supplier history
      // actually exists: buildHints(supplier) returns undefined otherwise, and we
      // skip the re-run. No history for a supplier → no extra call, no extra cost.
      const supplier = extraction.supplierName.value.trim();
      if (supplier) {
        const supplierHints = await buildHints(supplier);
        if (supplierHints) {
          extraction = await extractInvoice(base64, mediaType, supplierHints);
          refinedForSupplier = supplier;
        }
      }
    }

    // Confidence calibration — fold in this supplier's track record of correct
    // reads. A field the human has approved unchanged before earns higher
    // confidence than a cold per-read estimate, so a reliably-read-but-ambiguous
    // field (e.g. an O/0 invoice number) trends up instead of being re-guessed.
    // Only raises confidence, and only for fields we actually read a value for.
    const calibratedFields = await calibrateExtractionConfidence(extraction);

    // Consistency check — flag internally-inconsistent extractions for a human,
    // regardless of the model's stated confidence.
    const mismatch = arithmeticMismatch(extraction);

    return NextResponse.json({
      extraction,
      arithmeticMismatch: mismatch,
      demo,
      refinedForSupplier: refinedForSupplier ?? null,
      calibratedFields,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
