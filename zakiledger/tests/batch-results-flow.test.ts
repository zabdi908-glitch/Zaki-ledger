import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { InvoiceExtraction } from "@/lib/schema";
// Type-only, so it doesn't pull the module in ahead of the vi.mock calls below.
import type { ResultRow } from "@/lib/batch-results";

/**
 * The whole journey the results screen exists for, driven through the real route
 * handlers: upload five files — three clean, one flagged, one unreadable — fix
 * the flagged one *without leaving the screen*, approve it, batch-approve the
 * clean three, and end on "4 approved, 1 failed".
 *
 * Driven end to end rather than as unit assertions because the claim being made
 * is a claim about the seam: the screen decides locally which of two endpoints
 * each document may use, and those endpoints have different rules. A test that
 * mocked `fetch` would prove the screen calls *something* and prove nothing
 * about whether four bills actually reached the ledger.
 *
 * The client half is `planApproval` applied to rows built exactly as
 * components/BatchUpload builds them from the NDJSON stream — the same function
 * the screen calls, on the same data the screen has.
 */

/** Xero, faked at the module boundary, so "posted" can be checked rather than assumed. */
const xero = vi.hoisted(() => ({
  calls: [] as Array<{ supplierName: string; total: number | null }>,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConfigured: () => true,
  isXeroConnected: async () => true,
  createXeroDraftBill: async (_userId: string, bill: any) => {
    xero.calls.push({ supplierName: bill.supplierName, total: bill.total });
    return `XERO-BILL-${xero.calls.length}`;
  },
}));

/**
 * Demo mode returns one sample per *kind* of document, so five uploaded files
 * would be five copies of the same receipt — and copies two and three would
 * correctly block as duplicates of copy one, which is a different test than this
 * one. Mapping each filename to a distinct sample gives the batch this scenario
 * describes: three genuinely different clean receipts.
 */
const samples = vi.hoisted(() => ({ byFilename: new Map<string, unknown>() }));

vi.mock("@/lib/demo", async () => {
  const actual = await vi.importActual<typeof import("@/lib/demo")>("@/lib/demo");
  return {
    ...actual,
    sampleForFilename: (filename: string) =>
      (samples.byFilename.get(filename) as InvoiceExtraction) ?? actual.sampleForFilename(filename),
  };
});

/** The one unreadable file, forced at the pipeline boundary — demo reads never fail. */
const pipeline = vi.hoisted(() => ({ failFor: new Set<string>() }));

vi.mock("@/lib/extract-pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/lib/extract-pipeline")>(
    "@/lib/extract-pipeline",
  );
  return {
    ...actual,
    extractOneDocument: async (userId: string, file: File) => {
      if (pipeline.failFor.has(file.name)) throw new Error("Could not extract text from image");
      return actual.extractOneDocument(userId, file);
    },
  };
});

// No real Supabase session exists in a unit test — stand in for one, the same
// user for every request in this file.
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

let batchRoute: any;
let approveRoute: any;
let bulkRoute: any;
let correctionsRoute: any;
let pendingRoute: any;
let sampleBulkBatch: any;
let sampleMessyReceiptExtraction: any;
let pendingRow: any;
let planApproval: any;
let rowStatus: any;
let tally: any;
let tallyLabel: any;
let flagReason: any;

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  batchRoute = (await import("@/app/api/extract-batch/route")).POST;
  approveRoute = (await import("@/app/api/approve/route")).POST;
  bulkRoute = (await import("@/app/api/approve/bulk/route")).POST;
  correctionsRoute = (await import("@/app/api/corrections/route")).GET;
  pendingRoute = (await import("@/app/api/pending/route")).GET;
  const demo = await import("@/lib/demo");
  sampleBulkBatch = demo.sampleBulkBatch;
  sampleMessyReceiptExtraction = demo.sampleMessyReceiptExtraction;
  const batchResults = await import("@/lib/batch-results");
  pendingRow = batchResults.pendingRow;
  planApproval = batchResults.planApproval;
  rowStatus = batchResults.rowStatus;
  tally = batchResults.tally;
  tallyLabel = batchResults.tallyLabel;
  flagReason = batchResults.flagReason;
});

