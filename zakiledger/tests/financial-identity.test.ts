import { describe, expect, it } from "vitest";
import {
  amountToMinorUnits,
  bankTransactionFingerprint,
  deriveOfxAccountIdentity,
  normalizeIdentityText,
} from "../lib/financial-identity";

describe("versioned financial fingerprints", () => {
  it("normalises case/whitespace and hashes deterministic minor-unit amounts", () => {
    const base = {
      sourceProvider: "csv",
      sourceOrganisationId: null,
      sourceAccountId: "account-1",
      transactionDate: "2026-08-01",
      postedDate: null,
      amount: 20,
      currency: "gbp",
      merchant: "  TESCO\n STORE ",
      description: "CARD  1234",
      reference: null,
    };
    expect(bankTransactionFingerprint(base)).toBe(
      bankTransactionFingerprint({ ...base, currency: "GBP", merchant: "tesco store" }),
    );
    expect(amountToMinorUnits(12.34, "GBP")).toBe(1234);
    expect(amountToMinorUnits(12, "JPY")).toBe(12);
    expect(amountToMinorUnits(12.345, "KWD")).toBe(12345);
  });

  it("does not aggressively remove transaction discriminators", () => {
    expect(normalizeIdentityText("Store #1234")).toBe("store #1234");
    expect(
      bankTransactionFingerprint({
        sourceProvider: "csv",
        sourceOrganisationId: null,
        sourceAccountId: "account-1",
        transactionDate: "2026-08-01",
        postedDate: null,
        amount: 20,
        currency: "GBP",
        merchant: "Tesco",
        description: "CARD 1234",
        reference: null,
      }),
    ).not.toBe(
      bankTransactionFingerprint({
        sourceProvider: "csv",
        sourceOrganisationId: null,
        sourceAccountId: "account-1",
        transactionDate: "2026-08-01",
        postedDate: null,
        amount: 20,
        currency: "GBP",
        merchant: "Tesco",
        description: "CARD 5678",
        reference: null,
      }),
    );
  });

  it("derives an opaque OFX account key without returning the full account number", () => {
    const identity = deriveOfxAccountIdentity({ bankId: "123456", accountId: "00012345", accountType: "CHECKING" });
    expect(identity?.sourceAccountId).toMatch(/^[a-f0-9]{64}$/);
    expect(identity?.metadata.accountLast4).toBe("2345");
    expect(JSON.stringify(identity)).not.toContain("00012345");
  });
});
