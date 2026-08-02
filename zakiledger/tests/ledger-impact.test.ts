import { describe, expect, it } from "vitest";
import { ledgerImpact } from "../lib/ledger-impact";

describe("ledgerImpact", () => {
  it("invoice payment reduces debtors and marks the invoice paid", () => {
    expect(ledgerImpact({ amount: -1800, currency: "GBP", category: "Uncategorised", invoiceNumber: "INV-2044", supplierName: "Acme Ltd" }))
      .toEqual(["Mark invoice INV-2044 as paid.", "Reduce Debtors (A/R): £1800.00"]);
  });
  it("VAT payment reduces the VAT liability", () => {
    expect(ledgerImpact({ amount: 1240, currency: "GBP", category: "VAT Control Account" }))
      .toEqual(["Reduce VAT liability: £1240.00"]);
  });
  it("PAYE/NI payment reduces that liability", () => {
    expect(ledgerImpact({ amount: 980, currency: "GBP", category: "PAYE/NI Liability" }))
      .toEqual(["Reduce PAYE/NI liability: £980.00"]);
  });
  it("a transfer has no profit-and-loss impact", () => {
    expect(ledgerImpact({ amount: 500, currency: "GBP", category: "Transfer" }))
      .toEqual(["Money moved between your own accounts — no profit-and-loss impact."]);
  });
  it("plain expense increases its category", () => {
    expect(ledgerImpact({ amount: 450, currency: "GBP", category: "Software & SaaS" }))
      .toEqual(["Increase Software & SaaS: £450.00"]);
  });
  it("refund reverses the earlier charge", () => {
    expect(ledgerImpact({ amount: -300, currency: "GBP", category: "Merchandise", detectionKind: "refund" }))
      .toEqual(["Reverse earlier charge: £300.00 back to Merchandise"]);
  });
  it("reversal nets to nil", () => {
    expect(ledgerImpact({ amount: 500, currency: "GBP", category: "Uncategorised", detectionKind: "reversal" }))
      .toEqual(["No net ledger impact — the pair cancels out."]);
  });
  it("uncategorised with no other signal asks for a category first", () => {
    expect(ledgerImpact({ amount: 120, currency: "GBP", category: "Uncategorised" }))
      .toEqual(["Set a category to see the ledger impact."]);
  });
});
