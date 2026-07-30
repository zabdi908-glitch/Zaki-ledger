import { describe, expect, it } from "vitest";
import {
  buildQueueRow,
  detectQueueDuplicates,
  plainEnglishGateReason,
  sectionForGate,
  type QueueItem,
} from "@/lib/extraction-insights";
import { gateApproval } from "@/lib/validation";

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "d1",
    documentType: "invoice",
    merchantName: "Office Depot",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-06-14",
    currency: "GBP",
    total: 142.9,
    overallConfidence: 0.98,
    ...overrides,
  };
}

const READY_FIELDS = { supplierName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.99, currency: 0.99, subtotal: 0.99, tax: 0.99, total: 0.99 };

describe("plainEnglishGateReason", () => {
  it("has a plain-English sentence for a ready gate", () => {
    const gate = gateApproval(READY_FIELDS);
    expect(plainEnglishGateReason(gate, "invoice").length).toBeGreaterThan(0);
  });
  it("names the low-confidence field for a blocked gate", () => {
    const gate = gateApproval({ ...READY_FIELDS, supplierName: 0.4 });
    const text = plainEnglishGateReason(gate, "invoice");
    expect(text.toLowerCase()).toContain("supplier");
  });
});

describe("sectionForGate", () => {
  it("puts a duplicate in the duplicate section regardless of gate status", () => {
    const gate = gateApproval(READY_FIELDS);
    expect(sectionForGate(gate, true)).toBe("duplicate");
  });
  it("maps ready/review/blocked to ready/review/issue", () => {
    const ready = gateApproval(READY_FIELDS);
    const review = gateApproval({ ...READY_FIELDS, currency: 0.5 });
    const blocked = gateApproval({ ...READY_FIELDS, supplierName: 0.3 });
    expect(sectionForGate(ready, false)).toBe("ready");
    expect(sectionForGate(review, false)).toBe("review");
    expect(sectionForGate(blocked, false)).toBe("issue");
  });
});

describe("detectQueueDuplicates", () => {
  it("pairs two invoices with the same supplier, invoice number, and total", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const dupes = detectQueueDuplicates([a, b]);
    expect(dupes.get("a")?.id).toBe("b");
    expect(dupes.get("b")?.id).toBe("a");
  });
  it("does not pair items with different totals", () => {
    const a = item({ id: "a", total: 100 });
    const b = item({ id: "b", total: 200 });
    expect(detectQueueDuplicates([a, b]).size).toBe(0);
  });
  it("pairs two receipts (no invoice number) on the same supplier, date, and total", () => {
    const a = item({ id: "a", documentType: "receipt", invoiceNumber: "" });
    const b = item({ id: "b", documentType: "receipt", invoiceNumber: "" });
    const dupes = detectQueueDuplicates([a, b]);
    expect(dupes.get("a")?.id).toBe("b");
  });
});

describe("buildQueueRow", () => {
  it("produces a ready row for a high-confidence invoice", () => {
    const { row, gate } = buildQueueRow(item(), false);
    expect(gate.status).toBe("ready");
    expect(row.section).toBe("ready");
    expect(row.amountLabel).toContain("142.90");
  });
  it("produces a duplicate row when flagged as a duplicate regardless of confidence", () => {
    const { row } = buildQueueRow(item(), true);
    expect(row.section).toBe("duplicate");
  });
});
