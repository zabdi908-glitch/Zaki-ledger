import type {
  CanonicalPostingIntent,
  GateDecision,
  PostingActor,
  PostingReasonCode,
} from "./posting-contract";

export interface EvidenceValidation {
  evidenceId: string;
  status: "VALID" | "MISSING" | "STALE" | "SCOPE_MISMATCH" | "HASH_MISMATCH";
}

export interface AccountMappingValidation {
  mappingId: string;
  status: "ELIGIBLE" | "MISSING" | "SCOPE_MISMATCH" | "INELIGIBLE";
}

export interface HumanApprovalValidation {
  id: string;
  authorizedRequestFingerprint: string;
  practiceId: string;
  clientEntityId: string;
  ledgerBookId: string;
  providerConnectionId: string;
  provider: string;
  externalOrganisationId: string;
  operationKind: string;
  externalObjectType: string;
  action: string;
  approvedByUserId: string;
  approvedAt: string;
  expiresAt: string | null;
  approverAuthorized: boolean;
}

export interface PostingValidationContext {
  destination: {
    clientExists: boolean;
    clientActive: boolean;
    ledgerBookMatches: boolean;
    ledgerBookActive: boolean;
    providerConnectionMatches: boolean;
    providerConnectionActive: boolean;
    currencySupported: boolean;
  };
  actorAuthorized: boolean;
  evidence: EvidenceValidation[];
  accountMappings: AccountMappingValidation[];
  humanApproval: HumanApprovalValidation | null;
  now: string;
}

function decision(
  deny: PostingReasonCode[],
  review: PostingReasonCode[],
): GateDecision {
  if (deny.length > 0) return { decision: "DENY", reasonCodes: deny };
  if (review.length > 0) return { decision: "REVIEW", reasonCodes: review };
  return { decision: "ALLOW", reasonCodes: ["CORE_SAFETY_ALLOW"] };
}

function isPositiveDecimal(value: unknown): boolean {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.\d+$/.test(value)) return false;
  return Number(value) > 0 && Number.isFinite(Number(value));
}

