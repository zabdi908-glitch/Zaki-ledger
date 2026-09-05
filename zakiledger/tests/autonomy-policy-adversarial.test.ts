import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionFingerprint,
  canonicalizePolicyInput,
  clientPolicySnapshotSha256,
  policyBundleSha256,
} from "../lib/autonomy-policy-canonicalization";
import type {
  AutonomyPolicyBundle,
  NormalizedPolicyInput,
  PolicyEvaluationRequest,
} from "../lib/autonomy-policy-contract";
import { evaluateAutonomyPolicy, STEP7_INITIAL_POLICY_BUNDLE } from "../lib/autonomy-policy-evaluator";
import { InMemoryAutonomyPolicyDecisionStore } from "../lib/autonomy-policy-store";
import { BASE_INPUT, BASE_SNAPSHOT, CLIENT_ID, LEDGER_BOOK_ID, requestFor, withAction } from "./autonomy-policy-fixtures";

const OTHER_CLIENT_ID = "70000000-0000-4000-8000-000000000002";
const OTHER_LEDGER_BOOK_ID = "72000000-0000-4000-8000-000000000002";

function evaluate(input: NormalizedPolicyInput) {
  return evaluateAutonomyPolicy(requestFor(input));
}

function mutateActionSnapshot(
  input: NormalizedPolicyInput,
  changes: Record<string, unknown>,
): NormalizedPolicyInput {
  const snapshot = { ...input.action.snapshot, ...changes };
  const fingerprint = actionFingerprint(snapshot);
  return {
    ...input,
    action: {
      ...input.action,
      snapshot,
      claimedActionFingerprint: fingerprint,
      computedActionFingerprint: fingerprint,
    },
    humanAuthorization: {
      ...input.humanAuthorization,
      authorizedActionFingerprint: fingerprint,
    },
  };
}

