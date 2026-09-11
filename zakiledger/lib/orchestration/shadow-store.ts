import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertShadowOnly,
  assertShadowTransition,
  isTerminalShadowState,
  SHADOW_STAGE_ORDER,
  type ImmutableReference,
  type ShadowAttemptRecord,
  type ShadowLease,
  type ShadowRunRecord,
  type ShadowRunRequest,
  type ShadowStage,
  type ShadowStageRecord,
  type ShadowState,
} from "./shadow-contract";
import {
  canonicalShadowJson,
  fingerprintShadowRun,
  fingerprintStageOutput,
  shadowSha256,
} from "./shadow-canonicalization";

export interface BeginStageInput {
  runId: string;
  stage: ShadowStage;
  inputFingerprint: string;
  workerId: string;
  leaseSeconds?: number;
}

export interface BeginStageResult {
  stage: ShadowStageRecord;
  attempt: ShadowAttemptRecord;
  lease: ShadowLease;
}

export interface SucceededStageCheckpoint {
  stage: ShadowStageRecord;
  scope: { practiceId: string; clientEntityId: string; ledgerBookId: string };
  output: unknown;
  provenance: readonly ImmutableReference[];
}

export interface FinalizeStageInput<T> {
  runId: string;
  stageId: string;
  attemptId: string;
  stage: ShadowStage;
  workerId: string;
  fencingToken: bigint;
  state: Exclude<ShadowState, "PENDING" | "RUNNING" | "RETRYABLE">;
  inputFingerprint: string;
  output: T;
  provenance: readonly ImmutableReference[];
  reasonCode: string | null;
}

export interface ShadowOrchestrationStore {
  createOrReuseRun(request: ShadowRunRequest): Promise<ShadowRunRecord>;
  loadSucceededStage(runId: string, stage: ShadowStage): Promise<SucceededStageCheckpoint | null>;
  beginStage(input: BeginStageInput): Promise<BeginStageResult>;
  renewLease(lease: ShadowLease, leaseSeconds?: number): Promise<ShadowLease>;
  markStageRetryable(input: {
    runId: string; stageId: string; attemptId: string; workerId: string;
    fencingToken: bigint; reasonCode: string;
  }): Promise<void>;
  finalizeStage<T>(input: FinalizeStageInput<T>): Promise<{ outputFingerprint: string; reused: boolean }>;
}

interface MemoryRun extends ShadowRunRecord { terminal: boolean }
interface MemoryStage extends ShadowStageRecord { attempts: number }
interface MemoryAttempt extends ShadowAttemptRecord { workerId: string }
interface MemoryOutput {
  canonical: string;
  fingerprint: string;
  output: unknown;
  provenance: readonly ImmutableReference[];
}

/** Deterministic local store mirroring migration 034 conflict and fencing semantics. */
export class InMemoryShadowOrchestrationStore implements ShadowOrchestrationStore {
  private sequence = 0;
  private fence = 0n;
  private readonly runs = new Map<string, MemoryRun>();
  private readonly stages = new Map<string, MemoryStage>();
  private readonly attempts = new Map<string, MemoryAttempt>();
  private readonly leases = new Map<string, ShadowLease>();
  private readonly outputs = new Map<string, MemoryOutput>();

  private id(prefix: string): string { return `${prefix}-${++this.sequence}`; }

