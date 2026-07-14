import { NextRequest, NextResponse } from "next/server";
import { extractInvoice } from "@/lib/anthropic";
import { buildHints } from "@/lib/learning";
import { arithmeticMismatch } from "@/lib/schema";

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

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mediaType = file.type || "application/pdf";

    // Learning loop: inject hints from past corrections (cross-supplier on first pass).
    const hints = await buildHints();

    const extraction = await extractInvoice(base64, mediaType, hints);

    // Consistency check — flag internally-inconsistent extractions for a human,
    // regardless of the model's stated confidence.
    const mismatch = arithmeticMismatch(extraction);

    return NextResponse.json({ extraction, arithmeticMismatch: mismatch });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
