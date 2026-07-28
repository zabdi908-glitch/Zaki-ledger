import { NextRequest, NextResponse } from "next/server";
import {
  EXTRACT_CONCURRENCY,
  extractOneDocument,
  mapWithConcurrency,
} from "@/lib/extract-pipeline";
import { gateApproval, gateReasonSummary } from "@/lib/validation";
import type { InvoiceExtraction, ReviewableField } from "@/lib/schema";
import { REVIEWABLE_FIELDS } from "@/lib/schema";
import { requireUser } from "@/lib/auth";

/**
 * POST /api/extract-batch
 * Body: multipart form with several files under "files" (or repeated "file").
 *
 * Reads them in parallel and **streams NDJSON** — one JSON object per line — so
 * the client learns about each document the moment it lands:
 *
 *   {"type":"start","total":5}
 *   {"type":"result","index":1,"filename":"receipt-2.png","status":"success",...}
 *   {"type":"result","index":0,"filename":"receipt-1.png","status":"success",...}
 *   {"type":"summary","total":5,"succeeded":4,"failed":1,"queued":4}
 *
 * Streaming rather than one JSON array at the end is a deliberate choice, and the
 * only honest way to satisfy "show progress as files complete": a single response
 * that arrives when everything is finished gives the UI nothing to report until
 * there is nothing left to report, so any "2 of 5" drawn from it would be an
 * animation rather than a fact. Results still arrive as a complete set — the
 * client assembles the array — they just arrive as they happen. Note lines are
 * emitted in COMPLETION order; each carries its `index` so the UI can hold the
 * original file order.
 */

/** What the UI needs to render one row, plus the extraction itself. */
interface BatchFileResult {
  type: "result";
  index: number;
  filename: string;
  status: "success" | "error";
  /** Present on success. Null when the read worked but the queue write didn't. */
  documentId?: string | null;
  /** The model's overall confidence in the whole extraction. */
  confidence?: number;
  extraction?: InvoiceExtraction;
  /** Where the confidence gate landed — drives ✅ vs ⚠️ in the results list. */
  gate?: "ready" | "review" | "blocked";
  /** Why it's flagged, when it is (e.g. "Merchant low confidence (61%)"). */
  warning?: string;
  /** Set when the read succeeded but the document couldn't be queued. */
  queueError?: string | null;
  /** Why the file failed outright. Only on status "error". */
  reason?: string;
}

/** Confidence per field, for the gate. No human edits exist at upload time. */
function confidencesOf(extraction: InvoiceExtraction): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) out[f] = (extraction as any)[f].confidence as number;
  return out;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let files: File[];
  try {
    const form = await req.formData();
    // Accept either a repeated "files" field or a repeated "file" one, so a
    // caller doesn't have to guess which name this endpoint wanted.
    files = [...form.getAll("files"), ...form.getAll("file")].filter(
      (f): f is File => f instanceof File,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read the upload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));

      write({ type: "start", total: files.length });

      const started = Date.now();
      let succeeded = 0;
      let failed = 0;
      let queued = 0;

      try {
        await mapWithConcurrency(
          files,
          EXTRACT_CONCURRENCY,
          async (file, index): Promise<BatchFileResult> => {
            const filename = file.name || `file-${index + 1}`;
            try {
              const doc = await extractOneDocument(user.id, file);

              // Same gate the review screen and bulk approve use — so a document
              // flagged here is flagged for exactly the reason it will be later,
              // in the same words.
              const gate = gateApproval(confidencesOf(doc.extraction), {
                documentType: doc.extraction.documentType?.value,
                taxItemized: doc.extraction.taxItemized,
                documentTypeConfidence: doc.extraction.documentType?.confidence,
              });

              return {
                type: "result",
                index,
                filename,
                status: "success",
                documentId: doc.documentId,
                confidence: doc.extraction.overallConfidence,
                extraction: doc.extraction,
                gate: gate.status,
                warning:
                  gate.status === "ready"
                    ? undefined
                    : gateReasonSummary(gate, doc.extraction.documentType?.value ?? "invoice"),
                queueError: doc.queueError,
              };
            } catch (err) {
              // One unreadable file is one failed row. The rest of the batch is
              // already in flight and is not touched by this.
              return {
                type: "result",
                index,
                filename,
                status: "error",
                reason: err instanceof Error ? err.message : "Could not extract this document.",
              };
            }
          },
          (result) => {
            if (result.status === "success") {
              succeeded += 1;
              if (result.documentId) queued += 1;
            } else {
              failed += 1;
            }
            write(result);
          },
        );

        write({
          type: "summary",
          total: files.length,
          succeeded,
          failed,
          queued,
          elapsedMs: Date.now() - started,
        });
        console.log(
          `[extract-batch] ${files.length} file(s) → ${succeeded} succeeded, ${failed} failed, ` +
            `${queued} queued, ${Date.now() - started}ms`,
        );
      } catch (err) {
        // The batch itself came apart (not a single file) — say so in-band, since
        // the HTTP status was committed the moment the stream opened.
        write({
          type: "fatal",
          error: err instanceof Error ? err.message : "Batch extraction failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Ask intermediaries not to buffer, which would defeat the whole point.
      "X-Accel-Buffering": "no",
    },
  });
}
