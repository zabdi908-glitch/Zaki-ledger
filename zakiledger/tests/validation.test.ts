import { describe, expect, it } from "vitest";
import {
  CRITICAL_THRESHOLD,
  checkTotals,
  effectiveConfidence,
  gateApproval,
} from "@/lib/validation";
import {
  REVIEWABLE_FIELDS,
  arithmeticMismatch,
  type InvoiceExtraction,
  type ReviewableField,
} from "@/lib/schema";
import {
  sampleAmbiguousExtraction,
  sampleExtraction,
  sampleForFilename,
  sampleMessyReceiptExtraction,
  sampleReceiptExtraction,
} from "@/lib/demo";

/**
 * Effective confidence per field, exactly as the review screen computes it —
 * so these assertions exercise the same path the UI gates on.
 */
function confidencesOf(
  x: InvoiceExtraction,
  edits: Record<string, string> = {},
  affirmed: Record<string, boolean> = {},
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const original = String((x as any)[f].value);
    out[f] = effectiveConfidence((x as any)[f].confidence, original, edits[f], affirmed[f] === true);
  }
  return out;
}

/** Gate context matching a given extraction, with overrides. */
function ctxFor(x: InvoiceExtraction, over: Record<string, unknown> = {}) {
  return {
    documentType: x.documentType.value,
    taxItemized: x.taxItemized,
    documentTypeConfidence: x.documentType.confidence,
    ...over,
  };
}

describe("demo sample routing", () => {
  it("routes filenames to the matching sample", () => {
    expect(sampleForFilename("invoice.pdf").documentType.value).toBe("invoice");
    expect(sampleForFilename("receipt.png").documentType.value).toBe("receipt");
    expect(sampleForFilename("messy-till-receipt.png").invoiceNumber.value).toBe("");
    expect(sampleForFilename("ambiguous.pdf").documentType.confidence).toBeLessThan(CRITICAL_THRESHOLD);
  });
});

describe("invoice gating (Phase 1 behaviour must not drift)", () => {
  const inv = sampleExtraction();

  it("blocks on a low-confidence invoice number", () => {
    const g = gateApproval(confidencesOf(inv), ctxFor(inv));
    expect(g.status).toBe("blocked");
    expect(g.reasons.map((r) => r.field)).toEqual(["invoiceNumber"]);
  });

  it("unlocks when the number is edited", () => {
    const g = gateApproval(confidencesOf(inv, { invoiceNumber: "INV-20488" }), ctxFor(inv));
    expect(g.status).toBe("ready");
  });

  it("unlocks via confirm-as-is, without an edit", () => {
    const g = gateApproval(confidencesOf(inv, {}, { invoiceNumber: true }), ctxFor(inv));
    expect(g.status).toBe("ready");
  });

  it("does NOT unlock when a field is cleared to blank", () => {
    const g = gateApproval(confidencesOf(inv, { invoiceNumber: "" }), ctxFor(inv));
    expect(g.status).toBe("blocked");
  });

  it("defaults to invoice rules when called with no context (legacy callers)", () => {
    expect(gateApproval(confidencesOf(inv)).status).toBe("blocked");
  });

  it("runs the arithmetic check and passes", () => {
    expect(arithmeticMismatch(inv)).toBe(false);
    expect(checkTotals(240, 48, 288)?.ok).toBe(true);
    expect(checkTotals(240, 48, 999)?.ok).toBe(false);
  });

  it("returns null from checkTotals when a value is missing", () => {
    expect(checkTotals(null, 48, 288)).toBeNull();
  });
});

describe("clean receipt (number + itemised VAT)", () => {
  const r = sampleReceiptExtraction();

  it("is ready to approve", () => {
    const g = gateApproval(confidencesOf(r), ctxFor(r));
    expect(g.status).toBe("ready");
  });

  it("still runs the arithmetic check when VAT is itemised", () => {
    expect(arithmeticMismatch(r)).toBe(false);
    expect(checkTotals(r.subtotal.value, r.tax.value, r.total.value)?.ok).toBe(true);
  });
});

