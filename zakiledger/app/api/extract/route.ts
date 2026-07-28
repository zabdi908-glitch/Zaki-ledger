import { NextRequest, NextResponse } from "next/server";
import { extractOneDocument } from "@/lib/extract-pipeline";
import { requireUser } from "@/lib/auth";

/**
 * POST /api/extract
 * Body: multipart form with a single "file" (invoice PDF or image).
 * Returns the structured extraction + which fields need human attention.
 *
 * The reading itself lives in lib/extract-pipeline.ts, shared with the batch
 * route — "run the existing extract logic on each file" has to mean the same
 * logic, not a copy of it.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    return NextResponse.json(await extractOneDocument(user.id, file));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
