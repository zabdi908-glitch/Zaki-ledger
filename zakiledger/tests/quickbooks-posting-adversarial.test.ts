import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../lib/posting-contract";
import {
  expectedQuickBooksBillMaterial,
  normalizedQuickBooksBillMaterial,
  QuickBooksPostingAdapter,
  type QuickBooksAuthorizedBillGrant,
  type QuickBooksBillRecoveryGrant,
  type QuickBooksCreateBillRequest,
  type QuickBooksObservedBill,
  type QuickBooksPostingTransport,
} from "../lib/provider-adapters/quickbooks-posting-adapter";

function grant(): QuickBooksAuthorizedBillGrant {
  const scope = {
    practiceId: "e0010000-0000-0000-0000-000000000001",
    clientEntityId: "e0020000-0000-0000-0000-000000000001",
    ledgerBookId: "e0030000-0000-0000-0000-000000000001",
    providerConnectionId: "e0040000-0000-0000-0000-000000000001",
    externalOrganisationId: "adversarial-realm",
  };
  return {
    operation: {
      id: "e0000000-0000-0000-0000-000000000001",
      stateAtDispatch: "AUTHORIZED",
      ...scope,
      provider: "quickbooks",
      externalObjectType: "BILL",
      action: "CREATE",
      authorizedRequestFingerprint: "a".repeat(64),
    },
    attempt: {
      id: "e0050000-0000-0000-0000-000000000001",
      number: 1,
      kind: "SUBMIT",
      providerIdempotencyToken: "adversarial-token",
    },
    accountMapping: {
      id: "e0060000-0000-0000-0000-000000000001",
      providerAccountId: "expense-6100",
      providerAccountType: "Expense",
      scope,
      eligible: true,
    },
    taxMapping: {
      id: "e0070000-0000-0000-0000-000000000001",
      providerTaxCode: "T20",
      evidenceFingerprint: "b".repeat(64),
      scope,
      eligible: true,
    },
    vendorChild: {
      operationId: "e0080000-0000-0000-0000-000000000001",
      state: "SUCCEEDED",
      externalVendorId: "vendor-8",
      verifiedProviderStateFingerprint: "c".repeat(64),
    },
    requestedObject: {
      amount: "120.00",
      currency: "GBP",
      invoiceDate: "2026-08-22",
      invoiceNumber: "ADV-1",
      description: "Adversarial bill",
    },
    expectedMaterialState: { status: "OPEN" },
  };
}

function observed(overrides: Partial<QuickBooksObservedBill> = {}): QuickBooksObservedBill {
  return {
    id: "bill-1",
    realmId: "adversarial-realm",
    status: "OPEN",
    vendorId: "vendor-8",
    transactionDate: "2026-08-22",
    documentNumber: "ADV-1",
    currency: "GBP",
    amount: "120.00",
    lines: [{
      amount: "120.00",
      description: "Adversarial bill",
      providerAccountId: "expense-6100",
      providerTaxCode: "T20",
    }],
    providerVersion: "1",
    ...overrides,
  };
}

class AdversarialTransport implements QuickBooksPostingTransport {
  createCalls = 0;
  readCalls = 0;
  recoveryCalls = 0;
  createResult: { externalBillId: string; providerRequestId: string | null } = {
    externalBillId: "bill-1",
    providerRequestId: "request-1",
  };
  createError: Error | null = null;
  readResult: QuickBooksObservedBill | null = observed();
  recoveryResult: QuickBooksObservedBill[] = [];

  async createBill() {
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    return this.createResult;
  }

  async readBill() {
    this.readCalls += 1;
    return this.readResult;
  }

  async findBillsByCorrelation() {
    this.recoveryCalls += 1;
    return this.recoveryResult;
  }
}

function recoveryGrant(knownExternalBillId: string | null = null): QuickBooksBillRecoveryGrant {
  const authorized = grant();
  const { stateAtDispatch: _stateAtDispatch, ...operation } = authorized.operation;
  return {
    ...authorized,
    operation: { ...operation, stateAtRecovery: "UNCERTAIN" },
    attempt: {
      id: "e0090000-0000-0000-0000-000000000001",
      number: 2,
      kind: "RECOVERY",
      providerIdempotencyToken: "adversarial-recovery-token",
    },
    knownExternalBillId,
  };
}

