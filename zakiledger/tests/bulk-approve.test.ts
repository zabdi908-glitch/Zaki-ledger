import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { InvoiceExtraction } from "../lib/schema";

function s(value: string, confidence: number, reason = "test fixture"): { value: string; confidence: number; reason: string } {
  return { value, confidence, reason };
}
function n(value: number, confidence: number, reason = "test fixture"): { value: number; confidence: number; reason: string } {
  return { value, confidence, reason };
}

/** Bulk approval runs through the real route against the in-memory store. */

const TEST_USER_ID = "test-user";

// No real Supabase session exists in a unit test — stand in for one, the same
// user for every request in this file, so route handlers see the documents
// this file queues directly via lib/store.
vi.mock("../lib/auth", () => ({
  requireUser: async () => ({ id: TEST_USER_ID }),
}));

const { POST: bulkRoute } = await import("../app/api/approve/bulk/route");
const { sampleBulkBatch, sampleReceiptExtraction } = await import("../lib/demo");
const { listPendingDocuments, savePendingDocument } = await import("../lib/store");
const { SUPPORTED_CURRENCIES } = await import("../lib/currency");
type BulkApproveResult = Awaited<ReturnType<typeof import("../lib/bulk-approve").bulkApprove>>;

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

async function bulkApproveRequest(documentIds: string[]) {
  const req = new Request("http://test/api/approve/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentIds }),
  });
  const res = await bulkRoute(req as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as BulkApproveResult & { error?: string } };
}

/** Queue a batch and return its ids, in the order given. */
async function queue(batch: Array<{ filename: string; extraction: InvoiceExtraction }>) {
  const ids: string[] = [];
  for (const b of batch) ids.push(await savePendingDocument(TEST_USER_ID, b));
  return ids;
}

// =============================================================================
// The headline scenario: one batch, all three outcomes.
// =============================================================================
describe("the mixed batch: 3 clean receipts, 1 low-confidence merchant, 1 bad currency", () => {
  let body: BulkApproveResult;
  let ids: string[];

  beforeAll(async () => {
    ids = await queue(sampleBulkBatch());
    const res = await bulkApproveRequest(ids);
    expect(res.status).toBe(200);
    body = res.body;
  });

  it("returns one result per submitted document, in order", () => {
    expect(body.results).toHaveLength(5);
    expect(body.results.map((r) => r.documentId)).toEqual(ids);
  });

  it("summarises as 3 approved, 1 blocked, 1 error", () => {
    expect(body.summary.approved).toBe(3);
    expect(body.summary.blocked).toBe(1);
    expect(body.summary.errors).toBe(1);
  });

  it("does not report local approvals as provider postings", () => {
    expect(body.summary.postedTotals).toEqual({});
    expect(body.summary.postedLabel).toBe("£0.00");
  });

  it("reports merchant, total and currency on every item, whatever its outcome", () => {
    for (const r of body.results) {
      expect(r.merchantName).toBeTruthy();
      expect(typeof r.total).toBe("number");
      expect(r.currency).toBeTruthy();
    }
  });

  it("blocks the smudged merchant name and says which field and how confident", () => {
    const blocked = body.results.filter((r) => r.status === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].merchantName).toBe("The Corner Cafe");
    // Named in receipt language ("Merchant", not "supplierName"), with the score.
    expect(blocked[0].reason).toContain("Merchant");
    expect(blocked[0].reason).toContain("61%");
  });

  it("errors the unpostable currency and names the ones that work", () => {
    const errored = body.results.filter((r) => r.status === "error");
    expect(errored).toHaveLength(1);
    expect(errored[0].merchantName).toBe("Shinjuku Station Kiosk");
    expect(errored[0].currency).toBe("ZZZ");
    expect(errored[0].reason).toContain("ZZZ");
    for (const c of SUPPORTED_CURRENCIES) expect(errored[0].reason).toContain(c);
  });

  it("keeps provider identity and ids empty without an explicit posting proposal", () => {
    for (const r of body.results.filter((r) => r.status === "approved")) {
      expect(r.billId).toBeNull();
      expect(r.billPlatform).toBeNull();
      expect(r.postingState).toBe("REVIEW");
      expect(r.invoiceId).toBeTruthy();
    }
  });

  it("clears approved documents from the queue and keeps the rest, with reasons", async () => {
    const stillQueued = await listPendingDocuments(TEST_USER_ID);
    expect(stillQueued.map((d) => d.extraction.supplierName.value).sort()).toEqual([
      "Shinjuku Station Kiosk",
      "The Corner Cafe",
    ]);
    // The reason travels with the row, so the human sees it without re-running.
    for (const d of stillQueued) expect(d.lastReason).toBeTruthy();
  });

  it("does not re-approve an already-approved document when the batch is resubmitted", async () => {
    const again = await bulkApproveRequest(ids);
    expect(again.body.summary.approved).toBe(0);
    // The three that already landed report as errors explaining why, not as
    // silent no-ops that would read like the approval had been lost.
    const reasons = again.body.results.map((r) => r.reason ?? "");
    expect(reasons.filter((r) => r.includes("Already approved"))).toHaveLength(3);
  });
});