function isCurrency(value: unknown): boolean {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

export class CorePostingSafetyGate {
  evaluate(
    intent: CanonicalPostingIntent,
    actor: PostingActor,
    context: PostingValidationContext,
  ): GateDecision {
    const deny: PostingReasonCode[] = [];
    const review: PostingReasonCode[] = [];

    if (!context.destination.clientExists || !context.destination.ledgerBookMatches ||
        !context.destination.providerConnectionMatches) {
      deny.push("DESTINATION_BINDING_MISMATCH");
    } else {
      if (!context.destination.clientActive) deny.push("INACTIVE_CLIENT");
      if (!context.destination.ledgerBookActive) deny.push("INACTIVE_LEDGER_BOOK");
      if (!context.destination.providerConnectionActive) deny.push("INACTIVE_PROVIDER_CONNECTION");
    }

    if (actor.kind !== "USER" || !context.actorAuthorized) {
      deny.push("UNAUTHORIZED_ACTOR");
    }

    if (intent.action !== "CREATE") deny.push("UNSUPPORTED_ACTION");
    if (!new Set(["BILL", "VENDOR"]).has(intent.externalObjectType)) {
      deny.push("UNSUPPORTED_OBJECT_TYPE");
    }
    if (intent.action === "CREATE" && !intent.sourceActionClaimFingerprint) {
      deny.push("INVALID_REQUESTED_OBJECT");
    }

    if (intent.externalObjectType === "BILL") {
      if (!isPositiveDecimal(intent.requestedObject.amount)) deny.push("INVALID_AMOUNT");
      if (!isCurrency(intent.requestedObject.currency) || !context.destination.currencySupported) {
        deny.push("INVALID_CURRENCY");
      }
    }

    if (intent.requestedObject.synthetic === true && intent.requestedObject.liveTarget === true) {
      deny.push("SYNTHETIC_LIVE_PROHIBITED");
    }

    if (intent.evidence.length === 0) review.push("MISSING_EVIDENCE");
    if (context.evidence.length !== intent.evidence.length) {
      review.push("MISSING_EVIDENCE_REFERENCE");
    }
    for (const evidence of context.evidence) {
      if (evidence.status === "MISSING") review.push("MISSING_EVIDENCE_REFERENCE");
      if (evidence.status === "STALE") review.push("STALE_EVIDENCE");
      if (evidence.status === "SCOPE_MISMATCH") deny.push("EVIDENCE_SCOPE_MISMATCH");
      if (evidence.status === "HASH_MISMATCH") deny.push("EVIDENCE_FINGERPRINT_MISMATCH");
    }

    const mappedAccounts = intent.accountTreatment.filter((item) => item.disposition === "MAPPED");
    const ambiguousAccounts = intent.accountTreatment.filter((item) => item.disposition === "AMBIGUOUS");
    const notApplicableAccounts = intent.accountTreatment.filter((item) => item.disposition === "NOT_APPLICABLE");
    if (intent.externalObjectType === "BILL") {
      if (intent.accountTreatment.length === 0) review.push("MISSING_ACCOUNT_TREATMENT");
      if (ambiguousAccounts.length > 0) {
        review.push("AMBIGUOUS_ACCOUNT_TREATMENT");
      }
      if (notApplicableAccounts.length > 0) deny.push("ACCOUNT_NOT_APPLICABLE_PROHIBITED");
      if (mappedAccounts.length === 0 && ambiguousAccounts.length === 0 && notApplicableAccounts.length === 0) {
        review.push("MISSING_ACCOUNT_TREATMENT");
      }
    } else {
      if (intent.accountTreatment.length === 0) review.push("MISSING_ACCOUNT_TREATMENT");
      if (mappedAccounts.length > 0 || ambiguousAccounts.length > 0) {
        deny.push("ACCOUNT_NOT_APPLICABLE_PROHIBITED");
      }
    }

    for (const mapping of context.accountMappings) {
      if (mapping.status === "MISSING" || mapping.status === "SCOPE_MISMATCH") {
        deny.push("ACCOUNT_MAPPING_SCOPE_MISMATCH");
      }
      if (mapping.status === "INELIGIBLE") deny.push("INELIGIBLE_ACCOUNT_MAPPING");
    }
    if (context.accountMappings.length !== mappedAccounts.length) {
      deny.push("ACCOUNT_MAPPING_SCOPE_MISMATCH");
    }

    const mappedTaxes = intent.taxTreatment.filter((item) => item.disposition === "MAPPED");
    const ambiguousTaxes = intent.taxTreatment.filter((item) => item.disposition === "AMBIGUOUS");
    const notApplicableTaxes = intent.taxTreatment.filter((item) => item.disposition === "NOT_APPLICABLE");
    if (intent.externalObjectType === "BILL") {
      if (intent.taxTreatment.length === 0) review.push("MISSING_TAX_TREATMENT");
      if (ambiguousTaxes.length > 0) review.push("AMBIGUOUS_TAX_TREATMENT");
      if (notApplicableTaxes.length > 0) deny.push("TAX_NOT_APPLICABLE_PROHIBITED");
      for (const tax of mappedTaxes) {
        if (!tax.treatmentId.trim() || !tax.providerTaxCode.trim() ||
            !/^[0-9a-f]{64}$/i.test(tax.evidenceFingerprint)) {
          deny.push("INVALID_TAX_TREATMENT");
        }
      }
    } else {
      if (intent.taxTreatment.length === 0) review.push("MISSING_TAX_TREATMENT");
      if (mappedTaxes.length > 0 || ambiguousTaxes.length > 0) {
        deny.push("TAX_NOT_APPLICABLE_PROHIBITED");
      }
    }

    return decision([...new Set(deny)], [...new Set(review)]);
  }
}

export class Step5DeterministicPermissionGate {
  evaluate(
    intent: CanonicalPostingIntent,
    coreDecision: GateDecision,
    context: PostingValidationContext,
  ): GateDecision {
    if (coreDecision.decision !== "ALLOW") return coreDecision;
    const approval = context.humanApproval;
    if (!intent.humanApprovalId || !approval) {
      return { decision: "REVIEW", reasonCodes: ["MISSING_HUMAN_APPROVAL"] };
    }
    if (approval.authorizedRequestFingerprint !== intent.authorizedRequestFingerprint) {
      return { decision: "REVIEW", reasonCodes: ["STALE_APPROVAL_HASH"] };
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(context.now)) {
      return { decision: "REVIEW", reasonCodes: ["STALE_HUMAN_APPROVAL"] };
    }
    if (Date.parse(approval.approvedAt) > Date.parse(context.now)) {
      return { decision: "REVIEW", reasonCodes: ["STALE_HUMAN_APPROVAL"] };
    }
    if (
      approval.practiceId !== intent.practiceId ||
      approval.clientEntityId !== intent.clientEntityId ||
      approval.ledgerBookId !== intent.ledgerBookId ||
      approval.providerConnectionId !== intent.providerConnectionId ||
      approval.provider !== intent.provider ||
      approval.externalOrganisationId !== intent.externalOrganisationId ||
      approval.operationKind !== intent.operationKind ||
      approval.externalObjectType !== intent.externalObjectType ||
      approval.action !== intent.action
    ) {
      return { decision: "DENY", reasonCodes: ["APPROVAL_SCOPE_MISMATCH"] };
    }
    if (!approval.approverAuthorized) {
      return { decision: "DENY", reasonCodes: ["UNAUTHORIZED_APPROVER"] };
    }
    return { decision: "ALLOW", reasonCodes: ["PERMISSION_ALLOW"] };
  }
}
