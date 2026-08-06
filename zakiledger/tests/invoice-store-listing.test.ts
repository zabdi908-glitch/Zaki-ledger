import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => null,
  isSupabaseConfigured: () => false,
}));

import { listApprovedInvoicesForMatching, saveApprovedInvoice } from "../lib/store";

function approvedInvoice(over: Partial<Parameters<typeof saveApprovedInvoice>[1]> = {}) {
  return {
    documentType: "invoice" as const,
    supplierName: "Acme Ltd",
    invoiceNumber: "INV-2044",
    invoiceDate: "2026-07-14",
    currency: "GBP",
    subtotal: 1500,
    tax: 300,
    total: 1800,
    overallConfidence: 0.95,
    ...over,
  };
}

describe("listApprovedInvoicesForMatching", () => {
  it("returns full identity fields for the matcher, scoped to the user", async () => {
    await saveApprovedInvoice("matcher-user-1", approvedInvoice());
    await saveApprovedInvoice("matcher-user-2", approvedInvoice({ invoiceNumber: "INV-9999" }));

    const mine = await listApprovedInvoicesForMatching("matcher-user-1");
    expect(mine.some((i) => i.invoiceNumber === "INV-2044")).toBe(true);
    expect(mine.some((i) => i.invoiceNumber === "INV-9999")).toBe(false);
    const match = mine.find((i) => i.invoiceNumber === "INV-2044");
    expect(match).toMatchObject({ supplierName: "Acme Ltd", total: 1800, status: "approved" });
  });
});
