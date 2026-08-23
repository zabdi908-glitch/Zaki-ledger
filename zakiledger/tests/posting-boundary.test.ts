import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { postApprovedBill, type ApprovedBillPostingRequest } from "../lib/accounting";
import { canonicalizePostingIntent, type PostingIntent } from "../lib/posting-contract";
import { CorePostingSafetyGate, type PostingValidationContext } from "../lib/posting-gates";
import {
  FakeQuickBooksPostingTransport,
  QuickBooksPostingAdapter,
} from "../lib/provider-adapters/quickbooks-posting-adapter";
import { XeroPostingAdapter } from "../lib/provider-adapters/xero-posting-adapter";

const runtimeRoot = join(process.cwd());

function sourceFiles(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) output.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(name)) output.push(path);
  }
  return output;
}

const bill = {
  documentType: "invoice" as const,
  supplierName: "Boundary Supplier",
  invoiceNumber: "B-100",
  invoiceDate: "2026-08-20",
  currency: "GBP",
  subtotal: 100,
  tax: 20,
  total: 120,
  lineItems: [],
};

function request(overrides: Partial<ApprovedBillPostingRequest> = {}): ApprovedBillPostingRequest {
  return {
    destination: {
      practiceId: "practice-a",
      clientEntityId: "client-a",
      ledgerBookId: "book-a",
      providerConnectionId: "connection-a",
      provider: "quickbooks",
      externalOrganisationId: "realm-a",
    },
    idempotencyKey: "bill:boundary:1",
    sourceDocumentId: "document-a",
    sourceRevision: "revision-a",
    evidence: [{
      kind: "IMPORT_ARTIFACT",
      evidenceId: "artifact-a",
      fingerprint: "a".repeat(64),
    }],
    accountTreatment: [{ disposition: "MAPPED", mappingId: "mapping-a" }],
    taxTreatment: [{
      disposition: "MAPPED",
      treatmentId: "tax-a",
      providerTaxCode: "T20",
      evidenceFingerprint: "b".repeat(64),
    }],
    humanApprovalId: "approval-a",
    ...overrides,
  };
}

const allowContext: PostingValidationContext = {
  destination: {
    clientExists: true,
    clientActive: true,
    ledgerBookMatches: true,
    ledgerBookActive: true,
    providerConnectionMatches: true,
    providerConnectionActive: true,
    currencySupported: true,
  },
  actorAuthorized: true,
  evidence: [{ evidenceId: "artifact-a", status: "VALID" }],
  accountMappings: [{ mappingId: "mapping-a", status: "ELIGIBLE" }],
  humanApproval: null,
  now: "2026-08-22T12:00:00.000Z",
};

