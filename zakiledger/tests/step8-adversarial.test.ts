import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import capabilityBundle from "../policies/step8-provider-reversibility-v1.json";
import { auditSha256 } from "../lib/audit-canonicalization";
import {
  classifyCompoundContinuation,
  fingerprintCorrectionPlan,
  planReversibility,
} from "../lib/reversibility-planner";
import type {
  CompoundCorrectionPlan,
  CorrectionPlanStep,
  ReversibilityPlannerInput,
} from "../lib/reversibility-contract";

const state = { Id: "object-1", SyncToken: "9", status: "ACTIVE" };
const stateFingerprint = auditSha256(state);

function request(overrides: Partial<ReversibilityPlannerInput> = {}): ReversibilityPlannerInput {
  return {
    contractVersion: "step8-reversibility-planner-v1",
    provider: "quickbooks",
    objectType: "QBO_VENDOR",
    lifecycleState: "ACTIVE",
    desiredCorrection: "UPDATE_NON_FINANCIAL",
    originalOutcome: "CONFIRMED",
    currentState: {
      readCompleted: true,
      observedAt: "2026-09-06T12:00:00.000Z",
      providerObjectId: "object-1",
      providerVersionToken: "9",
      stateFingerprint,
    },
    beforeState: { canonical: state, claimedFingerprint: stateFingerprint },
    checks: {
      dependencies: "CLEAR",
      periodLock: "NOT_APPLICABLE",
      tax: "NOT_APPLICABLE",
      reconciliation: "NOT_APPLICABLE",
    },
    evaluationAsOf: "2026-09-06T12:05:00.000Z",
    ...overrides,
  };
}

function step(index: number, method: CorrectionPlanStep["method"]): CorrectionPlanStep {
  return {
    index,
    method,
    requiredBeforeStateFingerprint: stateFingerprint,
    requiredProviderVersionToken: "9",
    afterStateVerification: "READ_BACK_AND_FINGERPRINT",
  };
}

function compound(steps: readonly CorrectionPlanStep[]): CompoundCorrectionPlan {
  return {
    contractVersion: "step8-compound-correction-plan-v1",
    executionSemantics: "LINEAR_FAIL_CLOSED",
    steps,
    fingerprint: fingerprintCorrectionPlan(steps),
  };
}