  async createOrReuseRun(request: ShadowRunRequest): Promise<ShadowRunRecord> {
    assertShadowOnly(request);
    const inputFingerprint = fingerprintShadowRun(request);
    const runKey = shadowSha256({ namespace: "step9-shadow-run-key-v1", inputFingerprint });
    const existing = this.runs.get(runKey);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) throw new Error("SHADOW_RUN_KEY_INTEGRITY_CONFLICT");
      return { ...existing, reused: true };
    }
    const run: MemoryRun = {
      ...request,
      id: this.id("run"),
      runKey,
      inputFingerprint,
      state: "PENDING",
      reused: false,
      terminal: false,
    };
    this.runs.set(runKey, run);
    return run;
  }

  async loadSucceededStage(runId: string, stageName: ShadowStage): Promise<SucceededStageCheckpoint | null> {
    const run = [...this.runs.values()].find((item) => item.id === runId);
    if (!run) throw new Error("SHADOW_RUN_NOT_FOUND");
    const stage = this.stages.get(`${runId}:${stageName}`);
    if (!stage || !isTerminalShadowState(stage.state)) return null;
    if (stage.state !== "SUCCEEDED") throw new Error("SHADOW_RESUME_COMPLETED_STAGE_NOT_SUCCEEDED");
    const persisted = this.outputs.get(stage.id);
    if (!persisted) throw new Error("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_MISSING");
    const expected = fingerprintStageOutput(stageName, persisted.output, persisted.provenance);
    const canonical = canonicalShadowJson({
      inputFingerprint: stage.inputFingerprint, output: persisted.output,
      provenance: persisted.provenance, reasonCode: null,
    });
    if (stage.outputFingerprint !== persisted.fingerprint || expected !== persisted.fingerprint ||
        canonical !== persisted.canonical) {
      throw new Error("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_FINGERPRINT_MISMATCH");
    }
    return {
      stage: { ...stage },
      scope: { practiceId: run.practiceId, clientEntityId: run.clientEntityId, ledgerBookId: run.ledgerBookId },
      output: persisted.output, provenance: persisted.provenance,
    };
  }

  async beginStage(input: BeginStageInput): Promise<BeginStageResult> {
    const run = [...this.runs.values()].find((item) => item.id === input.runId);
    if (!run) throw new Error("SHADOW_RUN_NOT_FOUND");
    if (run.terminal || isTerminalShadowState(run.state)) throw new Error("TERMINAL_SHADOW_RUN_CANNOT_REOPEN");
    const key = `${input.runId}:${input.stage}`;
    let stage = this.stages.get(key);
    if (stage && isTerminalShadowState(stage.state)) throw new Error("TERMINAL_SHADOW_STAGE_CANNOT_REOPEN");
    if (stage && stage.inputFingerprint !== input.inputFingerprint) throw new Error("SHADOW_STAGE_INPUT_CONFLICT");
    if (!stage) {
      stage = {
        id: this.id("stage"), runId: input.runId, stage: input.stage,
        ordinal: SHADOW_STAGE_ORDER[input.stage], state: "PENDING",
        inputFingerprint: input.inputFingerprint, outputFingerprint: null, attempts: 0,
      };
      this.stages.set(key, stage);
    }
    const resourceKey = shadowSha256({
      namespace: "step9-shadow-lease-v1", practiceId: run.practiceId,
      clientEntityId: run.clientEntityId, ledgerBookId: run.ledgerBookId, stage: input.stage,
    });
    const active = this.leases.get(resourceKey);
    if (active && Date.parse(active.expiresAt) > Date.now()) throw new Error("SHADOW_LEASE_HELD");
    if (stage.state === "RUNNING") {
      const prior = [...this.attempts.values()]
        .filter((item) => item.stageId === stage!.id && item.state === "RUNNING")
        .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
      if (prior) prior.state = "RETRYABLE";
      stage.state = "RETRYABLE";
    }
    assertShadowTransition(stage.state, "RUNNING");
    stage.state = "RUNNING";
    stage.attempts += 1;
    if (run.state === "PENDING" || run.state === "RETRYABLE") run.state = "RUNNING";
    const lease: ShadowLease = {
      resourceKey, ownerId: input.workerId, fencingToken: ++this.fence,
      expiresAt: new Date(Date.now() + (input.leaseSeconds ?? 120) * 1_000).toISOString(),
    };
    this.leases.set(resourceKey, lease);
    const attempt: MemoryAttempt = {
      id: this.id("attempt"), stageId: stage.id, attemptNumber: stage.attempts,
      state: "RUNNING", fencingToken: lease.fencingToken, workerId: input.workerId,
    };
    this.attempts.set(attempt.id, attempt);
    return { stage: { ...stage }, attempt: { ...attempt }, lease: { ...lease } };
  }

  async renewLease(lease: ShadowLease, leaseSeconds = 120): Promise<ShadowLease> {
    const current = this.leases.get(lease.resourceKey);
    if (!current || current.ownerId !== lease.ownerId || current.fencingToken !== lease.fencingToken) {
      throw new Error("STALE_SHADOW_FENCE");
    }
    if (Date.parse(current.expiresAt) <= Date.now()) throw new Error("STALE_SHADOW_FENCE");
    current.expiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    return { ...current };
  }

  async markStageRetryable(input: {
    runId: string; stageId: string; attemptId: string; workerId: string;
    fencingToken: bigint; reasonCode: string;
  }): Promise<void> {
    const stage = [...this.stages.values()].find((item) => item.id === input.stageId);
    const attempt = this.attempts.get(input.attemptId);
    const lease = [...this.leases.values()].find((item) => item.fencingToken === input.fencingToken);
    if (!stage || !attempt || stage.runId !== input.runId || attempt.stageId !== stage.id) {
      throw new Error("SHADOW_ATTEMPT_NOT_FOUND");
    }
    if (!lease || lease.ownerId !== input.workerId || attempt.workerId !== input.workerId ||
        attempt.fencingToken !== input.fencingToken) throw new Error("STALE_SHADOW_FENCE");
    assertShadowTransition(stage.state, "RETRYABLE");
    stage.state = "RETRYABLE";
    attempt.state = "RETRYABLE";
    const run = [...this.runs.values()].find((item) => item.id === input.runId)!;
    assertShadowTransition(run.state === "PENDING" ? "RUNNING" : run.state, "RETRYABLE");
    run.state = "RETRYABLE";
    lease.expiresAt = new Date(0).toISOString();
  }

  async finalizeStage<T>(input: FinalizeStageInput<T>): Promise<{ outputFingerprint: string; reused: boolean }> {
    const stage = [...this.stages.values()].find((item) => item.id === input.stageId);
    const attempt = this.attempts.get(input.attemptId);
    if (!stage || !attempt || stage.runId !== input.runId || attempt.stageId !== stage.id) {
      throw new Error("SHADOW_ATTEMPT_NOT_FOUND");
    }
    const lease = [...this.leases.values()].find((item) => item.fencingToken === input.fencingToken);
    if (!lease || lease.ownerId !== input.workerId || attempt.workerId !== input.workerId ||
        attempt.fencingToken !== input.fencingToken || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new Error("STALE_SHADOW_FENCE");
    }
    if (stage.inputFingerprint !== input.inputFingerprint) throw new Error("SHADOW_STAGE_INPUT_CONFLICT");
    const outputFingerprint = fingerprintStageOutput(input.stage, input.output, input.provenance);
    const canonical = canonicalShadowJson({
      inputFingerprint: input.inputFingerprint, output: input.output, provenance: input.provenance,
      reasonCode: input.reasonCode,
    });
    const existing = this.outputs.get(stage.id);
    if (existing && (existing.fingerprint !== outputFingerprint || existing.canonical !== canonical)) {
      throw new Error("SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT");
    }
    if (isTerminalShadowState(stage.state)) {
      if (attempt.state !== stage.state || stage.outputFingerprint !== outputFingerprint) {
        throw new Error("SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT");
      }
      return { outputFingerprint, reused: true };
    }
    if (stage.state !== "RUNNING" || attempt.state !== "RUNNING") throw new Error("SHADOW_ATTEMPT_NOT_RUNNING");
    assertShadowTransition("RUNNING", input.state);
    this.outputs.set(stage.id, {
      canonical, fingerprint: outputFingerprint, output: input.output,
      provenance: input.provenance,
    });
    stage.outputFingerprint = outputFingerprint;
    stage.state = input.state;
    attempt.state = input.state;
    const run = [...this.runs.values()].find((item) => item.id === input.runId)!;
    if (input.stage === "EXCEPTION_OUTPUT") {
      run.state = input.state;
      run.terminal = true;
    }
    return { outputFingerprint, reused: existing !== undefined };
  }
}

