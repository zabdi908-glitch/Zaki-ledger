export const SHADOW_MODE = "SHADOW" as const;
export type ShadowMode = typeof SHADOW_MODE;

export const SHADOW_STAGES = [
  "INGESTION",
  "EXTRACTION",
  "CANONICAL_UPDATE",
  "RECONCILIATION",
  "BALANCE_PROOF",
  "POLICY_EVALUATION",
  "STEP8_PLANNING",
  "EXCEPTION_OUTPUT",
] as const;
export type ShadowStage = (typeof SHADOW_STAGES)[number];

export const SHADOW_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_SAFE",
  "RETRYABLE",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "UNCERTAIN",
  "CANCELLED",
] as const;
export type ShadowState = (typeof SHADOW_STATES)[number];

export const TERMINAL_SHADOW_STATES = [
  "SUCCEEDED",
  "FAILED_SAFE",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "UNCERTAIN",
  "CANCELLED",
] as const satisfies readonly ShadowState[];

export const SHADOW_STAGE_ORDER: Readonly<Record<ShadowStage, number>> = Object.freeze(
  Object.fromEntries(SHADOW_STAGES.map((stage, index) => [stage, index + 1])) as Record<ShadowStage, number>,
);

const LEGAL_TRANSITIONS: Readonly<Record<ShadowState, readonly ShadowState[]>> = Object.freeze({
  PENDING: ["RUNNING", "CANCELLED", "BLOCKED"],
  // A running handler may be past an unsafe persistence checkpoint. Cancellation
  // is therefore accepted only before work starts or at a RETRYABLE boundary.
  RUNNING: ["SUCCEEDED", "FAILED_SAFE", "RETRYABLE", "REVIEW_REQUIRED", "BLOCKED", "UNCERTAIN"],
  RETRYABLE: ["RUNNING", "FAILED_SAFE", "REVIEW_REQUIRED", "BLOCKED", "UNCERTAIN", "CANCELLED"],
  SUCCEEDED: [],
  FAILED_SAFE: [],
  REVIEW_REQUIRED: [],
  BLOCKED: [],
  UNCERTAIN: [],
  CANCELLED: [],
});

export function isTerminalShadowState(state: ShadowState): boolean {
  return (TERMINAL_SHADOW_STATES as readonly string[]).includes(state);
}

export function assertShadowTransition(from: ShadowState, to: ShadowState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`ILLEGAL_SHADOW_TRANSITION:${from}->${to}`);
  }
}

const RUN_ROLLUP_PRECEDENCE = [
  "UNCERTAIN", "BLOCKED", "REVIEW_REQUIRED", "RETRYABLE", "FAILED_SAFE", "SUCCEEDED",
] as const satisfies readonly ShadowState[];

export function rollupShadowRunState(states: readonly ShadowState[]): ShadowState {
  for (const state of RUN_ROLLUP_PRECEDENCE) {
    if (states.includes(state)) return state;
  }
  if (states.includes("RUNNING")) return "RUNNING";
  if (states.includes("PENDING")) return "PENDING";
  if (states.includes("CANCELLED")) return "CANCELLED";
  throw new Error("SHADOW_RUN_ROLLUP_REQUIRES_STATE");
}

export interface ShadowScope {
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
}

export interface ShadowRunIdentity extends ShadowScope {
  contractVersion: "step9-shadow-orchestration-v1";
  scheduleKey: string;
  requestedFor: string;
}

export interface ShadowRunRequest extends ShadowRunIdentity {
  mode: ShadowMode;
  executionPermitted: false;
  correlationId: string;
}

export interface ImmutableReference {
  namespace: string;
  id: string;
  fingerprint: string;
}

export interface ShadowStageEnvelope<T> {
  schemaVersion: "step9-shadow-stage-envelope-v1";
  runId: string;
  stage: ShadowStage;
  inputFingerprint: string;
  outputFingerprint: string;
  output: T;
  provenance: readonly ImmutableReference[];
}

export interface ShadowLease {
  resourceKey: string;
  ownerId: string;
  fencingToken: bigint;
  expiresAt: string;
}

export interface ShadowRunRecord extends ShadowRunRequest {
  id: string;
  runKey: string;
  inputFingerprint: string;
  state: ShadowState;
  reused: boolean;
}

export interface ShadowStageRecord {
  id: string;
  runId: string;
  stage: ShadowStage;
  ordinal: number;
  state: ShadowState;
  inputFingerprint: string;
  outputFingerprint: string | null;
}

export interface ShadowAttemptRecord {
  id: string;
  stageId: string;
  attemptNumber: number;
  state: ShadowState;
  fencingToken: bigint;
}

export interface StageCompletion<T> {
  state: Exclude<ShadowState, "PENDING" | "RUNNING" | "RETRYABLE">;
  output: T;
  provenance: readonly ImmutableReference[];
  reasonCode: string | null;
}

export function assertShadowOnly(request: Pick<ShadowRunRequest, "mode" | "executionPermitted">): void {
  if (request.mode !== SHADOW_MODE) throw new Error("STEP9_SHADOW_MODE_REQUIRED");
  if (request.executionPermitted !== false) throw new Error("STEP9_EXECUTION_MUST_BE_DISABLED");
}
