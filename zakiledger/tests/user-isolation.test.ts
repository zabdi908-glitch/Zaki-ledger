import { beforeAll, describe, expect, it } from "vitest";
import { sampleReceiptExtraction } from "@/lib/demo";

/**
 * The property multi-user auth exists to guarantee: one user's queue,
 * invoices, corrections, and OAuth connections are invisible to another user.
 *
 * Exercised against the in-memory fallback (no SUPABASE_URL in the test env,
 * same as every other route-level test in this suite) — this is the storage
 * path a local dev run and the free-tier demo actually use, and it shares the
 * same `userId` filtering logic the Postgres path applies via `.eq("user_id",
 * userId)`, so a bug in the filter would show up here just as it would there.
 */

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const {
  savePendingDocument,
  listPendingDocuments,
  getPendingDocument,
  saveApprovedInvoice,
  findDuplicateReceipt,
  recordCorrection,
  recentCorrections,
} = await import("@/lib/store");
const { saveConnection, getConnection, deleteConnection } = await import("@/lib/oauth-store");

const ALICE = "alice";
const BOB = "bob";

describe("the pending queue", () => {
  it("keeps each user's queue invisible to the other", async () => {
    const aliceId = await savePendingDocument(ALICE, {
      extraction: sampleReceiptExtraction(),
      filename: "alice-receipt.png",
    });
    const bobId = await savePendingDocument(BOB, {
      extraction: sampleReceiptExtraction(),
      filename: "bob-receipt.png",
    });

    const aliceQueue = await listPendingDocuments(ALICE);
    const bobQueue = await listPendingDocuments(BOB);

    expect(aliceQueue.map((d) => d.id)).toContain(aliceId);
    expect(aliceQueue.map((d) => d.id)).not.toContain(bobId);
    expect(bobQueue.map((d) => d.id)).toContain(bobId);
    expect(bobQueue.map((d) => d.id)).not.toContain(aliceId);
  });

  it("looks like an unknown id, not a permission error, when fetched by the wrong user", async () => {
    const aliceId = await savePendingDocument(ALICE, {
      extraction: sampleReceiptExtraction(),
      filename: "alice-only.png",
    });

    expect(await getPendingDocument(ALICE, aliceId)).not.toBeNull();
    expect(await getPendingDocument(BOB, aliceId)).toBeNull();
  });
});

describe("approved invoices and duplicate detection", () => {
  it("doesn't let one user's approved receipt flag as a duplicate for another user", async () => {
    const receipt = sampleReceiptExtraction();
    await saveApprovedInvoice(ALICE, {
      documentType: "receipt",
      supplierName: receipt.supplierName.value,
      invoiceNumber: receipt.invoiceNumber.value,
      invoiceDate: receipt.invoiceDate.value,
      currency: receipt.currency.value,
      subtotal: receipt.subtotal.value,
      tax: receipt.tax.value,
      total: receipt.total.value,
      overallConfidence: receipt.overallConfidence,
    });

    // Alice sees her own receipt as a duplicate if she uploads it again...
    const aliceMatch = await findDuplicateReceipt(
      ALICE,
      receipt.supplierName.value,
      receipt.invoiceDate.value,
      receipt.total.value,
    );
    expect(aliceMatch).not.toBeNull();

    // ...but Bob uploading the exact same values sees a clean slate — this is
    // two different bookkeepers who each happen to have a client by this name,
    // not the same document twice.
    const bobMatch = await findDuplicateReceipt(
      BOB,
      receipt.supplierName.value,
      receipt.invoiceDate.value,
      receipt.total.value,
    );
    expect(bobMatch).toBeNull();
  });
});

describe("the correction ledger", () => {
  it("keeps each user's corrections out of the other's audit trail", async () => {
    await recordCorrection(ALICE, {
      supplierName: "Acme Ltd",
      field: "invoiceDate",
      aiValue: "2026-01-01",
      humanValue: "2026-01-02",
      aiConfidence: 0.5,
    });
    await recordCorrection(BOB, {
      supplierName: "Acme Ltd",
      field: "invoiceDate",
      aiValue: "2026-02-01",
      humanValue: "2026-02-02",
      aiConfidence: 0.5,
    });

    const aliceCorrections = await recentCorrections(ALICE, 50);
    const bobCorrections = await recentCorrections(BOB, 50);

    expect(aliceCorrections.some((c) => c.humanValue === "2026-01-02")).toBe(true);
    expect(aliceCorrections.some((c) => c.humanValue === "2026-02-02")).toBe(false);
    expect(bobCorrections.some((c) => c.humanValue === "2026-02-02")).toBe(true);
    expect(bobCorrections.some((c) => c.humanValue === "2026-01-02")).toBe(false);
  });
});

describe("accounting-platform connections", () => {
  it("lets both users connect the same provider without colliding", async () => {
    await saveConnection(ALICE, "xero", {
      accessToken: "alice-token",
      refreshToken: "alice-refresh",
      expiresIn: 1800,
    });
    await saveConnection(BOB, "xero", {
      accessToken: "bob-token",
      refreshToken: "bob-refresh",
      expiresIn: 1800,
    });

    expect((await getConnection(ALICE, "xero"))?.accessToken).toBe("alice-token");
    expect((await getConnection(BOB, "xero"))?.accessToken).toBe("bob-token");
  });

  it("disconnecting one user's connection leaves the other's untouched", async () => {
    await deleteConnection(ALICE, "xero");

    expect(await getConnection(ALICE, "xero")).toBeNull();
    expect((await getConnection(BOB, "xero"))?.accessToken).toBe("bob-token");
  });
});