/**
 * A fresh five-file batch, with merchants unique to this batch.
 *
 * The store is shared across the file and duplicate detection is real: a second
 * test approving the same three receipts would find them already in the ledger
 * and correctly block them. That is the duplicate rule working, not this
 * scenario failing — so each test gets documents it alone has ever seen.
 */
function batchFor(tag: string) {
  const filenames = [
    `clean-a-${tag}.png`,
    `clean-b-${tag}.png`,
    `clean-c-${tag}.png`,
    `messy-till-${tag}.png`,
    `broken-scan-${tag}.pdf`,
  ];
  const clean = sampleBulkBatch().slice(0, 3);

  samples.byFilename = new Map<string, unknown>([
    ...clean.map(({ extraction }, i): [string, unknown] => [
      filenames[i],
      { ...extraction, supplierName: { ...extraction.supplierName, value: `${extraction.supplierName.value} (${tag})` } },
    ]),
    [
      filenames[3],
      (() => {
        const messy = sampleMessyReceiptExtraction();
        return { ...messy, supplierName: { ...messy.supplierName, value: `The Corner Cafe ${tag}` } };
      })(),
    ],
  ]);
  pipeline.failFor = new Set([filenames[4]]);

  return { filenames, flaggedMerchant: `The Corner Cafe ${tag}` };
}

/** Upload the batch and rebuild the rows the screen would hold, from the stream. */
async function uploadAndBuildRows(filenames: string[]): Promise<ResultRow[]> {
  const form = new FormData();
  for (const name of filenames) {
    form.append("files", new File(["demo-bytes"], name, { type: "image/png" }));
  }
  const req = new Request("http://test/api/extract-batch", { method: "POST", body: form });
  const res = await batchRoute(req as unknown as NextRequest);

  const messages = (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as any);

  // Exactly what components/BatchUpload does with each "result" line.
  const rows = filenames.map((name, i) => pendingRow(name, i));
  for (const msg of messages.filter((m) => m.type === "result")) {
    rows[msg.index] = {
      index: msg.index,
      filename: msg.filename,
      read: msg.status === "error" ? "error" : "success",
      documentId: msg.documentId,
      confidence: msg.confidence,
      extraction: msg.extraction,
      queueError: msg.queueError,
      failure: msg.status === "error" ? msg.reason : undefined,
      edited: {},
      affirmed: {},
      typeConfirmed: false,
    };
  }
  return rows;
}

/** Run a plan's two halves through the real endpoints, as the screen does. */
async function runPlan(rows: ResultRow[], indexes: number[]): Promise<ResultRow[]> {
  const plan = planApproval(rows, indexes);
  const next = [...rows];

  if (plan.queued.length > 0) {
    const req = new Request("http://test/api/approve/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: plan.queued.map((q) => q.documentId) }),
    });
    const body = (await (await bulkRoute(req as unknown as NextRequest)).json()) as any;
    const byId = new Map(body.results.map((r: any) => [r.documentId, r]));
    for (const q of plan.queued) {
      const result = byId.get(q.documentId) as any;
      next[q.index] = { ...next[q.index], outcome: result.status, outcomeReason: result.reason };
    }
  }

  for (const d of plan.direct) {
    const req = new Request("http://test/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extraction: d.extraction,
        edited: d.edited,
        documentType: d.documentType,
        documentId: d.documentId ?? undefined,
      }),
    });
    const body = (await (await approveRoute(req as unknown as NextRequest)).json()) as any;
    next[d.index] = {
      ...next[d.index],
      outcome: body.status === "approved" ? "approved" : "blocked",
      outcomeReason: body.status === "approved" ? "Approved" : "Possible duplicate",
    };
  }

  return next;
}

