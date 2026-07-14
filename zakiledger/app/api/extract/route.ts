import { NextRequest, NextResponse } from "next/server";
import { extractInvoice } from "@/lib/anthropic";
import { buildHints } from "@/lib/learning";
import { arithmeticMismatch } from "@/lib/schema";
import { sampleExtraction } from "@/lib/demo";

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

    // Consistency check — flag internally-inconsistent extractions for a human,
    // regardless of the model's stated confidence.
    const mismatch = arithmeticMismatch(extraction);

    return NextResponse.json({
      extraction,
      arithmeticMismatch: mismatch,
      demo,
      refinedForSupplier: refinedForSupplier ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