function row(value: unknown, label: string): Record<string, unknown> {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object") throw new Error(`${label}_RETURNED_NO_ROW`);
  return item as Record<string, unknown>;
}

/** Service-role-only adapter for migration 034 RPCs. */
export class SupabaseShadowOrchestrationStore implements ShadowOrchestrationStore {
  constructor(private readonly db: SupabaseClient) {}

  async createOrReuseRun(request: ShadowRunRequest): Promise<ShadowRunRecord> {
    assertShadowOnly(request);
    const inputFingerprint = fingerprintShadowRun(request);
    const runKey = shadowSha256({ namespace: "step9-shadow-run-key-v1", inputFingerprint });
    const result = await this.db.rpc("claim_shadow_orchestration_run_v1", {
      p_practice_id: request.practiceId, p_client_entity_id: request.clientEntityId,
      p_ledger_book_id: request.ledgerBookId, p_schedule_key: request.scheduleKey,
      p_requested_for: request.requestedFor, p_correlation_id: request.correlationId,
      p_run_key_hex: runKey, p_input_fingerprint_hex: inputFingerprint,
      p_mode: request.mode, p_execution_permitted: request.executionPermitted,
    });
    if (result.error) throw new Error(`SHADOW_RUN_CLAIM_FAILED:${result.error.message}`);
    const value = row(result.data, "SHADOW_RUN_CLAIM");
    return {
      ...request, id: String(value.run_id), runKey, inputFingerprint,
      state: String(value.state) as ShadowState, reused: value.reused === true,
    };
  }

