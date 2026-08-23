import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostingActor, PostingState } from "./posting-contract";
import type { SanitizedProviderFailure } from "./provider-adapters/provider-posting-adapter";
import type {
  QuickBooksAuthorizedBillGrant,
  QuickBooksBillRecoveryGrant,
} from "./provider-adapters/quickbooks-posting-adapter";

export interface PostingExecutionResult {
  operationId: string;
  state: PostingState;
  externalBillId: string | null;
  reasonCodes: string[];
  resumed: boolean;
  recovered: boolean;
}

export type QuickBooksPrepareResult =
  | { kind: "DISPATCH"; grant: QuickBooksAuthorizedBillGrant }
  | { kind: "RECOVERY_REQUIRED"; state: "SUBMITTING" | "VERIFYING" | "UNCERTAIN" }
  | { kind: "SUCCEEDED"; externalBillId: string }
  | { kind: "BLOCKED"; state: PostingState; reasonCode: string }
  | { kind: "DENIED"; state: "DENIED"; reasonCode: string };

export type QuickBooksRecoveryPrepareResult =
  | { kind: "RECOVER"; grant: QuickBooksBillRecoveryGrant }
  | { kind: "SUCCEEDED"; externalBillId: string }
  | { kind: "BLOCKED"; state: PostingState; reasonCode: string };

export interface QuickBooksExecutionStore {
  prepareQuickBooksBillSubmission(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksPrepareResult>;
  beginQuickBooksBillRecovery(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksRecoveryPrepareResult>;
  recordQuickBooksBillAcknowledged(
    operationId: string,
    attemptId: string,
    externalBillId: string,
    providerRequestId: string | null,
  ): Promise<void>;
  recordQuickBooksBillFailure(
    operationId: string,
    attemptId: string,
    targetState: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<PostingExecutionResult>;
  recordQuickBooksBillObservation(input: {
    operationId: string;
    attemptId: string;
    externalBillId: string | null;
    providerVersion: string | null;
    providerStateFingerprint: string | null;
    normalizedProviderState: Record<string, unknown> | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<PostingExecutionResult>;
}

function rpcPayload<T>(data: unknown, label: string): T {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") throw new Error(`${label} returned no payload`);
  return value as T;
}

function mapExecutionResult(payload: Record<string, unknown>): PostingExecutionResult {
  return {
    operationId: payload.operationId as string,
    state: payload.state as PostingState,
    externalBillId: (payload.externalBillId as string | null) ?? null,
    reasonCodes: (payload.reasonCodes as string[] | undefined) ?? [],
    resumed: Boolean(payload.resumed),
    recovered: Boolean(payload.recovered),
  };
}

export class SupabaseQuickBooksExecutionStore implements QuickBooksExecutionStore {
  constructor(private readonly db: SupabaseClient) {}

  async prepareQuickBooksBillSubmission(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksPrepareResult> {
    const { data, error } = await this.db.rpc("prepare_quickbooks_bill_submission_v1", {
      p_operation_id: operationId,
      p_actor_user_id: actor.userId,
      p_adapter_name: "QuickBooksPostingAdapter",
      p_adapter_version: "step5-day4-v1",
      p_lease_seconds: 120,
    });
    if (error) throw new Error(`QuickBooks dispatch preparation failed: ${error.message}`);
    return rpcPayload<QuickBooksPrepareResult>(data, "prepare_quickbooks_bill_submission_v1");
  }

  async beginQuickBooksBillRecovery(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksRecoveryPrepareResult> {
    const { data, error } = await this.db.rpc("begin_quickbooks_bill_recovery_v1", {
      p_operation_id: operationId,
      p_actor_user_id: actor.userId,
      p_adapter_name: "QuickBooksPostingAdapter",
      p_adapter_version: "step5-day4-v1",
      p_lease_seconds: 120,
    });
    if (error) throw new Error(`QuickBooks recovery preparation failed: ${error.message}`);
    return rpcPayload<QuickBooksRecoveryPrepareResult>(data, "begin_quickbooks_bill_recovery_v1");
  }

  async recordQuickBooksBillAcknowledged(
    operationId: string,
    attemptId: string,
    externalBillId: string,
    providerRequestId: string | null,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_quickbooks_bill_acknowledged_v1", {
      p_operation_id: operationId,
      p_attempt_id: attemptId,
      p_external_bill_id: externalBillId,
      p_provider_request_id: providerRequestId,
    });
    if (error) throw new Error(`QuickBooks acknowledgement persistence failed: ${error.message}`);
  }

  async recordQuickBooksBillFailure(
    operationId: string,
    attemptId: string,
    targetState: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<PostingExecutionResult> {
    const { data, error } = await this.db.rpc("record_quickbooks_bill_failure_v1", {
      p_operation_id: operationId,
      p_attempt_id: attemptId,
      p_target_state: targetState,
      p_failure_classification: failure.classification,
      p_failure_code: failure.code,
      p_sanitized_summary: failure.summary,
    });
    if (error) throw new Error(`QuickBooks failure persistence failed: ${error.message}`);
    return mapExecutionResult(rpcPayload<Record<string, unknown>>(
      data,
      "record_quickbooks_bill_failure_v1",
    ));
  }

  async recordQuickBooksBillObservation(input: {
    operationId: string;
    attemptId: string;
    externalBillId: string | null;
    providerVersion: string | null;
    providerStateFingerprint: string | null;
    normalizedProviderState: Record<string, unknown> | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<PostingExecutionResult> {
    const { data, error } = await this.db.rpc("record_quickbooks_bill_observation_v1", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_external_bill_id: input.externalBillId,
      p_provider_version: input.providerVersion,
      p_provider_state_fingerprint_hex: input.providerStateFingerprint,
      p_normalized_provider_state: input.normalizedProviderState,
      p_comparison_outcome: input.comparisonOutcome,
      p_reason_code: input.reasonCode,
    });
    if (error) throw new Error(`QuickBooks observation persistence failed: ${error.message}`);
    return mapExecutionResult(rpcPayload<Record<string, unknown>>(
      data,
      "record_quickbooks_bill_observation_v1",
    ));
  }
}
