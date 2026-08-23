import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { ApprovedBillPostingRequest } from "../lib/accounting";
import type { PostingIntent } from "../lib/posting-contract";

const posting = vi.hoisted(() => ({
  calls: [] as PostingIntent[],
}));

vi.mock("../lib/authoritative-posting-service", () => ({
  createAuthoritativePostingService: () => ({
    submit: async (intent: PostingIntent) => {
      posting.calls.push(intent);
      return intent.requestedObject.synthetic === true
        ? {
            operationId: "operation-denied",
            state: "DENIED",
            reasonCodes: ["SYNTHETIC_LIVE_PROHIBITED"],
            resumed: false,
            authorizedRequestFingerprint: "d".repeat(64),
          }
        : {
            operationId: "operation-authorized",
            state: "AUTHORIZED",
            reasonCodes: ["PERMISSION_ALLOW"],
            resumed: false,
            authorizedRequestFingerprint: "c".repeat(64),
          };
    },
  }),
}));

vi.mock("../lib/auth", () => ({
  requireUser: async () => ({ id: "containment-user" }),
}));

let approveRoute: (req: NextRequest) => Promise<Response>;
let bulkRoute: (req: NextRequest) => Promise<Response>;
let sampleReceiptExtraction: () => any;
let savePendingDocument: typeof import("../lib/store").savePendingDocument;

function postingRequest(documentId: string, synthetic = false): ApprovedBillPostingRequest {
  return {
    destination: {
      practiceId: "practice-a",
      clientEntityId: "client-a",
      ledgerBookId: "book-a",
      providerConnectionId: "connection-a",
      provider: "xero",
      externalOrganisationId: "tenant-a",
    },
    idempotencyKey: `bill:${documentId}`,
    sourceDocumentId: documentId,
    sourceRevision: "revision-a",
    evidence: [{
      kind: "IMPORT_ARTIFACT",
      evidenceId: "artifact-a",
      fingerprint: "a".repeat(64),
    }],
    accountTreatment: [{ disposition: "MAPPED", mappingId: "mapping-a" }],
    taxTreatment: [{
      disposition: "MAPPED",
      treatmentId: "tax-a",
      providerTaxCode: "OUTPUT2",
      evidenceFingerprint: "b".repeat(64),
    }],
    humanApprovalId: "approval-a",
    synthetic,
  };
}

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  approveRoute = (await import("../app/api/approve/route")).POST as typeof approveRoute;
  bulkRoute = (await import("../app/api/approve/bulk/route")).POST as typeof bulkRoute;
  sampleReceiptExtraction = (await import("../lib/demo")).sampleReceiptExtraction;
  savePendingDocument = (await import("../lib/store")).savePendingDocument;
});

beforeEach(() => {
  posting.calls = [];
});

async function post(route: typeof approveRoute, body: unknown) {
  const request = new Request("http://test/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await route(request as unknown as NextRequest);
  return { status: response.status, body: await response.json() as any };
}

describe("approval route containment", () => {
  it("single approval reaches AuthoritativePostingService with an explicit destination", async () => {
    const extraction = {
      ...sampleReceiptExtraction(),
      supplierName: { ...sampleReceiptExtraction().supplierName, value: "Single Boundary Supplier" },
    };
    const documentId = await savePendingDocument("containment-user", {
      filename: "single-boundary.png",
      extraction,
    });
    const response = await post(approveRoute, {
      extraction,
      edited: {},
      proceedDuplicate: true,
      documentId,
      posting: postingRequest(documentId),
    });

    expect(response.status).toBe(200);
    expect(response.body.postingState).toBe("AUTHORIZED");
    expect(posting.calls).toHaveLength(1);
    expect(posting.calls[0]).toMatchObject({
      provider: "xero",
      providerConnectionId: "connection-a",
      externalOrganisationId: "tenant-a",
    });
  });

  it("bulk approval reaches AuthoritativePostingService for each explicit item", async () => {
    const extraction = {
      ...sampleReceiptExtraction(),
      supplierName: { ...sampleReceiptExtraction().supplierName, value: "Bulk Boundary Supplier" },
    };
    const documentId = await savePendingDocument("containment-user", {
      filename: "bulk-boundary.png",
      extraction,
    });

    const response = await post(bulkRoute, {
      documentIds: [documentId],
      postingByDocumentId: { [documentId]: postingRequest(documentId) },
    });

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      status: "approved",
      postingState: "AUTHORIZED",
      billId: null,
    });
    expect(posting.calls).toHaveLength(1);
  });

  it("document-less and demo approval payloads cannot reach live posting", async () => {
    const extraction = {
      ...sampleReceiptExtraction(),
      supplierName: { ...sampleReceiptExtraction().supplierName, value: "Demo Boundary Supplier" },
    };
    const localOnly = await post(approveRoute, {
      extraction,
      edited: {},
      proceedDuplicate: true,
    });
    expect(localOnly.body.postingState).toBe("REVIEW");
    expect(posting.calls).toHaveLength(0);

    const documentId = await savePendingDocument("containment-user", {
      filename: "synthetic-boundary.png",
      extraction,
      synthetic: true,
    });
    const synthetic = await post(approveRoute, {
      extraction,
      edited: {},
      proceedDuplicate: true,
      documentId,
      // A request cannot downgrade the row's durable synthetic provenance.
      posting: postingRequest(documentId, false),
    });
    expect(synthetic.body.postingState).toBe("DENIED");
    expect(synthetic.body.postingReasonCodes).toContain("SYNTHETIC_LIVE_PROHIBITED");
    expect(posting.calls).toHaveLength(1);
    expect(posting.calls[0].requestedObject.synthetic).toBe(true);
  });
});
