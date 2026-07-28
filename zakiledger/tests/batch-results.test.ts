import { describe, expect, it } from "vitest";
import {
  effectiveConfidences,
  flagReason,
  hasHumanInput,
  isActionable,
  pendingRow,
  planApproval,
  rowStatus,
  tally,
  tallyLabel,
  type ResultRow,
} from "@/lib/batch-results";
import {
  sampleForeignCurrencyReceiptExtraction,
  sampleMessyReceiptExtraction,
  sampleReceiptExtraction,
} from "@/lib/demo";
import type { InvoiceExtraction } from "@/lib/schema";

/**
 * The results screen's decision logic: what a row is, and how it gets approved.
 *
 * Every claim the screen makes to the human is decided here — "ready to
 * approve", "still needs a look", and, most consequentially, *which endpoint* a
 * given document is allowed to go through. The last one is the reason this is a
 * module and not a handful of conditions inside JSX: routing a document the
 * human never looked at down the route that skips the server-side gate would be
 * invisible in the UI and wrong in the ledger.
 */

let nextIndex = 0;
function row(extraction: InvoiceExtraction, over: Partial<ResultRow> = {}): ResultRow {
  const i = over.index ?? nextIndex++;
  return {
    ...pendingRow(`file-${i}.png`, i),
    read: "success",
    documentId: `doc-${i}`,
    confidence: extraction.overallConfidence,
    extraction,
    ...over,
  };
}

describe("what a row is", () => {
  it("calls a clean read ready to approve", () => {
    expect(rowStatus(row(sampleReceiptExtraction()))).toBe("ready");
  });

  it("flags a low-confidence merchant, and says which field in the human's words", () => {
    const flagged = row(sampleMessyReceiptExtraction());
    expect(rowStatus(flagged)).toBe("flagged");
    // "Merchant", not "supplierName" — a bookkeeper never sees a field key, and
    // a receipt's merchant is not called a supplier.
    expect(flagReason(flagged)).toContain("Merchant");
    expect(flagReason(flagged)).toContain("61%");
  });

  it("reports a failed read as failed, with nothing to approve", () => {
    const broken: ResultRow = {
      ...pendingRow("broken.pdf", 9),
      read: "error",
      failure: "Could not extract text from image",
    };
    expect(rowStatus(broken)).toBe("failed");
    expect(isActionable(broken)).toBe(false);
  });

  it("stays 'extracting' until its line arrives", () => {
    expect(rowStatus(pendingRow("waiting.png", 0))).toBe("extracting");
  });
});

describe("fixing a flagged document in place", () => {
  it("turns amber to green the moment the field is corrected — no round trip", () => {
    const flagged = row(sampleMessyReceiptExtraction());
    expect(rowStatus(flagged)).toBe("flagged");

    const fixed: ResultRow = { ...flagged, edited: { supplierName: "The Corner Cafe Ltd" } };

    expect(rowStatus(fixed)).toBe("ready");
    expect(flagReason(fixed)).toBeNull();
    // A human-entered value is verified, which is exactly what unlocks the gate.
    expect(effectiveConfidences(fixed).supplierName).toBe(1);
  });

  it("also clears on confirm-as-is, when the timid read was right all along", () => {
    const flagged = row(sampleMessyReceiptExtraction());
    const confirmed: ResultRow = {
      ...flagged,
      edited: { supplierName: "The Corner Cafe" }, // unchanged
      affirmed: { supplierName: true },
    };

    expect(rowStatus(confirmed)).toBe("ready");
    // Confirming is not editing: nothing was corrected, so the direct-approve
    // route will record this as a confirmation and the merchant's track record
    // accumulates instead of resetting.
    expect(confirmed.edited.supplierName).toBe(flagged.extraction!.supplierName.value);
  });

  it("does not accept a blank as a fix — an empty critical field is not data", () => {
    const blanked: ResultRow = {
      ...row(sampleMessyReceiptExtraction()),
      edited: { supplierName: "   " },
    };
    expect(rowStatus(blanked)).toBe("flagged");
  });

  it("leaves an untouched row untouched", () => {
    expect(hasHumanInput(row(sampleReceiptExtraction()))).toBe(false);
  });
});

