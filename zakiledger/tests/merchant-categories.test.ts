import { describe, expect, it } from "vitest";
import { suggestMerchantCategory, GL_CATEGORIES } from "../lib/merchant-categories";

describe("suggestMerchantCategory", () => {
  it("matches common UK merchants case-insensitively inside longer strings", () => {
    expect(suggestMerchantCategory("GOOGLE WORKSPACE GB-LON")).toEqual({ category: "Software & SaaS", confidencePct: 96 });
    expect(suggestMerchantCategory("SHELL PETROL 4471 LEEDS")).toEqual({ category: "Motor Expenses", confidencePct: 94 });
    expect(suggestMerchantCategory("HMRC VAT PAYMENT")).toEqual({ category: "VAT Control Account", confidencePct: 98 });
    expect(suggestMerchantCategory("WISE TRANSFER 8841")).toEqual({ category: "Transfer", confidencePct: 99 });
  });
  it("returns null for unknown merchants and null input", () => {
    expect(suggestMerchantCategory("BOB'S ARTISAN LLAMA FARM")).toBeNull();
    expect(suggestMerchantCategory(null)).toBeNull();
  });
  it("prefers the more specific rule when patterns overlap", () => {
    // AMAZON WEB SERVICES is SaaS, plain AMAZON is Office Supplies
    expect(suggestMerchantCategory("AMAZON WEB SERVICES")).toEqual({ category: "Software & SaaS", confidencePct: 96 });
    expect(suggestMerchantCategory("AMAZON BUSINESS EU")).toEqual({ category: "Office Supplies", confidencePct: 92 });
  });
  it("every rule's category appears in GL_CATEGORIES", () => {
    expect(GL_CATEGORIES).toContain("Software & SaaS");
    expect(GL_CATEGORIES).toContain("Motor Expenses");
  });
});