  async loadSucceededStage(runId: string, stageName: ShadowStage): Promise<SucceededStageCheckpoint | null> {
    const stageResult = await this.db.from("shadow_orchestration_stages")
      .select("id,run_id,practice_id,client_entity_id,ledger_book_id,stage,stage_ordinal,state,input_fingerprint,output_fingerprint")
      .eq("run_id", runId).eq("stage", stageName).maybeSingle();
    if (stageResult.error) throw new Error(`SHADOW_RESUME_STAGE_LOOKUP_FAILED:${stageResult.error.message}`);
    if (!stageResult.data || !isTerminalShadowState(String(stageResult.data.state) as ShadowState)) return null;
    if (stageResult.data.state !== "SUCCEEDED") throw new Error("SHADOW_RESUME_COMPLETED_STAGE_NOT_SUCCEEDED");
    const outputResult = await this.db.from("shadow_orchestration_stage_outputs")
      .select("stage_id,run_id,practice_id,client_entity_id,ledger_book_id,input_fingerprint,output_fingerprint,output_payload,output_canonical_json,provenance,provenance_canonical_json")
      .eq("stage_id", stageResult.data.id).eq("run_id", runId).maybeSingle();
    if (outputResult.error) throw new Error(`SHADOW_RESUME_OUTPUT_LOOKUP_FAILED:${outputResult.error.message}`);
    if (!outputResult.data) throw new Error("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_MISSING");
    const stageInput = databaseSha256(stageResult.data.input_fingerprint, "stage input");
    const stageOutput = databaseSha256(stageResult.data.output_fingerprint, "stage output");
    const outputInput = databaseSha256(outputResult.data.input_fingerprint, "output input");
    const outputFingerprint = databaseSha256(outputResult.data.output_fingerprint, "output fingerprint");
    const provenance = outputResult.data.provenance;
    if (!Array.isArray(provenance) || canonicalShadowJson(outputResult.data.output_payload) !== outputResult.data.output_canonical_json ||
        canonicalShadowJson(provenance) !== outputResult.data.provenance_canonical_json ||
        stageInput !== outputInput || stageOutput !== outputFingerprint ||
        fingerprintStageOutput(stageName, outputResult.data.output_payload, provenance) !== outputFingerprint ||
        stageResult.data.stage !== stageName || outputResult.data.stage_id !== stageResult.data.id ||
        outputResult.data.run_id !== runId || stageResult.data.practice_id !== outputResult.data.practice_id ||
        stageResult.data.client_entity_id !== outputResult.data.client_entity_id ||
        stageResult.data.ledger_book_id !== outputResult.data.ledger_book_id) {
      throw new Error("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_FINGERPRINT_MISMATCH");
    }
    for (const reference of provenance) assertImmutableReference(reference);
    return {
      stage: { id: String(stageResult.data.id), runId, stage: stageName,
        ordinal: Number(stageResult.data.stage_ordinal), state: "SUCCEEDED",
        inputFingerprint: stageInput, outputFingerprint: stageOutput },
      scope: { practiceId: String(stageResult.data.practice_id),
        clientEntityId: String(stageResult.data.client_entity_id),
        ledgerBookId: String(stageResult.data.ledger_book_id) },
      output: outputResult.data.output_payload, provenance,
    };
  }

