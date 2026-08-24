import { describe, expect, it } from "vitest";
import { CanonicalDocumentEvidenceService } from "../lib/canonical-document-evidence";

const extraction: any = { supplierName: { value: "Vendor", confidence: 1 }, invoiceNumber: { value: "INV-1", confidence: 1 }, invoiceDate: { value: "2026-08-23", confidence: 1 }, subtotal: { value: 10, confidence: 1 }, tax: { value: 0, confidence: 1 }, total: { value: 10, confidence: 1 }, currency: { value: "USD", confidence: 1 }, overallConfidence: 1, documentType: { value: "invoice", confidence: 1 } };
const base = { userId: "user-a", practiceId: "practice-a", clientEntityId: "client-a", ledgerBookId: "book-a", pendingDocumentId: "pending-a" };

describe("Eyes to Memory canonical evidence bridge", () => {
  it("hashes immutable bytes and extraction deterministically for duplicate upload replay", async () => {
    const calls: any[] = [];
    const service = new CanonicalDocumentEvidenceService({ rpc: async (name, input) => { calls.push({ name, input }); return { data: { outcome: "CREATED", artifactId: "artifact", extractionId: "extract" }, error: null }; } });
    await service.retainExtraction({ ...base, bytes: Buffer.from("same source"), storageLocator: "client-a/a", filename: "a.pdf", mimeType: "application/pdf", extraction, extractorName: "test", extractorVersion: "1" });
    await service.retainExtraction({ ...base, bytes: Buffer.from("same source"), storageLocator: "client-a/a", filename: "a.pdf", mimeType: "application/pdf", extraction, extractorName: "test", extractorVersion: "1" });
    expect(calls[0].name).toBe("ingest_document_evidence_with_pending_v1");
    expect(calls[0].input.p_pending_document_id).toBe("pending-a");
    expect(calls[0].input.p_content_sha256_hex).toBe(calls[1].input.p_content_sha256_hex);
    expect(calls[0].input.p_extraction_fingerprint_hex).toBe(calls[1].input.p_extraction_fingerprint_hex);
  });

  it("binds confirmation idempotency to all confirmed facts and exact canonical scope", async () => {
    const calls: any[] = [];
    const service = new CanonicalDocumentEvidenceService({ rpc: async (name, input) => { calls.push({ name, input }); return { data: { outcome: "RESUMED", documentId: "doc", revisionId: "rev" }, error: null }; } });
    const input = { ...base, extractionId: "extract", idempotencyKey: "approve-1", documentKind: "invoice", confirmedRevision: { issuer_name: "Vendor", amount_minor: "1000", currency_code: "USD" } };
    await service.confirm(input);
    await service.confirm(input);
    await service.confirm({ ...input, confirmedRevision: { ...input.confirmedRevision, amount_minor: "1100" } });
    expect(calls[0].name).toBe("confirm_document_evidence_with_pending_v1");
    expect(calls[0].input.p_pending_document_id).toBe("pending-a");
    expect(calls[0].input.p_confirmed_fingerprint_hex).toBe(calls[1].input.p_confirmed_fingerprint_hex);
    expect(calls[0].input.p_confirmed_fingerprint_hex).not.toBe(calls[2].input.p_confirmed_fingerprint_hex);
    expect(calls[0].input).toMatchObject({ p_client_entity_id: "client-a", p_ledger_book_id: "book-a", p_actor_user_id: "user-a" });
  });

  it("does not swallow store failure, so crash/retry cannot continue through legacy evidence", async () => {
    const service = new CanonicalDocumentEvidenceService({ rpc: async () => ({ data: null, error: { message: "transaction rolled back" } }) });
    await expect(service.confirm({ ...base, extractionId: "extract", idempotencyKey: "retry", documentKind: "invoice", confirmedRevision: {} })).rejects.toThrow("transaction rolled back");
  });
});
