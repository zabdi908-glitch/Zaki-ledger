import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoritativePostingService } from "../lib/authoritative-posting-service";
import type { PostingActor, PostingState } from "../lib/posting-contract";
import { quickBooksAccountingApiBase } from "../lib/quickbooks";
import {
  LiveQuickBooksSandboxOAuthVerifier,
  QuickBooksSandboxPilotExecutor,
  type QuickBooksSandboxPilotInput,
  type QuickBooksSandboxPilotStore,
} from "../lib/quickbooks-sandbox-pilot-executor";

const INPUT: QuickBooksSandboxPilotInput = {
  vendorOperationId: "249d5c5b-1111-42b2-9615-108e51a31696",
  billOperationId: "1c93b544-c9b2-4f0a-a573-c96d9a07f61e",
  externalVendorId: "70",
};
const ACTOR: PostingActor = {
  kind: "USER",
  userId: "aa100000-0000-4000-8000-000000000003",
};
const SCOPE = {
  actorUserId: ACTOR.userId,
  providerConnectionId: "aa100000-0000-4000-8000-000000000004",
  realmId: "9341457595863196",
  vendorState: "AUTHORIZED" as const,
  billState: "AUTHORIZED" as const,
  existingBillId: null,
};

class MemoryPilotStore implements QuickBooksSandboxPilotStore {
  events: string[] = [];
  eligibilityResult: Awaited<ReturnType<QuickBooksSandboxPilotStore["validateEligibility"]>> = {
    kind: "READY",
    scope: SCOPE,
  };
  mappingResult: Awaited<ReturnType<QuickBooksSandboxPilotStore["reverifyMappings"]>> = {
    kind: "READY",
  };
  authorizationResult: Awaited<ReturnType<QuickBooksSandboxPilotStore["refreshAuthorization"]>> = {
    kind: "REFRESHED",
    authorizations: [
      {
        operationId: INPUT.vendorOperationId,
        authorizationId: "aa100000-0000-4000-8000-000000000005",
        expiresAt: "2026-08-31T13:00:00.000Z",
        refreshed: true,
      },
      {
        operationId: INPUT.billOperationId,
        authorizationId: "aa100000-0000-4000-8000-000000000006",
        expiresAt: "2026-08-31T13:00:00.000Z",
        refreshed: true,
      },
    ],
  };
  dispatchResult: Awaited<ReturnType<QuickBooksSandboxPilotStore["prepareDispatch"]>> = {
    kind: "READY",
    scope: SCOPE,
  };

  async validateEligibility() {
    this.events.push("ELIGIBILITY");
    return this.eligibilityResult;
  }

  async reverifyMappings() {
    this.events.push("MAPPINGS");
    return this.mappingResult;
  }

  async refreshAuthorization() {
    this.events.push("REFRESH_AUTHORIZATION");
    return this.authorizationResult;
  }

  async prepareDispatch() {
    this.events.push("PREPARE_DISPATCH");
    return this.dispatchResult;
  }

  async audit(
    _input: QuickBooksSandboxPilotInput,
    _actor: PostingActor,
    reasonCode: string,
    _details: Record<string, unknown>,
  ) {
    this.events.push(reasonCode);
  }
}

function posting(
  vendorState: PostingState = "SUCCEEDED",
  billState: PostingState = "SUCCEEDED",
) {
  const calls: string[] = [];
  const service = {
    async adoptExistingQuickBooksVendor() {
      calls.push("VENDOR_READ_BACK");
      return {
        operationId: INPUT.vendorOperationId,
        state: vendorState,
        externalVendorId: vendorState === "SUCCEEDED" ? INPUT.externalVendorId : null,
        reasonCodes: [vendorState === "SUCCEEDED" ? "QUICKBOOKS_VENDOR_ADOPTED_AND_VERIFIED" : "VENDOR_REVIEW"],
        resumed: false,
        recovered: false,
      };
    },
    async executeQuickBooksBill() {
      calls.push("BILL_CREATE_AND_READ_BACK");
      return {
        operationId: INPUT.billOperationId,
        state: billState,
        externalBillId: billState === "SUCCEEDED" ? "801" : null,
        reasonCodes: [billState === "SUCCEEDED" ? "QUICKBOOKS_BILL_VERIFIED" : "BILL_UNCERTAIN"],
        resumed: false,
        recovered: false,
      };
    },
  } as Pick<AuthoritativePostingService,
    "adoptExistingQuickBooksVendor" | "executeQuickBooksBill">;
  return { calls, service };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  process.env.QUICKBOOKS_ENVIRONMENT = "production";
  process.env.QUICKBOOKS_SANDBOX_PILOT_ENABLED = "true";
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.QUICKBOOKS_ENVIRONMENT;
  delete process.env.QUICKBOOKS_SANDBOX_PILOT_ENABLED;
});

