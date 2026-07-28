import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { REVIEWABLE_FIELDS, type DocumentType, type InvoiceExtraction } from "@/lib/schema";

// No real Supabase session exists in a unit test — stand in for one.
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

const { POST: extractRoute } = await import("@/app/api/extract/route");
const { POST: approveRoute } = await import("@/app/api/approve/route");

/**
 * End-to-end route tests: upload → extract → approve → duplicate detection,
 * driving the real route handlers in-process. No dev server, no network.
 *
 * These run against the in-memory store (no SUPABASE_URL in the test env), which
 * is process-wide and accumulates. Tests in this file are therefore ORDER
 * DEPENDENT by design — a duplicate can only be found after something was
 * approved. vitest.config.ts gives each test file its own worker so files can't
 * contaminate each other.
 */

beforeAll(() => {
  // Force demo mode: deterministic samples, and no real API call from a test run.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

type ExtractBody = {
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo: boolean;
  duplicate: { documentType?: DocumentType; processedOn: string } | null;
  supplierMemory?: Record<string, { count: number; confidence: number }>;
  calibratedFields?: string[];
};

async function extract(filename: string): Promise<ExtractBody> {
  const form = new FormData();
  form.append("file", new File(["demo-bytes"], filename, { type: "image/png" }));
  const req = new Request("http://test/api/extract", { method: "POST", body: form });
  const res = await extractRoute(req as unknown as NextRequest);
  expect(res.status).toBe(200);
  return (await res.json()) as ExtractBody;
}

async function approve(
  extraction: InvoiceExtraction,
  opts: {
    edits?: Record<string, string>;
    proceedDuplicate?: boolean;
    documentType?: DocumentType;
  } = {},
) {
  const edited: Record<string, string> = {};
  for (const f of REVIEWABLE_FIELDS) edited[f] = String((extraction as any)[f].value);
  Object.assign(edited, opts.edits ?? {});

  const req = new Request("http://test/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extraction,
      edited,
      proceedDuplicate: opts.proceedDuplicate ?? false,
      documentType: opts.documentType,
    }),
  });
  const res = await approveRoute(req as unknown as NextRequest);
  return (await res.json()) as any;
}

describe("extraction produces the right shape per document type", () => {
  it("classifies an invoice and itemises tax", async () => {
    const r = await extract("invoice.pdf");
    expect(r.demo).toBe(true);
    expect(r.extraction.documentType.value).toBe("invoice");
    expect(r.extraction.taxItemized).toBe(true);
    expect(r.arithmeticMismatch).toBe(false);
    expect(r.duplicate).toBeNull();
  });

  it("classifies a clean receipt", async () => {
    const r = await extract("receipt.png");
    expect(r.extraction.documentType.value).toBe("receipt");
    expect(r.extraction.invoiceNumber.value).not.toBe("");
    expect(r.extraction.taxItemized).toBe(true);
  });

  it("reports a messy receipt's absent fields without erroring", async () => {
    const r = await extract("messy-till-receipt.png");
    expect(r.extraction.documentType.value).toBe("receipt");
    expect(r.extraction.invoiceNumber.value).toBe("");
    expect(r.extraction.invoiceNumber.confidence).toBe(0);
    expect(r.extraction.taxItemized).toBe(false);
    expect(r.extraction.total.value).toBeGreaterThan(0);
    // The headline requirement: absent tax must not surface as an inconsistency.
    expect(r.arithmeticMismatch).toBe(false);
  });
});