describe("messy receipt: no number, no itemised VAT", () => {
  const m = sampleMessyReceiptExtraction();

  it("reports the absent fields as zero-confidence, not as read values", () => {
    expect(m.invoiceNumber.value).toBe("");
    expect(m.invoiceNumber.confidence).toBe(0);
    expect(m.taxItemized).toBe(false);
  });

  it("SKIPS the arithmetic check rather than failing it", () => {
    // 0 + 0 != 12.40, but the document states no split to reconcile.
    expect(arithmeticMismatch(m)).toBe(false);
  });

  it("blocks on the smudged merchant, never on the missing number", () => {
    const g = gateApproval(confidencesOf(m), ctxFor(m));
    expect(g.status).toBe("blocked");
    expect(g.reasons.map((r) => r.field)).toEqual(["supplierName"]);
    expect(g.reasons.some((r) => r.field === "invoiceNumber")).toBe(false);
  });

  it("is ready once the merchant is fixed, despite having no number", () => {
    const g = gateApproval(confidencesOf(m, { supplierName: "The Corner Cafe Ltd" }), ctxFor(m));
    expect(g.status).toBe("ready");
  });

  it("CONTROL: the same document under invoice rules would be stuck forever", () => {
    const g = gateApproval(
      confidencesOf(m, { supplierName: "The Corner Cafe Ltd" }),
      ctxFor(m, { documentType: "invoice" }),
    );
    expect(g.status).toBe("blocked");
    expect(g.reasons.some((r) => r.field === "invoiceNumber")).toBe(true);
  });

  it("raises no tax warning when the document states no tax", () => {
    const g = gateApproval(confidencesOf(m, { supplierName: "X" }), ctxFor(m));
    expect(g.reasons.some((r) => r.field === "tax")).toBe(false);
  });

  it("CONTROL: tax at 0 WOULD warn if we wrongly claimed it was itemised", () => {
    const g = gateApproval(
      confidencesOf(m, { supplierName: "X" }),
      ctxFor(m, { taxItemized: true }),
    );
    expect(g.status).toBe("review");
    expect(g.reasons.some((r) => r.field === "tax")).toBe(true);
  });
});

describe("low-confidence document-type gate", () => {
  const a = sampleAmbiguousExtraction();

  it("blocks when the classification is below the critical threshold", () => {
    const g = gateApproval(confidencesOf(a), ctxFor(a));
    expect(g.status).toBe("blocked");
    expect(g.reasons).toEqual([{ field: "documentType", confidence: a.documentType.confidence }]);
  });

  it("blocks on the TYPE first, even though every field reads well", () => {
    // Proves the type is judged before the field tiers: no field here is low.
    const fieldGate = gateApproval(confidencesOf(a), ctxFor(a, { documentTypeConfidence: 0.99 }));
    expect(fieldGate.status).toBe("ready");
  });

  it("clears once the human confirms the type", () => {
    const g = gateApproval(confidencesOf(a), ctxFor(a, { documentTypeConfirmed: true }));
    expect(g.status).toBe("ready");
  });

  it("honours a human override to the other type", () => {
    const g = gateApproval(
      confidencesOf(a),
      ctxFor(a, { documentType: "receipt", documentTypeConfirmed: true }),
    );
    expect(g.status).toBe("ready");
  });

  it("does not gate a confident classification", () => {
    const inv = sampleExtraction();
    expect(inv.documentType.confidence).toBeGreaterThanOrEqual(CRITICAL_THRESHOLD);
    const g = gateApproval(confidencesOf(inv, { invoiceNumber: "X-1" }), ctxFor(inv));
    expect(g.status).toBe("ready");
  });

  it("treats an omitted type confidence as certain (back-compat)", () => {
    const g = gateApproval(confidencesOf(a), { documentType: "invoice", taxItemized: true });
    expect(g.status).toBe("ready");
  });

  it("uses exactly CRITICAL_THRESHOLD as the boundary", () => {
    const base = confidencesOf(a);
    const at = gateApproval(base, ctxFor(a, { documentTypeConfidence: CRITICAL_THRESHOLD }));
    const below = gateApproval(base, ctxFor(a, { documentTypeConfidence: CRITICAL_THRESHOLD - 0.001 }));
    expect(at.status).toBe("ready");
    expect(below.status).toBe("blocked");
  });
});