describe("QuickBooks Sandbox pilot executor", () => {
  it("proves OAuth, adopts and verifies Vendor, then dispatches and verifies Bill", async () => {
    const store = new MemoryPilotStore();
    const target = posting();
    const oauth = { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) };
    const executor = new QuickBooksSandboxPilotExecutor(store, target.service, oauth);

    await expect(executor.execute(INPUT, ACTOR)).resolves.toMatchObject({
      verdict: "SUCCEEDED",
      vendorState: "SUCCEEDED",
      billState: "SUCCEEDED",
      externalVendorId: "70",
      externalBillId: "801",
      flow: [
        "immutable-operation-evidence-scope:VERIFIED",
        "live-oauth:VERIFIED",
        "account-tax-mappings:VERIFIED",
        "exact-human-authorization:REFRESHED",
        "final-dispatch-preflight:ALLOW",
        "vendor-adopt-read-back:SUCCEEDED",
        "vendor-gate:SUCCEEDED",
        "bill-dispatch-and-read-back:SUCCEEDED",
      ],
    });
    expect(target.calls).toEqual(["VENDOR_READ_BACK", "BILL_CREATE_AND_READ_BACK"]);
    expect(store.events).toEqual([
      "ELIGIBILITY",
      "SANDBOX_PILOT_OAUTH_VERIFIED",
      "MAPPINGS",
      "REFRESH_AUTHORIZATION",
      "SANDBOX_PILOT_AUTHORIZATION_REFRESHED",
      "PREPARE_DISPATCH",
      "SANDBOX_PILOT_VENDOR_SUCCEEDED",
      "SANDBOX_PILOT_SUCCEEDED",
    ]);
  });

  it("stops before OAuth or provider I/O on REVIEW, DENIED, or UNCERTAIN preflight", async () => {
    for (const state of ["REVIEW", "DENIED", "UNCERTAIN"] as const) {
      const store = new MemoryPilotStore();
      store.eligibilityResult = { kind: "STOP", state, reasonCode: `PAIR_${state}` };
      const target = posting();
      const oauth = { verify: vi.fn() };
      const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
        .execute(INPUT, ACTOR);
      expect(result).toMatchObject({ verdict: "STOPPED", reasonCode: `PAIR_${state}` });
      expect(oauth.verify).not.toHaveBeenCalled();
      expect(target.calls).toEqual([]);
    }
  });

  it("requires a real Sandbox OAuth probe before any provider operation", async () => {
    const store = new MemoryPilotStore();
    const target = posting();
    const oauth = { verify: vi.fn().mockRejectedValue(new Error("revoked")) };
    const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute(INPUT, ACTOR);
    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "QUICKBOOKS_LIVE_OAUTH_REQUIRED",
    });
    expect(target.calls).toEqual([]);
    expect(store.events).toContain("SANDBOX_PILOT_OAUTH_REVIEW");
    expect(store.events).not.toContain("MAPPINGS");
    expect(store.events).not.toContain("REFRESH_AUTHORIZATION");
  });

  it("stops on mapping REVIEW after OAuth and before authorization refresh", async () => {
    const store = new MemoryPilotStore();
    store.mappingResult = {
      kind: "STOP",
      state: "REVIEW",
      reasonCode: "PILOT_ACCOUNT_MAPPING_NOT_CURRENT",
    };
    const target = posting();
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) },
    ).execute(INPUT, ACTOR);

    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "PILOT_ACCOUNT_MAPPING_NOT_CURRENT",
      flow: [
        "immutable-operation-evidence-scope:VERIFIED",
        "live-oauth:VERIFIED",
        "account-tax-mappings:REVIEW",
      ],
    });
    expect(store.events).not.toContain("REFRESH_AUTHORIZATION");
    expect(target.calls).toEqual([]);
  });

  it("stops when migration 025 blocks authorization and never reaches provider I/O", async () => {
    const store = new MemoryPilotStore();
    store.authorizationResult = {
      kind: "BLOCKED",
      operationId: INPUT.billOperationId,
      reasonCode: "CURRENT_TAX_MAPPING_INVALID",
    };
    const target = posting();
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) },
    ).execute(INPUT, ACTOR);

    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "CURRENT_TAX_MAPPING_INVALID",
      flow: expect.arrayContaining(["exact-human-authorization:REVIEW"]),
    });
    expect(store.events).toContain("SANDBOX_PILOT_AUTHORIZATION_REVIEW");
    expect(store.events).not.toContain("PREPARE_DISPATCH");
    expect(target.calls).toEqual([]);
  });

  it("retains migration 026 as a final stop after authorization refresh", async () => {
    const store = new MemoryPilotStore();
    store.dispatchResult = {
      kind: "STOP",
      state: "REVIEW",
      reasonCode: "PILOT_EXACT_AUTHORIZATION_STALE",
    };
    const target = posting();
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) },
    ).execute(INPUT, ACTOR);

    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "PILOT_EXACT_AUTHORIZATION_STALE",
      flow: expect.arrayContaining(["final-dispatch-preflight:STOP"]),
    });
    expect(target.calls).toEqual([]);
  });

  it("never dispatches Bill unless Vendor adoption returns exact SUCCEEDED binding", async () => {
    const store = new MemoryPilotStore();
    const target = posting("REVIEW");
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: null }) },
    ).execute(INPUT, ACTOR);
    expect(result).toMatchObject({ verdict: "STOPPED", vendorState: "REVIEW" });
    expect(target.calls).toEqual(["VENDOR_READ_BACK"]);
    expect(store.events).toContain("SANDBOX_PILOT_STOPPED_AFTER_VENDOR");
  });

  it("does not dispatch Bill when the durable Vendor-success audit cannot commit", async () => {
    const store = new MemoryPilotStore();
    const originalAudit = store.audit.bind(store);
    store.audit = async (input, actor, reasonCode, details) => {
      if (reasonCode === "SANDBOX_PILOT_VENDOR_SUCCEEDED") throw new Error("audit unavailable");
      return originalAudit(input, actor, reasonCode, details);
    };
    const target = posting();
    await expect(new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: null }) },
    ).execute(INPUT, ACTOR)).rejects.toThrow("audit unavailable");
    expect(target.calls).toEqual(["VENDOR_READ_BACK"]);
  });

  it("stops on an UNCERTAIN Bill outcome and does not retry", async () => {
    const store = new MemoryPilotStore();
    const target = posting("SUCCEEDED", "UNCERTAIN");
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: null }) },
    ).execute(INPUT, ACTOR);
    expect(result).toMatchObject({ verdict: "STOPPED", billState: "UNCERTAIN" });
    expect(target.calls).toEqual(["VENDOR_READ_BACK", "BILL_CREATE_AND_READ_BACK"]);
    expect(store.events).toContain("SANDBOX_PILOT_STOPPED_AFTER_BILL");
  });

  it("returns an existing verified Bill without another Vendor read or Bill CREATE", async () => {
    const store = new MemoryPilotStore();
    store.eligibilityResult = {
      kind: "READY",
      scope: { ...SCOPE, vendorState: "SUCCEEDED", billState: "SUCCEEDED", existingBillId: "801" },
    };
    const target = posting();
    const result = await new QuickBooksSandboxPilotExecutor(
      store,
      target.service,
      { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) },
    ).execute(INPUT, ACTOR);
    expect(result).toMatchObject({ verdict: "SUCCEEDED", externalBillId: "801" });
    expect(target.calls).toEqual([]);
    expect(store.events).not.toContain("REFRESH_AUTHORIZATION");
  });

  it("fails closed before database or network access when the pilot is disabled", async () => {
    process.env.QUICKBOOKS_SANDBOX_PILOT_ENABLED = "false";
    const store = new MemoryPilotStore();
    const target = posting();
    const oauth = { verify: vi.fn() };
    const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute(INPUT, ACTOR);
    expect(result).toMatchObject({ verdict: "STOPPED", reasonCode: "QUICKBOOKS_SANDBOX_REQUIRED" });
    expect(store.events).toEqual([]);
    expect(oauth.verify).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });

  it("allows a production-hosted Sandbox run for the code-pinned operations and realm", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = new MemoryPilotStore();
    const target = posting();
    const oauth = { verify: vi.fn().mockResolvedValue({ accountName: "Sandbox Co" }) };

    await expect(new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute(INPUT, ACTOR)).resolves.toMatchObject({
        verdict: "SUCCEEDED",
        vendorState: "SUCCEEDED",
        billState: "SUCCEEDED",
      });
    expect(target.calls).toEqual(["VENDOR_READ_BACK", "BILL_CREATE_AND_READ_BACK"]);
  });

  it("stops before preflight when an operation is not the code-pinned pilot operation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = new MemoryPilotStore();
    const target = posting();
    const oauth = { verify: vi.fn() };
    const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute({ ...INPUT, billOperationId: "aa100000-0000-4000-8000-000000000099" }, ACTOR);

    expect(result).toMatchObject({ verdict: "STOPPED", reasonCode: "QUICKBOOKS_SANDBOX_REQUIRED" });
    expect(store.events).toEqual([]);
    expect(oauth.verify).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });

  it("stops before OAuth when the resolved realm is not the code-pinned Sandbox realm", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = new MemoryPilotStore();
    store.eligibilityResult = { kind: "READY", scope: { ...SCOPE, realmId: "different-realm" } };
    const target = posting();
    const oauth = { verify: vi.fn() };
    const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute(INPUT, ACTOR);

    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "QUICKBOOKS_SANDBOX_REQUIRED",
      flow: ["immutable-operation-evidence-scope:VERIFIED", "pilot-realm:STOP"],
    });
    expect(store.events).toEqual(["ELIGIBILITY"]);
    expect(oauth.verify).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });
});

