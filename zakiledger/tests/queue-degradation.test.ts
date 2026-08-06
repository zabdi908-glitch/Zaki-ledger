import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The approval queue is additive to the single-document flow — so when the queue
 * is unavailable, the flow that existed before it must carry on untouched.
 *
 * This is a regression guard for a real incident, not a hypothetical: shipping
 * the queue added a `savePendingDocument` call to /api/extract, and a deployment
 * whose database predated `pending_documents` started 500ing on EVERY upload. One
 * missing table took down the whole product. The rule this file encodes is that
 * a queue failure costs the user their bulk-approve option and nothing else.
 */
const store = vi.hoisted(() => ({ failQueueWrites: true }));

vi.mock("../lib/store", async () => {
  const actual = await vi.importActual<typeof import("../lib/store")>("../lib/store");
  return {
    ...actual,
    savePendingDocument: async (...args: Parameters<typeof actual.savePendingDocument>) => {
      if (store.failQueueWrites) {
        throw new Error("Could not find the table 'public.pending_documents' in the schema cache");
      }
      return actual.savePendingDocument(...args);
    },
    resolvePendingDocument: async (
      ...args: Parameters<typeof actual.resolvePendingDocument>
    ) => {
      if (store.failQueueWrites) {
        throw new Error("Could not find the table 'public.pending_documents' in the schema cache");
      }
      return actual.resolvePendingDocument(...args);
    },
  };
});

// No real Supabase session exists in a unit test — stand in for one.
vi.mock("../lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

let extractRoute: any;
let approveRoute: any;
let REVIEWABLE_FIELDS: readonly string[];

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  extractRoute = (await import("../app/api/extract/route")).POST;
  approveRoute = (await import("../app/api/approve/route")).POST;
  REVIEWABLE_FIELDS = (await import("../lib/schema")).REVIEWABLE_FIELDS;
});

async function extract(filename: string) {
  const form = new FormData();
  form.append("file", new File(["demo-bytes"], filename, { type: "image/png" }));
  const req = new Request("http://test/api/extract", { method: "POST", body: form });
  const res = await extractRoute(req as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as any };
}

describe("a queue the database can't serve", () => {
  it("still extracts, and says so by returning no document id", async () => {
    const { status, body } = await extract("invoice.pdf");

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    // The part the human actually needs — the read itself — is fully intact.
    expect(body.extraction.supplierName.value).toBeTruthy();
    expect(body.extraction.total.value).toBeGreaterThan(0);
    // Only the queue is missing, and it degrades to "no id" rather than an error.
    expect(body.documentId).toBeNull();
  });

  it("reports WHY, instead of leaving an empty queue to look like lost data", async () => {
    // The bug this pins: the failure was logged server-side only, so an upload
    // succeeded, the queue stayed empty, and nothing on screen connected the two.
    // Non-fatal must not mean invisible.
    const { body } = await extract("invoice.pdf");

    expect(body.queueError).toBeTruthy();
    expect(body.queueError).toContain("pending_documents");
  });

  it("reports no queue error on the happy path", async () => {
    store.failQueueWrites = false;
    try {
      const { body } = await extract("receipt.png");
      expect(body.documentId).toBeTruthy();
      expect(body.queueError).toBeNull();
    } finally {
      store.failQueueWrites = true;
    }
  });

  it("still approves, rather than reporting a 500 for work it already committed", async () => {
    const { body: extracted } = await extract("receipt.png");

    const edited: Record<string, string> = {};
    for (const f of REVIEWABLE_FIELDS) edited[f] = String(extracted.extraction[f].value);

    const req = new Request("http://test/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extraction: extracted.extraction,
        edited,
        // A client that DOES hold an id from before the outage — clearing it will
        // throw, after the invoice and its corrections are already written.
        documentId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    const res = await approveRoute(req as unknown as NextRequest);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.invoiceId).toBeTruthy();
  });
});
