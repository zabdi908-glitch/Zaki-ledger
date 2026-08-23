import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthoritativePostingService } from "../lib/authoritative-posting-service";
import {
  canonicalJson,
  canonicalizePostingIntent,
  type CanonicalPostingIntent,
  type PostingActor,
  type PostingIntent,
  type PostingOperation,
  type PostingReasonCode,
  type PostingState,
} from "../lib/posting-contract";
import type { PostingValidationContext } from "../lib/posting-gates";
import type {
  ClaimResult,
  PostingStore,
  TransitionResult,
} from "../lib/posting-store";

const ACTOR: PostingActor = {
  kind: "USER",
  userId: "15000000-0000-0000-0000-000000000001",
};

function vendorIntent(overrides: Partial<PostingIntent> = {}): PostingIntent {
  return {
    practiceId: "15100000-0000-0000-0000-000000000001",
    clientEntityId: "15200000-0000-0000-0000-000000000001",
    ledgerBookId: "15300000-0000-0000-0000-000000000001",
    providerConnectionId: "15400000-0000-0000-0000-000000000001",
    provider: "quickbooks",
    externalOrganisationId: "realm-15",
    parentOperationId: null,
    operationKind: "ENSURE_VENDOR",
    externalObjectType: "VENDOR",
    action: "CREATE",
    idempotencyKey: "vendor-key-15",
    sourceActionClaim: {
      sourceKind: "CANONICAL_SUPPLIER",
      sourceId: "supplier-15",
      sourceRevision: "1",
      postingSubjectKey: "supplier-15",
    },
    intentSchemaVersion: "1",
    canonicalizationVersion: "1",
    validationRuleSetVersion: "step5-day3-v1",
    requestedObject: { displayName: "Supplier Fifteen" },
    evidence: [
      {
        kind: "IMPORT_ARTIFACT",
        evidenceId: "15500000-0000-0000-0000-000000000001",
        fingerprint: "a".repeat(64),
      },
    ],
    accountTreatment: [
      { disposition: "NOT_APPLICABLE", reason: "Vendor has no posting account" },
    ],
    taxTreatment: [
      { disposition: "NOT_APPLICABLE", reason: "Vendor has no tax treatment" },
    ],
    expectedMaterialState: { displayName: "Supplier Fifteen" },
    humanApprovalId: "15600000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

function billIntent(overrides: Partial<PostingIntent> = {}): PostingIntent {
  return vendorIntent({
    operationKind: "POST_OBJECT",
    externalObjectType: "BILL",
    idempotencyKey: "bill-key-15",
    sourceActionClaim: {
      sourceKind: "FINANCIAL_DOCUMENT_REVISION",
      sourceId: "15700000-0000-0000-0000-000000000001",
      sourceRevision: "1",
      postingSubjectKey: "bill-15",
    },
    requestedObject: { amount: "100.00", currency: "GBP" },
    accountTreatment: [
      {
        disposition: "MAPPED",
        mappingId: "15800000-0000-0000-0000-000000000001",
      },
    ],
    taxTreatment: [
      {
        disposition: "MAPPED",
        treatmentId: "tax-standard-15",
        providerTaxCode: "TAX",
        evidenceFingerprint: "b".repeat(64),
      },
    ],
    expectedMaterialState: { amount: "100.00", currency: "GBP" },
    ...overrides,
  });
}

function validContext(intent: CanonicalPostingIntent): PostingValidationContext {
  const mappingIds = intent.accountTreatment
    .filter((item) => item.disposition === "MAPPED")
    .map((item) => item.mappingId);
  return {
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
    evidence: intent.evidence.map((item) => ({ evidenceId: item.evidenceId, status: "VALID" })),
    accountMappings: mappingIds.map((mappingId) => ({ mappingId, status: "ELIGIBLE" })),
    humanApproval: intent.humanApprovalId
      ? {
          id: intent.humanApprovalId,
          authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
          practiceId: intent.practiceId,
          clientEntityId: intent.clientEntityId,
          ledgerBookId: intent.ledgerBookId,
          providerConnectionId: intent.providerConnectionId,
          provider: intent.provider,
          externalOrganisationId: intent.externalOrganisationId,
          operationKind: intent.operationKind,
          externalObjectType: intent.externalObjectType,
          action: intent.action,
          approvedByUserId: ACTOR.userId,
          approvedAt: "2026-08-22T10:00:00.000Z",
          expiresAt: "2026-08-23T10:00:00.000Z",
          approverAuthorized: true,
        }
      : null,
    now: "2026-08-22T12:00:00.000Z",
  };
}

type RecordedEvent =
  | { type: "DECISION"; operationId: string; reasonCode: PostingReasonCode }
  | {
      type: "TRANSITION";
      operationId: string;
      priorState: PostingState;
      newState: PostingState;
      reasonCode: PostingReasonCode;
    };

const PERMITTED: Record<PostingState, PostingState[]> = {
  PROPOSED: ["VALIDATED", "REVIEW", "DENIED"],
  REVIEW: ["VALIDATED", "DENIED"],
  VALIDATED: ["AUTHORIZED", "REVIEW", "DENIED"],
  AUTHORIZED: ["SUBMITTING", "REVIEW", "DENIED"],
  SUBMITTING: ["VERIFYING", "FAILED_SAFE", "UNCERTAIN"],
  VERIFYING: ["SUCCEEDED", "FAILED_SAFE", "UNCERTAIN"],
  FAILED_SAFE: ["VALIDATED"],
  UNCERTAIN: ["VERIFYING"],
  DENIED: [],
  SUCCEEDED: [],
};

class MemoryPostingStore implements PostingStore {
  readonly operations = new Map<string, PostingOperation>();
  readonly events: RecordedEvent[] = [];
  private readonly idempotency = new Map<string, string>();
  private readonly sourceClaims = new Map<string, string>();
  private claimTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly contextFactory: (
      intent: CanonicalPostingIntent,
      actor: PostingActor,
    ) => PostingValidationContext = validContext,
  ) {}

  forceState(operationId: string, state: PostingState): void {
    const current = this.operations.get(operationId)!;
    this.operations.set(operationId, { ...current, currentState: state });
  }

  async claimOperation(intent: CanonicalPostingIntent): Promise<ClaimResult> {
    let release!: () => void;
    const previous = this.claimTail;
    this.claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await Promise.resolve();
      const idempotencyKey = canonicalJson([
        intent.clientEntityId,
        intent.ledgerBookId,
        intent.providerConnectionId,
        intent.externalObjectType,
        intent.action,
        intent.idempotencyKey,
      ]);
      const existingId = this.idempotency.get(idempotencyKey);
      if (existingId) {
        const existing = this.operations.get(existingId)!;
        if (existing.authorizedRequestFingerprint !== intent.authorizedRequestFingerprint) {
          return { kind: "IDEMPOTENCY_CONFLICT", conflictingOperationId: existing.id };
        }
        return { kind: "RESUMED", operation: existing };
      }

      if (intent.action === "CREATE" && intent.sourceActionClaimFingerprint) {
        const sourceKey = canonicalJson([
          intent.clientEntityId,
          intent.ledgerBookId,
          intent.providerConnectionId,
          intent.externalObjectType,
          intent.action,
          intent.sourceActionClaimFingerprint,
        ]);
        const claimedId = this.sourceClaims.get(sourceKey);
        if (claimedId) {
          return { kind: "DUPLICATE_CREATE_CLAIM", conflictingOperationId: claimedId };
        }
      }

      const operation: PostingOperation = {
        id: randomUUID(),
        practiceId: intent.practiceId,
        clientEntityId: intent.clientEntityId,
        ledgerBookId: intent.ledgerBookId,
        providerConnectionId: intent.providerConnectionId,
        provider: intent.provider,
        externalOrganisationId: intent.externalOrganisationId,
        parentOperationId: intent.parentOperationId ?? null,
        operationKind: intent.operationKind,
        externalObjectType: intent.externalObjectType,
        action: intent.action,
        idempotencyKey: intent.idempotencyKey,
        sourceActionClaimFingerprint: intent.sourceActionClaimFingerprint,
        authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
        currentState: "PROPOSED",
        humanAuthorizationId: null,
        permissionDecisionId: null,
        rowVersion: 1,
      };
      this.operations.set(operation.id, operation);
      this.idempotency.set(idempotencyKey, operation.id);
      if (intent.action === "CREATE" && intent.sourceActionClaimFingerprint) {
        this.sourceClaims.set(canonicalJson([
          intent.clientEntityId,
          intent.ledgerBookId,
          intent.providerConnectionId,
          intent.externalObjectType,
          intent.action,
          intent.sourceActionClaimFingerprint,
        ]), operation.id);
      }
      return { kind: "CREATED", operation };
    } finally {
      release();
    }
  }

  async getOperation(operationId: string): Promise<PostingOperation> {
    return this.operations.get(operationId)!;
  }

  async loadValidationContext(
    intent: CanonicalPostingIntent,
    actor: PostingActor,
  ): Promise<PostingValidationContext> {
    return this.contextFactory(intent, actor);
  }

  async recordDecision(
    operation: PostingOperation,
    _actor: PostingActor,
    reasonCode: PostingReasonCode,
  ): Promise<void> {
    this.events.push({ type: "DECISION", operationId: operation.id, reasonCode });
  }

  async transition(
    operation: PostingOperation,
    toState: PostingState,
    _actor: PostingActor,
    reasonCode: PostingReasonCode,
    options: { humanAuthorizationId?: string; permissionDecisionId?: string } = {},
  ): Promise<TransitionResult> {
    const current = this.operations.get(operation.id)!;
    if (current.currentState === toState) return { kind: "UNCHANGED", operation: current };
    if (current.currentState !== operation.currentState) return { kind: "STALE", operation: current };
    if (!PERMITTED[current.currentState].includes(toState)) {
      throw new Error(`forbidden transition ${current.currentState} -> ${toState}`);
    }
    if (toState === "AUTHORIZED" &&
        (!options.humanAuthorizationId || !options.permissionDecisionId)) {
      throw new Error("AUTHORIZED requires human authorization and permission");
    }
    const updated: PostingOperation = {
      ...current,
      currentState: toState,
      humanAuthorizationId: options.humanAuthorizationId ?? current.humanAuthorizationId,
      permissionDecisionId: options.permissionDecisionId ?? current.permissionDecisionId,
      rowVersion: current.rowVersion + 1,
    };
    this.operations.set(updated.id, updated);
    this.events.push({
      type: "TRANSITION",
      operationId: updated.id,
      priorState: current.currentState,
      newState: toState,
      reasonCode,
    });
    return { kind: "TRANSITIONED", operation: updated };
  }
}

