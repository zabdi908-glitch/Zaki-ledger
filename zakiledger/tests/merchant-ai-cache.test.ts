import { beforeEach, describe, expect, it } from "vitest";
import { __clearMerchantAiCacheForTests, cacheCategory, getCachedCategories } from "../lib/merchant-ai-cache";

beforeEach(() => __clearMerchantAiCacheForTests());

describe("merchant AI cache", () => {
  it("returns nothing for a merchant that hasn't been cached", async () => {
    const result = await getCachedCategories(["Totally Unknown Ltd"]);
    expect(result.size).toBe(0);
  });

  it("writes then reads back, normalising the merchant name", async () => {
    await cacheCategory("  Acme Cloud Tools LTD  ", {
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS billing name.",
    });
    const result = await getCachedCategories(["acme cloud tools ltd"]);
    expect(result.get("acme cloud tools ltd")).toEqual({
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS billing name.",
    });
  });

  it("bulk-reads a mix of cached and uncached names, returning only the cached ones", async () => {
    await cacheCategory("Known Merchant", { category: "Office Supplies", confidencePct: 70, reason: "Generic supplier name." });
    const result = await getCachedCategories(["Known Merchant", "Unknown Merchant"]);
    expect(result.size).toBe(1);
    expect(result.has("known merchant")).toBe(true);
    expect(result.has("unknown merchant")).toBe(false);
  });

  it("does not throw when the same merchant is cached twice", async () => {
    await cacheCategory("Repeat Merchant", { category: "Meals", confidencePct: 60, reason: "Cafe-style name." });
    await expect(
      cacheCategory("Repeat Merchant", { category: "Meals", confidencePct: 60, reason: "Cafe-style name." }),
    ).resolves.not.toThrow();
  });
});
