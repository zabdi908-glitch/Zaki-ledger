import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The isolation guarantee for batch upload: one unreadable file costs you that
 * file and nothing else.
 *
 * Demo-mode extraction never fails, so the failure has to be forced at the
 * pipeline boundary — otherwise this requirement is simply untested, which is
 * how "if one fails, don't stop the rest" quietly stops being true.
 */
const pipeline = vi.hoisted(() => ({
  /** Filenames that should blow up mid-read. */
  failFor: new Set<string>(),
}));

vi.mock("@/lib/extract-pipeline", async () => {
  const actual = await vi.importActual<typeof import("@/lib/extract-pipeline")>(
    "@/lib/extract-pipeline",
  );
  return {
    ...actual,
    extractOneDocument: async (userId: string, file: File) => {
      if (pipeline.failFor.has(file.name)) {
        throw new Error("Could not extract text from image");
      }
      return actual.extractOneDocument(userId, file);
    },
  };
});

// No real Supabase session exists in a unit test — stand in for one.
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

let batchRoute: any;
let listRoute: any;

beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  batchRoute = (await import("@/app/api/extract-batch/route")).POST;
  listRoute = (await import("@/app/api/pending/route")).GET;
});

async function uploadBatch(filenames: string[]) {
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

  return {
    results: messages.filter((m) => m.type === "result"),
    summary: messages.find((m) => m.type === "summary"),
  };
}

describe("one file fails in a batch of five", () => {
  it("reports 4 succeeded, 1 failed — the other four are untouched", async () => {
    pipeline.failFor = new Set(["receipt-5.pdf"]);

    const { results, summary } = await uploadBatch([
      "receipt-1.png",
      "receipt-2.png",
      "receipt-3.png",
      "receipt-4.png",
      "receipt-5.pdf",
    ]);

    expect(results).toHaveLength(5);
    expect(summary.succeeded).toBe(4);
    expect(summary.failed).toBe(1);

    const failed = results.find((r: any) => r.filename === "receipt-5.pdf");
    expect(failed.status).toBe("error");
    expect(failed.reason).toBe("Could not extract text from image");
    // The reason is carried per file, so the UI can say which one and why.
    expect(failed.documentId).toBeUndefined();

    for (const r of results.filter((r: any) => r.filename !== "receipt-5.pdf")) {
      expect(r.status).toBe("success");
      expect(r.documentId).toBeTruthy();
    }
  });

  it("queues the successes and not the failure", async () => {
    pipeline.failFor = new Set(["broken.png"]);

    const before = ((await (await listRoute()).json()) as any).documents;
    const { summary } = await uploadBatch(["good-1.png", "broken.png", "good-2.png"]);
    const after = ((await (await listRoute()).json()) as any).documents;

    expect(summary.succeeded).toBe(2);
    expect(summary.queued).toBe(2);
    expect(after.length - before.length).toBe(2);
    // Nothing from the failed file reached the queue.
    expect(after.some((d: any) => d.filename === "broken.png")).toBe(false);
  });

  it("survives every single file failing", async () => {
    pipeline.failFor = new Set(["a.png", "b.png"]);

    const { results, summary } = await uploadBatch(["a.png", "b.png"]);

    // Still a well-formed batch response, not a 500 — the caller gets told what
    // happened to each file rather than losing the whole request.
    expect(results).toHaveLength(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(2);
    expect(summary.queued).toBe(0);
  });
});
