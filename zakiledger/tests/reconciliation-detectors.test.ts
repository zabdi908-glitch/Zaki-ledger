import { describe, expect, it } from "vitest";
import {
  detectDuplicates,
  detectMerchantLinks,
  detectRefunds,
  detectReversals,
  detectSplitGroups,
  extractReference,
  merchantSimilarity,
} from "@/lib/reconciliation-detectors";
import type { BankTransaction } from "@/lib/reconciliation-schema";

/** Sign convention: positive = money out (debit), negative = money in (credit). */
function bank(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "b1",
    statementId: "s1",
    transactionDate: "2026-06-02",
    postedDate: null,
    merchant: "AWS EMEA",
    description: null,
    amount: 412.18,
    currency: "GBP",
    transactionId: null,
    memo: null,
    ...overrides,
  };
}

describe("extractReference", () => {
  it("reads an invoice reference off a client payment line", () => {
    expect(extractReference(bank({ merchant: "CLIENT PAYMENT INV-1003" }))?.key).toBe("INV1003");
  });
  it("groups the same invoice written two different ways", () => {
    const a = extractReference(bank({ merchant: "CLIENT PAYMENT INV-1001" }));
    const b = extractReference(bank({ merchant: "Client payment inv 1001" }));
    expect(a?.key).toBe(b?.key);
  });
  it("ignores a card mask that is not a reference", () => {
    expect(extractReference(bank({ merchant: null, description: "TRANSFER TO xx4471" }))).toBeNull();
  });
  it("ignores a keyword followed by a word rather than a code", () => {
    expect(extractReference(bank({ merchant: "REF CUSTOMER" }))).toBeNull();
  });
});

describe("merchantSimilarity", () => {
  it("treats punctuation-only differences as the same supplier", () => {
    expect(merchantSimilarity("MICROSOFT 365", "MICROSOFT*365")).toBeGreaterThanOrEqual(0.95);
  });
  it("links two trading names of one supplier", () => {
    expect(merchantSimilarity("ADOBE CREATIVE CLOUD", "ADOBE SYSTEMS IRELAND")).toBeGreaterThanOrEqual(0.7);
  });
  it("resolves an abbreviated merchant against its full name", () => {
    expect(merchantSimilarity("AMZN MKTPLACE UK", "AMAZON WEB SERVICES")).toBeGreaterThanOrEqual(0.7);
  });
  it("keeps unrelated merchants well apart", () => {
    expect(merchantSimilarity("SAINSBURYS LOCAL", "TESCO EXPRESS")).toBeLessThan(0.5);
  });
  it("scores an empty name as no resemblance", () => {
    expect(merchantSimilarity(null, "ADOBE")).toBe(0);
  });
});