describe("provider posting module boundary", () => {
  it("contains the former mutation primitives outside the runtime call graph", () => {
    const runtimeFiles = [
      ...sourceFiles(join(runtimeRoot, "app", "api")),
      ...sourceFiles(join(runtimeRoot, "lib")),
    ];
    const bannedPrimitives = [
      "createQuickBooksBill",
      "createXeroDraftBill",
      "findOrCreateVendor",
      "qboPost",
    ];
    const violations: string[] = [];

    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      for (const primitive of bannedPrimitives) {
        if (source.includes(primitive)) {
          violations.push(`${relative(runtimeRoot, file)}: ${primitive}`);
        }
      }
      const isAuthoritativeBoundary =
        file.endsWith("/lib/authoritative-posting-service.ts") ||
        file.endsWith("/lib/quickbooks-execution-store.ts");
      if (!file.includes("/provider-adapters/") && !isAuthoritativeBoundary &&
          source.includes("/provider-adapters/")) {
        violations.push(`${relative(runtimeRoot, file)}: imports provider adapter`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps routes and general services free of provider financial-write capability", () => {
    const accounting = readFileSync(join(runtimeRoot, "lib", "accounting.ts"), "utf8");
    const single = readFileSync(join(runtimeRoot, "app", "api", "approve", "route.ts"), "utf8");
    const bulk = readFileSync(join(runtimeRoot, "app", "api", "approve", "bulk", "route.ts"), "utf8");
    const quickbooks = readFileSync(join(runtimeRoot, "lib", "quickbooks.ts"), "utf8");
    const xero = readFileSync(join(runtimeRoot, "lib", "xero.ts"), "utf8");

    expect(accounting).toContain("createAuthoritativePostingService");
    expect(accounting).not.toMatch(/from ["'].\/(?:quickbooks|xero|oauth-store)["']/);
    expect(single).not.toMatch(/@\/lib\/(?:quickbooks|xero|oauth-store|provider-adapters)/);
    expect(bulk).not.toMatch(/@\/lib\/(?:quickbooks|xero|oauth-store|provider-adapters)/);
    expect(quickbooks).not.toMatch(/method:\s*["']POST["'][\s\S]{0,500}(?:\/bill|\/vendor)/i);
    expect(xero).not.toMatch(/\/Invoices[\s\S]{0,500}method:\s*["']POST["']/i);
  });

  it("does not use legacy extracted-item fields as posting authority", () => {
    const runtime = [
      ...sourceFiles(join(runtimeRoot, "app")),
      ...sourceFiles(join(runtimeRoot, "lib")),
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(runtime).not.toMatch(/posted_to_qb_at|qb_txn_id/);
  });

  it("enables only the narrow QuickBooks grant path and leaves Xero non-executing", async () => {
    const quickbooks = new QuickBooksPostingAdapter(new FakeQuickBooksPostingTransport());
    const result = await quickbooks.executeAuthorizedBill({} as never);
    expect(result).toMatchObject({ kind: "FAILED_SAFE" });
    await expect(new XeroPostingAdapter().execute()).rejects.toThrow("not implemented");
  });
});

describe("postApprovedBill compatibility façade", () => {
  it("constructs one exact intent and submits it to the authoritative service", async () => {
    const calls: Array<{ intent: PostingIntent; actor: unknown }> = [];
    const service = {
      submit: async (intent: PostingIntent, actor: unknown) => {
        calls.push({ intent, actor });
        return {
          operationId: "operation-a",
          state: "AUTHORIZED" as const,
          reasonCodes: ["PERMISSION_ALLOW" as const],
          resumed: false,
          authorizedRequestFingerprint: "c".repeat(64),
        };
      },
    };

    await postApprovedBill("user-a", bill, request(), service);

    expect(calls).toHaveLength(1);
    expect(calls[0].intent).toMatchObject({
      provider: "quickbooks",
      providerConnectionId: "connection-a",
      externalOrganisationId: "realm-a",
      action: "CREATE",
      externalObjectType: "BILL",
      idempotencyKey: "bill:boundary:1",
      accountTreatment: [{ disposition: "MAPPED", mappingId: "mapping-a" }],
    });
    expect(calls[0].actor).toEqual({ kind: "USER", userId: "user-a" });
  });

  it("requires an explicit destination and never falls back to a connected provider", async () => {
    const service = { submit: async () => { throw new Error("must not submit"); } };
    const missingDestination = request({
      destination: { ...request().destination, providerConnectionId: "" },
    });
    await expect(postApprovedBill("user-a", bill, missingDestination, service)).rejects.toThrow(
      "explicit canonical provider destination",
    );
  });

  it("routes missing account or tax treatment to REVIEW and synthetic live data to DENY", async () => {
    const captured: PostingIntent[] = [];
    const capture = {
      submit: async (intent: PostingIntent) => {
        captured.push(intent);
        return {
          operationId: "operation-a",
          state: "REVIEW" as const,
          reasonCodes: [],
          resumed: false,
          authorizedRequestFingerprint: "c".repeat(64),
        };
      },
    };
    await postApprovedBill("user-a", bill, request({ accountTreatment: [] }), capture);
    await postApprovedBill("user-a", bill, request({ taxTreatment: [] }), capture);
    await postApprovedBill("user-a", bill, request({ synthetic: true }), capture);

    const gate = new CorePostingSafetyGate();
    const noAccount = gate.evaluate(
      canonicalizePostingIntent(captured[0]),
      { kind: "USER", userId: "user-a" },
      { ...allowContext, accountMappings: [] },
    );
    const noTax = gate.evaluate(
      canonicalizePostingIntent(captured[1]),
      { kind: "USER", userId: "user-a" },
      allowContext,
    );
    const synthetic = gate.evaluate(
      canonicalizePostingIntent(captured[2]),
      { kind: "USER", userId: "user-a" },
      allowContext,
    );

    expect(noAccount).toMatchObject({ decision: "REVIEW" });
    expect(noAccount.reasonCodes).toContain("MISSING_ACCOUNT_TREATMENT");
    expect(noTax).toMatchObject({ decision: "REVIEW" });
    expect(noTax.reasonCodes).toContain("MISSING_TAX_TREATMENT");
    expect(synthetic).toMatchObject({ decision: "DENY" });
    expect(synthetic.reasonCodes).toContain("SYNTHETIC_LIVE_PROHIBITED");
  });
});