describe("AuthoritativePostingService.submit", () => {
  it("same key plus same intent resumes the one authorized operation", async () => {
    const store = new MemoryPostingStore();
    const service = new AuthoritativePostingService(store);
    const intent = vendorIntent();
    const first = await service.submit(intent, ACTOR);
    const second = await service.submit(intent, ACTOR);

    expect(first.state).toBe("AUTHORIZED");
    expect(second.state).toBe("AUTHORIZED");
    expect(second.operationId).toBe(first.operationId);
    expect(second.resumed).toBe(true);
    expect(store.operations).toHaveLength(1);
  });

  it("same scoped key plus different intent is deterministically denied", async () => {
    const store = new MemoryPostingStore();
    const service = new AuthoritativePostingService(store);
    await service.submit(vendorIntent(), ACTOR);
    const conflict = await service.submit(
      vendorIntent({ requestedObject: { displayName: "Different Supplier" } }),
      ACTOR,
    );

    expect(conflict.state).toBe("DENIED");
    expect(conflict.reasonCodes).toEqual(["IDEMPOTENCY_CONFLICT"]);
    expect(conflict.conflictingOperationId).toBeTruthy();
    expect(store.operations).toHaveLength(1);
  });

  it("duplicate CREATE business effect under another key is denied", async () => {
    const store = new MemoryPostingStore();
    const service = new AuthoritativePostingService(store);
    await service.submit(vendorIntent(), ACTOR);
    const duplicate = await service.submit(
      vendorIntent({ idempotencyKey: "another-caller-key" }),
      ACTOR,
    );

    expect(duplicate.state).toBe("DENIED");
    expect(duplicate.reasonCodes).toEqual(["DUPLICATE_CREATE_CLAIM"]);
    expect(store.operations).toHaveLength(1);
  });

  it("serializes duplicate financial-document delivery under distinct approval keys", async () => {
    const store = new MemoryPostingStore();
    const service = new AuthoritativePostingService(store);
    const document = billIntent();
    const duplicateDelivery = billIntent({ idempotencyKey: "duplicate-document-delivery-key" });

    const results = await Promise.all([
      service.submit(document, ACTOR),
      service.submit(duplicateDelivery, ACTOR),
    ]);

    expect(results.filter((result) => result.state === "AUTHORIZED")).toHaveLength(1);
    expect(results.filter((result) => result.state === "DENIED")).toMatchObject([
      { reasonCodes: ["DUPLICATE_CREATE_CLAIM"] },
    ]);
    expect(store.operations).toHaveLength(1);
  });

  it("cross-client/book/provider mismatch is denied", async () => {
    const store = new MemoryPostingStore((intent) => ({
      ...validContext(intent),
      destination: {
        clientExists: true,
        clientActive: true,
        ledgerBookMatches: false,
        ledgerBookActive: false,
        providerConnectionMatches: false,
        providerConnectionActive: false,
        currencySupported: true,
      },
    }));
    const denied = await new AuthoritativePostingService(store).submit(vendorIntent(), ACTOR);
    expect(denied.state).toBe("DENIED");
    expect(denied.reasonCodes).toContain("DESTINATION_BINDING_MISMATCH");
  });

  it("inactive or non-postable account mapping is denied", async () => {
    const store = new MemoryPostingStore((intent) => ({
      ...validContext(intent),
      accountMappings: [{
        mappingId: "15800000-0000-0000-0000-000000000001",
        status: "INELIGIBLE",
      }],
    }));
    const denied = await new AuthoritativePostingService(store).submit(billIntent(), ACTOR);
    expect(denied.state).toBe("DENIED");
    expect(denied.reasonCodes).toContain("INELIGIBLE_ACCOUNT_MAPPING");
  });

  it("missing or ambiguous accounting treatment becomes REVIEW", async () => {
    const store = new MemoryPostingStore();
    const reviewed = await new AuthoritativePostingService(store).submit(
      billIntent({
        accountTreatment: [],
        taxTreatment: [{ disposition: "AMBIGUOUS", candidateTreatmentIds: ["tax-a", "tax-b"] }],
      }),
      ACTOR,
    );
    expect(reviewed.state).toBe("REVIEW");
    expect(reviewed.reasonCodes).toContain("MISSING_ACCOUNT_TREATMENT");
    expect(reviewed.reasonCodes).toContain("AMBIGUOUS_TAX_TREATMENT");
  });

  it("deterministic prohibition becomes DENIED", async () => {
    const store = new MemoryPostingStore();
    const denied = await new AuthoritativePostingService(store).submit(
      vendorIntent({ requestedObject: { synthetic: true, liveTarget: true } }),
      ACTOR,
    );
    expect(denied.state).toBe("DENIED");
    expect(denied.reasonCodes).toContain("SYNTHETIC_LIVE_PROHIBITED");
  });

  it("stale approval hash becomes REVIEW", async () => {
    const store = new MemoryPostingStore((intent) => {
      const context = validContext(intent);
      return {
        ...context,
        humanApproval: context.humanApproval
          ? { ...context.humanApproval, authorizedRequestFingerprint: "f".repeat(64) }
          : null,
      };
    });
    const reviewed = await new AuthoritativePostingService(store).submit(vendorIntent(), ACTOR);
    expect(reviewed.state).toBe("REVIEW");
    expect(reviewed.reasonCodes).toEqual(["STALE_APPROVAL_HASH"]);
  });

  it("rejects a refund or negative Bill amount before authorization", async () => {
    const store = new MemoryPostingStore();
    const denied = await new AuthoritativePostingService(store).submit(
      billIntent({
        requestedObject: { amount: "-100.00", currency: "GBP" },
        expectedMaterialState: { amount: "-100.00", currency: "GBP" },
      }),
      ACTOR,
    );

    expect(denied.state).toBe("DENIED");
    expect(denied.reasonCodes).toContain("INVALID_AMOUNT");
    expect(store.events.some(
      (event) => event.type === "TRANSITION" && event.newState === "AUTHORIZED",
    )).toBe(false);
  });

  it("routes a human correction after approval to REVIEW instead of authorizing it", async () => {
    const approvedIntent = canonicalizePostingIntent(billIntent());
    const store = new MemoryPostingStore((correctedIntent) => {
      const context = validContext(correctedIntent);
      return {
        ...context,
        humanApproval: context.humanApproval
          ? {
              ...context.humanApproval,
              authorizedRequestFingerprint: approvedIntent.authorizedRequestFingerprint,
            }
          : null,
      };
    });
    const corrected = await new AuthoritativePostingService(store).submit(
      billIntent({
        requestedObject: { amount: "125.00", currency: "GBP" },
        expectedMaterialState: { amount: "125.00", currency: "GBP" },
      }),
      ACTOR,
    );

    expect(corrected.state).toBe("REVIEW");
    expect(corrected.reasonCodes).toEqual(["STALE_APPROVAL_HASH"]);
    expect(store.events.some(
      (event) => event.type === "TRANSITION" && event.newState === "AUTHORIZED",
    )).toBe(false);
  });

  it("invalid evidence fingerprint is denied and missing evidence is reviewed", async () => {
    const mismatchStore = new MemoryPostingStore((intent) => ({
      ...validContext(intent),
      evidence: [{ evidenceId: intent.evidence[0].evidenceId, status: "HASH_MISMATCH" }],
    }));
    const mismatch = await new AuthoritativePostingService(mismatchStore).submit(vendorIntent(), ACTOR);
    expect(mismatch.state).toBe("DENIED");
    expect(mismatch.reasonCodes).toContain("EVIDENCE_FINGERPRINT_MISMATCH");

    const missingStore = new MemoryPostingStore();
    const missing = await new AuthoritativePostingService(missingStore).submit(
      vendorIntent({ evidence: [] }),
      ACTOR,
    );
    expect(missing.state).toBe("REVIEW");
    expect(missing.reasonCodes).toContain("MISSING_EVIDENCE");
  });

  it("valid intent transitions PROPOSED -> VALIDATED -> AUTHORIZED only", async () => {
    const store = new MemoryPostingStore();
    const authorized = await new AuthoritativePostingService(store).submit(vendorIntent(), ACTOR);
    const transitions = store.events.filter(
      (event): event is Extract<RecordedEvent, { type: "TRANSITION" }> => event.type === "TRANSITION",
    );

    expect(authorized.state).toBe("AUTHORIZED");
    expect(authorized.reasonCodes).toEqual(["PERMISSION_ALLOW"]);
    expect(transitions.map((event) => [event.priorState, event.newState])).toEqual([
      ["PROPOSED", "VALIDATED"],
      ["VALIDATED", "AUTHORIZED"],
    ]);
    expect(transitions.some((event) => event.newState === "SUBMITTING")).toBe(false);
  });

  it("concurrent submit calls serialize to one authorized operation", async () => {
    const store = new MemoryPostingStore();
    const service = new AuthoritativePostingService(store);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.submit(vendorIntent(), ACTOR)),
    );

    expect(new Set(results.map((item) => item.operationId))).toHaveLength(1);
    expect(results.every((item) => item.state === "AUTHORIZED")).toBe(true);
    expect(store.operations).toHaveLength(1);
    expect([...store.operations.values()][0].currentState).toBe("AUTHORIZED");
    expect(store.events.some(
      (event) => event.type === "TRANSITION" && event.newState === "SUBMITTING",
    )).toBe(false);
  });

  it("exact retries resume REVIEW and VALIDATED without creating another operation", async () => {
    const reviewStore = new MemoryPostingStore();
    const reviewService = new AuthoritativePostingService(reviewStore);
    const reviewIntent = billIntent({ accountTreatment: [] });
    const firstReview = await reviewService.submit(reviewIntent, ACTOR);
    const secondReview = await reviewService.submit(reviewIntent, ACTOR);
    expect(firstReview.state).toBe("REVIEW");
    expect(secondReview.state).toBe("REVIEW");
    expect(secondReview.operationId).toBe(firstReview.operationId);
    expect(reviewStore.operations).toHaveLength(1);

    const validatedStore = new MemoryPostingStore();
    const validatedService = new AuthoritativePostingService(validatedStore);
    const first = await validatedService.submit(vendorIntent(), ACTOR);
    validatedStore.forceState(first.operationId!, "VALIDATED");
    const resumed = await validatedService.submit(vendorIntent(), ACTOR);
    expect(resumed.operationId).toBe(first.operationId);
    expect(resumed.state).toBe("AUTHORIZED");
    expect(validatedStore.operations).toHaveLength(1);
  });

  it.each(["AUTHORIZED", "SUBMITTING", "UNCERTAIN", "SUCCEEDED"] as const)(
    "exact retry of %s returns existing state without advancing",
    async (state) => {
      const store = new MemoryPostingStore();
      const service = new AuthoritativePostingService(store);
      const first = await service.submit(vendorIntent(), ACTOR);
      store.forceState(first.operationId!, state);
      const eventCount = store.events.length;
      const retry = await service.submit(vendorIntent(), ACTOR);
      expect(retry.operationId).toBe(first.operationId);
      expect(retry.state).toBe(state);
      expect(retry.resumed).toBe(true);
      expect(store.operations).toHaveLength(1);
      expect(store.events).toHaveLength(eventCount);
    },
  );

  it("fingerprinting excludes the caller idempotency key but binds semantic intent", () => {
    const first = canonicalizePostingIntent(vendorIntent({ idempotencyKey: "key-a" }));
    const retryKey = canonicalizePostingIntent(vendorIntent({ idempotencyKey: "key-b" }));
    const changed = canonicalizePostingIntent(vendorIntent({
      requestedObject: { displayName: "Changed" },
    }));
    expect(retryKey.authorizedRequestFingerprint).toBe(first.authorizedRequestFingerprint);
    expect(changed.authorizedRequestFingerprint).not.toBe(first.authorizedRequestFingerprint);
  });
});
