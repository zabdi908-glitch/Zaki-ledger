import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { InvoiceExtraction } from "../lib/schema";

function s(value: string, confidence: number, reason = "test fixture"): { value: string; confidence: number; reason: string } {
  return { value, confidence, reason };
}
function n(value: number, confidence: number, reason = "test fixture"): { value: number; confidence: number; reason: string } {
  return { value, confidence, reason };
}

/**
 * Bulk approve, driven through the real route handler against the in-memory
 * store, with Xero faked at the module boundary.
 *
 * Faking Xero (rather than leaving it disconnected, as tests/flow.test.ts does)
 * is the point: the headline claim is "3 of these 5 post to Xero and the other
 * two don't", and that can only be proven by watching what actually reached the
 * platform. `xero.calls` is that evidence.
 */
const xero = vi.hoisted(() => ({
  connected: true,
  calls: [] as Array<{ supplierName: string; total: number | null; currency: string | null }>,
  /** When set, createXeroDraftBill throws for this supplier — the outage case. */
  failFor: null as string | null,
}));

vi.mock("../lib/xero", () => ({
  isXeroConfigured: () => true,
  isXeroConnected: async () => xero.connected,
  createXeroDraftBill: async (_userId: string, bill: any) => {
    if (xero.failFor && bill.supplierName === xero.failFor) {
      throw new Error("Xero bill creation failed (400): currency not enabled");
    }
    xero.calls.push({
      supplierName: bill.supplierName,
      total: bill.total,
      currency: bill.currency,
    });
    return `XERO-BILL-${xero.calls.length}`;
  },
}));

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

  it("totals only what was actually posted", () => {
    // 63.00 + 153.60 + 99.00 — the blocked and errored documents contribute nothing.
    expect(body.summary.postedTotals).toEqual({ GBP: 315.6 });
    expect(body.summary.postedLabel).toBe("£315.60");
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
    expect(errored[0].currency).toBe("JPY");
    expect(errored[0].reason).toContain("JPY");
    for (const c of SUPPORTED_CURRENCIES) expect(errored[0].reason).toContain(c);
  });

  it("posts exactly the three approved documents to Xero — and nothing else", () => {
    expect(xero.calls).toHaveLength(3);
    expect(xero.calls.map((c) => c.supplierName)).toEqual([
      "Greenway Fuel & Services",
      "Northgate Hardware",
      "Mereside Catering",
    ]);
    // The two that didn't clear the gate never touched the platform.
    const posted = xero.calls.map((c) => c.supplierName);
    expect(posted).not.toContain("The Corner Cafe");
    expect(posted).not.toContain("Shinjuku Station Kiosk");
  });

  it("returns the bill id for each approved document", () => {
    for (const r of body.results.filter((r) => r.status === "approved")) {
      expect(r.billId).toMatch(/^XERO-BILL-/);
      expect(r.billPlatform).toBe("xero");
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

  it("does not re-post an already-approved document when the batch is resubmitted", async () => {
    const before = xero.calls.length;
    const again = await bulkApproveRequest(ids);
    expect(again.body.summary.approved).toBe(0);
    expect(xero.calls).toHaveLength(before);
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

  it("keeps going — and keeps the approval — when the platform rejects one bill", async () => {
    const ids = await queue([
      {
        filename: "receipt-brackley-tools.png",
        extraction: {
          ...sampleReceiptExtraction(),
          supplierName: s("Brackley Tools", 0.95),
          invoiceNumber: s("BT-500", 0.9),
          invoiceDate: s("2026-07-24", 0.94),
          subtotal: n(10, 0.95),
          tax: n(2, 0.92),
          total: n(12, 0.96),
        },
      },
      {
        filename: "receipt-lowther-print.png",
        extraction: {
          ...sampleReceiptExtraction(),
          supplierName: s("Lowther Print", 0.95),
          invoiceNumber: s("LP-900", 0.9),
          invoiceDate: s("2026-07-25", 0.94),
          subtotal: n(30, 0.95),
          tax: n(6, 0.92),
          total: n(36, 0.96),
        },
      },
    ]);

    xero.failFor = "Brackley Tools";
    const { body } = await bulkApproveRequest(ids);
    xero.failFor = null;

    expect(body.summary.approved).toBe(1);
    expect(body.summary.errors).toBe(1);

    const failed = body.results[0];
    expect(failed.status).toBe("error");
    expect(failed.reason).toContain("posting the bill failed");
    // The approval itself survived the platform failure — same contract as the
    // single-document route, which also refuses to lose a human's approval.
    expect(failed.invoiceId).toBeTruthy();

    expect(body.results[1].status).toBe("approved");
    expect(body.summary.postedTotals).toEqual({ GBP: 36 });
  });

  it("counts a document that failed to post as approved-but-not-posted, never as posted", async () => {
    // Guard on the summary arithmetic: an error must not inflate "Total posted".
    const posted = xero.calls.map((c) => c.supplierName);
    expect(posted).not.toContain("Brackley Tools");
    expect(posted).toContain("Lowther Print");
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