// =============================================================================
// Isolation: the property that makes bulk approve safe to press.
// =============================================================================
describe("one document's failure never costs the others their approval", () => {
  it("keeps going when an id doesn't exist at all", async () => {
    const [good] = await queue([
      {
        filename: "receipt-oakfield.png",
        extraction: {
          ...sampleReceiptExtraction(),
          supplierName: s("Oakfield Stationers", 0.95),
          invoiceNumber: s("OS-771", 0.9),
          invoiceDate: s("2026-07-23", 0.94),
          subtotal: n(20, 0.95),
          tax: n(4, 0.92),
          total: n(24, 0.96),
        },
      },
    ]);

    const { body } = await bulkApproveRequest([
      "00000000-0000-0000-0000-000000000000",
      good,
      "not-a-real-id",
    ]);

    expect(body.summary.approved).toBe(1);
    expect(body.summary.errors).toBe(2);
    expect(body.results.find((r) => r.documentId === good)?.status).toBe("approved");
    expect(body.results.filter((r) => r.status === "error").map((r) => r.reason)).toEqual([
      expect.stringContaining("not found"),
      expect.stringContaining("not found"),
    ]);
  });

  it("counts approved documents without a posting proposal as not posted", async () => {
    const sample = sampleReceiptExtraction();
    const ids = await queue([{
      filename: "local-only.png",
      extraction: {
        ...sample,
        supplierName: s("Local Only Supplier", 0.97),
        invoiceNumber: s("LOCAL-ONLY-1", 0.95),
        invoiceDate: s("2026-08-01", 0.96),
      },
    }]);
    const { body } = await bulkApproveRequest(ids);
    expect(body.summary.approved).toBe(1);
    expect(body.summary.postedTotals).toEqual({});
    expect(body.summary.approvedWithoutPosting).toBe(true);
  });
});

// =============================================================================
// The gate is the existing one — bulk just can't offer the human override.
// =============================================================================
describe("gating rules carried over from the review screen", () => {
  it("blocks a document whose type the model couldn't classify", async () => {
    const { sampleAmbiguousExtraction } = await import("../lib/demo");
    const ids = await queue([
      { filename: "ambiguous.pdf", extraction: sampleAmbiguousExtraction() },
    ]);
    const { body } = await bulkApproveRequest(ids);
    expect(body.results[0].status).toBe("blocked");
    expect(body.results[0].reason).toContain("invoice or a receipt");
  });

  it("blocks arithmetic that doesn't reconcile, however confident the read", async () => {
    const ids = await queue([
      {
        filename: "receipt-bad-maths.png",
        extraction: {
          ...sampleReceiptExtraction(),
          supplierName: s("Fenwick Supplies", 0.97),
          invoiceNumber: s("FS-12", 0.95),
          invoiceDate: s("2026-07-26", 0.96),
          subtotal: n(100, 0.97),
          tax: n(20, 0.96),
          total: n(130, 0.98, "should be 120"), // should be 120
        },
      },
    ]);
    const { body } = await bulkApproveRequest(ids);
    expect(body.results[0].status).toBe("blocked");
    expect(body.results[0].reason).toContain("Totals don't add up");
  });

  it("blocks a duplicate rather than waving it through — nobody is here to decide", async () => {
    const receipt = {
      ...sampleReceiptExtraction(),
      supplierName: s("Hollow Lane Garage", 0.96),
      invoiceNumber: s("HL-31", 0.93),
      invoiceDate: s("2026-07-27", 0.95),
      subtotal: n(40, 0.95),
      tax: n(8, 0.93),
      total: n(48, 0.97),
    };
    // Both copies in ONE batch: sequential processing means the first is already
    // in the ledger when the second is checked, so the second is caught.
    const ids = await queue([
      { filename: "garage-a.png", extraction: receipt },
      { filename: "garage-b.png", extraction: receipt },
    ]);
    const { body } = await bulkApproveRequest(ids);
    expect(body.results[0].status).toBe("approved");
    expect(body.results[1].status).toBe("blocked");
    expect(body.results[1].reason).toContain("duplicate");
  });

  it("treats a repeated id in one batch as one document, not as its own duplicate", async () => {
    const ids = await queue([
      {
        filename: "receipt-westgate.png",
        extraction: {
          ...sampleReceiptExtraction(),
          supplierName: s("Westgate Cycles", 0.96),
          invoiceNumber: s("WC-88", 0.93),
          invoiceDate: s("2026-07-28", 0.95),
          subtotal: n(50, 0.95),
          tax: n(10, 0.93),
          total: n(60, 0.97),
        },
      },
    ]);
    const { body } = await bulkApproveRequest([ids[0], ids[0], ids[0]]);
    expect(body.results).toHaveLength(1);
    expect(body.summary.approved).toBe(1);
  });
});

// =============================================================================
// Request-level validation.
// =============================================================================
describe("the request itself", () => {
  it("rejects an empty selection", async () => {
    const res = await bulkApproveRequest([]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects ids that aren't strings", async () => {
    const req = new Request("http://test/api/approve/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: [1, 2, 3] }),
    });
    const res = await bulkRoute(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});
