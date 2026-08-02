import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropicMock = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: anthropicMock.parse };
  },
}));

const { classifyMerchant } = await import("@/lib/merchant-ai");

beforeEach(() => {
  anthropicMock.parse.mockReset();
});

describe("classifyMerchant", () => {
  it("returns the parsed classification on a clean response", async () => {
    anthropicMock.parse.mockResolvedValueOnce({
      parsed_output: {
        category: "Software & SaaS",
        confidencePct: 88,
        reason: "Recurring SaaS-style billing name.",
      },
    });
    const result = await classifyMerchant("ACME CLOUD TOOLS LTD");
    expect(result).toEqual({
      category: "Software & SaaS",
      confidencePct: 88,
      reason: "Recurring SaaS-style billing name.",
    });
  });

  it("returns null, not a throw, when the API call fails", async () => {
    anthropicMock.parse.mockRejectedValueOnce(new Error("rate limited"));
    await expect(classifyMerchant("ACME CLOUD TOOLS LTD")).resolves.toBeNull();
  });

  it("returns null when the model gives no parsed output", async () => {
    anthropicMock.parse.mockResolvedValueOnce({ parsed_output: undefined });
    await expect(classifyMerchant("ACME CLOUD TOOLS LTD")).resolves.toBeNull();
  });
});
