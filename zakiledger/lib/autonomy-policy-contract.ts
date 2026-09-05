export const POLICY_DECISIONS = ["ALLOW", "REVIEW", "DENY"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const SUPPORTED_POLICY_ACTIONS = [
  "ADOPT_EXISTING_VENDOR",
  "CREATE_VENDOR",
  "CREATE_BILL",
] as const;
export type SupportedPolicyAction = (typeof SUPPORTED_POLICY_ACTIONS)[number];

export type PolicyActionType = SupportedPolicyAction | string;
export type EvidenceQuality = "STRONG" | "ACCEPTABLE" | "WEAK" | "UNKNOWN";
export type EvidenceCompleteness = "COMPLETE" | "INCOMPLETE" | "CONFLICTED" | "UNKNOWN";
export type FactProvenance = "DETERMINISTIC" | "MODEL" | "HUMAN_ATTESTED" | "UNKNOWN";
export type TreatmentCertainty = "EXACT" | "AMBIGUOUS" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";
export type ReversibilityClass = "DIRECT" | "COMPENSATING" | "IRREVERSIBLE" | "UNKNOWN";
export type RiskSeverity = "INFO" | "REVIEW" | "DENY" | "UNKNOWN";
export type AuthorizationState = "EXACT" | "MISSING" | "EXPIRED" | "REVOKED" | "WRONG_SCOPE" | "UNKNOWN";

export interface PolicyReasonDefinition {
  code: string;
  outcome: PolicyDecision;
  ordinal: number;
}

export interface PolicyProfileDefinition {
  actionType: SupportedPolicyAction;
  enabled: boolean;
  allowPermitted: boolean;
  requiresAmount: boolean;
  maxReversibility: ReversibilityClass;
  minimumConfidenceBasisPoints: number;
  minimumPriorVerifiedActions: number;
  requiresHumanAuthorization: boolean;
}

export interface AutonomyPolicyBundle {
  policyVersion: "step7-initial-profiles-v1";
  contractVersion: "step7-day1-policy-contract-v1";
  canonicalizationVersion: "step7-canonical-json-v1";
  evaluatorVersion: "step7-policy-evaluator-v1";
  decisionPrecedence: readonly ["DENY", "REVIEW", "ALLOW"];
  profiles: Record<SupportedPolicyAction, PolicyProfileDefinition>;
  reversibilityRegistry: Record<ReversibilityClass, number>;
  riskRegistry: Record<string, RiskSeverity>;
  reasons: readonly PolicyReasonDefinition[];
}

/** Authoritative monetary limits are signed integer minor units represented as bigint in memory. */
export interface ClientPolicySnapshot {
  snapshotVersion: number;
  clientEntityId: string;
  policyVersion: string;
  enabledProfiles: readonly SupportedPolicyAction[];
  maxSingleActionAmountMinor: bigint | null;
  maxDailyAggregateAmountMinor: bigint | null;
  requireHumanAuthorizationFor: readonly SupportedPolicyAction[];
  suspended: boolean;
}

export interface PolicyEvidenceFact {
  evidenceId: string;
  revisionId: string | null;
  sha256: string;
  verifiedSha256: string;
  clientEntityId: string;
  ledgerBookId: string;
  retained: boolean;
  verified: boolean;
  provenance: FactProvenance;
}

export interface PolicyConfidenceFact {
  fact: string;
  basisPoints: number;
  provenance: FactProvenance;
}

export interface PolicyRiskFlag {
  code: string;
  severity: RiskSeverity;
  evidenceSha256: string;
}

export interface NormalizedPolicyInput {
  schemaVersion: "step7-normalized-policy-input-v1";
  client: {
    clientEntityId: string;
    ledgerBookId: string;
    active: boolean;
  };
  action: {
    actionType: PolicyActionType;
    fingerprintVersion: "step7-action-fingerprint-v1" | "step5-authorized-request-v1";
    claimedActionFingerprint: string;
    computedActionFingerprint: string;
    step5AuthorizedRequestFingerprint: string | null;
    snapshot: Record<string, unknown>;
  };
  amount: {
    amountMinor: bigint | null;
    currencyCode: string | null;
    dailyAggregateBeforeMinor: bigint | null;
    rawSourceDecimal: string | null;
  };
  evidence: {
    quality: EvidenceQuality;
    completeness: EvidenceCompleteness;
    facts: readonly PolicyEvidenceFact[];
  };
  confidence: readonly PolicyConfidenceFact[];
  transactionType: string;
  accountTreatment: {
    certainty: TreatmentCertainty;
    mappingId: string | null;
    verified: boolean;
  };
  taxTreatment: {
    certainty: TreatmentCertainty;
    treatmentId: string | null;
    verified: boolean;
  };
  reversibility: ReversibilityClass;
  history: {
    priorVerifiedActions: number;
    stablePattern: boolean;
    hasCorrectionsOrReversals: boolean;
    snapshotSha256: string;
  };
  riskFlags: readonly PolicyRiskFlag[];
  humanAuthorization: {
    state: AuthorizationState;
    authorizationId: string | null;
    authorizedActionFingerprint: string | null;
    authorizedClientEntityId: string | null;
    authorizedLedgerBookId: string | null;
    authorizedActionType: PolicyActionType | null;
  };
  profileFacts: {
    existingVendorMatch: "EXACT_UNIQUE_CURRENT_VERIFIED" | "AMBIGUOUS" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";
    billArithmeticVerified: boolean | null;
    duplicateCheck: "CLEAR" | "POSSIBLE_DUPLICATE" | "INCOMPLETE" | "NOT_APPLICABLE" | "UNKNOWN";
    vendorBindingVerified: boolean | null;
  };
  evaluationAsOf: string;
  modelProposedPermission: PolicyDecision | null;
}

export interface NormalizationIssue {
  code: string;
  path: string;
  valueDigest: string;
}

export interface CanonicalPolicyInput {
  input: NormalizedPolicyInput;
  issues: readonly NormalizationIssue[];
  actionSnapshotCanonicalJson: string;
  normalizedInputCanonicalJson: string;
  normalizedInputSha256: string;
  submittedPayloadSha256: string;
}

export interface PolicyRuleTrace {
  outcome: PolicyDecision;
  reasonCode: string;
  reasonOrdinal: number;
  inputPaths: readonly string[];
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  reasonCodes: readonly string[];
  ruleTrace: readonly PolicyRuleTrace[];
  actionFingerprint: string;
  policyVersion: string;
  evaluatorVersion: string;
  resultSha256: string;
}

export interface PolicyEvaluationRequest {
  bundle: AutonomyPolicyBundle;
  bundleSha256: string;
  clientSnapshot: ClientPolicySnapshot;
  clientSnapshotSha256: string;
  canonicalInput: CanonicalPolicyInput;
}

export interface StoredPolicyDecision extends PolicyEvaluationResult {
  id: string;
  decisionKey: string;
  normalizedPolicyInputId: string;
  reused: boolean;
}
