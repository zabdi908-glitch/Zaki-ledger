import { randomUUID } from "node:crypto";
import { getSupabase } from "./supabase";
import {
  canonicalJson,
  canonicalizePostingIntent,
  type CanonicalPostingIntent,
  type GateDecision,
  type PostingActor,
  type PostingIntent,
  type PostingOperation,
  type PostingReasonCode,
  type PostingState,
  type PostingSubmitResult,
} from "./posting-contract";
import {
  CorePostingSafetyGate,
  Step5DeterministicPermissionGate,
} from "./posting-gates";
import {
  SupabasePostingStore,
  type PostingStore,
  type TransitionResult,
} from "./posting-store";
import {
  type PostingExecutionResult,
  type QuickBooksExecutionStore,
  SupabaseQuickBooksExecutionStore,
} from "./quickbooks-execution-store";
import {
  expectedQuickBooksBillMaterial,
  normalizedQuickBooksBillMaterial,
  quickBooksProviderStateFingerprint,
  type QuickBooksAuthorizedBillGrant,
  type QuickBooksBillRecoveryGrant,
  type QuickBooksPostingAdapter,
  type QuickBooksRecoveryOutcome,
} from "./provider-adapters/quickbooks-posting-adapter";

const PASSIVE_RETRY_STATES = new Set<PostingState>([
  "AUTHORIZED",
  "SUBMITTING",
  "VERIFYING",
  "UNCERTAIN",
  "SUCCEEDED",
  "DENIED",
  "FAILED_SAFE",
]);

function result(
  operation: PostingOperation,
  intent: CanonicalPostingIntent,
  reasonCodes: PostingReasonCode[],
  resumed: boolean,
): PostingSubmitResult {
  return {
    operationId: operation.id,
    state: operation.currentState,
    reasonCodes,
    resumed,
    authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
  };
}

function primaryReason(decision: GateDecision): PostingReasonCode {
  return decision.reasonCodes[0];
}

export class AuthoritativePostingService {
  constructor(
    private readonly store: PostingStore,
    private readonly coreSafetyGate = new CorePostingSafetyGate(),
    private readonly permissionGate = new Step5DeterministicPermissionGate(),
    private readonly executionStore?: QuickBooksExecutionStore,
  ) {}

