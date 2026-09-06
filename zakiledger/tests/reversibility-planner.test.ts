import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditSha256 } from "../lib/audit-canonicalization";
import { assertLinearCorrectionSteps, planReversibility } from "../lib/reversibility-planner";
import type { ReversibilityPlannerInput } from "../lib/reversibility-contract";

const beforeState = { Id: "provider-object-1", SyncToken: "7", status: "ACTIVE" };
const fingerprint = auditSha256(beforeState);

function input(overrides: Partial<ReversibilityPlannerInput> = {}): ReversibilityPlannerInput {
  const base: ReversibilityPlannerInput = {
    contractVersion: "step8-reversibility-planner-v1",
    provider: "quickbooks",
    objectType: "QBO_VENDOR",
    lifecycleState: "ACTIVE",
    desiredCorrection: "UPDATE_NON_FINANCIAL",
    originalOutcome: "CONFIRMED",
    currentState: {
      readCompleted: true,
      observedAt: "2026-09-06T12:00:00.000Z",
      providerObjectId: "provider-object-1",
      providerVersionToken: "7",
      stateFingerprint: fingerprint,
    },
    beforeState: { canonical: beforeState, claimedFingerprint: fingerprint },
    checks: {
      dependencies: "CLEAR",
      periodLock: "NOT_APPLICABLE",
      tax: "NOT_APPLICABLE",
      reconciliation: "NOT_APPLICABLE",
    },
    evaluationAsOf: "2026-09-06T12:04:59.000Z",
  };
  return { ...base, ...overrides };
}

describe("Step 8 pure reversibility planner", () => {
  it("returns a ratified safe method without granting execution permission", () => {
    const first = planReversibility(input());
    const replay = planReversibility(input());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      decision: "SAFE_METHOD",
      reasonCodes: ["QBO_VENDOR_SPARSE_UPDATE_RATIFIED"],
      grantsExecutionPermission: false,
      plan: {
        executionSemantics: "LINEAR_FAIL_CLOSED",
        steps: [{ index: 1, method: "QBO_VENDOR_SPARSE_UPDATE" }],
      },
    });
    expect(first.plan?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers only the ratified v1 provider matrix", () => {
    const cases: Array<[Partial<ReversibilityPlannerInput>, string]> = [
      [{ desiredCorrection: "INACTIVATE" }, "QBO_VENDOR_INACTIVATE"],
      [{ objectType: "QBO_BILL", lifecycleState: "UNPAID_UNLINKED", desiredCorrection: "DELETE" }, "QBO_BILL_DELETE"],
      [{ provider: "xero", objectType: "XERO_CONTACT", desiredCorrection: "ARCHIVE" }, "XERO_CONTACT_ARCHIVE"],
      [{ provider: "xero", objectType: "XERO_BILL", lifecycleState: "DRAFT", desiredCorrection: "DELETE" }, "XERO_DRAFT_BILL_DELETE"],
      [{ provider: "xero", objectType: "XERO_BILL", lifecycleState: "APPROVED_UNPAID", desiredCorrection: "VOID" }, "XERO_APPROVED_BILL_VOID"],
      [{ provider: "xero", objectType: "XERO_BILL", lifecycleState: "PAID", desiredCorrection: "UPDATE_NON_FINANCIAL" }, "XERO_PAID_BILL_METADATA_UPDATE"],
    ];
    for (const [overrides, method] of cases) {
      expect(planReversibility(input(overrides))).toMatchObject({
        decision: "SAFE_METHOD",
        plan: { steps: [{ method }] },
        grantsExecutionPermission: false,
      });
    }
  });

  it("fails closed for an uncertain original outcome before considering capabilities", () => {
    expect(planReversibility(input({ originalOutcome: "UNCERTAIN" }))).toEqual({
      decision: "NO_SAFE_METHOD",
      reasonCodes: ["ORIGINAL_OUTCOME_UNCERTAIN"],
      plan: null,
      capabilityBundleVersion: "step8-provider-reversibility-v1",
      plannerVersion: "step8-pure-reversibility-planner-v1",
      grantsExecutionPermission: false,
    });
  });

  it("routes missing and blocked current-state checks to REVIEW in deterministic order", () => {
    const missing = planReversibility(input({
      currentState: { readCompleted: false, observedAt: null, providerObjectId: null, providerVersionToken: null, stateFingerprint: null },
      beforeState: { canonical: null, claimedFingerprint: null },
    }));
    expect(missing.reasonCodes).toEqual([
      "CURRENT_STATE_READ_REQUIRED",
      "CURRENT_STATE_OBSERVED_AT_REQUIRED",
      "PROVIDER_OBJECT_ID_REQUIRED",
      "PROVIDER_VERSION_TOKEN_REQUIRED",
      "CURRENT_STATE_FINGERPRINT_REQUIRED",
      "BEFORE_STATE_REQUIRED",
    ]);

    const blocked = planReversibility(input({ checks: {
      dependencies: "BLOCKED",
      periodLock: "BLOCKED",
      tax: "BLOCKED",
      reconciliation: "BLOCKED",
    } }));
    expect(blocked).toMatchObject({
      decision: "REVIEW",
      reasonCodes: [
        "LINKED_OBJECT_REVIEW_REQUIRED",
        "PERIOD_LOCK_REVIEW_REQUIRED",
        "TAX_REPORTING_REVIEW_REQUIRED",
        "RECONCILIATION_REVIEW_REQUIRED",
      ],
      plan: null,
    });
  });

  it("rejects mismatched before-state identity and unratified paid financial corrections", () => {
    expect(planReversibility(input({
      beforeState: { canonical: beforeState, claimedFingerprint: "a".repeat(64) },
    }))).toMatchObject({ decision: "NO_SAFE_METHOD", reasonCodes: ["BEFORE_STATE_FINGERPRINT_MISMATCH"] });

    expect(planReversibility(input({
      provider: "xero",
      objectType: "XERO_BILL",
      lifecycleState: "PART_PAID",
      desiredCorrection: "UPDATE_FINANCIAL",
    }))).toMatchObject({
      decision: "NO_SAFE_METHOD",
      reasonCodes: ["PAID_OR_LINKED_FINANCIAL_CORRECTION_UNRATIFIED"],
      plan: null,
    });
  });

  it("requires compound plans to be contiguous and read-back verified", () => {
    expect(() => assertLinearCorrectionSteps([])).toThrow("at least one step");
    expect(() => assertLinearCorrectionSteps([{
      index: 2,
      method: "QBO_VENDOR_INACTIVATE",
      requiredBeforeStateFingerprint: fingerprint,
      requiredProviderVersionToken: "7",
      afterStateVerification: "READ_BACK_AND_FINGERPRINT",
    }])).toThrow("contiguous");
  });

  it("has no clock, network, model, provider-adapter, or permission dependency", () => {
    const source = readFileSync(resolve(process.cwd(), "lib", "reversibility-planner.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:fetch|Date\.now|new Date|Math\.random)\b/);
    expect(source).not.toMatch(/provider-adapters|authoritative-posting|autonomy-policy|openai|anthropic/i);
    expect(source).toContain("grantsExecutionPermission: false");
  });
});
