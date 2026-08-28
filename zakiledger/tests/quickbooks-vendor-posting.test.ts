import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthoritativePostingService } from "../lib/authoritative-posting-service";
import type { PostingActor, PostingState } from "../lib/posting-contract";
import type { PostingStore } from "../lib/posting-store";
import type {
  QuickBooksVendorExecutionStore,
  QuickBooksVendorPrepareResult,
  QuickBooksVendorRecoveryPrepareResult,
  VendorExecutionResult,
} from "../lib/quickbooks-vendor-execution-store";
import type { SanitizedProviderFailure } from "../lib/provider-adapters/provider-posting-adapter";
import {
  QuickBooksVendorPostingAdapter,
  QuickBooksVendorSubmissionError,
  type QuickBooksAuthorizedVendorGrant,
  type QuickBooksCreateVendorRequest,
  type QuickBooksObservedVendor,
  type QuickBooksVendorPostingTransport,
  type QuickBooksVendorRecoveryGrant,
} from "../lib/provider-adapters/quickbooks-vendor-posting-adapter";
import {
  createAuthenticatedQuickBooksVendorPostingAdapter,
  type QuickBooksHttpClient,
} from "../lib/provider-adapters/quickbooks-authenticated-posting-transport";

const OPERATION_ID = "c7100000-0000-0000-0000-000000000001";
const ACTOR: PostingActor = { kind: "USER", userId: "c7000000-0000-0000-0000-000000000001" };

function grant(): QuickBooksAuthorizedVendorGrant {
  return {
    operation: {
      id: OPERATION_ID,
      stateAtDispatch: "AUTHORIZED",
      practiceId: "c7110000-0000-0000-0000-000000000001",
      clientEntityId: "c7120000-0000-0000-0000-000000000001",
      ledgerBookId: "c7130000-0000-0000-0000-000000000001",
      providerConnectionId: "c7140000-0000-0000-0000-000000000001",
      provider: "quickbooks",
      externalOrganisationId: "vendor-safe-realm",
      externalObjectType: "VENDOR",
      action: "CREATE",
      authorizedRequestFingerprint: "a".repeat(64),
    },
    attempt: {
      id: randomUUID(), number: 1, kind: "SUBMIT",
      providerIdempotencyToken: `zaki-qb-vendor-${OPERATION_ID}-1`,
    },
    requestedObject: { displayName: "Safe Vendor", synthetic: false, liveTarget: true },
    expectedMaterialState: { displayName: "Safe Vendor" },
  };
}

type Attempt = { id: string; kind: "SUBMIT" | "RECOVERY" };

class MemoryVendorStore implements QuickBooksVendorExecutionStore {
  state: PostingState = "AUTHORIZED";
  destinationAllowed = true;
  failAcknowledgementPersistence = false;
  knownExternalVendorId: string | null = null;
  bindingExternalVendorId: string | null = null;
  attempts: Attempt[] = [];
  events: string[] = [];
  private prepareTail = Promise.resolve();

  private result(reasonCode: string, recovered = false): VendorExecutionResult {
    return {
      operationId: OPERATION_ID,
      state: this.state,
      externalVendorId: this.state === "SUCCEEDED" ? this.bindingExternalVendorId : null,
      reasonCodes: [reasonCode],
      resumed: recovered,
      recovered,
    };
  }

  private submissionGrant(): QuickBooksAuthorizedVendorGrant {
    const base = grant();
    const id = randomUUID();
    this.attempts.push({ id, kind: "SUBMIT" });
    return { ...base, attempt: { ...base.attempt, id, number: this.attempts.length } };
  }

  private recoveryGrant(
    stateAtRecovery: "SUBMITTING" | "VERIFYING" | "UNCERTAIN",
  ): QuickBooksVendorRecoveryGrant {
    const base = grant();
    const id = randomUUID();
    this.attempts.push({ id, kind: "RECOVERY" });
    const { stateAtDispatch: _stateAtDispatch, ...operation } = base.operation;
    return {
      ...base,
      operation: { ...operation, stateAtRecovery },
      attempt: {
        id, number: this.attempts.length, kind: "RECOVERY",
        providerIdempotencyToken: `zaki-qb-vendor-${OPERATION_ID}-recovery-${this.attempts.length}`,
      },
      knownExternalVendorId: this.knownExternalVendorId,
    };
  }