  async beginStage(input: BeginStageInput): Promise<BeginStageResult> {
    const result = await this.db.rpc("claim_shadow_stage_v1", {
      p_run_id: input.runId, p_stage: input.stage, p_input_fingerprint_hex: input.inputFingerprint,
      p_worker_id: input.workerId, p_lease_seconds: input.leaseSeconds ?? 120,
    });
    if (result.error) throw new Error(`SHADOW_STAGE_CLAIM_FAILED:${result.error.message}`);
    const value = row(result.data, "SHADOW_STAGE_CLAIM");
    return {
      stage: {
        id: String(value.stage_id), runId: input.runId, stage: input.stage,
        ordinal: SHADOW_STAGE_ORDER[input.stage], state: "RUNNING",
        inputFingerprint: input.inputFingerprint, outputFingerprint: null,
      },
      attempt: {
        id: String(value.attempt_id), stageId: String(value.stage_id),
        attemptNumber: Number(value.attempt_number), state: "RUNNING",
        fencingToken: BigInt(String(value.fencing_token)),
      },
      lease: {
        resourceKey: String(value.resource_key), ownerId: input.workerId,
        fencingToken: BigInt(String(value.fencing_token)), expiresAt: String(value.lease_expires_at),
      },
    };
  }

  async renewLease(lease: ShadowLease, leaseSeconds = 120): Promise<ShadowLease> {
    const result = await this.db.rpc("renew_shadow_stage_lease_v1", {
      p_resource_key_hex: lease.resourceKey, p_owner_id: lease.ownerId,
      p_fencing_token: lease.fencingToken.toString(10), p_lease_seconds: leaseSeconds,
    });
    if (result.error) throw new Error(`SHADOW_LEASE_RENEWAL_FAILED:${result.error.message}`);
    const value = row(result.data, "SHADOW_LEASE_RENEWAL");
    return { ...lease, expiresAt: String(value.lease_expires_at) };
  }

  async markStageRetryable(input: {
    runId: string; stageId: string; attemptId: string; workerId: string;
    fencingToken: bigint; reasonCode: string;
  }): Promise<void> {
    const result = await this.db.rpc("mark_shadow_stage_retryable_v1", {
      p_run_id: input.runId, p_stage_id: input.stageId, p_attempt_id: input.attemptId,
      p_worker_id: input.workerId, p_fencing_token: input.fencingToken.toString(10),
      p_reason_code: input.reasonCode,
    });
    if (result.error) throw new Error(`SHADOW_STAGE_RETRY_FAILED:${result.error.message}`);
  }

  async finalizeStage<T>(input: FinalizeStageInput<T>): Promise<{ outputFingerprint: string; reused: boolean }> {
    const outputFingerprint = fingerprintStageOutput(input.stage, input.output, input.provenance);
    const result = await this.db.rpc("finalize_shadow_stage_attempt_v1", {
      p_run_id: input.runId, p_stage_id: input.stageId, p_attempt_id: input.attemptId,
      p_worker_id: input.workerId, p_fencing_token: input.fencingToken.toString(10),
      p_terminal_state: input.state, p_input_fingerprint_hex: input.inputFingerprint,
      p_output_fingerprint_hex: outputFingerprint,
      p_output_canonical_json: canonicalShadowJson(input.output),
      p_provenance_canonical_json: canonicalShadowJson(input.provenance),
      p_reason_code: input.reasonCode,
    });
    if (result.error) throw new Error(`SHADOW_STAGE_FINALIZE_FAILED:${result.error.message}`);
    const value = row(result.data, "SHADOW_STAGE_FINALIZE");
    return { outputFingerprint, reused: value.reused === true };
  }
}

function databaseSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`SHADOW_RESUME_${label.toUpperCase().replaceAll(" ", "_")}_MALFORMED`);
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`SHADOW_RESUME_${label.toUpperCase().replaceAll(" ", "_")}_MALFORMED`);
  }
  return normalized;
}

function assertImmutableReference(value: unknown): asserts value is ImmutableReference {
  const reference = value as Partial<ImmutableReference> | null;
  if (!reference || typeof reference.namespace !== "string" || !reference.namespace ||
      typeof reference.id !== "string" || !reference.id ||
      typeof reference.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(reference.fingerprint)) {
    throw new Error("SHADOW_RESUME_PROVENANCE_MALFORMED");
  }
}
