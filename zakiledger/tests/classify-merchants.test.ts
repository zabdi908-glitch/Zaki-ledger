import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const merchantAi = vi.hoisted(() => ({ classify: vi.fn() }));

vi.mock("../lib/merchant-ai", () => ({
  classifyMerchant: merchantAi.classify,
}));

vi.mock("../lib/auth", () => ({
  requireUser: async () => ({ id: "test-user" }),
}));

vi.mock("../lib/supabase", () => ({
  getSupabase: () => null,
  isSupabaseConfigured: () => false,
}));

const { POST: classifyRoute } = await import("../app/api/reconciliation/classify-merchants/route");
const { __clearMerchantAiCacheForTests } = await import("../lib/merchant-ai-cache");

beforeEach(() => {
  __clearMerchantAiCacheForTests();
  merchantAi.classify.mockReset();
});

async function classify(merchantNames: unknown) {
  const req = new Request("http://test/api/reconciliation/classify-merchants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantNames }),
  });
  const res = await classifyRoute(req as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as { categories: Record<string, unknown> } };
}

describe("POST /api/reconciliation/classify-merchants", () => {
  it("classifies a new merchant and returns it", async () => {
    merchantAi.classify.mockResolvedValueOnce({ category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." });
    const { status, body } = await classify(["Acme Cloud Tools"]);
    expect(status).toBe(200);
    expect(body.categories["acme cloud tools"]).toEqual({ category: "Software & SaaS", confidencePct: 88, reason: "Recurring SaaS billing name." });
    expect(merchantAi.classify).toHaveBeenCalledTimes(1);
  });

  it("never re-classifies a merchant already cached", async () => {
    merchantAi.classify.mockResolvedValueOnce({ category: "Meals", confidencePct: 70, reason: "Cafe-style name." });
    await classify(["Repeat Cafe"]);
    merchantAi.classify.mockClear();
    const { body } = await classify(["Repeat Cafe"]);
    expect(body.categories["repeat cafe"]).toEqual({ category: "Meals", confidencePct: 70, reason: "Cafe-style name." });
    expect(merchantAi.classify).not.toHaveBeenCalled();
  });

  it("omits a merchant whose classification fails, without failing the request", async () => {
    merchantAi.classify.mockResolvedValueOnce(null);
    const { status, body } = await classify(["Unclassifiable Ltd"]);
    expect(status).toBe(200);
    expect(body.categories["unclassifiable ltd"]).toBeUndefined();
  });

  it("returns the successful one and omits the failed one in a mixed batch", async () => {
    merchantAi.classify
      .mockResolvedValueOnce({ category: "Travel", confidencePct: 91, reason: "Named taxi operator." })
      .mockResolvedValueOnce(null);
    const { body } = await classify(["Good Cabs", "Bad Merchant"]);
    expect(body.categories["good cabs"]).toBeTruthy();
    expect(body.categories["bad merchant"]).toBeUndefined();
  });

  it("returns empty categories for an empty merchant list, without calling the classifier", async () => {
    const { status, body } = await classify([]);
    expect(status).toBe(200);
    expect(body.categories).toEqual({});
    expect(merchantAi.classify).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const { status } = await classify("not-an-array");
    expect(status).toBe(400);
  });
});
