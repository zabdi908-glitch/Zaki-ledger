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
  prepareResult: Awaited<ReturnType<QuickBooksSandboxPilotStore["prepare"]>> = {
    kind: "READY",
    scope: SCOPE,
  };

  async prepare() {
    this.events.push("PREPARE");
    return this.prepareResult;
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
        "operation-pair-and-current-gates:ALLOW",
        "live-oauth:VERIFIED",
        "vendor-adopt-read-back:SUCCEEDED",
        "vendor-gate:SUCCEEDED",
        "bill-dispatch-and-read-back:SUCCEEDED",
      ],
    });
    expect(target.calls).toEqual(["VENDOR_READ_BACK", "BILL_CREATE_AND_READ_BACK"]);
    expect(store.events).toEqual([
      "PREPARE",
      "SANDBOX_PILOT_OAUTH_VERIFIED",
      "SANDBOX_PILOT_VENDOR_SUCCEEDED",
      "SANDBOX_PILOT_SUCCEEDED",
    ]);
  });

  it("stops before OAuth or provider I/O on REVIEW, DENIED, or UNCERTAIN preflight", async () => {
    for (const state of ["REVIEW", "DENIED", "UNCERTAIN"] as const) {
      const store = new MemoryPilotStore();
      store.prepareResult = { kind: "STOP", state, reasonCode: `PAIR_${state}` };
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
    store.prepareResult = {
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
    store.prepareResult = { kind: "READY", scope: { ...SCOPE, realmId: "different-realm" } };
    const target = posting();
    const oauth = { verify: vi.fn() };
    const result = await new QuickBooksSandboxPilotExecutor(store, target.service, oauth)
      .execute(INPUT, ACTOR);

    expect(result).toMatchObject({
      verdict: "STOPPED",
      reasonCode: "QUICKBOOKS_SANDBOX_REQUIRED",
      flow: ["operation-pair-and-current-gates:ALLOW", "pilot-realm:STOP"],
    });
    expect(store.events).toEqual(["PREPARE"]);
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