describe("approving a receipt with no number", () => {
  let firstApproval: any;

  it("approves and records the merchant correction", async () => {
    const r = await extract("messy-till-receipt.png");
    firstApproval = await approve(r.extraction, {
      edits: { supplierName: "The Corner Cafe Ltd" },
    });
    expect(firstApproval.status).toBe("approved");
    expect(firstApproval.invoiceId).toBeTruthy();
    expect(firstApproval.correctionsRecorded).toBe(1);
  });

  it("never builds trust on a non-read (blank number, 0-confidence tax/subtotal)", () => {
    // Only invoiceDate, currency and total were genuinely read. Regression guard
    // for the bug where numeric 0 stringified to "0" and slipped the empty check.
    expect(firstApproval.confirmationsRecorded).toBe(3);
  });

  it("posts nothing and errors nothing when no platform is connected", () => {
    expect(firstApproval.billId).toBeNull();
    expect(firstApproval.billError).toBeNull();
  });
});

describe("receipt duplicate detection (merchant + date + total)", () => {
  it("catches the duplicate at approve time, on the corrected values", async () => {
    const r = await extract("messy-till-receipt.png");
    // Upload-time can't match: the raw read still has the smudged merchant name,
    // while the stored row has the corrected one. This is precisely the gap the
    // second checkpoint exists to close.
    expect(r.duplicate).toBeNull();

    const a = await approve(r.extraction, { edits: { supplierName: "The Corner Cafe Ltd" } });
    expect(a.status).toBe("duplicate");
    expect(a.duplicate.documentType).toBe("receipt");
  });

  it("warns without blocking — proceedDuplicate saves it", async () => {
    const r = await extract("messy-till-receipt.png");
    const a = await approve(r.extraction, {
      edits: { supplierName: "The Corner Cafe Ltd" },
      proceedDuplicate: true,
    });
    expect(a.status).toBe("approved");
  });

  it("does NOT flag the same merchant and date at a different total", async () => {
    const r = await extract("messy-till-receipt.png");
    const a = await approve(r.extraction, {
      edits: { supplierName: "The Corner Cafe Ltd", total: "19.95" },
    });
    expect(a.status).toBe("approved");
  });
});

describe("invoice duplicate detection (supplier + number)", () => {
  it("approves the first time, confirming every field", async () => {
    const r = await extract("invoice.pdf");
    const a = await approve(r.extraction);
    expect(a.status).toBe("approved");
    expect(a.confirmationsRecorded).toBe(REVIEWABLE_FIELDS.length);
    expect(a.correctionsRecorded).toBe(0);
  });

  it("flags the re-upload at upload time", async () => {
    const r = await extract("invoice.pdf");
    expect(r.duplicate).not.toBeNull();
    expect(r.duplicate?.documentType).toBe("invoice");
  });
});

describe("merchant memory is the same machinery as supplier memory", () => {
  it("accrues per-merchant confirmations and lifts confidence", async () => {
    const before = await extract("receipt.png");
    const baseline = before.extraction.invoiceNumber.confidence;

    // Vary the total each time so the receipt duplicate check doesn't fire.
    for (let i = 0; i < 3; i++) {
      const r = await extract("receipt.png");
      await approve(r.extraction, { edits: { total: String(70 + i) }, proceedDuplicate: true });
    }

    const after = await extract("receipt.png");
    expect(after.supplierMemory?.invoiceNumber?.count).toBeGreaterThanOrEqual(3);
    expect(after.extraction.invoiceNumber.confidence).toBeGreaterThan(baseline);
    expect(after.calibratedFields).toContain("invoiceNumber");
  });
});

describe("human override of the document type", () => {
  it("stores the human's type, not the model's guess", async () => {
    const r = await extract("ambiguous.pdf");
    expect(r.extraction.documentType.value).toBe("invoice");
    expect(r.extraction.documentType.confidence).toBeLessThan(0.8);

    // Human says it's actually a receipt.
    const a = await approve(r.extraction, { documentType: "receipt" });
    expect(a.status).toBe("approved");

    // Proof it was stored AS a receipt: it is now findable by the receipt
    // identity rule (merchant + date + total), which only matches receipts.
    const again = await extract("ambiguous.pdf");
    const dup = await approve(again.extraction, { documentType: "receipt" });
    expect(dup.status).toBe("duplicate");
    expect(dup.duplicate.documentType).toBe("receipt");
  });
});
