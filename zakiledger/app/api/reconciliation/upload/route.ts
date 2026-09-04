import { NextRequest, NextResponse } from "next/server";
import { parseCsvStatement, parseOfxStatement } from "@/lib/bank-parsers";
import { parsePdfStatement } from "@/lib/bank-statement-pdf";
import { saveBankStatement } from "@/lib/reconciliation-store";
import { requireUser } from "@/lib/auth";
import { isReconciliationWriteFrozen, reconciliationFreezeResponse } from "@/lib/reconciliation-freeze";
import type { FileFormat } from "@/lib/reconciliation-schema";
import { sha256Hex } from "@/lib/financial-identity";
import { MAX_OFX_UPLOAD_BYTES, retainOfxEvidence } from "@/lib/ofx-evidence-store";

/** File extension -> parser. */
function detectFormat(fileName: string): FileFormat | null {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "ofx" || ext === "qfx") return "ofx";
  if (ext === "pdf") return "pdf";
  return null;
}

/**
 * POST /api/reconciliation/upload
 * Body: multipart form with a single "file" (bank statement, CSV, OFX, or PDF).
 * Returns the statement id + summary so the caller can immediately hit
 * GET /api/reconciliation/[id]/transactions to see matches.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isReconciliationWriteFrozen()) return reconciliationFreezeResponse();

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const format = detectFormat(file.name);
    if (!format) {
      return NextResponse.json(
        { error: "Unsupported file type — expected .csv, .ofx, .qfx, or .pdf." },
        { status: 400 },
      );
    }

    if (format === "ofx" && (file.size === 0 || file.size > MAX_OFX_UPLOAD_BYTES)) {
      return NextResponse.json(
        { error: `OFX upload must be between 1 and ${MAX_OFX_UPLOAD_BYTES} bytes.` },
        { status: 413 },
      );
    }

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const sourceArtifactHash = sha256Hex(fileBytes);
    const text = format === "pdf" ? null : new TextDecoder().decode(fileBytes);
    const parsed =
      format === "csv"
        ? parseCsvStatement(text!)
        : format === "ofx"
          ? parseOfxStatement(text!)
          : await parsePdfStatement(file);

    if (parsed.transactions.length === 0) {
      return NextResponse.json(
        { error: "No transactions could be read from this file." },
        { status: 400 },
      );
    }

    let artifactId: string | undefined;
    if (format === "ofx") {
      const evidence = await retainOfxEvidence({ userId: user.id, rawBytes: fileBytes, parsed });
      if (evidence.contentSha256 !== sourceArtifactHash || evidence.contentLength !== fileBytes.byteLength) {
        throw new Error("OFX evidence verification failed before statement ingestion");
      }
      artifactId = evidence.artifactId;
    }

    const statement = await saveBankStatement(user.id, file.name, format, parsed, { sourceArtifactHash });

    return NextResponse.json({
      ...(artifactId ? { artifactId } : {}),
      statementId: statement.id,
      transactionCount: statement.transactionCount,
      dateRange: { start: statement.periodStart, end: statement.periodEnd },
      currency: statement.currency,
      status: "extracted",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse the statement.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
