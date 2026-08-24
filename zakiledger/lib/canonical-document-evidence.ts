import { createHash } from "crypto";
import { canonicalJson, sha256Hex } from "./posting-contract";
import type { InvoiceExtraction } from "./schema";
import { resolveTenantContextForUser } from "./tenant-context";

export type EvidenceIngestResult = { outcome: "CREATED" | "DESTINATION_REJECTED"; artifactId?: string; extractionId?: string };
export type EvidenceConfirmationResult = { outcome: "CREATED" | "RESUMED" | "IDEMPOTENCY_CONFLICT" | "DESTINATION_REJECTED"; documentId?: string; revisionId?: string };

export interface CanonicalEvidenceStore {
  rpc(name: string, input: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** The single route-facing bridge from uploaded bytes to immutable canonical evidence. */
export class CanonicalDocumentEvidenceService {
  constructor(private readonly store: CanonicalEvidenceStore) {}

  async retainExtraction(input: { userId: string; practiceId: string; clientEntityId: string; ledgerBookId: string; pendingDocumentId: string; bytes: Buffer; storageLocator: string; filename: string | null; mimeType: string; extraction: InvoiceExtraction; extractorName: string; extractorVersion: string }): Promise<EvidenceIngestResult> {
    const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const extractionFingerprint = sha256Hex(canonicalJson(input.extraction));
    const { data, error } = await this.store.rpc("ingest_document_evidence_with_pending_v1", {
      p_practice_id: input.practiceId, p_client_entity_id: input.clientEntityId, p_ledger_book_id: input.ledgerBookId,
      p_actor_user_id: input.userId, p_pending_document_id: input.pendingDocumentId, p_content_sha256_hex: contentSha256, p_content_length: input.bytes.length,
      p_storage_locator: input.storageLocator, p_source_filename: input.filename, p_mime_type: input.mimeType,
      p_extraction_fingerprint_hex: extractionFingerprint, p_extraction_payload: input.extraction,
      p_extractor_name: input.extractorName, p_extractor_version: input.extractorVersion,
    });
    if (error) throw new Error(`Canonical evidence retention failed: ${error.message}`);
    return data as EvidenceIngestResult;
  }

  async confirm(input: { userId: string; practiceId: string; clientEntityId: string; ledgerBookId: string; pendingDocumentId: string; extractionId: string; idempotencyKey: string; documentKind: string; confirmedRevision: Record<string, unknown> }): Promise<EvidenceConfirmationResult> {
    const fingerprint = sha256Hex(canonicalJson({ documentKind: input.documentKind, confirmedRevision: input.confirmedRevision }));
    const { data, error } = await this.store.rpc("confirm_document_evidence_with_pending_v1", {
      p_practice_id: input.practiceId, p_client_entity_id: input.clientEntityId, p_ledger_book_id: input.ledgerBookId,
      p_actor_user_id: input.userId, p_pending_document_id: input.pendingDocumentId, p_extraction_id: input.extractionId, p_idempotency_key: input.idempotencyKey,
      p_confirmed_fingerprint_hex: fingerprint, p_document_kind: input.documentKind, p_confirmed_revision: input.confirmedRevision,
    });
    if (error) throw new Error(`Canonical evidence confirmation failed: ${error.message}`);
    return data as EvidenceConfirmationResult;
  }
}

export async function canonicalEvidenceContext(userId: string) {
  return resolveTenantContextForUser(userId);
}
