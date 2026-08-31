import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthoritativePostingService } from "../lib/authoritative-posting-service";
import type { PostingActor, PostingState } from "../lib/posting-contract";
import type { PostingStore } from "../lib/posting-store";
import type {
  PostingExecutionResult,
  QuickBooksExecutionStore,
  QuickBooksPrepareResult,
  QuickBooksRecoveryPrepareResult,
} from "../lib/quickbooks-execution-store";
import type { SanitizedProviderFailure } from "../lib/provider-adapters/provider-posting-adapter";
import {
  FakeQuickBooksPostingTransport,
  QuickBooksPostingAdapter,
  QuickBooksSubmissionError,
  type QuickBooksAuthorizedBillGrant,
  type QuickBooksBillRecoveryGrant,
  type QuickBooksPostingTransport,
} from "../lib/provider-adapters/quickbooks-posting-adapter";

const OPERATION_ID = "d4100000-0000-0000-0000-000000000001";
const ACTOR: PostingActor = {
  kind: "USER",
  userId: "d4000000-0000-0000-0000-000000000001",
};

function baseGrant(): QuickBooksAuthorizedBillGrant {
  const scope = {
    practiceId: "d4110000-0000-0000-0000-000000000001",
    clientEntityId: "d4120000-0000-0000-0000-000000000001",
    ledgerBookId: "d4130000-0000-0000-0000-000000000001",
    providerConnectionId: "d4140000-0000-0000-0000-000000000001",
    externalOrganisationId: "fake-realm-day4",
  };
  return {
    operation: {
      id: OPERATION_ID,
      stateAtDispatch: "AUTHORIZED",
      ...scope,
      provider: "quickbooks",
      externalObjectType: "BILL",
      action: "CREATE",
      authorizedRequestFingerprint: "a".repeat(64),
    },
    attempt: {
      id: randomUUID(),
      number: 1,
      kind: "SUBMIT",
      providerIdempotencyToken: `zaki-qb-${OPERATION_ID}-1`,
    },
    accountMapping: {
      id: "d4150000-0000-0000-0000-000000000001",
      providerAccountId: "qb-expense-6100",
      providerAccountType: "Expense",
      scope,
      eligible: true,
    },
    taxMapping: {
      id: "d4160000-0000-0000-0000-000000000001",
      providerTaxCode: "20.0% S",
      evidenceFingerprint: "b".repeat(64),
      scope,
      eligible: true,
    },
    vendorChild: {
      operationId: "d4170000-0000-0000-0000-000000000001",
      state: "SUCCEEDED",
      externalVendorId: "qb-vendor-91",
      verifiedProviderStateFingerprint: "c".repeat(64),
    },
    requestedObject: {
      amount: "120.00",
      currency: "GBP",
      invoiceDate: "2026-08-22",
      invoiceNumber: "INV-DAY4-1",
      description: "Invoice INV-DAY4-1",
    },
    expectedMaterialState: {
      externalObjectType: "BILL",
      status: "OPEN",
      amount: "120.00",
      currency: "GBP",
    },
  };
}

type StoredAttempt = { id: string; kind: "SUBMIT" | "RECOVERY" };

class MemoryQuickBooksExecutionStore implements QuickBooksExecutionStore {
  state: PostingState = "AUTHORIZED";
  accountEligible = true;
  taxValid = true;
  childState: PostingState = "SUCCEEDED";
  knownExternalBillId: string | null = null;
  bindingExternalBillId: string | null = null;
  failAcknowledgementPersistence = false;
  attempts: StoredAttempt[] = [];
  events: Array<{ type: string; details?: Record<string, unknown> }> = [];
  private prepareTail: Promise<void> = Promise.resolve();

  private result(reasonCode: string, recovered = false): PostingExecutionResult {
    return {
      operationId: OPERATION_ID,
      state: this.state,
      externalBillId: this.state === "SUCCEEDED" ? this.bindingExternalBillId : null,
      reasonCodes: [reasonCode],
      resumed: recovered,
      recovered,
    };
  }

  private submissionGrant(): QuickBooksAuthorizedBillGrant {
    const grant = baseGrant();
    const id = randomUUID();
    const attempt = { id, kind: "SUBMIT" as const };
    this.attempts.push(attempt);
    return {
      ...grant,
      attempt: {
        ...grant.attempt,
        id,
        number: this.attempts.length,
      },
    };
  }

