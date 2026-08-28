import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthoritativePostingService } from "../lib/authoritative-posting-service";
import type { PostingActor, PostingState } from "../lib/posting-contract";
import type { PostingStore } from "../lib/posting-store";
import type {
  QuickBooksVendorAdoptionPrepareResult,
  QuickBooksVendorAdoptionStore,
  VendorExecutionResult,
} from "../lib/quickbooks-vendor-execution-store";
import {
  QuickBooksVendorAdoptionAdapter,
  type QuickBooksObservedVendor,
  type QuickBooksVendorAdoptionGrant,
  type QuickBooksVendorReadTransport,
} from "../lib/provider-adapters/quickbooks-vendor-posting-adapter";
import {
  createAuthenticatedQuickBooksVendorAdoptionAdapter,
  type QuickBooksHttpClient,
} from "../lib/provider-adapters/quickbooks-authenticated-posting-transport";

const OPERATION_ID = "d7100000-0000-0000-0000-000000000001";
const ACTOR: PostingActor = { kind: "USER", userId: "d7000000-0000-0000-0000-000000000001" };
const REALM = "9341457595863196";
const CONNECTION_ID = "d7140000-0000-0000-0000-000000000001";
const VENDOR_ID = "70";

function adoptionGrant(attemptId = randomUUID()): QuickBooksVendorAdoptionGrant {
  return {
    operation: {
      id: OPERATION_ID,
      stateAtAdoption: "AUTHORIZED",
      practiceId: "d7110000-0000-0000-0000-000000000001",
      clientEntityId: "d7120000-0000-0000-0000-000000000001",
      ledgerBookId: "d7130000-0000-0000-0000-000000000001",
      providerConnectionId: CONNECTION_ID,
      provider: "quickbooks",
      externalOrganisationId: REALM,
      externalObjectType: "VENDOR",
      action: "CREATE",
      authorizedRequestFingerprint: "b".repeat(64),
    },
    attempt: {
      id: attemptId,
      number: 1,
      kind: "VERIFY",
      providerIdempotencyToken: null,
    },
    requestedObject: { displayName: "Zaki Sandbox Test Vendor" },
    expectedMaterialState: { displayName: "Zaki Sandbox Test Vendor" },
    externalVendorId: VENDOR_ID,
  };
}

class MemoryAdoptionStore implements QuickBooksVendorAdoptionStore {
  state: PostingState = "AUTHORIZED";
  bindingExternalVendorId: string | null = null;
  bindingKind: "ADOPTED" | null = null;
  conflictingBinding = false;
  attempts = 0;
  events: string[] = [];
  lastNormalizedProviderState: Record<string, unknown> | null = null;
  private prepareTail = Promise.resolve();

  private result(reasonCode: string): VendorExecutionResult {
    return {
      operationId: OPERATION_ID,
      state: this.state,
      externalVendorId: this.state === "SUCCEEDED" ? this.bindingExternalVendorId : null,
      reasonCodes: [reasonCode],
      resumed: false,
      recovered: false,
    };
  }

