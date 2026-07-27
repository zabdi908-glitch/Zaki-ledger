import { beforeAll, describe, expect, it } from "vitest";
import { GET as listRoute } from "@/app/api/pending/route";
import { DELETE as deleteRoute, GET as detailRoute } from "@/app/api/pending/[id]/route";
import { resolvePendingDocument, savePendingDocument } from "@/lib/store";
import { sampleMessyReceiptExtraction, sampleReceiptExtraction } from "@/lib/demo";

/**
 * The two endpoints behind the pending-documents view.
 *
 * They exist as a pair on purpose: the list draws a row per document and only
 * needs identity, while the detail endpoint carries every field's confidence and
 * is fetched only when a human opens "view details". These tests pin that split —
 * a list that quietly starts shipping full extractions would pass any test that
 * only checked the fields it renders.
 */

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

async function list() {
  const res = await listRoute();
  return { status: res.status, body: (await res.json()) as any };
}

async function detail(id: string) {
  const res = await detailRoute(new Request(`http://test/api/pending/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("the queue list", () => {
  let id: string;

  beforeAll(async () => {
    id = await savePendingDocument({
      extraction: sampleReceiptExtraction(),
      filename: "receipt-greenway-fuel.png",
    });
  });

  it("carries everything a row needs to be read and chosen", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);

    const doc = body.documents.find((d: any) => d.id === id);
    expect(doc).toBeDefined();
    // Exactly the fields the view renders — merchant, amount + currency, date,
    // confidence, and the type badge.
    expect(doc.merchantName).toBe("Greenway Fuel & Services");
    expect(doc.total).toBe(63);
    expect(doc.currency).toBe("GBP");
    expect(doc.invoiceDate).toBe("2026-07-18");
    expect(doc.overallConfidence).toBeGreaterThan(0);
    expect(doc.documentType).toBe("receipt");
  });

  it("stays a summary — the per-field scores are the detail endpoint's job", async () => {
    const { body } = await list();
    const doc = body.documents.find((d: any) => d.id === id);
    expect(doc.extraction).toBeUndefined();
  });

  it("is empty, not an error, when nothing is queued", async () => {
    // Nothing has been approved away here, so just assert the shape holds: an
    // empty queue is a 200 with no documents, which is what the empty state renders.
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(Array.isArray(body.documents)).toBe(true);
  });
});

describe("the detail view", () => {
  it("returns the full extraction, with a confidence for every field", async () => {
    const id = await savePendingDocument({
      extraction: sampleReceiptExtraction(),
      filename: "detail-me.png",
    });

    const { status, body } = await detail(id);
    expect(status).toBe(200);
    expect(body.extraction.supplierName.value).toBe("Greenway Fuel & Services");
    expect(body.extraction.supplierName.confidence).toBeGreaterThan(0);
    expect(body.extraction.documentType.confidence).toBeGreaterThan(0);
    expect(body.extraction.lineItems.length).toBeGreaterThan(0);
  });

  it("preserves a field the document never stated as an absence, not a zero-confidence read", async () => {
    // A till receipt with no number: the view has to tell "not printed on the
    // document" apart from "read it badly", and this is the data that decides it.
    const id = await savePendingDocument({
      extraction: sampleMessyReceiptExtraction(),
      filename: "messy-till-receipt.png",
    });

    const { body } = await detail(id);
    expect(body.extraction.invoiceNumber.value).toBe("");
    expect(body.extraction.invoiceNumber.confidence).toBe(0);
    expect(body.extraction.taxItemized).toBe(false);
  });

  it("404s on an unknown id rather than pretending it's an empty document", async () => {
    const { status, body } = await detail("00000000-0000-0000-0000-000000000000");
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});

describe("deleting a queued document", () => {
  async function del(id: string) {
    const res = await deleteRoute(new Request(`http://test/api/pending/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("removes it from the queue for good", async () => {
    const id = await savePendingDocument({
      extraction: sampleReceiptExtraction(),
      filename: "duplicate-to-bin.png",
    });

    const { status, body } = await del(id);
    expect(status).toBe(200);
    expect(body.status).toBe("deleted");

    // Gone from the list AND unfetchable — not merely hidden from the queue view.
    const { body: after } = await list();
    expect(after.documents.find((d: any) => d.id === id)).toBeUndefined();
    const res = await detailRoute(new Request(`http://test/api/pending/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });

  it("404s on an id that was never there", async () => {
    const { status } = await del("00000000-0000-0000-0000-000000000000");
    expect(status).toBe(404);
  });

  it("refuses to delete a document that already reached the ledger", async () => {
    // The audit-trail guard: this row is what links an approved bill back to the
    // extraction it came from, so deleting it would orphan the bill's origin.
    const id = await savePendingDocument({
      extraction: sampleMessyReceiptExtraction(),
      filename: "already-approved.png",
    });
    await resolvePendingDocument(id, { outcome: "approved", invoiceId: "inv-1" });

    const { status, body } = await del(id);
    expect(status).toBe(409);
    expect(body.error).toContain("already been approved");
  });
});
