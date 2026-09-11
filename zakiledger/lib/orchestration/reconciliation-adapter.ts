import type { ShadowScope } from "./shadow-contract";
import { fingerprintSortedManifest, shadowSha256 } from "./shadow-canonicalization";
import { canonicalShadowJson } from "./shadow-canonicalization";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Step4ReconciliationFrontier } from "../reconciliation-store";

export interface ReconciliationManifestMember {
  namespace:
    | "bank_statement"
    | "bank_transaction"
    | "accounting_transaction"
    | "reconciliation_match"
    | "qb_claim_holder";
  id: string;
  fingerprint: string;
}

/** Lossless Step 9 fingerprint projection of the Step 4 semantic frontier. */
export function step4FrontierManifest(
  frontier: Step4ReconciliationFrontier,
): readonly ReconciliationManifestMember[] {
  return [
    manifestMember("bank_statement", frontier.statement),
    ...frontier.bankTransactions.map((row) => manifestMember("bank_transaction", row)),
    ...frontier.qbTransactions.map((row) => manifestMember("accounting_transaction", row)),
    ...frontier.currentStatementMatches.map((row) => manifestMember("reconciliation_match", row)),
    ...frontier.liveQbClaimHolders.map((row) => manifestMember("qb_claim_holder", row)),
  ];
}

function manifestMember(namespace: ReconciliationManifestMember["namespace"], row: object): ReconciliationManifestMember {
  const identified = row as { id: string };
  return {
    namespace,
    id: String(identified.id),
    fingerprint: shadowSha256({ namespace: `step9-${namespace}-v1`, row }),
  };
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
  inputMembers: readonly ReconciliationManifestMember[];
  outputMembers: readonly ReconciliationManifestMember[];
}

export interface ReconciliationSnapshotRecordInput extends ShadowScope {
  runId: string; stageId: string; attemptId: string; workerId: string;
  fencingToken: bigint; statementId: string; role: "INPUT" | "OUTPUT";
  reconciliationVersion: string; members: readonly ReconciliationManifestMember[];
}

export interface ShadowReconciliationSnapshotStore {
  record(input: ReconciliationSnapshotRecordInput): Promise<{ id: string; fingerprint: string; reused: boolean }>;
}

export class SupabaseShadowReconciliationSnapshotStore implements ShadowReconciliationSnapshotStore {
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

  async reconcile(
    input: Omit<FrozenReconciliationInput, "members">,
    snapshots: {
      input?(members: readonly ReconciliationManifestMember[]): Promise<void>;
      output?(members: readonly ReconciliationManifestMember[]): Promise<void>;
    } = {},
  ): Promise<ShadowReconciliationResult<T>> {
    if (!input.reconciliationVersion.trim()) throw new Error("RECONCILIATION_VERSION_REQUIRED");
    const scope = { ...input, statementId: input.statementId };
    const before = await this.domain.loadManifest(scope);
    const beforeManifest = fingerprintSortedManifest("step9-reconciliation-frontier-v1", before, memberKey);
    const frozen: FrozenReconciliationInput = { ...input, members: before };
    const inputFingerprint = shadowSha256({
      namespace: "step9-reconciliation-input-v1", ...input, beforeManifest,
    });
    await snapshots.input?.(before);
    const result = await this.domain.computeAndPersist(frozen);
    const after = await this.domain.loadOutputManifest(scope);
    const afterInputMembers = after.filter(isStableSourceMember);
    const afterInputManifest = fingerprintSortedManifest(
      "step9-reconciliation-frontier-v1", afterInputMembers, memberKey,
    );
    const beforeInputs = before.filter(isStableSourceMember);
    const stableInputManifest = fingerprintSortedManifest(
      "step9-reconciliation-frontier-v1", beforeInputs, memberKey,
    );
    if (afterInputManifest !== stableInputManifest) throw new Error("RECONCILIATION_FRONTIER_DRIFT_UNCERTAIN");
    await snapshots.output?.(after);
    return {
      inputFingerprint, result, inputMembers: before, outputMembers: after,
      outputFingerprint: fingerprintSortedManifest("step9-reconciliation-output-v1", after, memberKey),
    };
  }
}

function memberKey(member: ReconciliationManifestMember): string {
  return `${member.namespace}:${member.id}`;
}

function isStableSourceMember(member: ReconciliationManifestMember): boolean {
  return member.namespace === "bank_statement" || member.namespace === "bank_transaction" ||
    member.namespace === "accounting_transaction";
}
