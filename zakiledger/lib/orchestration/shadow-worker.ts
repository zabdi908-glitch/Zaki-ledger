import {
  assertShadowOnly,
  rollupShadowRunState,
  SHADOW_STAGES,
  type ImmutableReference,
  isTerminalShadowState,
  type ShadowRunRecord,
  type ShadowRunRequest,
  type ShadowStage,
} from "./shadow-contract";
import { fingerprintStageInput } from "./shadow-canonicalization";
import type { ShadowOrchestrationStore } from "./shadow-store";
import type { ShadowAttemptRecord, ShadowLease, ShadowStageRecord } from "./shadow-contract";
import { fingerprintShadowRun } from "./shadow-canonicalization";

export interface ShadowStageContext {
  run: ShadowRunRecord;
  stage: ShadowStage;
  dependencyFingerprint: string | null;
  priorTerminalOutcome: Exclude<ShadowStageHandlerResult["state"], "SUCCEEDED"> | null;
  stageRecord: ShadowStageRecord;
  attempt: ShadowAttemptRecord;
  lease: ShadowLease;
}

export interface ShadowStageHandlerResult {
  state: "SUCCEEDED" | "FAILED_SAFE" | "REVIEW_REQUIRED" | "BLOCKED" | "UNCERTAIN" | "CANCELLED";
  output: unknown;
  provenance: readonly ImmutableReference[];
  reasonCode: string | null;
}

export type ShadowStageHandlers = Partial<Record<ShadowStage, (context: ShadowStageContext) => Promise<ShadowStageHandlerResult>>>;

/**
 * Coordination skeleton only. It ends after STEP8_PLANNING/EXCEPTION_OUTPUT and
 * has no posting dependency, actor, or provider mutation capability.
 */
export class ShadowOrchestrationWorker {
  constructor(
    private readonly store: ShadowOrchestrationStore,
    private readonly workerId: string,
    private readonly handlers: ShadowStageHandlers,
  ) {}

  async run(request: ShadowRunRequest): Promise<ShadowRunRecord> {
    assertShadowOnly(request);
    const run = await this.store.createOrReuseRun(request);
    if (run.inputFingerprint !== fingerprintShadowRun(request)) {
      throw new Error("SHADOW_RUN_KEY_INTEGRITY_CONFLICT");
    }
    // Exact replay is a read/reuse operation. Never ask the store to reopen a
    // terminal run or any of its terminal stages.
    if (run.reused && isTerminalShadowState(run.state)) return run;
    let dependencyFingerprint: string | null = null;
    let priorTerminalOutcome: Exclude<ShadowStageHandlerResult["state"], "SUCCEEDED"> | null = null;

    for (const stage of SHADOW_STAGES) {
      if (priorTerminalOutcome && stage !== "EXCEPTION_OUTPUT") continue;
      const handler = this.handlers[stage];
      if (!handler) {
        throw new Error(`SHADOW_STAGE_HANDLER_MISSING:${stage}`);
      }
      const input = { runInputFingerprint: run.inputFingerprint, dependencyFingerprint };
      const inputFingerprint = fingerprintStageInput(stage, dependencyFingerprint, input);
      const claimed = await this.store.beginStage({
        runId: run.id, stage, inputFingerprint, workerId: this.workerId,
      });
      let result: ShadowStageHandlerResult;
      try {
        result = await handler({
          run, stage, dependencyFingerprint, priorTerminalOutcome,
          stageRecord: claimed.stage, attempt: claimed.attempt, lease: claimed.lease,
        });
      } catch (error) {
        if (stage === "EXCEPTION_OUTPUT") {
          await this.store.markStageRetryable({
            runId: run.id, stageId: claimed.stage.id, attemptId: claimed.attempt.id,
            workerId: this.workerId, fencingToken: claimed.lease.fencingToken,
            reasonCode: "EXCEPTION_OUTPUT_PERSISTENCE_FAILED",
          });
          throw error;
        }
        const classified = classifyShadowFailure(error);
        if (classified.state === "RETRYABLE") {
          await this.store.markStageRetryable({
            runId: run.id, stageId: claimed.stage.id, attemptId: claimed.attempt.id,
            workerId: this.workerId, fencingToken: claimed.lease.fencingToken,
            reasonCode: classified.reasonCode,
          });
          throw error;
        }
        result = {
          state: classified.state,
          output: { reasonCode: classified.reasonCode },
          provenance: [],
          reasonCode: classified.reasonCode,
        };
      }
      if (stage === "POLICY_EVALUATION") {
        const decision = (result.output as { decision?: unknown } | null)?.decision;
        if (decision !== "ALLOW" && decision !== "REVIEW" && decision !== "DENY") {
          throw new Error("INVALID_STEP7_OBSERVATION");
        }
        if (decision === "REVIEW") result = { ...result, state: "REVIEW_REQUIRED" };
        if (decision === "DENY") result = { ...result, state: "BLOCKED" };
      }
      if (stage === "STEP8_PLANNING") {
        const planning = result.output as { decision?: unknown; grantsExecutionPermission?: unknown } | null;
        if (!planning || planning.grantsExecutionPermission !== false ||
            !["SAFE_METHOD", "REVIEW", "NO_SAFE_METHOD"].includes(String(planning.decision))) {
          throw new Error("INVALID_STEP8_OBSERVATION");
        }
        if (planning.decision === "REVIEW") result = { ...result, state: "REVIEW_REQUIRED" };
        if (planning.decision === "NO_SAFE_METHOD") result = { ...result, state: "FAILED_SAFE" };
      }
      const effectiveResult = stage === "EXCEPTION_OUTPUT" && priorTerminalOutcome
        ? { ...result, state: priorTerminalOutcome }
        : result;
      const finalized = await this.store.finalizeStage({
        runId: run.id, stageId: claimed.stage.id, attemptId: claimed.attempt.id,
        stage, workerId: this.workerId, fencingToken: claimed.lease.fencingToken,
        state: effectiveResult.state, inputFingerprint, output: effectiveResult.output,
        provenance: effectiveResult.provenance, reasonCode: effectiveResult.reasonCode,
      });
      dependencyFingerprint = finalized.outputFingerprint;

      // ALLOW and SAFE_METHOD can only appear inside observational output.
      // They never change this control rule or create a downstream execution stage.
      if (stage === "EXCEPTION_OUTPUT") break;
      if (result.state !== "SUCCEEDED") priorTerminalOutcome = result.state;
    }
    return { ...run, state: rollupShadowRunState([priorTerminalOutcome ?? "SUCCEEDED"]) };
  }
}

function classifyShadowFailure(error: unknown): {
  state: "RETRYABLE" | "REVIEW_REQUIRED" | "BLOCKED" | "UNCERTAIN";
  reasonCode: string;
} {
  const message = error instanceof Error ? error.message : "UNKNOWN_SHADOW_STAGE_FAILURE";
  const reasonCode = message.split(":", 1)[0] || "UNKNOWN_SHADOW_STAGE_FAILURE";
  if (reasonCode.includes("UNCERTAIN") || reasonCode.includes("FRONTIER_DRIFT")) {
    return { state: "UNCERTAIN", reasonCode };
  }
  if (reasonCode.includes("REVIEW") || reasonCode.includes("AMBIGUOUS")) {
    return { state: "REVIEW_REQUIRED", reasonCode };
  }
  if (/(INTEGRITY|CONFLICT|MISMATCH|PROHIBITED|INVALID)/.test(reasonCode)) {
    return { state: "BLOCKED", reasonCode };
  }
  return { state: "RETRYABLE", reasonCode };
}