describe("live Sandbox OAuth verifier", () => {
  it("proves the token and exact realm with a real company-info GET", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ CompanyInfo: { CompanyName: "Sandbox Co" } }),
    });
    const verifier = new LiveQuickBooksSandboxOAuthVerifier(
      { getAccess: vi.fn().mockResolvedValue({ accessToken: "live-token", realmId: SCOPE.realmId }) },
      http,
    );
    await expect(verifier.verify(ACTOR.userId, SCOPE.realmId)).resolves.toEqual({
      accountName: "Sandbox Co",
    });
    expect(http).toHaveBeenCalledWith(expect.stringContaining("sandbox-quickbooks.api.intuit.com"),
      expect.objectContaining({ method: "GET" }));
  });

  it("keeps a production-hosted OAuth probe pinned to the configured realm and Sandbox URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const http = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ CompanyInfo: { CompanyName: "Sandbox Co" } }),
    });
    const access = { getAccess: vi.fn().mockResolvedValue({ accessToken: "live-token", realmId: SCOPE.realmId }) };
    const verifier = new LiveQuickBooksSandboxOAuthVerifier(access, http);

    await expect(verifier.verify(ACTOR.userId, SCOPE.realmId)).resolves.toEqual({
      accountName: "Sandbox Co",
    });
    expect(quickBooksAccountingApiBase()).toBe("https://quickbooks.api.intuit.com");
    expect(http.mock.calls[0][0]).toMatch(/^https:\/\/sandbox-quickbooks\.api\.intuit\.com\//);

    await expect(verifier.verify(ACTOR.userId, "different-realm"))
      .rejects.toThrow("QUICKBOOKS_SANDBOX_REQUIRED");
    expect(access.getAccess).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe("migration 026 contract", () => {
  const sql = readFileSync(
    join(process.cwd(), "..", "supabase", "migrations", "026_quickbooks_sandbox_pilot_executor.sql"),
    "utf8",
  );

  it("keeps the preflight service-only, append-only, and without a provider write capability", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.prepare_quickbooks_sandbox_pilot_v1[\s\S]*authenticated, service_role/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.prepare_quickbooks_sandbox_pilot_v1[\s\S]*TO service_role/i);
    expect(sql).toMatch(/posting_pilot_append_event_v1/);
    expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*http_post/i);
  });

  it("rechecks authorization, evidence, account, tax, and exact Vendor child identity", () => {
    expect(sql).toMatch(/posting_human_authorizations/);
    expect(sql).toMatch(/posting_dispatch_evidence_status_v1/);
    expect(sql).toMatch(/eligible_provider_posting_accounts/);
    expect(sql).toMatch(/eligible_provider_tax_treatments/);
    expect(sql).toMatch(/vendorChild,operationId/);
    expect(sql).toMatch(/vendorChild,authorizedRequestFingerprint/);
  });
});

