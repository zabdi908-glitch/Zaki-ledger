import initialBundleJson from "../policies/step7-initial-profiles-v1.json";
import {
  clientPolicySnapshotSha256,
  policyBundleSha256,
  policyResultSha256,
} from "./autonomy-policy-canonicalization";
import {
  SUPPORTED_POLICY_ACTIONS,
  type AutonomyPolicyBundle,
  type PolicyDecision,
  type PolicyEvaluationRequest,
  type PolicyEvaluationResult,
  type PolicyRuleTrace,
  type SupportedPolicyAction,
} from "./autonomy-policy-contract";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const STEP7_INITIAL_POLICY_BUNDLE = deepFreeze(initialBundleJson as unknown as AutonomyPolicyBundle);

const outcomeRank: Record<PolicyDecision, number> = { DENY: 0, REVIEW: 1, ALLOW: 2 };
const ascii = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const absolute = (value: bigint): bigint => value < 0n ? -value : value;
const INT64_MAX = (1n << 63n) - 1n;

function bundleIsValid(bundle: AutonomyPolicyBundle): boolean {
  if (bundle.policyVersion !== "step7-initial-profiles-v1" ||
      bundle.contractVersion !== "step7-day1-policy-contract-v1" ||
      bundle.canonicalizationVersion !== "step7-canonical-json-v1" ||
      bundle.evaluatorVersion !== "step7-policy-evaluator-v1" ||
      bundle.decisionPrecedence.join("|") !== "DENY|REVIEW|ALLOW") return false;
  const reasonCodes = new Set<string>();
  const ordinals = new Set<number>();
  for (const reason of bundle.reasons) {
    if (reasonCodes.has(reason.code) || ordinals.has(reason.ordinal) || !Number.isSafeInteger(reason.ordinal)) return false;
    reasonCodes.add(reason.code);
    ordinals.add(reason.ordinal);
  }
  return SUPPORTED_POLICY_ACTIONS.every((action) => bundle.profiles[action]?.actionType === action) &&
    reasonCodes.has("INVALID_POLICY_BINDING") && reasonCodes.has("NO_EXPLICIT_ALLOW_RULE");
}

function snapshotIsValid(snapshot: PolicyEvaluationRequest["clientSnapshot"]): boolean {
  return Number.isSafeInteger(snapshot.snapshotVersion) && snapshot.snapshotVersion > 0 &&
    (snapshot.maxSingleActionAmountMinor === null || (typeof snapshot.maxSingleActionAmountMinor === "bigint" && snapshot.maxSingleActionAmountMinor >= 0n && snapshot.maxSingleActionAmountMinor <= INT64_MAX)) &&
    (snapshot.maxDailyAggregateAmountMinor === null || (typeof snapshot.maxDailyAggregateAmountMinor === "bigint" && snapshot.maxDailyAggregateAmountMinor >= 0n && snapshot.maxDailyAggregateAmountMinor <= INT64_MAX)) &&
    new Set(snapshot.enabledProfiles).size === snapshot.enabledProfiles.length &&
    new Set(snapshot.requireHumanAuthorizationFor).size === snapshot.requireHumanAuthorizationFor.length &&
    snapshot.enabledProfiles.every((action) => (SUPPORTED_POLICY_ACTIONS as readonly string[]).includes(action)) &&
    snapshot.requireHumanAuthorizationFor.every((action) => (SUPPORTED_POLICY_ACTIONS as readonly string[]).includes(action));
}

