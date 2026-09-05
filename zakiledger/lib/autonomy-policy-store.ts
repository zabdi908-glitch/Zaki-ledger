import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalPolicyJsonSha256,
  canonicalPolicyJson,
  policyDecisionKey,
  policyResultSha256,
} from "./autonomy-policy-canonicalization";
import type {
  AutonomyPolicyBundle,
  ClientPolicySnapshot,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
  StoredPolicyDecision,
} from "./autonomy-policy-contract";
import { evaluateAutonomyPolicy } from "./autonomy-policy-evaluator";

export interface PolicyDecisionAuditMetadata {
  policyBundleId: string;
  clientPolicySnapshotId: string;
  requestedBy: string;
  correlationId: string | null;
}

export interface AutonomyPolicyDecisionStore {
  evaluateAndRecord(
    request: PolicyEvaluationRequest,
    audit: PolicyDecisionAuditMetadata,
  ): Promise<StoredPolicyDecision>;
}

export interface AutonomyPolicyArtifactStore {
  publishBundle(input: {
    bundle: AutonomyPolicyBundle;
    publishedBy: string;
    supersedesBundleId: string | null;
  }): Promise<{ id: string; bundleSha256: string }>;
  recordClientSnapshot(input: {
    policyBundleId: string;
    policyBundleSha256: string;
    snapshot: ClientPolicySnapshot;
    recordedBy: string;
    supersedesSnapshotId: string | null;
  }): Promise<{ id: string; snapshotSha256: string }>;
}

interface StoredEntry {
  semanticRecord: string;
  decision: StoredPolicyDecision;
}

/** Test/local store with the same insert-or-return-existing integrity semantics as migration 032. */
export class InMemoryAutonomyPolicyDecisionStore implements AutonomyPolicyDecisionStore {
  private readonly records = new Map<string, StoredEntry>();
  private nextId = 1;

  async evaluateAndRecord(
    request: PolicyEvaluationRequest,
    _audit: PolicyDecisionAuditMetadata,
  ): Promise<StoredPolicyDecision> {
    const evaluation = evaluateAutonomyPolicy(request);
    const decisionKey = policyDecisionKey(request.bundleSha256, request.clientSnapshotSha256, request.canonicalInput);
    const semanticRecord = canonicalPolicyJson({
      decisionKey,
      policyBundleSha256: request.bundleSha256,
      clientPolicySnapshotSha256: request.clientSnapshotSha256,
      normalizedInputSha256: request.canonicalInput.normalizedInputSha256,
      actionFingerprint: evaluation.actionFingerprint,
      evaluation,
    });
    const existing = this.records.get(decisionKey);
    if (existing) {
      if (existing.semanticRecord !== semanticRecord) throw new Error("DECISION_KEY_INTEGRITY_CONFLICT");
      return { ...existing.decision, reused: true };
    }
    const suffix = String(this.nextId++).padStart(12, "0");
    const decision: StoredPolicyDecision = {
      ...evaluation,
      id: `70000000-0000-4000-8000-${suffix}`,
      normalizedPolicyInputId: `71000000-0000-4000-8000-${suffix}`,
      decisionKey,
      reused: false,
    };
    this.records.set(decisionKey, { semanticRecord, decision });
    return decision;
  }

  get size(): number { return this.records.size; }
}

function firstRecord(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new Error("Policy decision RPC returned no record");
  return row as Record<string, unknown>;
}

function scalarId(value: unknown, label: string): string {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar !== "string" || !scalar) throw new Error(`${label} returned no ID`);
  return scalar;
}

export class SupabaseAutonomyPolicyArtifactStore implements AutonomyPolicyArtifactStore {
  constructor(private readonly db: SupabaseClient) {}

  async publishBundle(input: {
    bundle: AutonomyPolicyBundle;
    publishedBy: string;
    supersedesBundleId: string | null;
  }): Promise<{ id: string; bundleSha256: string }> {
    const bundleCanonicalJson = canonicalPolicyJson(input.bundle);
    const bundleSha256 = canonicalPolicyJsonSha256(bundleCanonicalJson);
    const { data, error } = await this.db.rpc("publish_autonomy_policy_bundle_v1", {
      p_policy_version: input.bundle.policyVersion,
      p_contract_version: input.bundle.contractVersion,
      p_canonicalization_version: input.bundle.canonicalizationVersion,
      p_evaluator_version: input.bundle.evaluatorVersion,
      p_bundle_canonical_json: bundleCanonicalJson,
      p_bundle_sha256_hex: bundleSha256,
      p_published_by: input.publishedBy,
      p_supersedes_bundle_id: input.supersedesBundleId,
    });
    if (error) throw new Error(`Autonomy policy bundle persistence failed: ${error.message}`);
    return { id: scalarId(data, "publish_autonomy_policy_bundle_v1"), bundleSha256 };
  }