  async prepareQuickBooksVendorSubmission(): Promise<QuickBooksVendorPrepareResult> {
    let release!: () => void;
    const previous = this.prepareTail;
    this.prepareTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.state === "SUCCEEDED") {
        return { kind: "SUCCEEDED", externalVendorId: this.bindingExternalVendorId! };
      }
      if (this.state === "SUBMITTING" || this.state === "VERIFYING" || this.state === "UNCERTAIN") {
        return { kind: "RECOVERY_REQUIRED", state: this.state };
      }
      if (this.state !== "AUTHORIZED") {
        return { kind: "BLOCKED", state: this.state, reasonCode: "OPERATION_NOT_AUTHORIZED" };
      }
      if (!this.destinationAllowed) {
        this.state = "DENIED";
        return { kind: "DENIED", state: "DENIED", reasonCode: "DISPATCH_DESTINATION_INVALID" };
      }
      const prepared = this.submissionGrant();
      this.events.push("ATTEMPT_PERSISTED", "AUTHORIZED_TO_SUBMITTING");
      this.state = "SUBMITTING";
      return { kind: "DISPATCH", grant: prepared };
    } finally {
      release();
    }
  }

  async beginQuickBooksVendorRecovery(): Promise<QuickBooksVendorRecoveryPrepareResult> {
    if (this.state === "SUCCEEDED") {
      return { kind: "SUCCEEDED", externalVendorId: this.bindingExternalVendorId! };
    }
    if (this.state !== "SUBMITTING" && this.state !== "VERIFYING" && this.state !== "UNCERTAIN") {
      return { kind: "BLOCKED", state: this.state, reasonCode: "RECOVERY_STATE_OR_OPERATION_NOT_ELIGIBLE" };
    }
    const original = this.state;
    const recovery = this.recoveryGrant(original);
    this.state = "VERIFYING";
    this.events.push("READ_ONLY_RECOVERY");
    return { kind: "RECOVER", grant: recovery };
  }

  async recordQuickBooksVendorAcknowledged(
    _operationId: string,
    _attemptId: string,
    externalVendorId: string,
  ): Promise<void> {
    if (this.failAcknowledgementPersistence) throw new Error("simulated acknowledgement crash");
    this.knownExternalVendorId = externalVendorId;
    this.state = "VERIFYING";
    this.events.push("ACKNOWLEDGED");
  }

  async recordQuickBooksVendorFailure(
    _operationId: string,
    _attemptId: string,
    state: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<VendorExecutionResult> {
    this.state = state;
    this.events.push(`FAILURE:${failure.code}`);
    return this.result(failure.code);
  }

  async recordQuickBooksVendorObservation(input: {
    externalVendorId: string | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<VendorExecutionResult> {
    const recovered = this.attempts.at(-1)?.kind === "RECOVERY";
    if (input.comparisonOutcome === "MATCH") {
      this.bindingExternalVendorId = input.externalVendorId;
      this.state = "SUCCEEDED";
    } else {
      this.state = "UNCERTAIN";
    }
    this.events.push(`OBSERVATION:${input.comparisonOutcome}`);
    return this.result(input.reasonCode, recovered);
  }
}

class FakeVendorTransport implements QuickBooksVendorPostingTransport {
  readonly vendors = new Map<string, QuickBooksObservedVendor>();
  readonly correlations = new Map<string, string[]>();
  createCalls = 0;
  readCalls = 0;
  recoveryCalls = 0;
  lastCreateRequest: QuickBooksCreateVendorRequest | null = null;
  constructor(private mode: "SUCCESS" | "TIMEOUT_AFTER_DELIVERY" = "SUCCESS") {}

  setMode(mode: "SUCCESS" | "TIMEOUT_AFTER_DELIVERY"): void { this.mode = mode; }

  async createVendor(request: QuickBooksCreateVendorRequest) {
    this.createCalls += 1;
    this.lastCreateRequest = request;
    const id = `fake-vendor-${this.vendors.size + 1}`;
    this.vendors.set(id, {
      id, realmId: request.realmId, displayName: request.displayName, active: true, providerVersion: "1",
    });
    this.correlations.set(request.correlationTag, [...(this.correlations.get(request.correlationTag) ?? []), id]);
    if (this.mode === "TIMEOUT_AFTER_DELIVERY") {
      throw new QuickBooksVendorSubmissionError({
        classification: "UNCERTAIN_DELIVERY",
        code: "RESPONSE_TIMEOUT_AFTER_POSSIBLE_VENDOR_CREATE",
        summary: "response timed out after possible Vendor creation",
      });
    }
    return { externalVendorId: id, providerRequestId: `vendor-request-${this.createCalls}` };
  }

  async readVendor(_realmId: string, _providerConnectionId: string, id: string) {
    this.readCalls += 1;
    const vendor = this.vendors.get(id);
    return vendor ? { ...vendor } : null;
  }

  async findVendorsByCorrelation(_realmId: string, tag: string) {
    this.recoveryCalls += 1;
    return (this.correlations.get(tag) ?? []).map((id) => this.vendors.get(id))
      .filter((vendor): vendor is QuickBooksObservedVendor => Boolean(vendor))
      .map((vendor) => ({ ...vendor }));
  }
}

function service(store: MemoryVendorStore): AuthoritativePostingService {
  return new AuthoritativePostingService({} as PostingStore, undefined, undefined, undefined, store);
}

describe("safe QuickBooks ENSURE_VENDOR execution", () => {
  it("persists before create, reads back, binds the verified Vendor, and succeeds", async () => {
    const store = new MemoryVendorStore();
    const transport = new FakeVendorTransport();
    const result = await service(store).executeQuickBooksVendor(
      OPERATION_ID, ACTOR, new QuickBooksVendorPostingAdapter(transport));
    expect(result).toMatchObject({ state: "SUCCEEDED", externalVendorId: "fake-vendor-1" });
    expect(store.events.slice(0, 2)).toEqual(["ATTEMPT_PERSISTED", "AUTHORIZED_TO_SUBMITTING"]);
    expect(store.bindingExternalVendorId).toBe("fake-vendor-1");
    expect(transport.readCalls).toBe(1);
    expect(transport.lastCreateRequest?.payload).toMatchObject({
      DisplayName: "Safe Vendor", Active: true,
    });
    expect(transport.lastCreateRequest?.correlationTag).toContain(OPERATION_ID);
  });

  it("resumes an existing verified Vendor without CREATE", async () => {
    const store = new MemoryVendorStore();
    store.state = "SUCCEEDED";
    store.bindingExternalVendorId = "existing-vendor";
    const transport = new FakeVendorTransport();
    const result = await service(store).executeQuickBooksVendor(
      OPERATION_ID, ACTOR, new QuickBooksVendorPostingAdapter(transport));
    expect(result).toMatchObject({ state: "SUCCEEDED", externalVendorId: "existing-vendor", resumed: true });
    expect(transport.createCalls).toBe(0);
  });

  it.each(["QBO_SERVER_ERROR", "QBO_RATE_LIMITED"])(
    "treats %s as uncertain and exact retry only recovers read-only",
    async (code) => {
      const store = new MemoryVendorStore();
      let createCalls = 0;
      const transport: QuickBooksVendorPostingTransport = {
        async createVendor() {
          createCalls += 1;
          throw new QuickBooksVendorSubmissionError({
            classification: "UNCERTAIN_DELIVERY", code, summary: "provider outcome is inconclusive",
          });
        },
        async readVendor() { return null; },
        async findVendorsByCorrelation() { return []; },
      };
      const posting = service(store);
      const adapter = new QuickBooksVendorPostingAdapter(transport);
      expect((await posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter)).state).toBe("UNCERTAIN");
      expect((await posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter)))
        .toMatchObject({ state: "UNCERTAIN", recovered: true });
      expect(createCalls).toBe(1);
      expect(store.events).toContain("READ_ONLY_RECOVERY");
    },
  );

  it("recovers read-only after a crash immediately after provider success", async () => {
    const store = new MemoryVendorStore();
    store.failAcknowledgementPersistence = true;
    const transport = new FakeVendorTransport();
    const posting = service(store);
    const adapter = new QuickBooksVendorPostingAdapter(transport);
    await expect(posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter))
      .rejects.toThrow("simulated acknowledgement crash");
    expect(transport.createCalls).toBe(1);
    store.failAcknowledgementPersistence = false;
    const recovered = await posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter);
    expect(recovered).toMatchObject({ state: "SUCCEEDED", recovered: true });
    expect(transport.createCalls).toBe(1);
    expect(transport.recoveryCalls).toBe(1);
  });

  it("keeps an ambiguous provider response UNCERTAIN and never blindly creates again", async () => {
    const store = new MemoryVendorStore();
    const transport = new FakeVendorTransport("TIMEOUT_AFTER_DELIVERY");
    const posting = service(store);
    const adapter = new QuickBooksVendorPostingAdapter(transport);
    expect((await posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter)).state).toBe("UNCERTAIN");
    transport.setMode("SUCCESS");
    expect((await posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter)))
      .toMatchObject({ state: "SUCCEEDED", recovered: true });
    expect(transport.createCalls).toBe(1);
  });

  it("serializes concurrent exact retries to one CREATE", async () => {
    const store = new MemoryVendorStore();
    const transport = new FakeVendorTransport();
    const posting = service(store);
    const adapter = new QuickBooksVendorPostingAdapter(transport);
    const results = await Promise.all([
      posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter),
      posting.executeQuickBooksVendor(OPERATION_ID, ACTOR, adapter),
    ]);
    expect(results.some((result) => result.state === "SUCCEEDED")).toBe(true);
    expect(transport.createCalls).toBe(1);
    expect(store.attempts.filter((attempt) => attempt.kind === "SUBMIT")).toHaveLength(1);
  });

  it("rejects a wrong realm/client destination before an attempt or provider call", async () => {
    const store = new MemoryVendorStore();
    store.destinationAllowed = false;
    const transport = new FakeVendorTransport();
    const result = await service(store).executeQuickBooksVendor(
      OPERATION_ID, ACTOR, new QuickBooksVendorPostingAdapter(transport));
    expect(result).toMatchObject({ state: "DENIED", reasonCodes: ["DISPATCH_DESTINATION_INVALID"] });
    expect(store.attempts).toHaveLength(0);
    expect(transport.createCalls).toBe(0);
  });

  it("keeps the parent Bill gate dependent on a SUCCEEDED Vendor child and has no legacy fallback", () => {
    const billPreparation = readFileSync(
      join(process.cwd(), "..", "supabase", "migrations", "016_quickbooks_bill_execution.sql"), "utf8");
    const vendorMigration = readFileSync(
      join(process.cwd(), "..", "supabase", "migrations", "023_quickbooks_vendor_execution.sql"), "utf8");
    expect(billPreparation).toContain("v_child.current_state <> 'SUCCEEDED'");
    expect(billPreparation).toContain("VENDOR_CHILD_UNRESOLVED");
    expect(vendorMigration).toContain("QUICKBOOKS_VENDOR_READ_ONLY_RECOVERY");
    expect(vendorMigration).not.toMatch(/findOrCreateVendor|createQuickBooksBill|oauth_connections/);
  });

  it("uses the shared authenticated transport for Vendor CREATE and read-back in the exact realm/connection scope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http: QuickBooksHttpClient = async (url, init) => {
      calls.push({ url, init });
      const isCreate = init.method === "POST";
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "intuit_tid" ? "fake-intuit-tid" : null },
        json: async () => isCreate
          ? { Vendor: { Id: "authenticated-vendor-1" } }
          : { Vendor: { Id: "authenticated-vendor-1", DisplayName: "Safe Vendor", Active: true, SyncToken: "7" } },
      };
    };
    const authorized = grant();
    const adapter = createAuthenticatedQuickBooksVendorPostingAdapter({
      actorUserId: ACTOR.userId,
      providerConnectionId: authorized.operation.providerConnectionId,
      realmId: authorized.operation.externalOrganisationId,
    }, {
      getAccess: async () => ({ accessToken: "fake-access-token", realmId: "vendor-safe-realm" }),
    }, http);

    const submitted = await adapter.executeAuthorizedVendor(authorized);
    expect(submitted).toMatchObject({ kind: "ACKNOWLEDGED", externalVendorId: "authenticated-vendor-1" });
    const readBack = await adapter.readBack(authorized, "authenticated-vendor-1");
    expect(readBack).toMatchObject({ kind: "OBSERVED", observation: { providerVersion: "7" } });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/v3/company/vendor-safe-realm/vendor?");
    expect(calls[0].url).toContain("requestid=zaki-qb-vendor-");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer fake-access-token" });
  });

  it("fails before CREATE when the authenticated transport's realm or provider connection scope differs", async () => {
    let calls = 0;
    const authorized = grant();
    const adapter = createAuthenticatedQuickBooksVendorPostingAdapter({
      actorUserId: ACTOR.userId,
      providerConnectionId: "different-provider-connection",
      realmId: "different-realm",
    }, {
      getAccess: async () => ({ accessToken: "fake-access-token", realmId: "different-realm" }),
    }, async () => {
      calls += 1;
      throw new Error("must not call fake transport");
    });

    await expect(adapter.executeAuthorizedVendor(authorized)).resolves.toMatchObject({
      kind: "FAILED_SAFE",
      failure: { classification: "BEFORE_DELIVERY" },
    });
    expect(calls).toBe(0);
  });
});
