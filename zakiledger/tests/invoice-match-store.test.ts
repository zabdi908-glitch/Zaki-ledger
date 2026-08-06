import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabase", () => ({
  getSupabase: () => null,
  isSupabaseConfigured: () => false,
}));

import { listInvoiceMatches, saveInvoiceMatch, __clearInvoiceMatchMemForTests } from "../lib/invoice-match-store";

beforeEach(() => __clearInvoiceMatchMemForTests());

describe("invoice match store", () => {
  it("saves and lists scoped by user and bank transaction ids", async () => {
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    await saveInvoiceMatch("u2", { bankTransactionId: "b1", invoiceId: "i9", confidencePct: 90, matchedBy: "amount_date" });
    const mine = await listInvoiceMatches("u1", ["b1", "b2"]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ invoiceId: "i1", status: "matched" });
  });
  it("re-matching the same bank transaction replaces the earlier match", async () => {
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    await saveInvoiceMatch("u1", { bankTransactionId: "b1", invoiceId: "i2", confidencePct: 85, matchedBy: "amount_date" });
    const mine = await listInvoiceMatches("u1", ["b1"]);
    expect(mine).toHaveLength(1);
    expect(mine[0].invoiceId).toBe("i2");
  });
});