  async recordClientSnapshot(input: {
    policyBundleId: string;
    policyBundleSha256: string;
    snapshot: ClientPolicySnapshot;
    recordedBy: string;
    supersedesSnapshotId: string | null;
  }): Promise<{ id: string; snapshotSha256: string }> {
    const snapshotCanonicalJson = canonicalPolicyJson(input.snapshot);
    const hashMaterial = canonicalPolicyJson({ namespace: "step7-client-policy-snapshot-v1", bundleSha256: input.policyBundleSha256, snapshot: input.snapshot });
    const snapshotSha256 = canonicalPolicyJsonSha256(hashMaterial);
    const { data, error } = await this.db.rpc("record_client_policy_snapshot_v1", {
      p_client_entity_id: input.snapshot.clientEntityId,
      p_policy_bundle_id: input.policyBundleId,
      p_policy_bundle_sha256_hex: input.policyBundleSha256,
      p_snapshot_version: input.snapshot.snapshotVersion,
      p_snapshot_canonical_json: snapshotCanonicalJson,
      p_snapshot_hash_material_canonical_json: hashMaterial,
      p_snapshot_sha256_hex: snapshotSha256,
      p_max_single_action_amount_minor: input.snapshot.maxSingleActionAmountMinor?.toString(10) ?? null,
      p_max_daily_aggregate_amount_minor: input.snapshot.maxDailyAggregateAmountMinor?.toString(10) ?? null,
      p_recorded_by: input.recordedBy,
      p_supersedes_snapshot_id: input.supersedesSnapshotId,
    });
    if (error) throw new Error(`Client policy snapshot persistence failed: ${error.message}`);
    return { id: scalarId(data, "record_client_policy_snapshot_v1"), snapshotSha256 };
  }
}

export class SupabaseAutonomyPolicyDecisionStore implements AutonomyPolicyDecisionStore {
  constructor(private readonly db: SupabaseClient) {}

  async evaluateAndRecord(
    request: PolicyEvaluationRequest,
    audit: PolicyDecisionAuditMetadata,
  ): Promise<StoredPolicyDecision> {
    const evaluation = evaluateAutonomyPolicy(request);
    const decisionKey = policyDecisionKey(request.bundleSha256, request.clientSnapshotSha256, request.canonicalInput);
    const resultMaterial = {
      decision: evaluation.decision,
      reasonCodes: evaluation.reasonCodes,
      ruleTrace: evaluation.ruleTrace,
      actionFingerprint: evaluation.actionFingerprint,
      policyVersion: evaluation.policyVersion,
      evaluatorVersion: evaluation.evaluatorVersion,
    };
    const verifiedResultHash = policyResultSha256(resultMaterial);
    if (verifiedResultHash !== evaluation.resultSha256) throw new Error("POLICY_RESULT_HASH_MISMATCH");

    const decisionKeyMaterial = {
      namespace: "step7-policy-decision-v1",
      policyBundleSha256: request.bundleSha256,
      clientPolicySnapshotSha256: request.clientSnapshotSha256,
      normalizedInputSha256: request.canonicalInput.normalizedInputSha256,
      computedActionFingerprint: request.canonicalInput.input.action.computedActionFingerprint,
    };

    const { data, error } = await this.db.rpc("record_autonomy_policy_decision_v1", {
      p_policy_bundle_id: audit.policyBundleId,
      p_policy_bundle_sha256_hex: request.bundleSha256,
      p_client_policy_snapshot_id: audit.clientPolicySnapshotId,
      p_client_policy_snapshot_sha256_hex: request.clientSnapshotSha256,
      p_client_entity_id: request.clientSnapshot.clientEntityId,
      p_action_type: request.canonicalInput.input.action.actionType,
      p_action_fingerprint_version: request.canonicalInput.input.action.fingerprintVersion,
      p_claimed_action_fingerprint_hex: request.canonicalInput.input.action.claimedActionFingerprint,
      p_computed_action_fingerprint_hex: request.canonicalInput.input.action.computedActionFingerprint,
      p_action_snapshot_canonical_json: request.canonicalInput.actionSnapshotCanonicalJson,
      p_normalized_input_canonical_json: request.canonicalInput.normalizedInputCanonicalJson,
      p_normalization_issues_canonical_json: canonicalPolicyJson(request.canonicalInput.issues),
      p_input_sha256_hex: request.canonicalInput.normalizedInputSha256,
      p_submitted_payload_sha256_hex: request.canonicalInput.submittedPayloadSha256,
      p_amount_minor: request.canonicalInput.input.amount.amountMinor?.toString(10) ?? null,
      p_daily_aggregate_before_minor: request.canonicalInput.input.amount.dailyAggregateBeforeMinor?.toString(10) ?? null,
      p_currency_code: request.canonicalInput.input.amount.currencyCode,
      p_decision_key_hex: decisionKey,
      p_decision_key_material_canonical_json: canonicalPolicyJson(decisionKeyMaterial),
      p_decision: evaluation.decision,
      p_reason_codes: evaluation.reasonCodes,
      p_rule_trace_canonical_json: canonicalPolicyJson(evaluation.ruleTrace),
      p_result_canonical_json: canonicalPolicyJson(resultMaterial),
      p_result_sha256_hex: evaluation.resultSha256,
      p_evaluator_version: evaluation.evaluatorVersion,
      p_requested_by: audit.requestedBy,
      p_correlation_id: audit.correlationId,
    });
    if (error) throw new Error(`Autonomy policy decision persistence failed: ${error.message}`);
    const row = firstRecord(data);
    if (row.decision_key !== decisionKey || row.result_sha256 !== evaluation.resultSha256 || row.decision !== evaluation.decision) throw new Error("DECISION_KEY_INTEGRITY_CONFLICT");
    return {
      ...evaluation,
      id: String(row.decision_id),
      normalizedPolicyInputId: String(row.normalized_policy_input_id),
      decisionKey,
      reused: row.reused === true,
    };
  }
}
