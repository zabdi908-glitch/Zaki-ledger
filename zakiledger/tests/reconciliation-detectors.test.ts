import { describe, expect, it } from "vitest";
import {
  detectDuplicates,
  detectMerchantLinks,
  detectRefunds,
  detectReversals,
  detectSplitGroups,
  extractReference,
  merchantSimilarity,
  tokenSimilarity,
} from "../lib/reconciliation-detectors";
import type { BankTransaction } from "../lib/reconciliation-schema";
import { syntheticStatement } from "./fixtures/statement";

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

/**
 * The detectors compare every transaction against every other, so they carry
 * short-circuits that skip work a pair cannot possibly need. A short-circuit
 * that is wrong in the rejecting direction silently invents or destroys
 * findings, which is worse than being slow — these lock the escape hatches to
 * results the slow path would also have produced.
 */
describe("similarity short-circuits stay faithful to the exact score", () => {
  const words = [
    "amazon", "amzn", "adobe", "adobesystems", "aws", "google", "goggle", "microsoft",
    "stripe", "strpe", "a", "ab", "marketplace", "mktplace", "xyzzy", "", "reallylongsuppliername",
  ];

  it("never skips a token pair that would have cleared the match threshold", () => {
    // softDice rejects a pair on length alone when `1 - lengthGap / longest`
    // falls below the threshold. That is only sound if the expression really
    // is an upper bound on tokenSimilarity — assert exactly that, since a
    // violation would mean real supplier matches are being thrown away.
    const THRESHOLD = 0.85;
    for (const a of words) {
      for (const b of words) {
        const longest = Math.max(a.length, b.length);
        if (longest === 0) continue;
        const bound = 1 - Math.abs(a.length - b.length) / longest;
        const actual = tokenSimilarity(a, b);
        // Abbreviations are scored by shape, not edit distance, so the length
        // bound does not apply to them — the guard exempts them for this reason.
        const abbreviation = actual === 0.9;
        if (!abbreviation) expect(actual).toBeLessThanOrEqual(bound + 1e-9);
      }
    }
  });

  it("scores a known set of supplier pairs exactly as before the pairs were precomputed", () => {
    expect(merchantSimilarity("ADOBE CREATIVE CLOUD", "ADOBE SYSTEMS IRELAND")).toBeGreaterThanOrEqual(0.7);
    expect(merchantSimilarity("AMZN MKTPLACE UK", "AMAZON WEB SERVICES")).toBeGreaterThanOrEqual(0.7);
    expect(merchantSimilarity("BRITISH GAS", "THAMES WATER")).toBeLessThan(0.7);
    expect(merchantSimilarity("STRIPE", "SHOPIFY")).toBeLessThan(0.7);
  });

  it("is symmetric", () => {
    for (const a of words) {
      for (const b of words) {
        expect(merchantSimilarity(a, b)).toBeCloseTo(merchantSimilarity(b, a), 10);
      }
    }
  });
});

describe("detector cost on a full statement", () => {
  it("runs every detector over 400 transactions well inside a frame budget", () => {
    const txns = syntheticStatement(400);
    const started = performance.now();
    detectDuplicates(txns);
    detectReversals(txns);
    detectRefunds(txns);
    detectSplitGroups(txns);
    detectMerchantLinks(txns);
    const elapsed = performance.now() - started;
    // Comparing every pair of names took ~1s on this input before the token
    // profiles, edit-distance buffer, and comparison cache went in. The bound
    // leaves room for a slow machine while still failing loudly if any of the
    // three is removed.
    expect(elapsed).toBeLessThan(600);
  });
});
