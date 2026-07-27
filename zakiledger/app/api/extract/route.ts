import { NextRequest, NextResponse } from "next/server";
import { extractDocument } from "@/lib/anthropic";
import { buildHints } from "@/lib/learning";
import { arithmeticMismatch, REVIEWABLE_FIELDS, type InvoiceExtraction } from "@/lib/schema";
import { confirmationStatsForSupplier, findDuplicateDocument, savePendingDocument } from "@/lib/store";
import { calibrateConfidence, FLOOR_MIN_CONFIRMATIONS } from "@/lib/calibration";
import { sampleForFilename } from "@/lib/demo";

/** Per-field supplier track record surfaced in the UI ("seen N× before"). */
type SupplierMemory = Record<string, { count: number; confidence: number }>;

/**
 * Raise each reviewable field's confidence by this supplier's confirmation track
 * record, in place. Returns the fields whose score was actually lifted and the
 * per-field track record to surface in the UI. No-op when the supplier is unknown
 * or has no history, and never invents confidence for a field we didn't read.
 */
async function calibrateExtractionConfidence(
  extraction: InvoiceExtraction,
): Promise<{ calibrated: string[]; memory: SupplierMemory }> {
  const supplier = extraction.supplierName.value.trim();
  const memory: SupplierMemory = {};
  if (!supplier) return { calibrated: [], memory };

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
    if (stat && stat.count >= FLOOR_MIN_CONFIRMATIONS && hasValue) {
      boosted = Math.max(boosted, stat.floor);
    }

    if (boosted > raw) {
      node.confidence = boosted;
      calibrated.push(field);
    }
    // Surface the track record whenever this supplier/field has any confirmed
    // history — independent of whether this particular read got calibrated.
    if (stat && stat.count > 0) {
      memory[field] = { count: stat.count, confidence: stat.floor };
    }
  }

  return { calibrated, memory };
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
      extraction = sampleForFilename(file.name ?? "");
    } else {
      const buffer = Buffer.from(await file.arrayBuffer());
      const base64 = buffer.toString("base64");
      const mediaType = file.type || "application/pdf";

      // Pass 1 — first read using recent cross-supplier corrections. We can't
      // target a supplier's hints yet because we don't know the supplier until
      // the model reads the document. This same pass also classifies the document
      // as an invoice or a receipt — detection is not a separate call.
      const generalHints = await buildHints();
      extraction = await extractDocument(base64, mediaType, generalHints);

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
          extraction = await extractDocument(base64, mediaType, supplierHints);
          refinedForSupplier = supplier;
        }
      }
    }

    // Confidence calibration — fold in this supplier's track record of correct
    // reads. A field the human has approved unchanged before earns higher
    // confidence than a cold per-read estimate, so a reliably-read-but-ambiguous
    // field (e.g. an O/0 invoice number) trends up instead of being re-guessed.
    // Only raises confidence, and only for fields we actually read a value for.
    const { calibrated: calibratedFields, memory: supplierMemory } =
      await calibrateExtractionConfidence(extraction);

    // Consistency check — flag internally-inconsistent extractions for a human,
    // regardless of the model's stated confidence.
    const mismatch = arithmeticMismatch(extraction);

    // Duplicate detection (upload is the earliest checkpoint). Warn, never block:
    // surface the match and let the human proceed or discard. Identity is supplier
    // + invoice number for an invoice, merchant + date + total for a receipt (which
    // usually has no number). Logged either way as an audit trail.
    const documentType = extraction.documentType.value;
    const dupSupplier = extraction.supplierName.value.trim();
    const dupInvoiceNumber = extraction.invoiceNumber.value.trim();
    const dupDate = extraction.invoiceDate.value.trim() || null;
    const dupTotal = extraction.total.value;
    const existing = await findDuplicateDocument(documentType, {
      supplierName: dupSupplier,
      invoiceNumber: dupInvoiceNumber,
      invoiceDate: dupDate,
      total: dupTotal,
    });
    console.log(
      `[duplicate-check] type=${documentType} supplier="${dupSupplier}" ` +
        `invoiceNumber="${dupInvoiceNumber}" date="${dupDate ?? ""}" total=${dupTotal} ` +
        `match=${existing ? `${existing.id} (processed ${existing.createdAt})` : "none"}`,
    );
    const duplicate = existing
      ? {
          documentType,
          supplierName: dupSupplier,
          invoiceNumber: dupInvoiceNumber,
          processedOn: existing.createdAt,
          existingId: existing.id,
        }
      : null;

    // Park it in the approval queue and hand back its id. This is what makes the
    // document addressable: the single review screen still works from the
    // extraction in the response, but bulk approve only ever needs the id, and the
    // extraction it approves is the stored one — not something a client re-sends.
    //
    // Non-fatal on purpose. The queue is ADDITIVE to the single-document flow: the
    // review screen works entirely from the extraction in this response and needs
    // no id at all. So a queue write that fails — most likely `pending_documents`
    // not yet created in a deployment running an older db/schema.sql — must cost
    // the user their bulk-approve option, not their extraction. Without this, one
    // missing table takes down uploading entirely, which is the whole product.
    let documentId: string | null = null;
    try {
      documentId = await savePendingDocument({ extraction, filename: file.name ?? null });
    } catch (err) {
      console.error(
        `[pending-queue] could not queue this document (bulk approve unavailable): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return NextResponse.json({
      documentId,
      extraction,
      arithmeticMismatch: mismatch,
      demo,
      refinedForSupplier: refinedForSupplier ?? null,
      calibratedFields,
      supplierMemory,
      duplicate,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
