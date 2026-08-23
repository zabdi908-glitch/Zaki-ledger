import { createHash } from "node:crypto";

export const POSTING_STATES = [
  "PROPOSED",
  "REVIEW",
  "VALIDATED",
  "AUTHORIZED",
  "SUBMITTING",
  "VERIFYING",
  "FAILED_SAFE",
  "UNCERTAIN",
  "DENIED",
  "SUCCEEDED",
] as const;

export type PostingState = (typeof POSTING_STATES)[number];
export type PostingProvider = "quickbooks" | "xero";
export type PostingAction =
  | "CREATE"
  | "UPDATE"
  | "VOID"
  | "DELETE"
  | "PAYMENT"
  | "JOURNAL"
  | "TRANSFER";

export interface PostingActor {
  kind: "USER";
  userId: string;
}

export type EvidenceReference =
  | {
      kind: "IMPORT_ARTIFACT";
      evidenceId: string;
      fingerprint: string;
    }
  | {
      kind: "FINANCIAL_DOCUMENT_REVISION";
      evidenceId: string;
      revisionId: string;
      fingerprint: string;
    };

export type AccountTreatment =
  | { disposition: "MAPPED"; mappingId: string }
  | { disposition: "NOT_APPLICABLE"; reason: string }
  | { disposition: "AMBIGUOUS"; candidateMappingIds: string[] };

export type TaxTreatment =
  | {
      disposition: "MAPPED";
      treatmentId: string;
      providerTaxCode: string;
      evidenceFingerprint: string;
    }
  | { disposition: "NOT_APPLICABLE"; reason: string }
  | { disposition: "AMBIGUOUS"; candidateTreatmentIds: string[] };

export interface SourceActionClaim {
  sourceKind: string;
  sourceId: string;
  sourceRevision: string;
  postingSubjectKey: string;
}

export interface PostingIntent {
  /** Optional caller-preallocated ID for an exact disclosed child operation. */
  operationId?: string | null;
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  provider: PostingProvider;
  externalOrganisationId: string;
  parentOperationId?: string | null;
  operationKind: string;
  externalObjectType: string;
  action: PostingAction;
  idempotencyKey: string;
  sourceActionClaim?: SourceActionClaim | null;
  intentSchemaVersion: string;
  canonicalizationVersion: string;
  validationRuleSetVersion: string;
  requestedObject: Record<string, unknown>;
  evidence: EvidenceReference[];
  accountTreatment: AccountTreatment[];
  taxTreatment: TaxTreatment[];
  expectedMaterialState: Record<string, unknown>;
  humanApprovalId?: string | null;
}

export interface CanonicalPostingIntent extends PostingIntent {
  authorizedRequestFingerprint: string;
  sourceActionClaimFingerprint: string | null;
}

export interface PostingOperation {
  id: string;
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  provider: PostingProvider;
  externalOrganisationId: string;
  parentOperationId: string | null;
  operationKind: string;
  externalObjectType: string;
  action: PostingAction;
  idempotencyKey: string;
  sourceActionClaimFingerprint: string | null;
  authorizedRequestFingerprint: string;
  currentState: PostingState;
  humanAuthorizationId: string | null;
  permissionDecisionId: string | null;
  rowVersion: number;
}

export type PostingReasonCode =
  | "OPERATION_CLAIMED"
  | "IDEMPOTENCY_CONFLICT"
  | "DUPLICATE_CREATE_CLAIM"
  | "DESTINATION_BINDING_MISMATCH"
  | "INACTIVE_CLIENT"
  | "INACTIVE_LEDGER_BOOK"
  | "INACTIVE_PROVIDER_CONNECTION"
  | "UNAUTHORIZED_ACTOR"
  | "UNSUPPORTED_ACTION"
  | "UNSUPPORTED_OBJECT_TYPE"
  | "INVALID_REQUESTED_OBJECT"
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "SYNTHETIC_LIVE_PROHIBITED"
  | "MISSING_EVIDENCE"
  | "MISSING_EVIDENCE_REFERENCE"
  | "STALE_EVIDENCE"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "EVIDENCE_FINGERPRINT_MISMATCH"
  | "MISSING_ACCOUNT_TREATMENT"
  | "AMBIGUOUS_ACCOUNT_TREATMENT"
  | "ACCOUNT_MAPPING_SCOPE_MISMATCH"
  | "INELIGIBLE_ACCOUNT_MAPPING"
  | "ACCOUNT_NOT_APPLICABLE_PROHIBITED"
  | "MISSING_TAX_TREATMENT"
  | "AMBIGUOUS_TAX_TREATMENT"
  | "INVALID_TAX_TREATMENT"
  | "TAX_NOT_APPLICABLE_PROHIBITED"
  | "MISSING_HUMAN_APPROVAL"
  | "STALE_APPROVAL_HASH"
  | "STALE_HUMAN_APPROVAL"
  | "APPROVAL_SCOPE_MISMATCH"
  | "UNAUTHORIZED_APPROVER"
  | "CORE_SAFETY_ALLOW"
  | "PERMISSION_ALLOW";

export interface GateDecision {
  decision: "ALLOW" | "REVIEW" | "DENY";
  reasonCodes: PostingReasonCode[];
}

export interface PostingSubmitResult {
  operationId: string | null;
  state: PostingState | "DENIED";
  reasonCodes: PostingReasonCode[];
  resumed: boolean;
  authorizedRequestFingerprint: string;
  conflictingOperationId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Non-finite numbers are not canonical posting values");
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalizePostingIntent(intent: PostingIntent): CanonicalPostingIntent {
  const semanticIntent = {
    operationKind: intent.operationKind,
    externalObjectType: intent.externalObjectType,
    action: intent.action,
    practiceId: intent.practiceId,
    clientEntityId: intent.clientEntityId,
    ledgerBookId: intent.ledgerBookId,
    providerConnectionId: intent.providerConnectionId,
    provider: intent.provider,
    externalOrganisationId: intent.externalOrganisationId,
    parentOperationId: intent.parentOperationId ?? null,
    requestedObject: intent.requestedObject,
    evidence: intent.evidence,
    accountTreatment: intent.accountTreatment,
    taxTreatment: intent.taxTreatment,
    expectedMaterialState: intent.expectedMaterialState,
    intentSchemaVersion: intent.intentSchemaVersion,
    canonicalizationVersion: intent.canonicalizationVersion,
    validationRuleSetVersion: intent.validationRuleSetVersion,
  };

  const sourceActionClaimFingerprint =
    intent.action === "CREATE" && intent.sourceActionClaim
      ? sha256Hex({
          practiceId: intent.practiceId,
          clientEntityId: intent.clientEntityId,
          ledgerBookId: intent.ledgerBookId,
          providerConnectionId: intent.providerConnectionId,
          provider: intent.provider,
          externalOrganisationId: intent.externalOrganisationId,
          externalObjectType: intent.externalObjectType,
          action: intent.action,
          sourceActionClaim: intent.sourceActionClaim,
        })
      : null;

  return {
    ...intent,
    operationId: intent.operationId ?? null,
    parentOperationId: intent.parentOperationId ?? null,
    humanApprovalId: intent.humanApprovalId ?? null,
    authorizedRequestFingerprint: sha256Hex(semanticIntent),
    sourceActionClaimFingerprint,
  };
}

export function normalizeHex(value: string): string {
  return value.replace(/^\\x/, "").toLowerCase();
}