export function evaluateAutonomyPolicy(request: PolicyEvaluationRequest): PolicyEvaluationResult {
  const { bundle, clientSnapshot, canonicalInput } = request;
  const input = canonicalInput.input;
  const trace: PolicyRuleTrace[] = [];
  const reasonByCode = new Map(bundle.reasons.map((reason) => [reason.code, reason]));
  const trigger = (code: string, paths: string[]): void => {
    const definition = reasonByCode.get(code);
    trace.push({
      outcome: definition?.outcome ?? "DENY",
      reasonCode: code,
      reasonOrdinal: definition?.ordinal ?? 2_147_483_647,
      inputPaths: [...paths].sort(ascii),
    });
  };

  const calculatedBundleHash = policyBundleSha256(bundle);
  const calculatedSnapshotHash = clientPolicySnapshotSha256(clientSnapshot, request.bundleSha256);
  if (!bundleIsValid(bundle) || !snapshotIsValid(clientSnapshot) || calculatedBundleHash !== request.bundleSha256 ||
      calculatedSnapshotHash !== request.clientSnapshotSha256 ||
      clientSnapshot.policyVersion !== bundle.policyVersion) {
    trigger("INVALID_POLICY_BINDING", ["/policyBundle", "/clientPolicySnapshot"]);
  }
  if (canonicalInput.issues.length > 0) trigger("INVALID_NORMALIZED_INPUT", ["/normalizationIssues"]);
  if (input.client.clientEntityId !== clientSnapshot.clientEntityId) trigger("CLIENT_BINDING_MISMATCH", ["/client/clientEntityId", "/clientPolicySnapshot/clientEntityId"]);
  if (input.action.snapshot.clientEntityId !== input.client.clientEntityId ||
      input.action.snapshot.ledgerBookId !== input.client.ledgerBookId ||
      input.action.snapshot.actionType !== input.action.actionType ||
      (input.action.actionType === "CREATE_BILL" &&
       (input.action.snapshot.amountMinor !== input.amount.amountMinor || input.action.snapshot.currencyCode !== input.amount.currencyCode))) {
    trigger("ACTION_FINGERPRINT_MISMATCH", ["/action/snapshot", "/client"]);
  }
  if (!input.client.active) trigger("CLIENT_INACTIVE", ["/client/active"]);
  if (clientSnapshot.suspended) trigger("POLICY_SUSPENDED", ["/clientPolicySnapshot/suspended"]);

  if (input.action.claimedActionFingerprint !== input.action.computedActionFingerprint ||
      (input.action.fingerprintVersion === "step5-authorized-request-v1" &&
       input.action.step5AuthorizedRequestFingerprint !== input.action.computedActionFingerprint) ||
      (input.humanAuthorization.authorizedActionFingerprint !== null &&
       input.humanAuthorization.authorizedActionFingerprint !== input.action.computedActionFingerprint)) {
    trigger("ACTION_FINGERPRINT_MISMATCH", ["/action", "/humanAuthorization/authorizedActionFingerprint"]);
  }

  const supported = (SUPPORTED_POLICY_ACTIONS as readonly string[]).includes(input.action.actionType);
  const action = supported ? input.action.actionType as SupportedPolicyAction : null;
  const profile = action ? bundle.profiles[action] : null;
  if (!action || !profile) trigger("UNSUPPORTED_ACTION", ["/action/actionType"]);
  else if (!profile.enabled || !clientSnapshot.enabledProfiles.includes(action)) trigger("PROFILE_DISABLED", ["/action/actionType", "/clientPolicySnapshot/enabledProfiles"]);

  if (input.modelProposedPermission === "ALLOW") trigger("MODEL_PERMISSION_OVERRIDE", ["/modelProposedPermission"]);
  if (input.evidence.completeness === "CONFLICTED") trigger("EVIDENCE_CONFLICT", ["/evidence/completeness"]);
  else if (input.evidence.completeness !== "COMPLETE" || input.evidence.facts.length === 0 || input.evidence.facts.some((fact) => !fact.retained || !fact.verified)) trigger("EVIDENCE_INCOMPLETE", ["/evidence"]);
  if (input.evidence.facts.some((fact) => fact.sha256 !== fact.verifiedSha256 ||
      fact.clientEntityId !== input.client.clientEntityId || fact.ledgerBookId !== input.client.ledgerBookId)) {
    trigger("EVIDENCE_BINDING_MISMATCH", ["/evidence/facts", "/client"]);
  }
  if (input.evidence.quality !== "STRONG" || input.evidence.facts.some((fact) => fact.provenance !== "DETERMINISTIC")) trigger("EVIDENCE_AMBIGUOUS", ["/evidence/quality", "/evidence/facts"]);

  if (profile && (input.confidence.length === 0 || input.confidence.some((fact) =>
    fact.basisPoints < profile.minimumConfidenceBasisPoints || fact.provenance !== "DETERMINISTIC"))) {
    trigger("CONFIDENCE_INSUFFICIENT", ["/confidence"]);
  }

  for (const flag of input.riskFlags) {
    const registered = bundle.riskRegistry[flag.code];
    if (!registered || registered !== flag.severity || flag.severity === "UNKNOWN") trigger("UNKNOWN_RISK_FLAG", [`/riskFlags/${flag.code}`]);
    else if (registered === "DENY") trigger("RISK_FLAG_DENY", [`/riskFlags/${flag.code}`]);
    else if (registered === "REVIEW") trigger("RISK_FLAG_REVIEW", [`/riskFlags/${flag.code}`]);
  }

  if (profile && bundle.reversibilityRegistry[input.reversibility] > bundle.reversibilityRegistry[profile.maxReversibility]) trigger("REVERSIBILITY_PROHIBITED", ["/reversibility"]);

  if (profile?.requiresAmount) {
    const amount = input.amount.amountMinor;
    const aggregate = input.amount.dailyAggregateBeforeMinor;
    if (amount === null || aggregate === null || !input.amount.currencyCode || !/^[A-Z]{3}$/.test(input.amount.currencyCode) ||
        clientSnapshot.maxSingleActionAmountMinor === null || clientSnapshot.maxDailyAggregateAmountMinor === null) {
      trigger("MATERIALITY_CONFIGURATION_MISSING", ["/amount", "/clientPolicySnapshot"]);
    } else if (typeof amount !== "bigint" || typeof aggregate !== "bigint" ||
      typeof clientSnapshot.maxSingleActionAmountMinor !== "bigint" || typeof clientSnapshot.maxDailyAggregateAmountMinor !== "bigint") {
      trigger("INVALID_NORMALIZED_INPUT", ["/amount", "/clientPolicySnapshot"]);
    } else if (amount <= 0n || absolute(amount) > absolute(clientSnapshot.maxSingleActionAmountMinor) ||
      absolute(aggregate) + absolute(amount) > absolute(clientSnapshot.maxDailyAggregateAmountMinor)) {
      trigger("MATERIALITY_LIMIT_EXCEEDED", ["/amount", "/clientPolicySnapshot"]);
    }
  } else if (input.amount.amountMinor !== null || input.amount.dailyAggregateBeforeMinor !== null) {
    trigger("INVALID_NORMALIZED_INPUT", ["/amount"]);
  }

  if (profile && (profile.requiresHumanAuthorization || clientSnapshot.requireHumanAuthorizationFor.includes(profile.actionType))) {
    const explicitScopeMismatch =
      (input.humanAuthorization.authorizedClientEntityId != null && input.humanAuthorization.authorizedClientEntityId !== input.client.clientEntityId) ||
      (input.humanAuthorization.authorizedLedgerBookId != null && input.humanAuthorization.authorizedLedgerBookId !== input.client.ledgerBookId) ||
      (input.humanAuthorization.authorizedActionType != null && input.humanAuthorization.authorizedActionType !== input.action.actionType);
    if (input.humanAuthorization.state === "REVOKED" || input.humanAuthorization.state === "WRONG_SCOPE" || explicitScopeMismatch) trigger("HUMAN_AUTHORIZATION_INVALID", ["/humanAuthorization", "/client", "/action/actionType"]);
    else if (input.humanAuthorization.state !== "EXACT" || !input.humanAuthorization.authorizationId ||
      !input.humanAuthorization.authorizedActionFingerprint || !input.humanAuthorization.authorizedClientEntityId ||
      !input.humanAuthorization.authorizedLedgerBookId || !input.humanAuthorization.authorizedActionType) trigger("HUMAN_AUTHORIZATION_REQUIRED", ["/humanAuthorization"]);
  }

  if (action === "ADOPT_EXISTING_VENDOR") {
    if (input.transactionType !== "VENDOR_ADOPTION") trigger("INVALID_TRANSACTION_TYPE", ["/transactionType"]);
    if (input.accountTreatment.certainty !== "NOT_APPLICABLE" || input.taxTreatment.certainty !== "NOT_APPLICABLE") trigger("ACCOUNT_TREATMENT_UNCERTAIN", ["/accountTreatment", "/taxTreatment"]);
    if (input.profileFacts.existingVendorMatch !== "EXACT_UNIQUE_CURRENT_VERIFIED") trigger("EXISTING_VENDOR_MATCH_AMBIGUOUS", ["/profileFacts/existingVendorMatch"]);
  }

  if (action === "CREATE_VENDOR") {
    if (input.transactionType !== "VENDOR_CREATION") trigger("INVALID_TRANSACTION_TYPE", ["/transactionType"]);
    if (input.accountTreatment.certainty !== "NOT_APPLICABLE" || input.taxTreatment.certainty !== "NOT_APPLICABLE") trigger("ACCOUNT_TREATMENT_UNCERTAIN", ["/accountTreatment", "/taxTreatment"]);
    trigger("CREATE_VENDOR_REVIEW_REQUIRED", ["/action/actionType"]);
  }

  if (action === "CREATE_BILL") {
    if (input.transactionType !== "BILL") trigger("INVALID_TRANSACTION_TYPE", ["/transactionType"]);
    if (input.accountTreatment.certainty !== "EXACT" || !input.accountTreatment.mappingId || !input.accountTreatment.verified) trigger("ACCOUNT_TREATMENT_UNCERTAIN", ["/accountTreatment"]);
    if (input.taxTreatment.certainty !== "EXACT" || !input.taxTreatment.treatmentId || !input.taxTreatment.verified) trigger("TAX_TREATMENT_UNCERTAIN", ["/taxTreatment"]);
    if (input.history.priorVerifiedActions < (profile?.minimumPriorVerifiedActions ?? Number.MAX_SAFE_INTEGER) || !input.history.stablePattern) trigger("HISTORY_INSUFFICIENT", ["/history"]);
    if (input.history.hasCorrectionsOrReversals) trigger("HISTORY_CONFLICT", ["/history/hasCorrectionsOrReversals"]);
    if (input.profileFacts.duplicateCheck !== "CLEAR") trigger("DUPLICATE_CHECK_INCOMPLETE", ["/profileFacts/duplicateCheck"]);
    if (input.profileFacts.billArithmeticVerified !== true || input.profileFacts.vendorBindingVerified !== true) trigger("BILL_FACTS_INCOMPLETE", ["/profileFacts"]);
  }

  const blocking = trace.some((item) => item.outcome !== "ALLOW");
  if (!blocking && profile?.allowPermitted && action === "ADOPT_EXISTING_VENDOR") trigger("ADOPT_EXISTING_VENDOR_ROUTINE_ALLOW", ["/action/actionType"]);
  if (!blocking && profile?.allowPermitted && action === "CREATE_BILL") trigger("CREATE_BILL_ROUTINE_ALLOW", ["/action/actionType"]);
  if (trace.length === 0 || !trace.some((item) => item.outcome === "ALLOW" || item.outcome === "REVIEW" || item.outcome === "DENY")) trigger("NO_EXPLICIT_ALLOW_RULE", ["/action/actionType"]);

  trace.sort((left, right) => outcomeRank[left.outcome] - outcomeRank[right.outcome] || left.reasonOrdinal - right.reasonOrdinal || ascii(left.reasonCode, right.reasonCode));
  const decision: PolicyDecision = trace.some((item) => item.outcome === "DENY") ? "DENY" : trace.some((item) => item.outcome === "REVIEW") ? "REVIEW" : trace.some((item) => item.outcome === "ALLOW") ? "ALLOW" : "DENY";
  const reasonCodes = [...new Set(trace.map((item) => item.reasonCode))];
  const material = {
    decision,
    reasonCodes,
    ruleTrace: trace,
    actionFingerprint: input.action.computedActionFingerprint,
    policyVersion: bundle.policyVersion,
    evaluatorVersion: bundle.evaluatorVersion,
  };
  return { ...material, resultSha256: policyResultSha256(material) };
}