describe("Step 7 Day 5 adversarial policy validation", () => {
  afterEach(() => vi.useRealTimers());

  it("enforces DENY over simultaneous REVIEW and otherwise-ALLOW facts", () => {
    const input = {
      ...BASE_INPUT,
      evidence: { ...BASE_INPUT.evidence, completeness: "INCOMPLETE" as const },
      riskFlags: [{ code: "SANCTIONS", severity: "DENY" as const, evidenceSha256: "d".repeat(64) }],
    };
    const result = evaluate(input);
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("RISK_FLAG_DENY");
    expect(result.reasonCodes).toContain("EVIDENCE_INCOMPLETE");
  });

  it("enforces REVIEW over an otherwise-ALLOW path", () => {
    const result = evaluate({ ...BASE_INPUT, accountTreatment: { ...BASE_INPUT.accountTreatment, certainty: "AMBIGUOUS" } });
    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toEqual(["ACCOUNT_TREATMENT_UNCERTAIN"]);
  });

  it.each([
    ["action", { ...BASE_INPUT, action: { ...BASE_INPUT.action, actionType: "UNKNOWN_ACTION" } }],
    ["evidence quality", { ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, quality: "MAGICAL" } }],
    ["evidence provenance", { ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [{ ...BASE_INPUT.evidence.facts[0], provenance: "MAGICAL" }] } }],
    ["confidence provenance", { ...BASE_INPUT, confidence: [{ ...BASE_INPUT.confidence[0], provenance: "MAGICAL" }] }],
    ["vendor match", { ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, existingVendorMatch: "MAGICAL" } }],
    ["duplicate check", { ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, duplicateCheck: "MAGICAL" } }],
    ["risk severity", { ...BASE_INPUT, riskFlags: [{ code: "SANCTIONS", severity: "MAGICAL", evidenceSha256: "d".repeat(64) }] }],
    ["risk code", { ...BASE_INPUT, riskFlags: [{ code: "UNREGISTERED", severity: "DENY", evidenceSha256: "d".repeat(64) }] }],
  ])("fails unknown %s closed", (_label, malformed) => {
    const result = evaluate(malformed as unknown as NormalizedPolicyInput);
    expect(result.decision).toBe("DENY");
  });

  it.each([
    ["decimal string", "100.00"],
    ["integer number", 10_000],
    ["floating number", 100.25],
    ["object", { minor: 10_000 }],
  ])("denies malformed authoritative money: %s", (_label, amountMinor) => {
    const malformed = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor } } as unknown as NormalizedPolicyInput;
    expect(evaluate(malformed).decision).toBe("DENY");
  });

  it("denies minor units outside the signed SQL bigint domain", () => {
    const tooLarge = 1n << 63n;
    const snapshot = { ...BASE_SNAPSHOT, maxSingleActionAmountMinor: tooLarge, maxDailyAggregateAmountMinor: tooLarge };
    const input = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: tooLarge, dailyAggregateBeforeMinor: 0n } };
    expect(evaluateAutonomyPolicy(requestFor(input, snapshot)).decision).toBe("DENY");
  });

  it("denies a normalized client bound to another client policy snapshot", () => {
    const input = mutateActionSnapshot({
      ...BASE_INPUT,
      client: { ...BASE_INPUT.client, clientEntityId: OTHER_CLIENT_ID },
      evidence: { ...BASE_INPUT.evidence, facts: BASE_INPUT.evidence.facts.map((fact) => ({ ...fact, clientEntityId: OTHER_CLIENT_ID })) },
      humanAuthorization: { ...BASE_INPUT.humanAuthorization, authorizedClientEntityId: OTHER_CLIENT_ID },
    }, { clientEntityId: OTHER_CLIENT_ID });
    expect(evaluate(input).decision).toBe("DENY");
  });

  it.each([
    ["action client", { clientEntityId: OTHER_CLIENT_ID }],
    ["action ledger book", { ledgerBookId: OTHER_LEDGER_BOOK_ID }],
  ])("denies cross-binding through %s", (_label, changes) => {
    expect(evaluate(mutateActionSnapshot(BASE_INPUT, changes)).decision).toBe("DENY");
  });

  it.each([
    ["evidence hash", { verifiedSha256: "e".repeat(64) }],
    ["evidence client", { clientEntityId: OTHER_CLIENT_ID }],
    ["evidence ledger book", { ledgerBookId: OTHER_LEDGER_BOOK_ID }],
  ])("denies %s mismatch", (_label, changes) => {
    const input = {
      ...BASE_INPUT,
      evidence: { ...BASE_INPUT.evidence, facts: [{ ...BASE_INPUT.evidence.facts[0], ...changes }] },
    } as unknown as NormalizedPolicyInput;
    expect(evaluate(input).decision).toBe("DENY");
  });

  it("denies claimed action fingerprint mismatch", () => {
    expect(evaluate({ ...BASE_INPUT, action: { ...BASE_INPUT.action, claimedActionFingerprint: "0".repeat(64) } }).decision).toBe("DENY");
  });

  it("denies bill amount drift outside the fingerprinted action snapshot", () => {
    const drifted = { ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: 20_000n } };
    const result = evaluate(drifted);
    expect(result.decision).toBe("DENY");
    expect(result.reasonCodes).toContain("ACTION_FINGERPRINT_MISMATCH");
  });

  it.each([
    ["fingerprint", { authorizedActionFingerprint: "0".repeat(64) }],
    ["client scope", { authorizedClientEntityId: OTHER_CLIENT_ID }],
    ["book scope", { authorizedLedgerBookId: OTHER_LEDGER_BOOK_ID }],
    ["action scope", { authorizedActionType: "CREATE_VENDOR" }],
  ])("denies authorization %s mismatch", (_label, changes) => {
    const input = {
      ...BASE_INPUT,
      humanAuthorization: { ...BASE_INPUT.humanAuthorization, ...changes },
    } as unknown as NormalizedPolicyInput;
    expect(evaluate(input).decision).toBe("DENY");
  });

  it("never allows CREATE_VENDOR v1 and denies every unsupported write action", () => {
    const vendor = withAction("CREATE_VENDOR", "VENDOR_CREATION", {
      amount: { amountMinor: null, currencyCode: null, dailyAggregateBeforeMinor: null, rawSourceDecimal: null },
      accountTreatment: { certainty: "NOT_APPLICABLE", mappingId: null, verified: true },
      taxTreatment: { certainty: "NOT_APPLICABLE", treatmentId: null, verified: true },
      profileFacts: { existingVendorMatch: "NOT_APPLICABLE", billArithmeticVerified: null, duplicateCheck: "NOT_APPLICABLE", vendorBindingVerified: null },
    });
    expect(evaluate(vendor).decision).toBe("REVIEW");
    for (const action of ["CREATE_JOURNAL", "CREATE_TRANSFER", "CREATE_ADJUSTMENT", "CREATE_REFUND", "CREATE_CREDIT", "CREATE_PAYMENT", "UNKNOWN"]) {
      expect(evaluate(withAction(action, action)).decision).toBe("DENY");
    }
  });

  it("allows the exact vendor adoption happy path", () => {
    const input = withAction("ADOPT_EXISTING_VENDOR", "VENDOR_ADOPTION", {
      amount: { amountMinor: null, currencyCode: null, dailyAggregateBeforeMinor: null, rawSourceDecimal: null },
      accountTreatment: { certainty: "NOT_APPLICABLE", mappingId: null, verified: true },
      taxTreatment: { certainty: "NOT_APPLICABLE", treatmentId: null, verified: true },
      reversibility: "DIRECT",
      profileFacts: { existingVendorMatch: "EXACT_UNIQUE_CURRENT_VERIFIED", billArithmeticVerified: null, duplicateCheck: "NOT_APPLICABLE", vendorBindingVerified: null },
    });
    expect(evaluate(input).decision).toBe("ALLOW");
  });

  it("allows the exact narrow CREATE_BILL happy path", () => {
    expect(evaluate(BASE_INPUT).decision).toBe("ALLOW");
  });

  it.each([
    ["active client", () => ({ ...BASE_INPUT, client: { ...BASE_INPUT.client, active: false } })],
    ["complete evidence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, completeness: "INCOMPLETE" as const } })],
    ["strong evidence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, quality: "WEAK" as const } })],
    ["retained evidence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [{ ...BASE_INPUT.evidence.facts[0], retained: false }] } })],
    ["verified evidence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [{ ...BASE_INPUT.evidence.facts[0], verified: false }] } })],
    ["evidence presence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [] } })],
    ["deterministic evidence", () => ({ ...BASE_INPUT, evidence: { ...BASE_INPUT.evidence, facts: [{ ...BASE_INPUT.evidence.facts[0], provenance: "MODEL" as const }] } })],
    ["confidence", () => ({ ...BASE_INPUT, confidence: [] })],
    ["bill transaction", () => ({ ...BASE_INPUT, transactionType: "OTHER" })],
    ["amount", () => ({ ...BASE_INPUT, amount: { ...BASE_INPUT.amount, amountMinor: null } })],
    ["currency", () => ({ ...BASE_INPUT, amount: { ...BASE_INPUT.amount, currencyCode: null } })],
    ["aggregate", () => ({ ...BASE_INPUT, amount: { ...BASE_INPUT.amount, dailyAggregateBeforeMinor: null } })],
    ["account certainty", () => ({ ...BASE_INPUT, accountTreatment: { ...BASE_INPUT.accountTreatment, certainty: "MISSING" as const } })],
    ["account mapping", () => ({ ...BASE_INPUT, accountTreatment: { ...BASE_INPUT.accountTreatment, mappingId: null } })],
    ["account verification", () => ({ ...BASE_INPUT, accountTreatment: { ...BASE_INPUT.accountTreatment, verified: false } })],
    ["tax certainty", () => ({ ...BASE_INPUT, taxTreatment: { ...BASE_INPUT.taxTreatment, certainty: "MISSING" as const } })],
    ["tax treatment", () => ({ ...BASE_INPUT, taxTreatment: { ...BASE_INPUT.taxTreatment, treatmentId: null } })],
    ["tax verification", () => ({ ...BASE_INPUT, taxTreatment: { ...BASE_INPUT.taxTreatment, verified: false } })],
    ["reversibility", () => ({ ...BASE_INPUT, reversibility: "IRREVERSIBLE" as const })],
    ["history count", () => ({ ...BASE_INPUT, history: { ...BASE_INPUT.history, priorVerifiedActions: 2 } })],
    ["stable history", () => ({ ...BASE_INPUT, history: { ...BASE_INPUT.history, stablePattern: false } })],
    ["clean history", () => ({ ...BASE_INPUT, history: { ...BASE_INPUT.history, hasCorrectionsOrReversals: true } })],
    ["duplicate clearance", () => ({ ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, duplicateCheck: "INCOMPLETE" as const } })],
    ["bill arithmetic", () => ({ ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, billArithmeticVerified: false } })],
    ["vendor binding", () => ({ ...BASE_INPUT, profileFacts: { ...BASE_INPUT.profileFacts, vendorBindingVerified: false } })],
    ["authorization state", () => ({ ...BASE_INPUT, humanAuthorization: { ...BASE_INPUT.humanAuthorization, state: "MISSING" as const } })],
    ["authorization id", () => ({ ...BASE_INPUT, humanAuthorization: { ...BASE_INPUT.humanAuthorization, authorizationId: null } })],
    ["authorization fingerprint", () => ({ ...BASE_INPUT, humanAuthorization: { ...BASE_INPUT.humanAuthorization, authorizedActionFingerprint: null } })],
  ])("cannot ALLOW CREATE_BILL without required condition: %s", (_label, build) => {
    expect(evaluate(build()).decision).not.toBe("ALLOW");
  });

  it("returns one decision for retries and concurrent identical attempts", async () => {
    const store = new InMemoryAutonomyPolicyDecisionStore();
    const audit = { policyBundleId: "bundle", clientPolicySnapshotId: "snapshot", requestedBy: "test", correlationId: null };
    const first = await store.evaluateAndRecord(requestFor(), audit);
    const retry = await store.evaluateAndRecord(requestFor(), audit);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => store.evaluateAndRecord(requestFor(), audit)));
    expect(retry).toMatchObject({ id: first.id, decisionKey: first.decisionKey, reused: true });
    expect(new Set(concurrent.map((item) => item.id))).toEqual(new Set([first.id]));
    expect(store.size).toBe(1);
  });

  it("fails hard when the same decision key is presented with conflicting semantics", async () => {
    const store = new InMemoryAutonomyPolicyDecisionStore();
    const audit = { policyBundleId: "bundle", clientPolicySnapshotId: "snapshot", requestedBy: "test", correlationId: null };
    const request = requestFor();
    await store.evaluateAndRecord(request, audit);
    const conflicting = {
      ...request,
      canonicalInput: {
        ...request.canonicalInput,
        input: { ...request.canonicalInput.input, accountTreatment: { certainty: "AMBIGUOUS" as const, mappingId: null, verified: false } },
      },
    };
    await expect(store.evaluateAndRecord(conflicting, audit)).rejects.toThrow("DECISION_KEY_INTEGRITY_CONFLICT");
  });

  it("is unaffected by wall-clock changes", () => {
    const request = requestFor();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1999-01-01T00:00:00.000Z"));
    const oldClock = evaluateAutonomyPolicy(request);
    vi.setSystemTime(new Date("2099-12-31T23:59:59.999Z"));
    expect(evaluateAutonomyPolicy(request)).toEqual(oldClock);
  });

  it("orders reasons independently of input and bundle rule traversal order", () => {
    const input = {
      ...BASE_INPUT,
      evidence: { ...BASE_INPUT.evidence, completeness: "INCOMPLETE" as const },
      riskFlags: [
        { code: "UNUSUAL_AMOUNT", severity: "REVIEW" as const, evidenceSha256: "e".repeat(64) },
        { code: "SANCTIONS", severity: "DENY" as const, evidenceSha256: "d".repeat(64) },
      ],
    };
    const original = requestFor(input);
    const reversedBundle = {
      ...STEP7_INITIAL_POLICY_BUNDLE,
      reasons: [...STEP7_INITIAL_POLICY_BUNDLE.reasons].reverse(),
    } as AutonomyPolicyBundle;
    const reversedBundleSha256 = policyBundleSha256(reversedBundle);
    const reversedRequest: PolicyEvaluationRequest = {
      ...original,
      bundle: reversedBundle,
      bundleSha256: reversedBundleSha256,
      clientSnapshotSha256: clientPolicySnapshotSha256(BASE_SNAPSHOT, reversedBundleSha256),
    };
    expect(evaluateAutonomyPolicy(reversedRequest).reasonCodes).toEqual(evaluateAutonomyPolicy(original).reasonCodes);
  });
});
