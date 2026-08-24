import { extractDocument } from "./openai";
import { extractDocumentEscalation } from "./anthropic";
import { buildHints } from "./learning";
import { arithmeticMismatch, REVIEWABLE_FIELDS, type InvoiceExtraction } from "./schema";
import { confirmationStatsForSupplier, findDuplicateDocument, savePendingDocument } from "./store";
import { CanonicalDocumentEvidenceService, canonicalEvidenceContext } from "./canonical-document-evidence";
import { getSupabase } from "./supabase";
import { createHash } from "crypto";
import { calibrateConfidence, FLOOR_MIN_CONFIRMATIONS } from "./calibration";
import { isDemoUnreadable, sampleForFilename } from "./demo";

/**
 * Reading one document, start to finish: extract → calibrate → check → queue.
 *
 * Lives here rather than in the route because there are now two callers — the
 * single upload and the batch upload — and "run the existing extract logic on
 * each file" has to mean *the same* logic, not a copy that drifts. Both routes
 * are thin wrappers over `extractOneDocument`.
 */

/** Per-field supplier track record surfaced in the UI ("seen N× before"). */
export type SupplierMemory = Record<string, { count: number; confidence: number }>;

export interface ExtractedDocument {
  /** Null when the queue write failed — see `queueError`. */
  documentId: string | null;
  /** Why the document couldn't be queued, when it couldn't. Null on success. */
  queueError: string | null;
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo: boolean;
  refinedForSupplier: string | null;
  calibratedFields: string[];
  supplierMemory: SupplierMemory;
  duplicate: {
    documentType: string;
    supplierName: string;
    invoiceNumber: string;
    processedOn: string;
    existingId: string;
  } | null;
}

/**
 * Raise each reviewable field's confidence by this supplier's confirmation track
 * record, in place. Returns the fields whose score was actually lifted and the
 * per-field track record to surface in the UI. No-op when the supplier is unknown
 * or has no history, and never invents confidence for a field we didn't read.
 */
