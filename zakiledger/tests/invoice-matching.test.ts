import { describe, expect, it } from "vitest";
import { extractInvoiceRefs, matchInvoices } from "../lib/invoice-matching";
import type { BankTransaction } from "../lib/reconciliation-schema";
import type { StoredInvoiceSummary } from "../lib/store";

function bank(over: Partial<BankTransaction>): BankTransaction {
  return {
    id: "b1", statementId: "s1", transactionDate: "2026-07-15", postedDate: null,
    merchant: null, description: null, amount: -1800, currency: "GBP",
    transactionId: null, memo: null, ...over,
  };
}
function invoice(over: Partial<StoredInvoiceSummary>): StoredInvoiceSummary {
  return {
    id: "i1", documentType: "invoice", supplierName: "Acme Ltd", invoiceNumber: "INV-2044",
    invoiceDate: "2026-07-14", total: 1800, status: "approved", createdAt: "2026-07-14T00:00:00Z", ...over,
  };
}

describe("extractInvoiceRefs", () => {
  it("finds INV-style and hash refs, normalised to upper case", () => {
    expect(extractInvoiceRefs("CLIENT PAYMENT inv-2044 £1,800")).toContain("INV-2044");
    expect(extractInvoiceRefs("PAYMENT #7731 THANKS")).toContain("7731");
  });
  it("returns [] when nothing looks like a reference", () => {
    expect(extractInvoiceRefs("TESCO STORES 2044 LEEDS")).toEqual([]); // bare numbers without INV/# are not refs
  });
});

describe("matchInvoices", () => {
  it("matches by reference + amount at 99%", () => {
    const [m] = matchInvoices([bank({ description: "CLIENT PAYMENT INV-2044" })], [invoice({})]);
    expect(m).toMatchObject({ invoiceId: "i1", confidencePct: 99, matchedBy: "reference" });
    expect(m.reason).toMatch(/reference/i);
  });
  it("falls back to amount + date window + supplier overlap", () => {
    const [m] = matchInvoices(
      [bank({ description: "ACME LTD PAYMENT", transactionDate: "2026-07-16" })],
      [invoice({})],
    );
    expect(m).toMatchObject({ invoiceId: "i1", matchedBy: "amount_date" });
    expect(m.confidencePct).toBeGreaterThanOrEqual(80);
    expect(m.confidencePct).toBeLessThan(99);
  });
  it("does not match outside the ±3 day window without a reference", () => {
    expect(matchInvoices(
      [bank({ description: "ACME LTD PAYMENT", transactionDate: "2026-07-25" })],
      [invoice({})],
    )).toEqual([]);
  });
  it("amount must agree in magnitude for both directions of signage", () => {
    // bank amount is signed (negative = money in per review page convention);
    // invoice totals are positive — compare absolute values.
    expect(matchInvoices([bank({ description: "INV-2044", amount: 1800 })], [invoice({})])).toHaveLength(1);
  });
  it("claims each invoice at most once, even with multiple candidate bank lines", () => {
    const results = matchInvoices(
      [
        bank({ id: "b1", description: "CLIENT PAYMENT INV-2044" }),
        bank({ id: "b2", description: "CLIENT PAYMENT INV-2044", transactionDate: "2026-07-16" }),
      ],
      [invoice({})],
    );
    expect(results).toHaveLength(1);
  });
});