describe("QuickBooks Bill adversarial safety probes", () => {
  it("rejects a forged non-AUTHORIZED dispatch grant before transport", async () => {
    const transport = new AdversarialTransport();
    const forged = grant();
    (forged.operation as unknown as { stateAtDispatch: string }).stateAtDispatch = "VALIDATED";
    const result = await new QuickBooksPostingAdapter(transport)
      .executeAuthorizedBill(forged as QuickBooksAuthorizedBillGrant);
    expect(result).toMatchObject({ kind: "FAILED_SAFE" });
    expect(transport.createCalls).toBe(0);
  });

  it("rejects cross-book account mapping scope before transport", async () => {
    const transport = new AdversarialTransport();
    const forged = grant();
    forged.accountMapping.scope.ledgerBookId = "wrong-book";
    const result = await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(forged);
    expect(result).toMatchObject({ kind: "FAILED_SAFE" });
    expect(transport.createCalls).toBe(0);
  });

  it("rejects cross-organisation tax mapping scope before transport", async () => {
    const transport = new AdversarialTransport();
    const forged = grant();
    forged.taxMapping.scope.externalOrganisationId = "wrong-realm";
    const result = await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(forged);
    expect(result).toMatchObject({ kind: "FAILED_SAFE" });
    expect(transport.createCalls).toBe(0);
  });

  it("rejects an unverified Vendor child before transport", async () => {
    const transport = new AdversarialTransport();
    const forged = grant();
    (forged.vendorChild as { state: string }).state = "UNCERTAIN";
    const result = await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(forged);
    expect(result).toMatchObject({ kind: "FAILED_SAFE" });
    expect(transport.createCalls).toBe(0);
  });

  it("treats malformed create acknowledgement as UNCERTAIN", async () => {
    const transport = new AdversarialTransport();
    transport.createResult = { externalBillId: "", providerRequestId: null };
    const result = await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(grant());
    expect(result).toMatchObject({
      kind: "UNCERTAIN",
      failure: { code: "MALFORMED_CREATE_ACKNOWLEDGEMENT" },
    });
  });

  it("treats unknown transport exceptions as UNCERTAIN and redacts tokens", async () => {
    const transport = new AdversarialTransport();
    transport.createError = new Error("Bearer abc.def access_token=top-secret");
    const result = await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(grant());
    expect(result).toMatchObject({ kind: "UNCERTAIN" });
    expect(result.kind === "UNCERTAIN" ? result.failure.summary : "")
      .not.toMatch(/abc\.def|top-secret/);
  });

  it("uses only read-back by known ID during UNCERTAIN recovery", async () => {
    const transport = new AdversarialTransport();
    const result = await new QuickBooksPostingAdapter(transport)
      .recover(recoveryGrant("bill-1"));
    expect(result).toMatchObject({ kind: "OBSERVED" });
    expect(transport.createCalls).toBe(0);
    expect(transport.readCalls).toBe(1);
    expect(transport.recoveryCalls).toBe(0);
  });

  it("keeps zero correlated recovery candidates inconclusive", async () => {
    const transport = new AdversarialTransport();
    const result = await new QuickBooksPostingAdapter(transport).recover(recoveryGrant());
    expect(result).toEqual({ kind: "INCONCLUSIVE", reasonCode: "BILL_ABSENCE_NOT_CONCLUSIVE" });
    expect(transport.createCalls).toBe(0);
  });

  it("keeps multiple correlated recovery candidates inconclusive", async () => {
    const transport = new AdversarialTransport();
    transport.recoveryResult = [observed({ id: "bill-1" }), observed({ id: "bill-2" })];
    const result = await new QuickBooksPostingAdapter(transport).recover(recoveryGrant());
    expect(result).toEqual({ kind: "INCONCLUSIVE", reasonCode: "MULTIPLE_CORRELATED_BILLS" });
    expect(transport.createCalls).toBe(0);
  });

  it("constructs explicit AccountRef and TaxCodeRef with no account discovery", async () => {
    let captured: Parameters<QuickBooksPostingTransport["createBill"]>[0] | null = null;
    const transport: QuickBooksPostingTransport = {
      createBill: async (request) => {
        captured = request;
        return { externalBillId: "bill-1", providerRequestId: null };
      },
      readBill: async () => observed(),
      findBillsByCorrelation: async () => [],
    };
    await new QuickBooksPostingAdapter(transport).executeAuthorizedBill(grant());
    expect((captured as QuickBooksCreateBillRequest | null)?.payload.Line[0]
      .AccountBasedExpenseLineDetail).toEqual({
      AccountRef: { value: "expense-6100" },
      TaxCodeRef: { value: "T20" },
    });
  });

  it.each([
    ["realm", observed({ realmId: "wrong-realm" })],
    ["status", observed({ status: "PAID" })],
    ["vendor", observed({ vendorId: "wrong-vendor" })],
    ["date", observed({ transactionDate: "2026-08-21" })],
    ["document number", observed({ documentNumber: "WRONG" })],
    ["currency", observed({ currency: "USD" })],
    ["amount", observed({ amount: "119.99" })],
    ["account", observed({ lines: [{ ...observed().lines[0], providerAccountId: "wrong" }] })],
    ["tax", observed({ lines: [{ ...observed().lines[0], providerTaxCode: "wrong" }] })],
  ])("detects %s material read-back mismatch", (_label, providerBill) => {
    const expected = expectedQuickBooksBillMaterial(grant());
    const normalized = normalizedQuickBooksBillMaterial(providerBill);
    const realmMatches = providerBill.realmId === grant().operation.externalOrganisationId;
    expect(realmMatches && canonicalJson(expected) === canonicalJson(normalized)).toBe(false);
  });

  it("confirms the adapter boundary contains no live transport or first-account query", () => {
    const source = readFileSync(
      join(process.cwd(), "lib", "provider-adapters", "quickbooks-posting-adapter.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/fetch\(|quickbooks\.api\.intuit\.com/i);
    expect(source).not.toMatch(/first expense|maxresults\s+1/i);
  });

  it("requires dispatch-time source evidence freshness revalidation", () => {
    const migration = readFileSync(
      join(process.cwd(), "..", "supabase", "migrations", "017_day4_dispatch_evidence_and_vendor_identity.sql"),
      "utf8",
    );
    expect(migration).toMatch(/posting_dispatch_evidence_status_v1/);
    expect(migration).toMatch(/financial_document_revisions|financial_documents|import_artifacts/);
    expect(migration).toMatch(/DISPATCH_EVIDENCE_STALE/);
  });

  it("passes the exact precommitted Vendor child operation ID through claim", () => {
    const source = readFileSync(join(process.cwd(), "lib", "posting-store.ts"), "utf8");
    const claim = source.slice(
      source.indexOf("async claimOperation"),
      source.indexOf("async getOperation"),
    );
    expect(claim).toMatch(/__zakiRequestedOperationId/);
    expect(grant().vendorChild.operationId).toBeTruthy();
  });
});