async function calibrateExtractionConfidence(
  userId: string,
  extraction: InvoiceExtraction,
): Promise<{ calibrated: string[]; memory: SupplierMemory }> {
  const supplier = extraction.supplierName.value.trim();
  const memory: SupplierMemory = {};
  if (!supplier) return { calibrated: [], memory };

  const stats = await confirmationStatsForSupplier(userId, supplier);
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
 * Read one document and park it in the approval queue.
 *
 * Throws only when the *extraction itself* failed (an unreadable file, a model
 * error) — that is the one outcome a caller must report as a failed file. A queue
 * write that fails is returned as `queueError`, not thrown, because the read
 * still succeeded and the human can still approve it on screen.
 */
export async function extractOneDocument(userId: string, file: File): Promise<ExtractedDocument> {
  // Demo mode: with no OpenAI key, return a realistic sample so the full
  // review → approve → learn flow works with zero setup. Real key = real GPT.
  const demo = !process.env.OPENAI_API_KEY;

  let extraction: InvoiceExtraction;
  // When set, the extraction was refined using this supplier's own correction history.
  let refinedForSupplier: string | undefined;

  if (demo) {
    // The unreadable-file path, reachable without an API key. Thrown rather than
    // returned, because that is precisely what a failed read does here — and the
    // batch route's per-file isolation is only exercised by a real throw.
    if (isDemoUnreadable(file.name ?? "")) {
      throw new Error("Could not extract text from this file — it may be corrupt or unreadable.");
    }
    extraction = sampleForFilename(file.name ?? "");
  } else {
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mediaType = file.type || "application/pdf";

    // Pass 1 — first read using recent cross-supplier corrections. We can't
    // target a supplier's hints yet because we don't know the supplier until
    // the model reads the document. This same pass also classifies the document
    // as an invoice or a receipt — detection is not a separate call.
    const generalHints = await buildHints(userId);
    let activeHints = generalHints;
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
      const supplierHints = await buildHints(userId, supplier);
      if (supplierHints) {
        activeHints = supplierHints;
        extraction = await extractDocument(base64, mediaType, supplierHints);
        refinedForSupplier = supplier;
      }
    }

    // Pass 3 — escalation. If OpenAI's extraction is uncertain, hand the same
    // document and hints to Anthropic for a more careful read. Missing
    // ANTHROPIC_API_KEY simply skips this pass; the low-confidence result
    // remains and flags the document for human review.
    const criticalLow =
      extraction.overallConfidence < 0.7 ||
      (["supplierName", "invoiceNumber", "total"] as const).some(
        (f) => (extraction as any)[f].confidence < 0.5,
      );
    if (criticalLow && process.env.ANTHROPIC_API_KEY) {
      extraction = await extractDocumentEscalation(base64, mediaType, activeHints);
    }
  }

  // Confidence calibration — fold in this supplier's track record of correct
  // reads. A field the human has approved unchanged before earns higher
  // confidence than a cold per-read estimate, so a reliably-read-but-ambiguous
  // field (e.g. an O/0 invoice number) trends up instead of being re-guessed.
  // Only raises confidence, and only for fields we actually read a value for.
  const { calibrated: calibratedFields, memory: supplierMemory } =
    await calibrateExtractionConfidence(userId, extraction);

  // Consistency check — flag internally-inconsistent extractions for a human,
  // regardless of the model's stated confidence.
  const mismatch = arithmeticMismatch(extraction);

  // Duplicate detection (upload is the earliest checkpoint). Warn, never block:
  // surface the match and let the human proceed or discard. Identity is supplier
  // + invoice number for an invoice, merchant + date + total for a receipt (which
  // usually has no number). Logged either way as an audit trail.
  //
  // Note for the batch caller: files are read in parallel, so two copies of the
  // same document in one batch will NOT see each other here — nothing is written
  // to `invoices` at this stage. They are caught later, at approve time, where
  // processing is sequential precisely so that check holds.
  const documentType = extraction.documentType.value;
  const dupSupplier = extraction.supplierName.value.trim();
  const dupInvoiceNumber = extraction.invoiceNumber.value.trim();
  const dupDate = extraction.invoiceDate.value.trim() || null;
  const dupTotal = extraction.total.value;
  const existing = await findDuplicateDocument(userId, documentType, {
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
  // missing or out of date in a deployment running an older db/schema.sql — must
  // cost the user their bulk-approve option, not their extraction.
  //
  // But non-fatal must not mean invisible. Reporting it only to the server log is
  // what once turned a plain misconfiguration into a bug hunt: uploads succeeded,
  // the queue stayed empty, and nothing on screen connected the two. The reason
  // travels back so the UI can say what happened.
  let documentId: string | null = null;
  let queueError: string | null = null;
  try {
    documentId = await savePendingDocument(userId, { extraction, filename: file.name ?? null });
    // A queue row is only a UI convenience. On a configured database, retain
    // the immutable upload and link its extraction before returning success.
    const db = getSupabase();
    if (db && documentId) {
      const bytes = Buffer.from(await file.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      const context = await canonicalEvidenceContext(userId);
      const locator = `${context.clientEntityId}/${digest}-${bytes.length}`;
      const upload = await db.storage.from("document-evidence").upload(locator, bytes, {
        contentType: file.type || "application/octet-stream", upsert: false,
      });
      if (upload.error && !/already exists/i.test(upload.error.message)) {
        throw new Error(`Failed to retain uploaded source: ${upload.error.message}`);
      }
      const retained = await new CanonicalDocumentEvidenceService(db).retainExtraction({
        userId, practiceId: context.practiceId, clientEntityId: context.clientEntityId, pendingDocumentId: documentId,
        ledgerBookId: context.internalLedgerBookId, bytes, storageLocator: locator,
        filename: file.name ?? null, mimeType: file.type || "application/octet-stream", extraction,
        extractorName: demo ? "zaki-demo" : "zaki-extraction", extractorVersion: "eyes-memory-v1",
      });
      if (retained.outcome !== "CREATED" || !retained.artifactId || !retained.extractionId) {
        throw new Error("Canonical evidence retention was rejected.");
      }
      console.info("[eyes-memory] retained+linked", { pendingDocumentId: documentId, artifactId: retained.artifactId, extractionId: retained.extractionId, requestFingerprint: digest });
    }
  } catch (err) {
    queueError = err instanceof Error ? err.message : String(err);
    console.error(
      `[pending-queue] could not queue this document (bulk approve unavailable): ${queueError}`,
    );
    // In a canonical deployment, returning a reviewable document without its
    // retained immutable source would recreate the posting-evidence bypass.
    if (getSupabase()) throw err;
  }

  return {
    documentId,
    queueError,
    extraction,
    arithmeticMismatch: mismatch,
    demo,
    refinedForSupplier: refinedForSupplier ?? null,
    calibratedFields,
    supplierMemory,
    duplicate,
  };
}

/**
 * How many documents may be read at once.
 *
 * Parallel, but not unbounded. Every real extraction is one or two Claude vision
 * calls, so dropping fifty files in at once would fire a hundred concurrent
 * requests and collect rate-limit errors on documents that were perfectly
 * readable — turning a provider limit into "your upload failed". Five at a time
 * keeps a normal batch (the 5–10 documents this feature is for) fully parallel
 * while putting a ceiling on the pathological case.
 */
export const EXTRACT_CONCURRENCY = 5;

/**
 * Map over items with at most `limit` running at once, preserving input order in
 * the results and invoking `onSettled` the moment each one lands.
 *
 * `onSettled` is what makes live progress honest: the caller learns about each
 * document as it finishes rather than being handed everything at the end, so a
 * progress display reports what actually happened instead of an animation.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (result: R, index: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  // Each "lane" pulls the next unclaimed index until the queue is empty, so a
  // slow document doesn't hold up the ones behind it (which fixed-size chunking
  // would).
  async function lane(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const result = await worker(items[i], i);
      results[i] = result;
      onSettled?.(result, i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => lane()),
  );
  return results;
}
