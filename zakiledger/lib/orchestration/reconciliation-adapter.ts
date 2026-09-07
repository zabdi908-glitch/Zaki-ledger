import type { ShadowScope } from "./shadow-contract";
import { fingerprintSortedManifest, shadowSha256 } from "./shadow-canonicalization";
import { canonicalShadowJson } from "./shadow-canonicalization";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReconciliationManifestMember {
  namespace: "bank_transaction" | "accounting_transaction" | "reconciliation_match";
  id: string;
  fingerprint: string;
}

export interface FrozenReconciliationInput extends ShadowScope {
  statementId: string;
  reconciliationVersion: string;
  members: readonly ReconciliationManifestMember[];
}

export interface ReconciliationDomainPort<T> {
  loadManifest(scope: ShadowScope & { statementId: string }): Promise<readonly ReconciliationManifestMember[]>;
  computeAndPersist(input: FrozenReconciliationInput): Promise<T>;
  loadOutputManifest(scope: ShadowScope & { statementId: string }): Promise<readonly ReconciliationManifestMember[]>;
}

export interface ShadowReconciliationResult<T> {
  inputFingerprint: string;
  outputFingerprint: string;
  result: T;
  outputMembers: readonly ReconciliationManifestMember[];
}

export interface ReconciliationSnapshotRecordInput extends ShadowScope {
  runId: string; stageId: string; attemptId: string; workerId: string;
  fencingToken: bigint; statementId: string; role: "INPUT" | "OUTPUT";
  reconciliationVersion: string; members: readonly ReconciliationManifestMember[];
}

export class SupabaseShadowReconciliationSnapshotStore {
  constructor(private readonly db: SupabaseClient) {}

  async record(input: ReconciliationSnapshotRecordInput): Promise<{ id: string; fingerprint: string; reused: boolean }> {
    const fingerprint = fingerprintSortedManifest(
      `step9-reconciliation-${input.role.toLowerCase()}-snapshot-v1`, input.members, memberKey,
    );
    const sorted = [...input.members].sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
    const { data, error } = await this.db.rpc("record_shadow_reconciliation_snapshot_v1", {
      p_run_id: input.runId, p_stage_id: input.stageId, p_attempt_id: input.attemptId,
      p_statement_id: input.statementId, p_snapshot_role: input.role,
      p_reconciliation_version: input.reconciliationVersion,
      p_manifest_canonical_json: canonicalShadowJson(sorted), p_manifest_fingerprint_hex: fingerprint,
      p_worker_id: input.workerId, p_fencing_token: input.fencingToken.toString(10),
    });
    if (error) throw new Error(`SHADOW_RECONCILIATION_SNAPSHOT_FAILED:${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) throw new Error("SHADOW_RECONCILIATION_SNAPSHOT_RETURNED_NO_ROW");
    return { id: String(row.snapshot_id), fingerprint, reused: row.reused === true };
  }
}

/** Freezes both frontiers and rejects evidence drift around the existing Step 4 operation. */
export class ShadowReconciliationAdapter<T> {
  constructor(private readonly domain: ReconciliationDomainPort<T>) {}

  async reconcile(input: Omit<FrozenReconciliationInput, "members">): Promise<ShadowReconciliationResult<T>> {
    if (!input.reconciliationVersion.trim()) throw new Error("RECONCILIATION_VERSION_REQUIRED");
    const scope = { ...input, statementId: input.statementId };
    const before = await this.domain.loadManifest(scope);
    const beforeManifest = fingerprintSortedManifest("step9-reconciliation-frontier-v1", before, memberKey);
    const frozen: FrozenReconciliationInput = { ...input, members: before };
    const inputFingerprint = shadowSha256({
      namespace: "step9-reconciliation-input-v1", ...input, beforeManifest,
    });
    const result = await this.domain.computeAndPersist(frozen);
    const after = await this.domain.loadOutputManifest(scope);
    const afterInputMembers = after.filter((item) => item.namespace !== "reconciliation_match");
    const afterInputManifest = fingerprintSortedManifest(
      "step9-reconciliation-frontier-v1", afterInputMembers, memberKey,
    );
    const beforeInputs = before.filter((item) => item.namespace !== "reconciliation_match");
    const stableInputManifest = fingerprintSortedManifest(
      "step9-reconciliation-frontier-v1", beforeInputs, memberKey,
    );
    if (afterInputManifest !== stableInputManifest) throw new Error("RECONCILIATION_FRONTIER_DRIFT_UNCERTAIN");
    return {
      inputFingerprint, result, outputMembers: after,
      outputFingerprint: fingerprintSortedManifest("step9-reconciliation-output-v1", after, memberKey),
    };
  }
}

function memberKey(member: ReconciliationManifestMember): string {
  return `${member.namespace}:${member.id}`;
}