  async submit(intentInput: PostingIntent, actor: PostingActor): Promise<PostingSubmitResult> {
    const intent = canonicalizePostingIntent(intentInput);
    const claim = await this.store.claimOperation(intent, actor);

    if (claim.kind === "DESTINATION_REJECTED") {
      return {
        operationId: null,
        state: "DENIED",
        reasonCodes: ["DESTINATION_BINDING_MISMATCH"],
        resumed: false,
        authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
      };
    }
    if (claim.kind === "IDEMPOTENCY_CONFLICT" || claim.kind === "DUPLICATE_CREATE_CLAIM") {
      const reasonCode = claim.kind === "IDEMPOTENCY_CONFLICT"
        ? "IDEMPOTENCY_CONFLICT"
        : "DUPLICATE_CREATE_CLAIM";
      return {
        operationId: null,
        state: "DENIED",
        reasonCodes: [reasonCode],
        resumed: false,
        authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
        conflictingOperationId: claim.conflictingOperationId,
      };
    }

    const resumed = claim.kind === "RESUMED";
    let operation = claim.operation;
    if (PASSIVE_RETRY_STATES.has(operation.currentState)) {
      return result(operation, intent, [], resumed);
    }

    // A stale concurrent caller may observe one transition while another call
    // advances the same operation. Reload and continue at most four times; no
    // path in submit can enter SUBMITTING or invoke provider code.
    for (let iteration = 0; iteration < 4; iteration += 1) {
      if (PASSIVE_RETRY_STATES.has(operation.currentState)) {
        return result(operation, intent, [], resumed);
      }

      const context = await this.store.loadValidationContext(intent, actor);
      const coreDecision = this.coreSafetyGate.evaluate(intent, actor, context);
      await this.store.recordDecision(operation, actor, primaryReason(coreDecision), {
        gate: "CorePostingSafetyGate",
        decision: coreDecision.decision,
        reasonCodes: coreDecision.reasonCodes,
        authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
      });

      if (coreDecision.decision === "DENY") {
        const transition = await this.move(
          operation,
          "DENIED",
          actor,
          primaryReason(coreDecision),
        );
        if (transition.kind === "STALE") {
          operation = transition.operation;
          continue;
        }
        return result(transition.operation, intent, coreDecision.reasonCodes, resumed);
      }

      if (coreDecision.decision === "REVIEW") {
        if (operation.currentState === "REVIEW") {
          return result(operation, intent, coreDecision.reasonCodes, resumed);
        }
        const transition = await this.move(
          operation,
          "REVIEW",
          actor,
          primaryReason(coreDecision),
        );
        if (transition.kind === "STALE") {
          operation = transition.operation;
          continue;
        }
        return result(transition.operation, intent, coreDecision.reasonCodes, resumed);
      }

      if (operation.currentState === "PROPOSED" || operation.currentState === "REVIEW") {
        const validated = await this.move(
          operation,
          "VALIDATED",
          actor,
          "CORE_SAFETY_ALLOW",
        );
        if (validated.kind === "STALE") {
          operation = validated.operation;
          continue;
        }
        operation = validated.operation;
      }

      const permissionDecision = this.permissionGate.evaluate(intent, coreDecision, context);
      await this.store.recordDecision(operation, actor, primaryReason(permissionDecision), {
        gate: "Step5DeterministicPermissionGate",
        decision: permissionDecision.decision,
        reasonCodes: permissionDecision.reasonCodes,
        humanApprovalId: intent.humanApprovalId,
        authorizedRequestFingerprint: intent.authorizedRequestFingerprint,
      });

      if (permissionDecision.decision === "ALLOW") {
        const authorized = await this.move(
          operation,
          "AUTHORIZED",
          actor,
          "PERMISSION_ALLOW",
          {
            humanAuthorizationId: intent.humanApprovalId ?? undefined,
            permissionDecisionId: randomUUID(),
          },
        );
        if (authorized.kind === "STALE") {
          operation = authorized.operation;
          continue;
        }
        return result(authorized.operation, intent, permissionDecision.reasonCodes, resumed);
      }

      const targetState = permissionDecision.decision === "DENY" ? "DENIED" : "REVIEW";
      const permissionOutcome = await this.move(
        operation,
        targetState,
        actor,
        primaryReason(permissionDecision),
      );
      if (permissionOutcome.kind === "STALE") {
        operation = permissionOutcome.operation;
        continue;
      }
      return result(
        permissionOutcome.operation,
        intent,
        permissionDecision.reasonCodes,
        resumed,
      );
    }

    operation = await this.store.getOperation(operation.id);
    return result(operation, intent, [], resumed);
  }

  /**
   * Executes only the narrow Day-4 QuickBooks CREATE BILL grant. Operation
   * state, attempt persistence, recovery, binding, and audit remain owned by
   * the authoritative service/store; the adapter owns only provider I/O.
   */
  async executeQuickBooksBill(
    operationId: string,
    actor: PostingActor,
    adapter: QuickBooksPostingAdapter,
  ): Promise<PostingExecutionResult> {
    const executionStore = this.executionStore;
    if (!executionStore) throw new Error("QuickBooks execution store is not configured");

    const prepared = await executionStore.prepareQuickBooksBillSubmission(operationId, actor);
    if (prepared.kind === "SUCCEEDED") {
      return {
        operationId,
        state: "SUCCEEDED",
        externalBillId: prepared.externalBillId,
        reasonCodes: ["EXACT_RETRY_EXISTING_SUCCESS"],
        resumed: true,
        recovered: false,
      };
    }
    if (prepared.kind === "BLOCKED" || prepared.kind === "DENIED") {
      return {
        operationId,
        state: prepared.state,
        externalBillId: null,
        reasonCodes: [prepared.reasonCode],
        resumed: true,
        recovered: false,
      };
    }
    if (prepared.kind === "RECOVERY_REQUIRED") {
      return this.recoverQuickBooksBill(operationId, actor, adapter, executionStore);
    }

    const grant = prepared.grant;
    const submission = await adapter.executeAuthorizedBill(grant);
    if (submission.kind === "FAILED_SAFE" || submission.kind === "UNCERTAIN") {
      return executionStore.recordQuickBooksBillFailure(
        operationId,
        grant.attempt.id,
        submission.kind,
        submission.failure,
      );
    }

    // Persist the provider Bill ID and sanitized acknowledgement before any
    // read-back. A database failure here leaves SUBMITTING, whose retry path is
    // read-only recovery rather than another CREATE.
    await executionStore.recordQuickBooksBillAcknowledged(
      operationId,
      grant.attempt.id,
      submission.externalBillId,
      submission.providerRequestId,
    );
    const observation = await adapter.readBack(grant, submission.externalBillId);
    return this.finishQuickBooksVerification(
      grant,
      grant.attempt.id,
      observation,
      executionStore,
      false,
    );
  }

