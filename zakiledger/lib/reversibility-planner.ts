import capabilityBundle from "../policies/step8-provider-reversibility-v1.json";
import { auditSha256 } from "./audit-canonicalization";
import type {
  CompoundCorrectionPlan,
  CompoundContinuation,
  CompoundStepResult,
  CorrectionPlanStep,
  ReversibilityMethod,
  ReversibilityPlannerInput,
  ReversibilityPlannerResult,
} from "./reversibility-contract";

const SHA256 = /^[0-9a-f]{64}$/;

const REASON_ORDINALS = new Map(
  capabilityBundle.reasons.map((reason) => [reason.code, reason.ordinal]),
);

type Capability = (typeof capabilityBundle.capabilities)[number];

function ordered(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort((left, right) =>
    (REASON_ORDINALS.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (REASON_ORDINALS.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    (left < right ? -1 : left > right ? 1 : 0));
}

function result(
  decision: ReversibilityPlannerResult["decision"],
  reasonCodes: readonly string[],
  plan: CompoundCorrectionPlan | null = null,
): ReversibilityPlannerResult {
  return {
    decision,
    reasonCodes: ordered(reasonCodes),
    plan,
    capabilityBundleVersion: "step8-provider-reversibility-v1",
    plannerVersion: "step8-pure-reversibility-planner-v1",
    grantsExecutionPermission: false,
  };
}

function capabilitiesFor(input: ReversibilityPlannerInput): Capability[] {
  return capabilityBundle.capabilities.filter((capability) =>
    capability.provider === input.provider &&
    capability.objectType === input.objectType &&
    capability.lifecycleState === input.lifecycleState &&
    capability.desiredCorrection === input.desiredCorrection);
}

function planFingerprintMaterial(steps: readonly CorrectionPlanStep[]) {
  return {
    namespace: "step8-compound-correction-plan-v1",
    executionSemantics: "LINEAR_FAIL_CLOSED",
    steps,
  };
}

export function fingerprintCorrectionPlan(steps: readonly CorrectionPlanStep[]): string {
  assertLinearCorrectionSteps(steps);
  return auditSha256(planFingerprintMaterial(steps));
}

export function assertLinearCorrectionSteps(steps: readonly CorrectionPlanStep[]): void {
  if (steps.length === 0) throw new Error("correction plan must contain at least one step");
  for (const [index, step] of steps.entries()) {
    if (step.index !== index + 1) throw new Error("correction plan steps must be contiguous and one-based");
    if (!SHA256.test(step.requiredBeforeStateFingerprint)) throw new Error("invalid before-state fingerprint");
    if (step.requiredProviderVersionToken.trim() === "") throw new Error("provider version token is required");
    if (step.afterStateVerification !== "READ_BACK_AND_FINGERPRINT") {
      throw new Error("every correction step must require read-back verification");
    }
  }
}

/** Pure sequencing guard only. It performs no step and grants no permission. */
export function classifyCompoundContinuation(
  plan: CompoundCorrectionPlan,
  completed: readonly CompoundStepResult[],
): CompoundContinuation {
  if (plan.contractVersion !== "step8-compound-correction-plan-v1" ||
      plan.executionSemantics !== "LINEAR_FAIL_CLOSED") {
    return { disposition: "STOP", reasonCode: "STEP_RESULTS_INVALID" };
  }
  try {
    assertLinearCorrectionSteps(plan.steps);
  } catch {
    return { disposition: "STOP", reasonCode: "STEP_RESULTS_INVALID" };
  }
  if (plan.fingerprint !== fingerprintCorrectionPlan(plan.steps) || completed.length > plan.steps.length) {
    return { disposition: "STOP", reasonCode: "STEP_RESULTS_INVALID" };
  }
  for (const [index, observed] of completed.entries()) {
    if (observed.stepIndex !== index + 1) {
      return { disposition: "STOP", reasonCode: "STEP_RESULTS_INVALID" };
    }
    if (observed.outcome === "FAILED") return { disposition: "STOP", reasonCode: "PRIOR_STEP_FAILED" };
    if (observed.outcome === "UNCERTAIN") return { disposition: "STOP", reasonCode: "PRIOR_STEP_UNCERTAIN" };
    if (observed.outcome === "SUCCEEDED_UNVERIFIED") {
      return { disposition: "STOP", reasonCode: "PRIOR_STEP_NOT_VERIFIED" };
    }
  }
  if (completed.length === plan.steps.length) return { disposition: "COMPLETE" };
  return { disposition: "READY", nextStepIndex: completed.length + 1 };
}

/**
 * Pure accounting-safety classification. This function accepts all facts as
 * input and performs no provider, network, model, environment, or clock access.
 * SAFE_METHOD describes a correction method; it is never execution authority.
 */
export function planReversibility(input: ReversibilityPlannerInput): ReversibilityPlannerResult {
  if (input.contractVersion !== "step8-reversibility-planner-v1") {
    return result("NO_SAFE_METHOD", ["UNSUPPORTED_CONTRACT_VERSION"]);
  }
  if (input.originalOutcome === "UNCERTAIN") {
    return result("NO_SAFE_METHOD", ["ORIGINAL_OUTCOME_UNCERTAIN"]);
  }

  const missing: string[] = [];
  if (!input.currentState.readCompleted) missing.push("CURRENT_STATE_READ_REQUIRED");
  if (!input.currentState.observedAt) missing.push("CURRENT_STATE_OBSERVED_AT_REQUIRED");
  if (!input.currentState.providerObjectId?.trim()) missing.push("PROVIDER_OBJECT_ID_REQUIRED");
  if (!input.currentState.providerVersionToken?.trim()) missing.push("PROVIDER_VERSION_TOKEN_REQUIRED");
  if (!input.currentState.stateFingerprint || !SHA256.test(input.currentState.stateFingerprint)) {
    missing.push("CURRENT_STATE_FINGERPRINT_REQUIRED");
  }
  if (!input.beforeState.canonical || !input.beforeState.claimedFingerprint) {
    missing.push("BEFORE_STATE_REQUIRED");
  }
  if (missing.length > 0) return result("REVIEW", missing);

  const observedAt = Date.parse(input.currentState.observedAt!);
  const evaluationAsOf = Date.parse(input.evaluationAsOf);
  if (!Number.isFinite(observedAt) || !Number.isFinite(evaluationAsOf)) {
    return result("REVIEW", ["CURRENT_STATE_TIME_INVALID"]);
  }
  const ageMilliseconds = evaluationAsOf - observedAt;
  if (ageMilliseconds < 0) return result("REVIEW", ["CURRENT_STATE_EVIDENCE_FROM_FUTURE"]);
  if (ageMilliseconds > capabilityBundle.maximumCurrentStateAgeSeconds * 1_000) {
    return result("REVIEW", ["CURRENT_STATE_EVIDENCE_STALE"]);
  }

  const computedBeforeFingerprint = auditSha256(input.beforeState.canonical);
  if (computedBeforeFingerprint !== input.beforeState.claimedFingerprint ||
      computedBeforeFingerprint !== input.currentState.stateFingerprint) {
    return result("NO_SAFE_METHOD", ["BEFORE_STATE_FINGERPRINT_MISMATCH"]);
  }

  const unknownChecks = Object.entries(input.checks)
    .filter(([, state]) => state === "UNKNOWN")
    .map(([name]) => ({
      dependencies: "DEPENDENCY_CHECK_INCOMPLETE",
      periodLock: "PERIOD_LOCK_STATE_UNKNOWN",
      tax: "TAX_STATE_UNKNOWN",
      reconciliation: "RECONCILIATION_STATE_UNKNOWN",
    }[name]!));
  if (unknownChecks.length > 0) return result("REVIEW", unknownChecks);

  const blockedChecks = Object.entries(input.checks)
    .filter(([, state]) => state === "BLOCKED")
    .map(([name]) => ({
      dependencies: "LINKED_OBJECT_REVIEW_REQUIRED",
      periodLock: "PERIOD_LOCK_REVIEW_REQUIRED",
      tax: "TAX_REPORTING_REVIEW_REQUIRED",
      reconciliation: "RECONCILIATION_REVIEW_REQUIRED",
    }[name]!));
  if (blockedChecks.length > 0) return result("REVIEW", blockedChecks);

  const capabilities = capabilitiesFor(input);
  if (capabilities.length > 1) {
    return result("REVIEW", ["MULTIPLE_PLAUSIBLE_CORRECTION_METHODS"]);
  }
  const capability = capabilities[0];
  if (!capability) {
    const paidOrLinked = input.lifecycleState === "PAID" ||
      input.lifecycleState === "PART_PAID" || input.lifecycleState === "UNPAID_LINKED";
    return result("NO_SAFE_METHOD", [
      paidOrLinked ? "PAID_OR_LINKED_FINANCIAL_CORRECTION_UNRATIFIED" : "CAPABILITY_NOT_RATIFIED",
    ]);
  }

  const step: CorrectionPlanStep = {
    index: 1,
    method: capability.method as ReversibilityMethod,
    requiredBeforeStateFingerprint: computedBeforeFingerprint,
    requiredProviderVersionToken: input.currentState.providerVersionToken!,
    afterStateVerification: "READ_BACK_AND_FINGERPRINT",
  };
  const steps = [step] as const;
  const plan: CompoundCorrectionPlan = {
    contractVersion: "step8-compound-correction-plan-v1",
    executionSemantics: "LINEAR_FAIL_CLOSED",
    steps,
    fingerprint: fingerprintCorrectionPlan(steps),
  };
  return result("SAFE_METHOD", [capability.reasonCode], plan);
}
