import type { SupabaseClient } from "@supabase/supabase-js";
import type { PostingActor, PostingState } from "./posting-contract";
import type { SanitizedProviderFailure } from "./provider-adapters/provider-posting-adapter";
import type {
  QuickBooksAuthorizedVendorGrant,
  QuickBooksVendorRecoveryGrant,
} from "./provider-adapters/quickbooks-vendor-posting-adapter";

export interface VendorExecutionResult {
  operationId: string;
  state: PostingState;
  externalVendorId: string | null;
  reasonCodes: string[];
  resumed: boolean;
  recovered: boolean;
}

export type QuickBooksVendorPrepareResult =
  | { kind: "DISPATCH"; grant: QuickBooksAuthorizedVendorGrant }
  | { kind: "RECOVERY_REQUIRED"; state: "SUBMITTING" | "VERIFYING" | "UNCERTAIN" }
  | { kind: "SUCCEEDED"; externalVendorId: string }
  | { kind: "BLOCKED"; state: PostingState; reasonCode: string }
  | { kind: "DENIED"; state: "DENIED"; reasonCode: string };

export type QuickBooksVendorRecoveryPrepareResult =
  | { kind: "RECOVER"; grant: QuickBooksVendorRecoveryGrant }
  | { kind: "SUCCEEDED"; externalVendorId: string }
  | { kind: "BLOCKED"; state: PostingState; reasonCode: string };

export interface QuickBooksVendorExecutionStore {
  prepareQuickBooksVendorSubmission(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksVendorPrepareResult>;
  beginQuickBooksVendorRecovery(
    operationId: string,
    actor: PostingActor,
  ): Promise<QuickBooksVendorRecoveryPrepareResult>;
  recordQuickBooksVendorAcknowledged(
    operationId: string,
    attemptId: string,
    externalVendorId: string,
    providerRequestId: string | null,
  ): Promise<void>;
  recordQuickBooksVendorFailure(
    operationId: string,
    attemptId: string,
    targetState: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<VendorExecutionResult>;
  recordQuickBooksVendorObservation(input: {
    operationId: string;
    attemptId: string;
    externalVendorId: string | null;
    providerVersion: string | null;
    providerStateFingerprint: string | null;
    normalizedProviderState: Record<string, unknown> | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<VendorExecutionResult>;
}

function rpcPayload<T>(data: unknown, label: string): T {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") throw new Error(`${label} returned no payload`);
  return value as T;
}

function mapResult(payload: Record<string, unknown>): VendorExecutionResult {
  return {
    operationId: payload.operationId as string,
    state: payload.state as PostingState,
    externalVendorId: (payload.externalVendorId as string | null) ?? null,
    reasonCodes: (payload.reasonCodes as string[] | undefined) ?? [],
    resumed: Boolean(payload.resumed),
    recovered: Boolean(payload.recovered),
  };
}

export class SupabaseQuickBooksVendorExecutionStore implements QuickBooksVendorExecutionStore {
  constructor(private readonly db: SupabaseClient) {}

  async prepareQuickBooksVendorSubmission(operationId: string, actor: PostingActor):
  Promise<QuickBooksVendorPrepareResult> {
    const { data, error } = await this.db.rpc("prepare_quickbooks_vendor_submission_v1", {
      p_operation_id: operationId,
      p_actor_user_id: actor.userId,
      p_adapter_name: "QuickBooksVendorPostingAdapter",
      p_adapter_version: "step5-vendor-v1",
      p_lease_seconds: 120,
    });
    if (error) throw new Error(`QuickBooks Vendor dispatch preparation failed: ${error.message}`);
    return rpcPayload<QuickBooksVendorPrepareResult>(data, "prepare_quickbooks_vendor_submission_v1");
  }

  async beginQuickBooksVendorRecovery(operationId: string, actor: PostingActor):
  Promise<QuickBooksVendorRecoveryPrepareResult> {
    const { data, error } = await this.db.rpc("begin_quickbooks_vendor_recovery_v1", {
      p_operation_id: operationId,
      p_actor_user_id: actor.userId,
      p_adapter_name: "QuickBooksVendorPostingAdapter",
      p_adapter_version: "step5-vendor-v1",
      p_lease_seconds: 120,
    });
    if (error) throw new Error(`QuickBooks Vendor recovery preparation failed: ${error.message}`);
    return rpcPayload<QuickBooksVendorRecoveryPrepareResult>(data, "begin_quickbooks_vendor_recovery_v1");
  }

  async recordQuickBooksVendorAcknowledged(
    operationId: string,
    attemptId: string,
    externalVendorId: string,
    providerRequestId: string | null,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_quickbooks_vendor_acknowledged_v1", {
      p_operation_id: operationId,
      p_attempt_id: attemptId,
      p_external_vendor_id: externalVendorId,
      p_provider_request_id: providerRequestId,
    });
    if (error) throw new Error(`QuickBooks Vendor acknowledgement persistence failed: ${error.message}`);
  }

  async recordQuickBooksVendorFailure(
    operationId: string,
    attemptId: string,
    targetState: "FAILED_SAFE" | "UNCERTAIN",
    failure: SanitizedProviderFailure,
  ): Promise<VendorExecutionResult> {
    const { data, error } = await this.db.rpc("record_quickbooks_vendor_failure_v1", {
      p_operation_id: operationId,
      p_attempt_id: attemptId,
      p_target_state: targetState,
      p_failure_classification: failure.classification,
      p_failure_code: failure.code,
      p_sanitized_summary: failure.summary,
    });
    if (error) throw new Error(`QuickBooks Vendor failure persistence failed: ${error.message}`);
    return mapResult(rpcPayload<Record<string, unknown>>(data, "record_quickbooks_vendor_failure_v1"));
  }

  async recordQuickBooksVendorObservation(input: {
    operationId: string;
    attemptId: string;
    externalVendorId: string | null;
    providerVersion: string | null;
    providerStateFingerprint: string | null;
    normalizedProviderState: Record<string, unknown> | null;
    comparisonOutcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE";
    reasonCode: string;
  }): Promise<VendorExecutionResult> {
    const { data, error } = await this.db.rpc("record_quickbooks_vendor_observation_v1", {
      p_operation_id: input.operationId,
      p_attempt_id: input.attemptId,
      p_external_vendor_id: input.externalVendorId,
      p_provider_version: input.providerVersion,
      p_provider_state_fingerprint_hex: input.providerStateFingerprint,
      p_normalized_provider_state: input.normalizedProviderState,
      p_comparison_outcome: input.comparisonOutcome,
      p_reason_code: input.reasonCode,
    });
    if (error) throw new Error(`QuickBooks Vendor observation persistence failed: ${error.message}`);
    return mapResult(rpcPayload<Record<string, unknown>>(data, "record_quickbooks_vendor_observation_v1"));
  }
}