describe("Step 8 adversarial planner validation", () => {
  it("routes uncertain original outcomes and unsupported tuples to NO_SAFE_METHOD", () => {
    expect(planReversibility(request({ originalOutcome: "UNCERTAIN" }))).toMatchObject({
      decision: "NO_SAFE_METHOD",
      reasonCodes: ["ORIGINAL_OUTCOME_UNCERTAIN"],
      plan: null,
    });
    expect(planReversibility(request({
      provider: "sage" as unknown as ReversibilityPlannerInput["provider"],
      objectType: "SAGE_BILL" as unknown as ReversibilityPlannerInput["objectType"],
      lifecycleState: "POSTED" as unknown as ReversibilityPlannerInput["lifecycleState"],
    }))).toMatchObject({ decision: "NO_SAFE_METHOD", reasonCodes: ["CAPABILITY_NOT_RATIFIED"] });
  });

  it("routes stale deterministic current-state evidence to REVIEW without reading a clock", () => {
    expect(planReversibility(request({ evaluationAsOf: "2026-09-06T12:05:00.001Z" }))).toMatchObject({
      decision: "REVIEW",
      reasonCodes: ["CURRENT_STATE_EVIDENCE_STALE"],
      plan: null,
    });
  });

  it("never selects the first of multiple plausible ratified methods", () => {
    const duplicate = { ...capabilityBundle.capabilities[0], method: "QBO_VENDOR_INACTIVATE" } as
      (typeof capabilityBundle.capabilities)[number];
    capabilityBundle.capabilities.push(duplicate);
    try {
      expect(planReversibility(request())).toMatchObject({
        decision: "REVIEW",
        reasonCodes: ["MULTIPLE_PLAUSIBLE_CORRECTION_METHODS"],
        plan: null,
      });
    } finally {
      capabilityBundle.capabilities.pop();
    }
  });

  it("returns SAFE_METHOD only for one exact ratified tuple", () => {
    expect(planReversibility(request())).toMatchObject({
      decision: "SAFE_METHOD",
      reasonCodes: ["QBO_VENDOR_SPARSE_UPDATE_RATIFIED"],
      grantsExecutionPermission: false,
    });
    expect(planReversibility(request({ desiredCorrection: "DELETE" }))).toMatchObject({
      decision: "NO_SAFE_METHOD",
      reasonCodes: ["CAPABILITY_NOT_RATIFIED"],
      plan: null,
    });
  });

  it("binds compound order into the fingerprint", () => {
    const first = [step(1, "QBO_VENDOR_SPARSE_UPDATE"), step(2, "QBO_VENDOR_INACTIVATE")];
    const reordered = [step(1, "QBO_VENDOR_INACTIVATE"), step(2, "QBO_VENDOR_SPARSE_UPDATE")];
    expect(fingerprintCorrectionPlan(first)).not.toBe(fingerprintCorrectionPlan(reordered));
  });

  it("stops all later compound steps after failure, uncertainty, or missing read-back", () => {
    const plan = compound([
      step(1, "QBO_VENDOR_SPARSE_UPDATE"),
      step(2, "QBO_VENDOR_INACTIVATE"),
    ]);
    expect(classifyCompoundContinuation(plan, [{ stepIndex: 1, outcome: "FAILED" }]))
      .toEqual({ disposition: "STOP", reasonCode: "PRIOR_STEP_FAILED" });
    expect(classifyCompoundContinuation(plan, [{ stepIndex: 1, outcome: "UNCERTAIN" }]))
      .toEqual({ disposition: "STOP", reasonCode: "PRIOR_STEP_UNCERTAIN" });
    expect(classifyCompoundContinuation(plan, [{ stepIndex: 1, outcome: "SUCCEEDED_UNVERIFIED" }]))
      .toEqual({ disposition: "STOP", reasonCode: "PRIOR_STEP_NOT_VERIFIED" });
    expect(classifyCompoundContinuation(plan, [{ stepIndex: 1, outcome: "SUCCEEDED_VERIFIED" }]))
      .toEqual({ disposition: "READY", nextStepIndex: 2 });
  });

  it("contains no provider, model, network, clock, Step 7 decision, or Step 5 execution dependency", () => {
    const source = readFileSync(resolve(process.cwd(), "lib", "reversibility-planner.ts"), "utf8");
    expect(source).not.toMatch(/provider-adapters|openai|anthropic|fetch\s*\(|Date\.now|new Date/i);
    expect(source).not.toMatch(/\b(?:ALLOW|DENY|PolicyDecision|autonomy-policy)\b/);
    expect(source).not.toMatch(/authoritative-posting|posting-store|executeAuthorized|dispatch/i);
    expect(source).toContain("grantsExecutionPermission: false");
  });
});

describe("migration 033 adversarial audit contract", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "..", "supabase", "migrations", "033_audit_reversibility_foundation.sql"),
    "utf8",
  );

  it("replays identical event keys and rejects changed content under the same key", () => {
    expect(sql).toContain("'reused', v_reused");
    expect(sql).toContain("v_reused := true");
    expect(sql).toContain("v_existing.event_payload_canonical_json <> p_event_payload_canonical_json");
    expect(sql).toContain("AUDIT_EVENT_KEY_INTEGRITY_CONFLICT");
  });

  it("rejects broken previous-event, event, content, and state-snapshot hashes", () => {
    expect(sql).toContain("AUDIT_PREVIOUS_EVENT_HASH_MISMATCH");
    expect(sql).toContain("AUDIT_EVENT_HASH_MISMATCH");
    expect(sql).toContain("AUDIT_CONTENT_HASH_MISMATCH");
    expect(sql).toContain("AUDIT_STATE_SNAPSHOT_HASH_MISMATCH");
    expect(sql).toContain("audit_events_integrity_before");
    expect(sql).toContain("audit_state_snapshots_integrity");
  });

  it("rejects cross-practice/client/book audit and correction links", () => {
    expect(sql).toContain("ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id");
    expect(sql).toContain("AUDIT_EVENT_LINK_SCOPE_MISMATCH");
    expect(sql).toContain("AUDIT_SNAPSHOT_SCOPE_MISMATCH");
    expect(sql).toContain("CORRECTION_SOURCE_SCOPE_MISMATCH");
    expect(sql).toContain("CORRECTION_CHILD_SCOPE_MISMATCH");
    expect(sql).toContain("CORRECTION_BEFORE_SNAPSHOT_SCOPE_MISMATCH");
    expect(sql).toContain("target_practice_id = practice_id AND target_client_entity_id = client_entity_id");
    expect(sql).toContain("target_ledger_book_id IS NOT DISTINCT FROM ledger_book_id");
  });

  it("rejects audit/correction overwrites and keeps correction execution disabled", () => {
    for (const table of [
      "audit_events", "audit_state_snapshots", "audit_event_links",
      "correction_operations", "correction_operation_steps", "correction_relationships",
    ]) {
      expect(sql).toMatch(new RegExp(
        `CREATE TRIGGER ${table}_[a-z_]*immutable BEFORE UPDATE OR DELETE ON public\\.${table}`,
      ));
    }
    expect(sql).toContain("execution_state                 text NOT NULL DEFAULT 'DISABLED'");
    expect(sql).toContain("CHECK (NOT execution_permission_granted)");
  });
});
