export const REVERSIBILITY_DECISIONS = ["SAFE_METHOD", "REVIEW", "NO_SAFE_METHOD"] as const;
export type ReversibilityDecision = (typeof REVERSIBILITY_DECISIONS)[number];

export const REVERSIBILITY_PROVIDERS = ["quickbooks", "xero"] as const;
export type ReversibilityProvider = (typeof REVERSIBILITY_PROVIDERS)[number];

export const REVERSIBILITY_OBJECT_TYPES = [
  "QBO_VENDOR",
  "QBO_BILL",
  "XERO_CONTACT",
  "XERO_BILL",
] as const;
export type ReversibilityObjectType = (typeof REVERSIBILITY_OBJECT_TYPES)[number];

export const REVERSIBILITY_METHODS = [
  "QBO_VENDOR_SPARSE_UPDATE",
  "QBO_VENDOR_INACTIVATE",
  "QBO_BILL_SPARSE_UPDATE",
  "QBO_BILL_DELETE",
  "XERO_CONTACT_UPDATE",
  "XERO_CONTACT_ARCHIVE",
  "XERO_DRAFT_BILL_UPDATE",
  "XERO_DRAFT_BILL_DELETE",
  "XERO_APPROVED_BILL_UPDATE",
  "XERO_APPROVED_BILL_VOID",
  "XERO_PAID_BILL_METADATA_UPDATE",
] as const;
export type ReversibilityMethod = (typeof REVERSIBILITY_METHODS)[number];

export type DesiredCorrection =
  | "UPDATE_NON_FINANCIAL"
  | "UPDATE_FINANCIAL"
  | "INACTIVATE"
  | "ARCHIVE"
  | "DELETE"
  | "VOID";

export type ProviderLifecycleState =
  | "ACTIVE"
  | "INACTIVE"
  | "UNPAID_UNLINKED"
  | "UNPAID_LINKED"
  | "DRAFT"
  | "APPROVED_UNPAID"
  | "PART_PAID"
  | "PAID"
  | "ARCHIVED"
  | "VOIDED"
  | "DELETED"
  | "UNKNOWN";

export type ConstraintState = "CLEAR" | "BLOCKED" | "NOT_APPLICABLE" | "UNKNOWN";

export interface ReversibilityPlannerInput {
  contractVersion: "step8-reversibility-planner-v1";
  provider: ReversibilityProvider;
  objectType: ReversibilityObjectType;
  lifecycleState: ProviderLifecycleState;
  desiredCorrection: DesiredCorrection;
  originalOutcome: "CONFIRMED" | "UNCERTAIN";
  currentState: {
    readCompleted: boolean;
    observedAt: string | null;
    providerObjectId: string | null;
    providerVersionToken: string | null;
    stateFingerprint: string | null;
  };
  beforeState: {
    canonical: Record<string, unknown> | null;
    claimedFingerprint: string | null;
  };
  checks: {
    dependencies: ConstraintState;
    periodLock: ConstraintState;
    tax: ConstraintState;
    reconciliation: ConstraintState;
  };
  evaluationAsOf: string;
}

export interface CorrectionPlanStep {
  index: number;
  method: ReversibilityMethod;
  requiredBeforeStateFingerprint: string;
  requiredProviderVersionToken: string;
  afterStateVerification: "READ_BACK_AND_FINGERPRINT";
}

export interface CompoundCorrectionPlan {
  contractVersion: "step8-compound-correction-plan-v1";
  executionSemantics: "LINEAR_FAIL_CLOSED";
  steps: readonly CorrectionPlanStep[];
  fingerprint: string;
}

export interface ReversibilityPlannerResult {
  decision: ReversibilityDecision;
  reasonCodes: readonly string[];
  plan: CompoundCorrectionPlan | null;
  capabilityBundleVersion: "step8-provider-reversibility-v1";
  plannerVersion: "step8-pure-reversibility-planner-v1";
  grantsExecutionPermission: false;
}

export type CompoundStepOutcome = "SUCCEEDED_VERIFIED" | "SUCCEEDED_UNVERIFIED" | "FAILED" | "UNCERTAIN";

export interface CompoundStepResult {
  stepIndex: number;
  outcome: CompoundStepOutcome;
}

export type CompoundContinuation =
  | { disposition: "READY"; nextStepIndex: number }
  | { disposition: "COMPLETE" }
  | { disposition: "STOP"; reasonCode: "PRIOR_STEP_FAILED" | "PRIOR_STEP_UNCERTAIN" | "PRIOR_STEP_NOT_VERIFIED" | "STEP_RESULTS_INVALID" };