  async prepareQuickBooksVendorAdoption(
    _operationId: string,
    _actor: PostingActor,
    externalVendorId: string,
  ): Promise<QuickBooksVendorAdoptionPrepareResult> {
    let release!: () => void;
    const previous = this.prepareTail;
    this.prepareTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.state === "SUCCEEDED") {
        return this.bindingExternalVendorId === externalVendorId
          ? { kind: "SUCCEEDED", externalVendorId }
          : { kind: "BLOCKED", state: "SUCCEEDED", reasonCode: "EXISTING_VENDOR_BINDING_CONFLICT" };
      }
      if (this.state !== "AUTHORIZED") {
        return { kind: "BLOCKED", state: this.state, reasonCode: "VENDOR_ADOPTION_ALREADY_IN_PROGRESS" };
      }
      if (this.conflictingBinding) {
        this.state = "REVIEW";
        this.events.push("ADOPT_EXISTING:CONFLICT");
        return { kind: "BLOCKED", state: "REVIEW", reasonCode: "EXISTING_VENDOR_BINDING_CONFLICT" };
      }
      this.attempts += 1;
      this.state = "VERIFYING";
      this.events.push("ATTEMPT:VERIFY", "ADOPT_EXISTING", "AUTHORIZED_TO_VERIFYING");
      return { kind: "VERIFY", grant: adoptionGrant() };
    } finally {
      release();
    }
  }

  async recordQuickBooksVendorAdoptionObservation(input: {
    externalVendorId: string;
    normalizedProviderState: Record<string, unknown> | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<VendorExecutionResult> {
    this.lastNormalizedProviderState = input.normalizedProviderState;
    if (input.comparisonOutcome === "MATCH" && !this.conflictingBinding) {
      this.bindingExternalVendorId = input.externalVendorId;
      this.bindingKind = "ADOPTED";
      this.state = "SUCCEEDED";
    } else {
      this.state = "REVIEW";
    }
    this.events.push(`ADOPT_EXISTING:${input.comparisonOutcome}`);
    return this.result(this.conflictingBinding
      ? "EXISTING_VENDOR_BINDING_CONFLICT"
      : input.reasonCode);
  }
}

class FakeReadTransport implements QuickBooksVendorReadTransport {
  readCalls = 0;
  constructor(
    private readonly vendor: QuickBooksObservedVendor | null,
    private readonly fail = false,
  ) {}

  async readVendor(
    realmId: string,
    providerConnectionId: string,
    externalVendorId: string,
  ): Promise<QuickBooksObservedVendor | null> {
    this.readCalls += 1;
    expect(realmId).toBe(REALM);
    expect(providerConnectionId).toBe(CONNECTION_ID);
    expect(externalVendorId).toBe(VENDOR_ID);
    if (this.fail) throw new Error("stale credential or provider read failure");
    return this.vendor ? { ...this.vendor } : null;
  }
}

function observed(overrides: Partial<QuickBooksObservedVendor> = {}): QuickBooksObservedVendor {
  return {
    id: VENDOR_ID,
    realmId: REALM,
    displayName: "Zaki Sandbox Test Vendor",
    active: true,
    providerVersion: "4",
    ...overrides,
  };
}

function posting(store: MemoryAdoptionStore): AuthoritativePostingService {
  return new AuthoritativePostingService(
    {} as PostingStore,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
}

async function adopt(store: MemoryAdoptionStore, transport: FakeReadTransport) {
  return posting(store).adoptExistingQuickBooksVendor(
    OPERATION_ID,
    ACTOR,
    VENDOR_ID,
    new QuickBooksVendorAdoptionAdapter(transport),
  );
}

describe("safe QuickBooks ENSURE_VENDOR adopt-existing", () => {
  it("adopts only after exact active read-back and records an ADOPTED binding", async () => {
    const store = new MemoryAdoptionStore();
    const transport = new FakeReadTransport(observed());
    await expect(adopt(store, transport)).resolves.toMatchObject({
      state: "SUCCEEDED",
      externalVendorId: VENDOR_ID,
      reasonCodes: ["QUICKBOOKS_VENDOR_ADOPTED_AND_VERIFIED"],
    });
    expect(store.bindingKind).toBe("ADOPTED");
    expect(store.lastNormalizedProviderState).toMatchObject({
      providerVendorId: VENDOR_ID,
      realmId: REALM,
      displayName: "Zaki Sandbox Test Vendor",
      active: true,
    });
    expect(store.events).toEqual([
      "ATTEMPT:VERIFY", "ADOPT_EXISTING", "AUTHORIZED_TO_VERIFYING", "ADOPT_EXISTING:MATCH",
    ]);
    expect(transport.readCalls).toBe(1);
  });

  it("returns exact replay success without another provider read", async () => {
    const store = new MemoryAdoptionStore();
    store.state = "SUCCEEDED";
    store.bindingExternalVendorId = VENDOR_ID;
    store.bindingKind = "ADOPTED";
    const transport = new FakeReadTransport(observed());
    await expect(adopt(store, transport)).resolves.toMatchObject({
      state: "SUCCEEDED", externalVendorId: VENDOR_ID, resumed: true,
    });
    expect(transport.readCalls).toBe(0);
  });

  it("serializes concurrent adoption to one verification attempt and one binding", async () => {
    const store = new MemoryAdoptionStore();
    const transport = new FakeReadTransport(observed());
    const results = await Promise.all([adopt(store, transport), adopt(store, transport)]);
    expect(results.filter((result) => result.state === "SUCCEEDED")).toHaveLength(1);
    expect(store.attempts).toBe(1);
    expect(store.bindingKind).toBe("ADOPTED");
    expect(transport.readCalls).toBe(1);
    await expect(adopt(store, transport)).resolves.toMatchObject({ state: "SUCCEEDED", resumed: true });
    expect(transport.readCalls).toBe(1);
  });

  it("moves a wrong-realm observation to REVIEW without binding", async () => {
    const store = new MemoryAdoptionStore();
    await expect(adopt(store, new FakeReadTransport(observed({ realmId: "wrong-realm" }))))
      .resolves.toMatchObject({ state: "REVIEW", reasonCodes: ["QUICKBOOKS_VENDOR_ADOPTION_REALM_MISMATCH"] });
    expect(store.bindingKind).toBeNull();
  });

  it("moves an inactive Vendor to REVIEW without binding", async () => {
    const store = new MemoryAdoptionStore();
    await expect(adopt(store, new FakeReadTransport(observed({ active: false }))))
      .resolves.toMatchObject({ state: "REVIEW", reasonCodes: ["QUICKBOOKS_VENDOR_ADOPTION_INACTIVE"] });
    expect(store.bindingKind).toBeNull();
  });

  it("moves an exact-name mismatch to REVIEW without binding", async () => {
    const store = new MemoryAdoptionStore();
    await expect(adopt(store, new FakeReadTransport(observed({ displayName: "Different Vendor" }))))
      .resolves.toMatchObject({ state: "REVIEW", reasonCodes: ["QUICKBOOKS_VENDOR_ADOPTION_NAME_MISMATCH"] });
    expect(store.bindingKind).toBeNull();
  });

  it.each([
    ["not found", new FakeReadTransport(null), "VENDOR_ADOPTION_READ_BACK_NOT_FOUND"],
    ["read failure", new FakeReadTransport(observed(), true), "VENDOR_ADOPTION_READ_BACK_UNAVAILABLE"],
  ])("moves a stale %s to REVIEW", async (_label, transport, reasonCode) => {
    const store = new MemoryAdoptionStore();
    await expect(adopt(store, transport)).resolves.toMatchObject({
      state: "REVIEW", reasonCodes: [reasonCode],
    });
    expect(store.bindingKind).toBeNull();
  });

  it("blocks an existing conflicting binding before provider read", async () => {
    const store = new MemoryAdoptionStore();
    store.conflictingBinding = true;
    const transport = new FakeReadTransport(observed());
    await expect(adopt(store, transport)).resolves.toMatchObject({
      state: "REVIEW", reasonCodes: ["EXISTING_VENDOR_BINDING_CONFLICT"],
    });
    expect(transport.readCalls).toBe(0);
    expect(store.attempts).toBe(0);
  });

  it("uses one authenticated GET by provider ID in the exact realm and connection scope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http: QuickBooksHttpClient = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          Vendor: {
            Id: VENDOR_ID,
            DisplayName: "Zaki Sandbox Test Vendor",
            Active: true,
            SyncToken: "4",
          },
        }),
      };
    };
    const adapter = createAuthenticatedQuickBooksVendorAdoptionAdapter(
      { actorUserId: ACTOR.userId, providerConnectionId: CONNECTION_ID, realmId: REALM },
      { getAccess: async () => ({ accessToken: "fake-access-token", realmId: REALM }) },
      http,
    );
    await expect(adapter.readBack(adoptionGrant())).resolves.toMatchObject({
      kind: "OBSERVED",
      observation: { id: VENDOR_ID, realmId: REALM, active: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/v3/company/${REALM}/vendor/${VENDOR_ID}?minorversion=65`);
    expect(calls[0].init.method).toBeUndefined();
    expect(calls[0].init.body).toBeUndefined();
  });

  it("fails closed before HTTP when the provider connection scope differs", async () => {
    let calls = 0;
    const adapter = createAuthenticatedQuickBooksVendorAdoptionAdapter(
      { actorUserId: ACTOR.userId, providerConnectionId: "different-connection", realmId: REALM },
      { getAccess: async () => ({ accessToken: "fake-access-token", realmId: REALM }) },
      async () => {
        calls += 1;
        throw new Error("must not invoke fake HTTP");
      },
    );
    await expect(adapter.readBack(adoptionGrant())).resolves.toEqual({
      kind: "INCONCLUSIVE",
      reasonCode: "VENDOR_ADOPTION_READ_BACK_UNAVAILABLE",
    });
    expect(calls).toBe(0);
  });

  it("uses VERIFY/ADOPTED durability and keeps the Bill child gate intact", () => {
    const migration = readFileSync(
      join(process.cwd(), "..", "supabase", "migrations", "024_quickbooks_vendor_adopt_existing.sql"),
      "utf8",
    );
    const billMigration = readFileSync(
      join(process.cwd(), "..", "supabase", "migrations", "016_quickbooks_bill_execution.sql"),
      "utf8",
    );
    expect(migration).toContain("v_attempt_number, 'VERIFY'");
    expect(migration).toContain("'ADOPTED'");
    expect(migration).toContain("'action', 'ADOPT_EXISTING'");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).not.toContain("QUICKBOOKS_VENDOR_CREATE_ACKNOWLEDGED");
    expect(billMigration).toContain("v_child.current_state <> 'SUCCEEDED'");
    expect(billMigration).toContain("VENDOR_CHILD_UNRESOLVED");
  });
});