describe("five files: 3 clean, 1 flagged, 1 failed", () => {
  it("shows three ready, one flagged with its reason, and one failed", async () => {
    const { filenames } = batchFor("look");
    const rows = await uploadAndBuildRows(filenames);

    expect(rows.map(rowStatus)).toEqual(["ready", "ready", "ready", "flagged", "failed"]);
    // The flagged row says which field and why — the whole point of not sending
    // the human to another screen to find out.
    expect(flagReason(rows[3])).toContain("Merchant");
    // The failed row carries a reason and nothing else. There is no extraction to
    // show and nothing to edit.
    expect(rows[4].failure).toBe("Could not extract text from image");
    expect(rows[4].extraction).toBeUndefined();
    expect(tallyLabel(tally(rows))).toBe("3 ready to approve, 1 needs a look, 1 failed");
  });

  it("fixes the flagged one, approves it, batch-approves the rest: 4 approved, 1 failed", async () => {
    const { filenames, flaggedMerchant } = batchFor("main");
    const corrected = `${flaggedMerchant} Ltd`;
    xero.calls = [];

    let rows = await uploadAndBuildRows(filenames);
    const correctionsBefore = ((await (await correctionsRoute()).json()) as any).corrections.length;

    // --- Edit the flagged document, right here on the results page. --------
    rows[3] = { ...rows[3], edited: { supplierName: corrected } };
    expect(rowStatus(rows[3])).toBe("ready"); // ⚠️ → ✅, with no round trip

    // --- Approve it immediately, on its own. ------------------------------
    rows = await runPlan(rows, [3]);
    expect(rows[3].outcome).toBe("approved");

    // The correction was recorded — an edit made here feeds the same ledger an
    // edit made on the review screen does. This is the reason an edited document
    // takes the review route rather than being re-read by the bulk gate.
    const corrections = ((await (await correctionsRoute()).json()) as any).corrections;
    expect(corrections.length).toBe(correctionsBefore + 1);
    expect(corrections[0]).toMatchObject({
      field: "supplierName",
      aiValue: flaggedMerchant,
      humanValue: corrected,
    });

    // --- Bulk approve the three clean ones. -------------------------------
    rows = await runPlan(rows, [0, 1, 2]);
    expect(rows.slice(0, 3).map((r) => r.outcome)).toEqual(["approved", "approved", "approved"]);

    // --- The ending the human reads. --------------------------------------
    expect(tallyLabel(tally(rows))).toBe("4 approved, 1 failed");
    expect(tally(rows)).toMatchObject({ total: 5, approved: 4, failed: 1, flagged: 0, ready: 0 });

    // Four bills actually reached the platform — including the one that was
    // flagged, carrying the human's corrected merchant, not the smudged read.
    expect(xero.calls).toHaveLength(4);
    expect(xero.calls.map((c) => c.supplierName)).toContain(corrected);
    expect(xero.calls.map((c) => c.supplierName)).not.toContain(flaggedMerchant);
  });

  it("leaves nothing behind in the queue — approving here clears the queue entry", async () => {
    const { filenames, flaggedMerchant } = batchFor("queue");
    let rows = await uploadAndBuildRows(filenames);
    const queuedIds = rows.filter((r) => r.documentId).map((r) => r.documentId);
    expect(queuedIds).toHaveLength(4); // the failed file was never queued

    rows[3] = { ...rows[3], edited: { supplierName: `${flaggedMerchant} Ltd` } };
    rows = await runPlan(rows, [0, 1, 2, 3]);
    expect(rows.slice(0, 4).every((r) => r.outcome === "approved")).toBe(true);

    // A document approved on the results screen must not still be sitting in
    // /pending waiting to be approved a second time — whichever route it took.
    const stillPending = ((await (await pendingRoute()).json()) as any).documents.map(
      (d: any) => d.id,
    );
    for (const id of queuedIds) expect(stillPending).not.toContain(id);
  });

  it("won't approve the flagged document until it's actually been dealt with", async () => {
    const { filenames } = batchFor("sweep");
    const rows = await uploadAndBuildRows(filenames);

    // Selecting everything and hitting Bulk Approve must not sweep the flagged
    // document through on the strength of the clean ones next to it.
    const plan = planApproval(rows, [0, 1, 2, 3, 4]);

    expect(plan.queued.map((q) => q.index)).toEqual([0, 1, 2]);
    expect(plan.direct).toHaveLength(0);
    expect(plan.skipped.map((s) => s.index)).toEqual([3, 4]);
    expect(plan.skipped[0].reason).toContain("Merchant");
  });
});