  private async recoverQuickBooksBill(
    operationId: string,
    actor: PostingActor,
    adapter: QuickBooksPostingAdapter,
    executionStore: QuickBooksExecutionStore,
  ): Promise<PostingExecutionResult> {
    const recovery = await executionStore.beginQuickBooksBillRecovery(operationId, actor);
    if (recovery.kind === "SUCCEEDED") {
      return {
        operationId,
        state: "SUCCEEDED",
        externalBillId: recovery.externalBillId,
        reasonCodes: ["EXACT_RETRY_EXISTING_SUCCESS"],
        resumed: true,
        recovered: true,
      };
    }
    if (recovery.kind === "BLOCKED") {
      return {
        operationId,
        state: recovery.state,
        externalBillId: null,
        reasonCodes: [recovery.reasonCode],
        resumed: true,
        recovered: true,
      };
    }
    const observation = await adapter.recover(recovery.grant);
    return this.finishQuickBooksVerification(
      recovery.grant,
      recovery.grant.attempt.id,
      observation,
      executionStore,
      true,
    );
  }

  private finishQuickBooksVerification(
    grant: QuickBooksAuthorizedBillGrant | QuickBooksBillRecoveryGrant,
    attemptId: string,
    outcome: QuickBooksRecoveryOutcome,
    executionStore: QuickBooksExecutionStore,
    recovered: boolean,
  ): Promise<PostingExecutionResult> {
    if (outcome.kind === "INCONCLUSIVE") {
      return executionStore.recordQuickBooksBillObservation({
        operationId: grant.operation.id,
        attemptId,
        externalBillId: "knownExternalBillId" in grant ? grant.knownExternalBillId : null,
        providerVersion: null,
        providerStateFingerprint: null,
        normalizedProviderState: null,
        comparisonOutcome: "INCONCLUSIVE",
        reasonCode: outcome.reasonCode,
      });
    }

    const observed = outcome.observation;
    const normalized = normalizedQuickBooksBillMaterial(observed);
    const expected = expectedQuickBooksBillMaterial(grant);
    const matches = observed.realmId === grant.operation.externalOrganisationId &&
      canonicalJson(normalized) === canonicalJson(expected);
    return executionStore.recordQuickBooksBillObservation({
      operationId: grant.operation.id,
      attemptId,
      externalBillId: observed.id,
      providerVersion: observed.providerVersion,
      providerStateFingerprint: quickBooksProviderStateFingerprint(observed),
      normalizedProviderState: normalized,
      comparisonOutcome: matches ? "MATCH" : "MISMATCH",
      reasonCode: matches
        ? (recovered ? "QUICKBOOKS_BILL_RECOVERED_AND_VERIFIED" : "QUICKBOOKS_BILL_VERIFIED")
        : "QUICKBOOKS_BILL_MATERIAL_MISMATCH",
    });
  }

  private move(
    operation: PostingOperation,
    toState: PostingState,
    actor: PostingActor,
    reasonCode: PostingReasonCode,
    options?: { humanAuthorizationId?: string; permissionDecisionId?: string },
  ): Promise<TransitionResult> {
    return this.store.transition(operation, toState, actor, reasonCode, options);
  }
}

export function createAuthoritativePostingService(): AuthoritativePostingService {
  const db = getSupabase();
  if (!db) throw new Error("Authoritative posting requires a configured database");
  return new AuthoritativePostingService(
    new SupabasePostingStore(db),
    new CorePostingSafetyGate(),
    new Step5DeterministicPermissionGate(),
    new SupabaseQuickBooksExecutionStore(db),
  );
}