describe("detectReversals", () => {
  it("pairs equal and opposite transactions sharing an invoice reference", () => {
    const a = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1003", amount: -1750, transactionDate: "2026-06-02" });
    const b = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1003", amount: 1750, transactionDate: "2026-06-05" });
    const pairs = detectReversals([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reference?.key).toBe("INV1003");
    expect(pairs[0].confidencePct).toBe(95);
  });
  it("scores a same-merchant reversal lower than a referenced one", () => {
    const a = bank({ id: "b1", merchant: "ACME LTD", amount: -500 });
    const b = bank({ id: "b2", merchant: "ACME LTD", amount: 500 });
    expect(detectReversals([a, b])[0].confidencePct).toBe(88);
  });
  it("leaves transfers alone — they have their own section", () => {
    const a = bank({ id: "b1", merchant: null, description: "TRANSFER TO xx4471", amount: 900 });
    const b = bank({ id: "b2", merchant: null, description: "TRANSFER TO xx4471", amount: -900 });
    expect(detectReversals([a, b])).toHaveLength(0);
  });
  it("does not pair opposite amounts from unrelated suppliers", () => {
    const a = bank({ id: "b1", merchant: "ACME LTD", amount: -500 });
    const b = bank({ id: "b2", merchant: "TESCO EXPRESS", amount: 500 });
    expect(detectReversals([a, b])).toHaveLength(0);
  });
  it("does not pair transactions months apart", () => {
    const a = bank({ id: "b1", merchant: "ACME LTD", amount: -500, transactionDate: "2026-01-02" });
    const b = bank({ id: "b2", merchant: "ACME LTD", amount: 500, transactionDate: "2026-06-02" });
    expect(detectReversals([a, b])).toHaveLength(0);
  });
});

describe("detectRefunds", () => {
  it("pairs a charge with a later refund from a related merchant", () => {
    const charge = bank({ id: "b1", merchant: "AMZN MKTPLACE UK", amount: 123.45, transactionDate: "2026-06-02" });
    const refund = bank({ id: "b2", merchant: "REFUND AMAZON", amount: -123.45, transactionDate: "2026-06-09" });
    const pairs = detectRefunds([charge, refund]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].charge.id).toBe("b1");
    expect(pairs[0].refund.id).toBe("b2");
  });
  it("does not treat a credit before the charge as its refund", () => {
    const charge = bank({ id: "b1", merchant: "AMAZON", amount: 50, transactionDate: "2026-06-20" });
    const refund = bank({ id: "b2", merchant: "REFUND AMAZON", amount: -50, transactionDate: "2026-06-02" });
    expect(detectRefunds([charge, refund])).toHaveLength(0);
  });
  it("does not pair a refund with a different amount", () => {
    const charge = bank({ id: "b1", merchant: "AMAZON", amount: 50, transactionDate: "2026-06-02" });
    const refund = bank({ id: "b2", merchant: "REFUND AMAZON", amount: -49, transactionDate: "2026-06-09" });
    expect(detectRefunds([charge, refund])).toHaveLength(0);
  });
  it("skips transactions already explained by a reversal", () => {
    const charge = bank({ id: "b1", merchant: "AMAZON", amount: 50, transactionDate: "2026-06-02" });
    const refund = bank({ id: "b2", merchant: "REFUND AMAZON", amount: -50, transactionDate: "2026-06-09" });
    expect(detectRefunds([charge, refund], new Set(["b1"]))).toHaveLength(0);
  });
});

describe("detectSplitGroups", () => {
  it("groups two payments quoting one invoice reference", () => {
    const a = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1001", amount: -1000 });
    const b = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1001", amount: -500 });
    const groups = detectSplitGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(-1500);
    expect(groups[0].direction).toBe("in");
  });
  it("labels a bill paid in parts as money out", () => {
    const a = bank({ id: "b1", merchant: "SUPPLIER INV-1004", amount: 3000 });
    const b = bank({ id: "b2", merchant: "SUPPLIER INV-1004", amount: 1000 });
    const groups = detectSplitGroups([a, b]);
    expect(groups[0].direction).toBe("out");
    expect(groups[0].total).toBe(4000);
  });
  it("does not group a single referenced transaction", () => {
    expect(detectSplitGroups([bank({ merchant: "CLIENT PAYMENT INV-1001", amount: -1000 })])).toHaveLength(0);
  });
  it("does not group a reference whose transactions point opposite ways", () => {
    const a = bank({ id: "b1", merchant: "CLIENT PAYMENT INV-1003", amount: -1750 });
    const b = bank({ id: "b2", merchant: "CLIENT PAYMENT INV-1003", amount: 1750 });
    expect(detectSplitGroups([a, b])).toHaveLength(0);
  });
});

describe("detectMerchantLinks", () => {
  it("links two spellings of the same supplier", () => {
    const a = bank({ id: "b1", merchant: "MICROSOFT 365" });
    const b = bank({ id: "b2", merchant: "MICROSOFT*365" });
    const links = detectMerchantLinks([a, b]);
    expect(links.get("b1")?.b.id).toBe("b2");
    expect(links.get("b1")?.confidencePct).toBeGreaterThanOrEqual(85);
  });
  it("ignores identical merchant names — those are recurring, not related", () => {
    const a = bank({ id: "b1", merchant: "AWS EMEA" });
    const b = bank({ id: "b2", merchant: "AWS EMEA" });
    expect(detectMerchantLinks([a, b]).size).toBe(0);
  });
  it("ignores unrelated merchants", () => {
    const a = bank({ id: "b1", merchant: "SAINSBURYS LOCAL" });
    const b = bank({ id: "b2", merchant: "TESCO EXPRESS" });
    expect(detectMerchantLinks([a, b]).size).toBe(0);
  });
});

describe("detectDuplicates", () => {
  it("pairs same merchant and amount within a day", () => {
    const a = bank({ id: "b1", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    const b = bank({ id: "b2", merchant: "UBER TRIP", amount: 18.4, transactionDate: "2026-06-14" });
    expect(detectDuplicates([a, b]).get("b1")?.id).toBe("b2");
  });
});
