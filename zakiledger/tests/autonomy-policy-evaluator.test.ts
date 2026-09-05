import { describe, expect, it } from "vitest";
import { evaluateAutonomyPolicy } from "../lib/autonomy-policy-evaluator";
import { BASE_INPUT, requestFor, withAction } from "./autonomy-policy-fixtures";

describe("Step 7 pure policy evaluator", () => {
  it("allows only the narrow evidence-backed routine CREATE_BILL case", () => {
    const result = evaluateAutonomyPolicy(requestFor());
    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCodes).toEqual(["CREATE_BILL_ROUTINE_ALLOW"]);
  });

  it("uses REVIEW for ambiguous account or tax treatment", () => {
    const input = { ...BASE_INPUT, accountTreatment: { certainty: "AMBIGUOUS" as const, mappingId: null, verified: false } };
    const result = evaluateAutonomyPolicy(requestFor(input));
    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("ACCOUNT_TREATMENT_UNCERTAIN");
  });

  it.each([
    ["evidence", { ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, completeness: "INCOMPLETE" as const } }, "EVIDENCE_INCOMPLETE"],
    ["confidence", { ...BASE_INPUT, confidence: [{ fact: "vendor", basisPoints: 9_899, provenance: "DETERMINISTIC" as const }] }, "CONFIDENCE_INSUFFICIENT"],
    ["history", { ...BASE_INPUT, history: { ...BASE_INPUT.history, priorVerifiedActions: 2 } }, "HISTORY_INSUFFICIENT"],
    ["authorization", { ...BASE_INPUT, humanAuthorization: { state: "MISSING" as const, authorizationId: null, authorizedActionFingerprint: null } }, "HUMAN_AUTHORIZATION_REQUIRED"],
    ["duplicate check", { ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, duplicateCheck: "INCOMPLETE" as const } }, "DUPLICATE_CHECK_INCOMPLETE"],
    ["tax", { ...BASE_INPUT, taxTreatment: { certainty: "MISSING" as const, treatmentId: null, verified: false } }, "TAX_TREATMENT_UNCERTAIN"],
  ])("routes missing or ambiguous %s facts to REVIEW", (_name, input, reason) => {
    const result = evaluateAutonomyPolicy(requestFor(input));
    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain(reason);
  });

  it("denies materiality overflow using exact integer minor units", () => {
    const input = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: 100_001n } };
    const result = evaluateAutonomyPolicy(requestFor(input));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("MATERIALITY_LIMIT_EXCEEDED");
  });

  it("gives hard DENY precedence and orders reasons deterministically", () => {
    const input = {
      ...BASE_INPUT,
      action: { ...BASE_INPUT.action, claimedActionFingerprint: "0".repeat(64) },
      evidence: { ...BASE_INPUT.evidence, completeness: "INCOMPLETE" as const },
      riskFlags: [{ code: "SANCTIONS", severity: "DENY" as const, evidenceSha256: "d".repeat(64) }],
    };
    const result = evaluateAutonomyPolicy(requestFor(input));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes.slice(0, 2)).toEqual(["ACTION_FINGERPRINT_MISMATCH", "RISK_FLAG_DENY"]);
    expect(result.reasonCodes).toContain("EVIDENCE_INCOMPLETE");
  });

  it("never allows CREATE_VENDOR in v1", () => {
    const input = withAction("CREATE_VENDOR", "VENDOR_CREATION", {
      amount: { amountMinor: null, currencyCode: null, dailyAggregateBeforeMinor: null, rawSourceDecimal: null },
      accountTreatment: { certainty: "NOT_APPLICABLE", mappingId: null, verified: true },
      taxTreatment: { certainty: "NOT_APPLICABLE", treatmentId: null, verified: true },
      reversibility: "COMPENSATING",
      profileFacts: { existingVendorMatch: "NOT_APPLICABLE", billArithmeticVerified: null, duplicateCheck: "NOT_APPLICABLE", vendorBindingVerified: null },
    });
    const result = evaluateAutonomyPolicy(requestFor(input));
    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("CREATE_VENDOR_REVIEW_REQUIRED");
  });

  it("allows only exact verified adoption and denies unsupported action types", () => {
    const adopt = withAction("ADOPT_EXISTING_VENDOR", "VENDOR_ADOPTION", {
      amount: { amountMinor: null, currencyCode: null, dailyAggregateBeforeMinor: null, rawSourceDecimal: null },
      accountTreatment: { certainty: "NOT_APPLICABLE", mappingId: null, verified: true },
      taxTreatment: { certainty: "NOT_APPLICABLE", treatmentId: null, verified: true },
      reversibility: "DIRECT",
      profileFacts: { existingVendorMatch: "EXACT_UNIQUE_CURRENT_VERIFIED", billArithmeticVerified: null, duplicateCheck: "NOT_APPLICABLE", vendorBindingVerified: null },
    });
    expect(evaluateAutonomyPolicy(requestFor(adopt)).decision).toBe("ALLOW");
    for (const unsupported of ["CREATE_JOURNAL", "CREATE_TRANSFER", "CREATE_ADJUSTMENT", "CREATE_REFUND", "CREATE_CREDIT", "CREATE_PAYMENT", "UNKNOWN"]) {
      const denied = evaluateAutonomyPolicy(requestFor(withAction(unsupported, unsupported.replace("CREATE_", ""))));
      expect(denied.decision).toBe("DENY");
      expect(denied.reasonCodes).toContain("UNSUPPORTED_ACTION");
    }
  });

  it("keeps confidence separate from permission and fails unknown inputs closed", () => {
    const modelOnly = {
      ...BASE_INPUT,
      confidence: [{ fact: "vendor", basisPoints: 10_000, provenance: "MODEL" as const }],
      modelProposedPermission: "ALLOW" as const,
    };
    const denied = evaluateAutonomyPolicy(requestFor(modelOnly));
    expect(denied.decision).toBe("DENY");
    expect(denied.reasonCodes).toContain("MODEL_PERMISSION_OVERRIDE");
    expect(denied.reasonCodes).toContain("CONFIDENCE_INSUFFICIENT");

    const unknown = { ...BASE_INPUT, reversibility: "MAGICAL" as unknown as typeof BASE_INPUT.reversibility };
    const unknownResult = evaluateAutonomyPolicy(requestFor(unknown));
    expect(unknownResult.decision).toBe("DENY");
    expect(unknownResult.reasonCodes).toContain("INVALID_NORMALIZED_INPUT");
  });

  it("uses explicit evaluation input and has stable golden output", () => {
    const first = evaluateAutonomyPolicy(requestFor());
    const second = evaluateAutonomyPolicy(requestFor());
    expect(second).toEqual(first);
    const changed = requestFor({ ...BASE_INPUT, evaluationAsOf: "2026-09-06T12:00:00.000Z" });
    expect(changed.canonicalInput.normalizedInputSha256).not.toBe(requestFor().canonicalInput.normalizedInputSha256);
  });

  it("freezes the published initial profile artifact in memory", () => {
    const request = requestFor();
    expect(Object.isFrozen(request.bundle)).toBe(true);
    expect(Object.isFrozen(request.bundle.profiles.CREATE_BILL)).toBe(true);
  });
});
