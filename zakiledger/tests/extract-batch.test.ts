import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// No real Supabase session exists in a unit test — stand in for one.
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

/**
 * Batch upload: many files, read in parallel, one result each.
 *
 * The parallelism claim is tested as a claim about *time* (see the
 * mapWithConcurrency block) rather than inferred from the code shape — running
 * five documents through a sequential loop would satisfy every other assertion
 * in this file while being exactly the thing the feature exists to avoid.
 */

let batchRoute: any;
let listRoute: any;
let EXTRACT_CONCURRENCY: number;
let mapWithConcurrency: any;

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Lazy-import routes/modules *after* env vars are cleared.
  batchRoute = (await import("@/app/api/extract-batch/route")).POST;
  listRoute = (await import("@/app/api/pending/route")).GET;
  const pipeline = await import("@/lib/extract-pipeline");
  EXTRACT_CONCURRENCY = pipeline.EXTRACT_CONCURRENCY;
  mapWithConcurrency = pipeline.mapWithConcurrency;
});

/** Drive the route and collect the NDJSON stream into the messages it carried. */
async function uploadBatch(filenames: string[]) {
  const form = new FormData();
  for (const name of filenames) {
    form.append("files", new File(["demo-bytes"], name, { type: "image/png" }));
  }
  const req = new Request("http://test/api/extract-batch", { method: "POST", body: form });
  const res = await batchRoute(req as unknown as NextRequest);

  const text = await res.text();
  const messages = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as any);

  return {
    status: res.status,
    contentType: res.headers.get("Content-Type") ?? "",
    messages,
    start: messages.find((m) => m.type === "start"),
    results: messages.filter((m) => m.type === "result"),
    duplicates: messages.filter((m) => m.type === "duplicate"),
    summary: messages.find((m) => m.type === "summary"),
  };
}

describe("uploading five files at once", () => {
  it("streams NDJSON: a start line, one result per file, then a summary", async () => {
    const { status, contentType, messages, start, results, summary } = await uploadBatch([
      "receipt-1.png",
      "receipt-2.png",
      "receipt-3.png",
      "receipt-4.png",
      "receipt-5.png",
    ]);

    expect(status).toBe(200);
    expect(contentType).toContain("application/x-ndjson");
    expect(start.total).toBe(5);
    expect(results).toHaveLength(5);
    expect(summary.total).toBe(5);
    // Order matters: the summary can only be the last thing said.
    expect(messages[0].type).toBe("start");
    expect(messages[messages.length - 1].type).toBe("summary");
  });

  it("carries the per-file shape the UI renders from", async () => {
    const { results } = await uploadBatch(["receipt-a.png", "invoice-b.pdf"]);

    for (const r of results) {
      expect(r.filename).toBeTruthy();
      expect(["success", "error"]).toContain(r.status);
      expect(typeof r.index).toBe("number");
      if (r.status === "success") {
        expect(r.documentId).toBeTruthy();
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.extraction.supplierName.value).toBeTruthy();
        expect(["ready", "review", "blocked"]).toContain(r.gate);
      }
    }
  });

  it("tags each result with its input index, since lines arrive as they finish", async () => {
    const { results } = await uploadBatch(["a-receipt.png", "b-receipt.png", "c-receipt.png"]);
    // Completion order is not input order, so the index is what lets the UI keep
    // rows in the order the human picked the files.
    expect([...results.map((r: any) => r.index)].sort()).toEqual([0, 1, 2]);
  });

  it("flags a low-confidence read instead of calling it a clean success", async () => {
    // The smudged-merchant sample: extracted fine, but the gate would stop it.
    const { results, summary } = await uploadBatch(["messy-till-receipt.png"]);

    expect(results[0].status).toBe("success"); // the read worked
    expect(results[0].gate).not.toBe("ready"); // but it isn't clean
    expect(results[0].warning).toContain("Merchant");
    // A flagged document is still a successful extraction and still gets queued.
    expect(summary.succeeded).toBe(1);
    expect(summary.queued).toBe(1);
  });

  it("puts every successful extraction in the pending queue", async () => {
    const before = ((await (await listRoute()).json()) as any).documents.length;
    const { summary } = await uploadBatch(["queued-1.png", "queued-2.png"]);
    const after = ((await (await listRoute()).json()) as any).documents.length;

    expect(summary.queued).toBe(2);
    expect(after - before).toBe(2);
  });

  it("flags two copies of the same document uploaded together, even though neither is in the ledger yet", async () => {
    // Neither filename matches a demo keyword, so both fall through to the same
    // fixed invoice sample — same supplier, same invoice number. Upload-time
    // duplicate detection against the database can't catch this (nothing is
    // approved yet); this is the same-batch cross-check catching it instead.
    const { results, duplicates, summary } = await uploadBatch(["alpha.pdf", "bravo.pdf"]);

    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.status === "success")).toBe(true);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].index).toBe(1);
    expect(duplicates[0].matchIndex).toBe(0);
    // Still a normal successful, queued extraction — duplicate is a warning, not a block.
    expect(summary.succeeded).toBe(2);
    expect(summary.queued).toBe(2);
  });

  it("does not flag two different documents in the same batch", async () => {
    const { duplicates } = await uploadBatch(["invoice-alpha.pdf", "messy-till-receipt.png"]);
    expect(duplicates).toHaveLength(0);
  });

  it("rejects a request with no files at all", async () => {
    const req = new Request("http://test/api/extract-batch", {
      method: "POST",
      body: new FormData(),
    });
    const res = await batchRoute(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Parallelism, measured rather than assumed.
// =============================================================================
describe("mapWithConcurrency", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("runs work concurrently — five 60ms items finish in well under 300ms", async () => {
    const started = Date.now();
    await mapWithConcurrency([1, 2, 3, 4, 5], 5, async (n) => {
      await sleep(60);
      return n;
    });
    const elapsed = Date.now() - started;

    // Sequential would be ~300ms. Parallel is ~60ms; allow generous slack for a
    // loaded CI box while still failing loudly if the work went one-at-a-time.
    expect(elapsed).toBeLessThan(200);
  });

  it("honours the concurrency ceiling instead of firing everything at once", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency([...Array(12).keys()], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(10);
      running -= 1;
      return n;
    });

    // The ceiling is what stops a fifty-file drop turning a provider rate limit
    // into "your upload failed" on documents that were perfectly readable.
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // …but it is genuinely concurrent
  });

  it("keeps results in input order however they finish", async () => {
    // First item slowest, so completion order is the reverse of input order.
    const out = await mapWithConcurrency([30, 20, 10], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 20, 10]);
  });

  it("reports each item the moment it lands, not at the end", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      [40, 10, 25],
      3,
      async (ms) => {
        await sleep(ms);
        return ms;
      },
      (result) => seen.push(result),
    );
    // Fastest first — this callback firing in completion order is what makes the
    // "3 of 5 complete" counter a fact rather than an animation.
    expect(seen).toEqual([10, 25, 40]);
  });

  it("defaults to a sane ceiling for the batch route", () => {
    expect(EXTRACT_CONCURRENCY).toBeGreaterThan(1);
    expect(EXTRACT_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});