describe("planApproval — which route each document may take", () => {
  it("sends an untouched document through the server-side bulk gate, by id alone", () => {
    const clean = row(sampleReceiptExtraction(), { index: 0, documentId: "doc-clean" });
    const plan = planApproval([clean], [0]);

    expect(plan.queued).toEqual([{ index: 0, documentId: "doc-clean" }]);
    expect(plan.direct).toHaveLength(0);
  });

  it("sends an edited document through the review route, carrying the human's values", () => {
    const fixed = row(sampleMessyReceiptExtraction(), {
      index: 1,
      documentId: "doc-fixed",
      edited: { supplierName: "The Corner Cafe Ltd" },
    });
    const plan = planApproval([fixed], [1]);

    expect(plan.queued).toHaveLength(0);
    expect(plan.direct).toHaveLength(1);
    expect(plan.direct[0].documentId).toBe("doc-fixed"); // still clears the queue entry
    expect(plan.direct[0].edited.supplierName).toBe("The Corner Cafe Ltd");
    // Every reviewable field travels, not just the changed one: the approve route
    // reads an absent key as "unchanged", and it is the values on screen — not a
    // mix of screen and stored — that the human actually approved.
    expect(plan.direct[0].edited.total).toBe("12.4");
    expect(plan.direct[0].documentType).toBe("receipt");
  });

  it("refuses to approve a document that is still flagged", () => {
    const flagged = row(sampleMessyReceiptExtraction(), { index: 2 });
    const plan = planApproval([flagged], [2]);

    expect(plan.queued).toHaveLength(0);
    expect(plan.direct).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("Merchant");
  });

  it("refuses a failed read outright", () => {
    const broken: ResultRow = {
      ...pendingRow("broken.pdf", 3),
      read: "error",
      failure: "Could not extract text from image",
    };
    const plan = planApproval([broken], [3]);

    expect(plan.queued).toHaveLength(0);
    expect(plan.direct).toHaveLength(0);
    expect(plan.skipped).toEqual([{ index: 3, reason: "Could not extract text from image" }]);
  });

  it("refuses a currency we can't post in, even after the human edits something else", () => {
    // The gate has nothing to say about this document — every field reads
    // confidently. Without an explicit precondition, editing any unrelated field
    // would move it onto the route that does not check, and a JPY bill would go
    // out booked in the org's base currency at the wrong amount.
    const foreign = row(sampleForeignCurrencyReceiptExtraction(), {
      index: 4,
      edited: { supplierName: "Shinjuku Station Kiosk Ltd" },
    });
    const plan = planApproval([foreign], [4]);

    expect(plan.direct).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("Unsupported currency");
    expect(plan.skipped[0].reason).toContain("JPY");
  });

  it("routes an unqueueable document directly, since it has no id to send", () => {
    // The queue write failed. That already cost it its /pending entry; it must
    // not also cost it its approval.
    const orphan = row(sampleReceiptExtraction(), {
      index: 5,
      documentId: null,
      queueError: "relation \"pending_documents\" does not exist",
    });
    const plan = planApproval([orphan], [5]);

    expect(plan.queued).toHaveLength(0);
    expect(plan.direct).toHaveLength(1);
    expect(plan.direct[0].documentId).toBeNull();
  });

  it("never approves the same document twice in one batch", () => {
    const clean = row(sampleReceiptExtraction(), { index: 6, documentId: "doc-dupe" });
    expect(planApproval([clean], [6, 6, 6]).queued).toHaveLength(1);
  });

  it("skips a row that is already approved rather than posting a second bill", () => {
    const done = row(sampleReceiptExtraction(), { index: 7, outcome: "approved" });
    const plan = planApproval([done], [7]);

    expect(plan.queued).toHaveLength(0);
    expect(plan.direct).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("Already approved.");
  });

  it("splits a mixed selection down both routes in one plan", () => {
    const clean = row(sampleReceiptExtraction(), { index: 10, documentId: "a" });
    const fixed = row(sampleMessyReceiptExtraction(), {
      index: 11,
      documentId: "b",
      edited: { supplierName: "The Corner Cafe Ltd" },
    });
    const stillFlagged = row(sampleMessyReceiptExtraction(), { index: 12, documentId: "c" });

    const plan = planApproval([clean, fixed, stillFlagged], [10, 11, 12]);

    expect(plan.queued.map((q) => q.documentId)).toEqual(["a"]);
    expect(plan.direct.map((d) => d.documentId)).toEqual(["b"]);
    expect(plan.skipped.map((s) => s.index)).toEqual([12]);
  });
});

describe("the tally the human reads at the end", () => {
  it("counts each row once, by what it currently is", () => {
    const rows = [
      row(sampleReceiptExtraction(), { index: 20, outcome: "approved" }),
      row(sampleReceiptExtraction(), { index: 21, outcome: "approved" }),
      row(sampleReceiptExtraction(), { index: 22 }),
      row(sampleMessyReceiptExtraction(), { index: 23 }),
      { ...pendingRow("broken.pdf", 24), read: "error" as const, failure: "unreadable" },
    ];

    expect(tally(rows)).toMatchObject({
      total: 5,
      approved: 2,
      ready: 1,
      flagged: 1,
      failed: 1,
    });
  });

  it("says only what happened — the scenario's own ending", () => {
    const rows = [
      ...[30, 31, 32, 33].map((i) =>
        row(sampleReceiptExtraction(), { index: i, outcome: "approved" as const }),
      ),
      { ...pendingRow("broken.pdf", 34), read: "error" as const, failure: "unreadable" },
    ];

    expect(tallyLabel(tally(rows))).toBe("4 approved, 1 failed");
  });
});