  private recoveryGrant(originalState: "SUBMITTING" | "VERIFYING" | "UNCERTAIN"):
  QuickBooksBillRecoveryGrant {
    const grant = baseGrant();
    const id = randomUUID();
    this.attempts.push({ id, kind: "RECOVERY" });
    const { stateAtDispatch: _stateAtDispatch, ...operation } = grant.operation;
    return {
      ...grant,
      operation: { ...operation, stateAtRecovery: originalState },
      attempt: {
        id,
        number: this.attempts.length,
        kind: "RECOVERY",
        providerIdempotencyToken: `zaki-qb-${OPERATION_ID}-recovery-${this.attempts.length}`,
      },
      knownExternalBillId: this.knownExternalBillId,
    };
  }

  async prepareQuickBooksBillSubmission(): Promise<QuickBooksPrepareResult> {
    let release!: () => void;
    const previous = this.prepareTail;
    this.prepareTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.state === "SUCCEEDED") {
        return { kind: "SUCCEEDED", externalBillId: this.bindingExternalBillId! };
      }
      if (this.state === "SUBMITTING" || this.state === "VERIFYING" ||
          this.state === "UNCERTAIN") {
        return { kind: "RECOVERY_REQUIRED", state: this.state };
      }
      if (this.state !== "AUTHORIZED") {
        return { kind: "BLOCKED", state: this.state, reasonCode: "OPERATION_NOT_AUTHORIZED" };
      }
      if (!this.accountEligible) {
        this.state = "DENIED";
        return { kind: "DENIED", state: "DENIED", reasonCode: "DISPATCH_ACCOUNT_MAPPING_INVALID" };
      }
      if (!this.taxValid) {
        this.state = "DENIED";
        return { kind: "DENIED", state: "DENIED", reasonCode: "DISPATCH_TAX_MAPPING_INVALID" };
      }
      if (this.childState !== "SUCCEEDED") {
        return { kind: "BLOCKED", state: this.state, reasonCode: "VENDOR_CHILD_UNRESOLVED" };
      }
      const grant = this.submissionGrant();
      this.events.push({ type: "ATTEMPT_PERSISTED" });
      this.state = "SUBMITTING";
      this.events.push({ type: "AUTHORIZED_TO_SUBMITTING" });
      return { kind: "DISPATCH", grant };
    } finally {
      release();
    }
  }

  async beginQuickBooksBillRecovery(): Promise<QuickBooksRecoveryPrepareResult> {
    if (this.state === "SUCCEEDED") {
      return { kind: "SUCCEEDED", externalBillId: this.bindingExternalBillId! };
    }
    if (this.state !== "SUBMITTING" && this.state !== "VERIFYING" &&
        this.state !== "UNCERTAIN") {
      return { kind: "BLOCKED", state: this.state, reasonCode: "RECOVERY_STATE_NOT_ELIGIBLE" };
    }
    const original = this.state;
    const grant = this.recoveryGrant(original);
    this.state = "VERIFYING";
    this.events.push({ type: "READ_ONLY_RECOVERY" });
    return { kind: "RECOVER", grant };
  }

  async recordQuickBooksBillAcknowledged(
    _operationId: string,
    _attemptId: string,
    externalBillId: string,
  ): Promise<void> {
    if (this.failAcknowledgementPersistence) {
      throw new Error("simulated acknowledgement persistence crash");
    }
    this.knownExternalBillId = externalBillId;
    this.events.push({ type: "SANITIZED_ACK", details: { externalBillId, result: "CREATED" } });
    this.state = "VERIFYING";
  }

  async recordQuickBooksBillFailure(
    _operationId: string,
    _attemptId: string,
    targetState: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<PostingExecutionResult> {
    this.state = targetState;
    this.events.push({
      type: "SANITIZED_FAILURE",
      details: { classification: failure.classification, code: failure.code },
    });
    return this.result(failure.code);
  }

  async recordQuickBooksBillObservation(input: {
    externalBillId: string | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<PostingExecutionResult> {
    const attempt = this.attempts.at(-1)!;
    const recovered = attempt.kind === "RECOVERY";
    if (input.comparisonOutcome === "MATCH") {
      this.bindingExternalBillId = input.externalBillId;
      this.state = "SUCCEEDED";
    } else {
      this.state = "UNCERTAIN";
    }
    this.events.push({ type: "OBSERVATION", details: { outcome: input.comparisonOutcome } });
    return this.result(input.reasonCode, recovered);
  }
}

function service(store: MemoryQuickBooksExecutionStore): AuthoritativePostingService {
  return new AuthoritativePostingService(
    {} as PostingStore,
    undefined,
    undefined,
    store,
  );
}

describe("QuickBooksPostingAdapter CREATE BILL", () => {
  it("persists dispatch, creates once, reads back, verifies, binds, and succeeds", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport();
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );

    expect(result.state).toBe("SUCCEEDED");
    expect(result.externalBillId).toBe("fake-bill-1");
    expect(transport.createCalls).toBe(1);
    expect(transport.readCalls).toBe(1);
    expect(transport.lastCreateRequest?.payload.Line[0]).toMatchObject({
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: "qb-expense-6100" },
        TaxCodeRef: { value: "20.0% S" },
      },
    });
    expect(store.events.slice(0, 2).map((event) => event.type)).toEqual([
      "ATTEMPT_PERSISTED",
      "AUTHORIZED_TO_SUBMITTING",
    ]);
    expect(store.bindingExternalBillId).toBe("fake-bill-1");
  });

  it("returns the existing verified result on exact retry after success", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport();
    const posting = service(store);
    const adapter = new QuickBooksPostingAdapter(transport);
    const first = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);
    const retry = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);

    expect(first.state).toBe("SUCCEEDED");
    expect(retry).toMatchObject({
      state: "SUCCEEDED",
      externalBillId: first.externalBillId,
      resumed: true,
    });
    expect(transport.createCalls).toBe(1);
  });

  it("classifies a proven timeout before delivery as FAILED_SAFE", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport("TIMEOUT_BEFORE_DELIVERY");
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result.state).toBe("FAILED_SAFE");
    expect(transport.bills).toHaveLength(0);
  });

  it("classifies timeout after possible provider success as UNCERTAIN", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport("TIMEOUT_AFTER_DELIVERY");
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result.state).toBe("UNCERTAIN");
    expect(transport.bills).toHaveLength(1);
    expect(store.bindingExternalBillId).toBeNull();
  });

  it.each([
    ["provider 500", "QBO_SERVER_ERROR"],
    ["provider rate limit", "QBO_RATE_LIMITED"],
  ])("keeps %s delivery uncertain and never retries CREATE blindly", async (_label, code) => {
    const store = new MemoryQuickBooksExecutionStore();
    let createCalls = 0;
    const transport: QuickBooksPostingTransport = {
      async createBill() {
        createCalls += 1;
        throw new QuickBooksSubmissionError({
          classification: "UNCERTAIN_DELIVERY",
          code,
          summary: "provider response is inconclusive for delivery",
        });
      },
      async readBill() { return null; },
      async findBillsByCorrelation() { return []; },
    };
    const posting = service(store);
    const adapter = new QuickBooksPostingAdapter(transport);

    const first = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);
    const retry = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);

    expect(first).toMatchObject({ state: "UNCERTAIN", reasonCodes: [code] });
    expect(retry).toMatchObject({ state: "UNCERTAIN", recovered: true });
    expect(createCalls).toBe(1);
  });

  it("recovers read-only after acknowledgement persistence crashes post-create", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.failAcknowledgementPersistence = true;
    const transport = new FakeQuickBooksPostingTransport();
    const posting = service(store);
    const adapter = new QuickBooksPostingAdapter(transport);

    await expect(posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter))
      .rejects.toThrow("simulated acknowledgement persistence crash");
    expect(store.state).toBe("SUBMITTING");
    expect(transport.bills).toHaveLength(1);
    expect(transport.createCalls).toBe(1);

    store.failAcknowledgementPersistence = false;
    const recovered = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);
    expect(recovered).toMatchObject({ state: "SUCCEEDED", recovered: true });
    expect(transport.createCalls).toBe(1);
    expect(transport.recoveryCalls).toBe(1);
  });

  it("recovers UNCERTAIN through read-only correlation and verifies the created Bill", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport("TIMEOUT_AFTER_DELIVERY");
    const posting = service(store);
    const adapter = new QuickBooksPostingAdapter(transport);
    await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);
    transport.setMode("SUCCESS");
    const recovered = await posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter);

    expect(recovered).toMatchObject({ state: "SUCCEEDED", recovered: true });
    expect(transport.recoveryCalls).toBe(1);
    expect(transport.createCalls).toBe(1);
  });

  it("keeps UNCERTAIN when read-only recovery cannot prove an outcome", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.state = "UNCERTAIN";
    const transport = new FakeQuickBooksPostingTransport();
    const recovered = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(recovered).toMatchObject({ state: "UNCERTAIN", recovered: true });
    expect(transport.createCalls).toBe(0);
    expect(transport.recoveryCalls).toBe(1);
  });

  it("lets the bounded pilot stop on UNCERTAIN without starting recovery", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.state = "UNCERTAIN";
    const transport = new FakeQuickBooksPostingTransport();
    const stopped = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
      { recoverExisting: false },
    );
    expect(stopped).toMatchObject({
      state: "UNCERTAIN",
      reasonCodes: ["PILOT_STOP_RECOVERY_REQUIRED"],
      recovered: false,
    });
    expect(transport.createCalls).toBe(0);
    expect(transport.recoveryCalls).toBe(0);
  });

  it("maps deterministic provider validation rejection to FAILED_SAFE", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport("VALIDATION_REJECTION");
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result.state).toBe("FAILED_SAFE");
    expect(result.reasonCodes).toEqual(["QBO_VALIDATION_REJECTED"]);
  });

  it("denies a wrong or stale account mapping before creating an attempt", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.accountEligible = false;
    const transport = new FakeQuickBooksPostingTransport();
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result).toMatchObject({ state: "DENIED" });
    expect(result.reasonCodes).toEqual(["DISPATCH_ACCOUNT_MAPPING_INVALID"]);
    expect(store.attempts).toHaveLength(0);
    expect(transport.createCalls).toBe(0);
  });

  it("denies a tax mapping/code/fingerprint mismatch without provider defaults", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.taxValid = false;
    const transport = new FakeQuickBooksPostingTransport();
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result.reasonCodes).toEqual(["DISPATCH_TAX_MAPPING_INVALID"]);
    expect(transport.createCalls).toBe(0);
  });

  it("keeps the operation UNCERTAIN when provider read-back has a tax mismatch", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport("SUCCESS", (bill) => ({
      ...bill,
      lines: bill.lines.map((line) => ({ ...line, providerTaxCode: "WRONG" })),
    }));
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result.state).toBe("UNCERTAIN");
    expect(result.reasonCodes).toEqual(["QUICKBOOKS_BILL_MATERIAL_MISMATCH"]);
    expect(store.bindingExternalBillId).toBeNull();
  });

  it("serializes duplicate concurrent execution to one CREATE and read-only recovery", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    const transport = new FakeQuickBooksPostingTransport();
    const posting = service(store);
    const adapter = new QuickBooksPostingAdapter(transport);
    const results = await Promise.all([
      posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter),
      posting.executeQuickBooksBill(OPERATION_ID, ACTOR, adapter),
    ]);

    expect(transport.createCalls).toBe(1);
    expect(store.attempts.filter((attempt) => attempt.kind === "SUBMIT")).toHaveLength(1);
    expect(results.some((result) => result.state === "SUCCEEDED")).toBe(true);
  });

  it("blocks Bill submission while the ENSURE_VENDOR child is UNCERTAIN", async () => {
    const store = new MemoryQuickBooksExecutionStore();
    store.childState = "UNCERTAIN";
    const transport = new FakeQuickBooksPostingTransport();
    const result = await service(store).executeQuickBooksBill(
      OPERATION_ID,
      ACTOR,
      new QuickBooksPostingAdapter(transport),
    );
    expect(result).toMatchObject({ state: "AUTHORIZED" });
    expect(result.reasonCodes).toEqual(["VENDOR_CHILD_UNRESOLVED"]);
    expect(store.attempts).toHaveLength(0);
    expect(transport.createCalls).toBe(0);
  });
});