describe("migration 027 ordering contract", () => {
  const sql = readFileSync(
    join(process.cwd(), "..", "supabase", "migrations", "027_quickbooks_sandbox_pilot_ordering.sql"),
    "utf8",
  );

  it("separates immutable eligibility and mapping verification from authorization refresh", () => {
    expect(sql).toMatch(/prepare_quickbooks_sandbox_pilot_eligibility_v2/);
    expect(sql).toMatch(/posting_dispatch_evidence_status_v1/);
    expect(sql).toMatch(/reverify_quickbooks_sandbox_pilot_mappings_v1/);
    expect(sql).toMatch(/eligible_provider_posting_accounts/);
    expect(sql).toMatch(/eligible_provider_tax_treatments/);
    expect(sql).not.toMatch(/UPDATE\s+public\.eligible_provider_/i);
  });

  it("keeps all new coordinator functions service-only and provider-I/O free", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.prepare_quickbooks_sandbox_pilot_eligibility_v2[\s\S]*authenticated, service_role/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.prepare_quickbooks_sandbox_pilot_eligibility_v2[\s\S]*TO service_role/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.reverify_quickbooks_sandbox_pilot_mappings_v1[\s\S]*authenticated, service_role/i);
    expect(sql).not.toMatch(/http_(?:get|post)|net\.http/i);
  });
});
