import { NextRequest, NextResponse } from "next/server";
import { extractInvoice } from "@/lib/anthropic";
import { buildHints } from "@/lib/learning";
import { arithmeticMismatch, REVIEWABLE_FIELDS, type InvoiceExtraction } from "@/lib/schema";
import { confirmationStatsForSupplier, findDuplicateInvoice } from "@/lib/store";
import { calibrateConfidence, FLOOR_MIN_CONFIRMATIONS } from "@/lib/calibration";
import { sampleExtraction } from "@/lib/demo";

/** TEMPORARY debug row per field — remove once the calibration trend is confirmed. */
interface CalibrationDebug {
  field: string;
  raw: number; // model's confidence before calibration
  confirmedCount: number; // confirmations (since last edit) for this supplier/field
  bonus: number; // calibrated - raw
  floor: number | null; // established-trust floor, once applied (else null)
  calibrated: number;
}

/**
 * Raise each reviewable field's confidence by this supplier's confirmation track
 * record, in place. Returns the fields whose score was actually lifted (for UI
 * transparency) plus a temporary debug trace. No-op when the supplier is unknown
 * or has no history, and never invents confidence for a field we didn't read.
 */
async function calibrateExtractionConfidence(
  extraction: InvoiceExtraction,
): Promise<{ calibrated: string[]; debug: CalibrationDebug[] }> {
  const supplier = extraction.supplierName.value.trim();
  const debug: CalibrationDebug[] = [];
  if (!supplier) return { calibrated: [], debug };

  const stats = await confirmationStatsForSupplier(supplier);
  const calibrated: string[] = [];

  for (const field of REVIEWABLE_FIELDS) {
    const node = (extraction as any)[field] as { value: unknown; confidence: number };
    const raw = node.confidence;
    const stat = stats[field];
    const n = stat?.count ?? 0;
    const hasValue = String(node.value).trim() !== "";

    let boosted = n > 0 && hasValue ? calibrateConfidence(raw, n) : raw;

    // Established-trust floor: once the pattern is proven (>= FLOOR_MIN_CONFIRMATIONS),
    // a single noisy low read can't drop the score below the trust already built.
    // An edit resets the history upstream, so this only holds while reads stay correct.
    let floorApplied: number | null = null;
    if (stat && stat.count >= FLOOR_MIN_CONFIRMATIONS && hasValue) {
      floorApplied = stat.floor;
      boosted = Math.max(boosted, stat.floor);
    }

    if (boosted > raw) {
      node.confidence = boosted;
      calibrated.push(field);
    }
    debug.push({ field, raw, confirmedCount: n, bonus: boosted - raw, floor: floorApplied, calibrated: boosted });
  }

  // TEMPORARY: surfaces in the Render/dev server logs so we can watch the trend.
  console.log(`[calibration] supplier="${supplier}"`, JSON.stringify(debug));
  return { calibrated, debug };
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
    const { calibrated: calibratedFields, debug: calibrationDebug } =
      await calibrateExtractionConfidence(extraction);

    // Consistency check — flag internally-inconsistent extractions for a human,
    // regardless of the model's stated confidence.
    const mismatch = arithmeticMismatch(extraction);

    // Duplicate detection (upload is the earliest checkpoint). Warn, never block:
    // surface the match and let the human proceed or discard. Scope is supplier +
    // invoice number only, by design. Logged either way as an audit trail.
    const dupSupplier = extraction.supplierName.value.trim();
    const dupInvoiceNumber = extraction.invoiceNumber.value.trim();
    const existing = await findDuplicateInvoice(dupSupplier, dupInvoiceNumber);
    console.log(
      `[duplicate-check] supplier="${dupSupplier}" invoiceNumber="${dupInvoiceNumber}" ` +
        `match=${existing ? `${existing.id} (processed ${existing.createdAt})` : "none"}`,
    );
    const duplicate = existing
      ? {
          supplierName: dupSupplier,
          invoiceNumber: dupInvoiceNumber,
          processedOn: existing.createdAt,
          existingId: existing.id,
        }
      : null;

    return NextResponse.json({
      extraction,
      arithmeticMismatch: mismatch,
      demo,
      refinedForSupplier: refinedForSupplier ?? null,
      calibratedFields,
      calibrationDebug, // TEMPORARY
      duplicate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
