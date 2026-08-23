import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalJson,
  normalizeHex,
  sha256Hex,
  type CanonicalPostingIntent,
  type PostingActor,
  type PostingOperation,
  type PostingReasonCode,
  type PostingState,
} from "./posting-contract";
import type {
  AccountMappingValidation,
  EvidenceValidation,
  HumanApprovalValidation,
  PostingValidationContext,
} from "./posting-gates";

export type ClaimResult =
  | { kind: "CREATED"; operation: PostingOperation }
  | { kind: "RESUMED"; operation: PostingOperation }
  | { kind: "IDEMPOTENCY_CONFLICT"; conflictingOperationId: string }
  | { kind: "DUPLICATE_CREATE_CLAIM"; conflictingOperationId: string }
  | { kind: "DESTINATION_REJECTED" };

export type TransitionResult =
  | { kind: "TRANSITIONED"; operation: PostingOperation }
  | { kind: "UNCHANGED"; operation: PostingOperation }
  | { kind: "STALE"; operation: PostingOperation };

export interface PostingStore {
  claimOperation(intent: CanonicalPostingIntent, actor: PostingActor): Promise<ClaimResult>;
  getOperation(operationId: string): Promise<PostingOperation>;
  loadValidationContext(
    intent: CanonicalPostingIntent,
    actor: PostingActor,
  ): Promise<PostingValidationContext>;
  recordDecision(
    operation: PostingOperation,
    actor: PostingActor,
    reasonCode: PostingReasonCode,
    details: Record<string, unknown>,
  ): Promise<void>;
  transition(
    operation: PostingOperation,
    toState: PostingState,
    actor: PostingActor,
    reasonCode: PostingReasonCode,
    options?: { humanAuthorizationId?: string; permissionDecisionId?: string },
  ): Promise<TransitionResult>;
}

function requiredRow<T>(data: T | T[] | null, label: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`${label} returned no row`);
  return row;
}

function mapOperation(raw: Record<string, unknown>): PostingOperation {
  return {
    id: raw.id as string,
    practiceId: raw.practice_id as string,
    clientEntityId: raw.client_entity_id as string,
    ledgerBookId: raw.ledger_book_id as string,
    providerConnectionId: raw.provider_connection_id as string,
    provider: raw.provider as PostingOperation["provider"],
    externalOrganisationId: raw.external_organisation_id as string,
    parentOperationId: (raw.parent_operation_id as string | null) ?? null,
    operationKind: raw.operation_kind as string,
    externalObjectType: raw.external_object_type as string,
    action: raw.action as PostingOperation["action"],
    idempotencyKey: raw.idempotency_key as string,
    sourceActionClaimFingerprint: raw.source_action_claim_fingerprint
      ? normalizeHex(raw.source_action_claim_fingerprint as string)
      : null,
    authorizedRequestFingerprint: normalizeHex(raw.authorized_request_fingerprint as string),
    currentState: raw.current_state as PostingState,
    humanAuthorizationId: (raw.human_authorization_id as string | null) ?? null,
    permissionDecisionId: (raw.permission_decision_id as string | null) ?? null,
    rowVersion: Number(raw.row_version),
  };
}

function unwrapRpcOperation(data: unknown): PostingOperation {
  const payload = requiredRow<Record<string, unknown>>(
    data as Record<string, unknown>,
    "posting RPC",
  );
  const operation = payload.operation as Record<string, unknown> | undefined;
  if (!operation) throw new Error("posting RPC response omitted operation");
  return mapOperation(operation);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function documentEvidenceFingerprint(row: Record<string, unknown>): string {
  return sha256Hex({
    kind: "FINANCIAL_DOCUMENT_REVISION",
    id: row.id,
    clientEntityId: row.client_entity_id,
    documentId: row.document_id,
    revisionNumber: Number(row.revision_number),
    previousRevisionId: row.previous_revision_id ?? null,
    obligationStatus: row.obligation_status,
    resolutionStatus: row.resolution_status,
    issuerName: row.issuer_name ?? null,
    documentNumber: row.document_number ?? null,
    documentDate: row.document_date ?? null,
    dueDate: row.due_date ?? null,
    amountMinor: row.amount_minor === null ? null : String(row.amount_minor),
    currencyCode: row.currency_code ?? null,
    minorUnitExponent: row.minor_unit_exponent === null ? null : Number(row.minor_unit_exponent),
    provenance: row.provenance,
  });
}

export class SupabasePostingStore implements PostingStore {
  constructor(private readonly db: SupabaseClient) {}

  async claimOperation(intent: CanonicalPostingIntent, actor: PostingActor): Promise<ClaimResult> {
    const requestedObject = intent.operationId
      ? { ...intent.requestedObject, __zakiRequestedOperationId: intent.operationId }
      : intent.requestedObject;
    const { data, error } = await this.db.rpc("claim_posting_operation_v1", {
      p_practice_id: intent.practiceId,
      p_client_entity_id: intent.clientEntityId,
      p_ledger_book_id: intent.ledgerBookId,
      p_provider_connection_id: intent.providerConnectionId,
      p_provider: intent.provider,
      p_external_organisation_id: intent.externalOrganisationId,
      p_parent_operation_id: intent.parentOperationId,
      p_operation_kind: intent.operationKind,
      p_external_object_type: intent.externalObjectType,
      p_action: intent.action,
      p_idempotency_key: intent.idempotencyKey,
      p_source_action_claim_fingerprint_hex: intent.sourceActionClaimFingerprint,
      p_authorized_request_fingerprint_hex: intent.authorizedRequestFingerprint,
      p_intent_schema_version: intent.intentSchemaVersion,
      p_canonicalization_version: intent.canonicalizationVersion,
      p_validation_rule_set_version: intent.validationRuleSetVersion,
      p_requested_object: requestedObject,
      p_evidence_snapshot: intent.evidence,
      p_account_treatment_snapshot: intent.accountTreatment,
      p_tax_treatment_snapshot: intent.taxTreatment,
      p_expected_material_state: intent.expectedMaterialState,
      p_actor_user_id: actor.userId,
    });
    if (error) {
      if (errorCode(error) === "23503") {
        return { kind: "DESTINATION_REJECTED" };
      }
      throw new Error(`Posting operation claim failed: ${error.message}`);
    }
    const payload = requiredRow<Record<string, unknown>>(
      data as Record<string, unknown>,
      "claim_posting_operation_v1",
    );
    const outcome = payload.outcome as ClaimResult["kind"];
    if (outcome === "IDEMPOTENCY_CONFLICT" || outcome === "DUPLICATE_CREATE_CLAIM") {
      return {
        kind: outcome,
        conflictingOperationId: payload.conflicting_operation_id as string,
      };
    }
    return { kind: outcome, operation: unwrapRpcOperation(payload) } as ClaimResult;
  }

  async getOperation(operationId: string): Promise<PostingOperation> {
    const { data, error } = await this.db
      .from("posting_operations")
      .select("*")
      .eq("id", operationId)
      .single();
    if (error) throw new Error(`Posting operation reload failed: ${error.message}`);
    return mapOperation(data as Record<string, unknown>);
  }

  private async actorAuthorized(
    userId: string,
    practiceId: string,
    clientEntityId: string,
  ): Promise<boolean> {
    const { data: memberships, error } = await this.db
      .from("practice_memberships")
      .select("id,role,status,valid_from,valid_to")
      .eq("practice_id", practiceId)
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw new Error(`Posting actor authority lookup failed: ${error.message}`);
    const now = Date.now();
    const active = (memberships ?? []).filter((row) =>
      Date.parse(row.valid_from) <= now && (!row.valid_to || Date.parse(row.valid_to) > now),
    );
    if (active.some((row) => row.role === "owner" || row.role === "admin")) return true;
    const membershipIds = active.map((row) => row.id);
    if (membershipIds.length === 0) return false;
    const { data: grants, error: grantError } = await this.db
      .from("client_access")
      .select("role,status,valid_from,valid_to")
      .eq("client_entity_id", clientEntityId)
      .eq("user_id", userId)
      .in("membership_id", membershipIds)
      .eq("status", "active");
    if (grantError) throw new Error(`Posting client authority lookup failed: ${grantError.message}`);
    return (grants ?? []).some((row) =>
      (row.role === "admin" || row.role === "bookkeeper") &&
      Date.parse(row.valid_from) <= now &&
      (!row.valid_to || Date.parse(row.valid_to) > now),
    );
  }

  private async validateEvidence(intent: CanonicalPostingIntent): Promise<EvidenceValidation[]> {
    const output: EvidenceValidation[] = [];
    for (const reference of intent.evidence) {
      if (reference.kind === "IMPORT_ARTIFACT") {
        const { data, error } = await this.db
          .from("import_artifacts")
          .select("id,client_entity_id,content_sha256,storage_state")
          .eq("id", reference.evidenceId)
          .maybeSingle();
        if (error) throw new Error(`Posting evidence lookup failed: ${error.message}`);
        let status: EvidenceValidation["status"] = "VALID";
        if (!data) status = "MISSING";
        else if (data.client_entity_id !== intent.clientEntityId) status = "SCOPE_MISMATCH";
        else if (data.storage_state !== "retained") status = "STALE";
        else if (normalizeHex(data.content_sha256) !== normalizeHex(reference.fingerprint)) {
          status = "HASH_MISMATCH";
        }
        output.push({ evidenceId: reference.evidenceId, status });
        continue;
      }

      const { data: revision, error } = await this.db
        .from("financial_document_revisions")
        .select("*")
        .eq("id", reference.revisionId)
        .maybeSingle();
      if (error) throw new Error(`Posting document evidence lookup failed: ${error.message}`);
      let status: EvidenceValidation["status"] = "VALID";
      if (!revision) status = "MISSING";
      else if (revision.client_entity_id !== intent.clientEntityId ||
               revision.document_id !== reference.evidenceId) status = "SCOPE_MISMATCH";
      else {
        const { data: document, error: documentError } = await this.db
          .from("financial_documents")
          .select("current_revision_id,archived_at")
          .eq("id", reference.evidenceId)
          .eq("client_entity_id", intent.clientEntityId)
          .maybeSingle();
        if (documentError) throw new Error(`Posting document root lookup failed: ${documentError.message}`);
        if (!document) status = "MISSING";
        else if (document.archived_at || document.current_revision_id !== reference.revisionId) status = "STALE";
        else if (documentEvidenceFingerprint(revision as Record<string, unknown>) !==
                 normalizeHex(reference.fingerprint)) status = "HASH_MISMATCH";
      }
      output.push({ evidenceId: reference.evidenceId, status });
    }
    return output;
  }

  private async validateMappings(intent: CanonicalPostingIntent): Promise<AccountMappingValidation[]> {
    const mappingIds = intent.accountTreatment
      .filter((item) => item.disposition === "MAPPED")
      .map((item) => item.mappingId);
    if (mappingIds.length === 0) return [];
    const [{ data: mappings, error }, { data: eligible, error: eligibleError }] = await Promise.all([
      this.db.from("provider_posting_account_mappings").select("*").in("id", mappingIds),
      this.db.from("eligible_provider_posting_accounts").select("id").in("id", mappingIds),
    ]);
    if (error) throw new Error(`Posting account mapping lookup failed: ${error.message}`);
    if (eligibleError) throw new Error(`Posting account eligibility lookup failed: ${eligibleError.message}`);
    const byId = new Map((mappings ?? []).map((row) => [row.id as string, row]));
    const eligibleIds = new Set((eligible ?? []).map((row) => row.id as string));
    return mappingIds.map((mappingId) => {
      const row = byId.get(mappingId);
      if (!row) return { mappingId, status: "MISSING" };
      const matches =
        row.practice_id === intent.practiceId &&
        row.client_entity_id === intent.clientEntityId &&
        row.ledger_book_id === intent.ledgerBookId &&
        row.provider_connection_id === intent.providerConnectionId &&
        row.provider === intent.provider &&
        row.external_organisation_id === intent.externalOrganisationId;
      if (!matches) return { mappingId, status: "SCOPE_MISMATCH" };
      return { mappingId, status: eligibleIds.has(mappingId) ? "ELIGIBLE" : "INELIGIBLE" };
    });
  }

  private async loadApproval(
    intent: CanonicalPostingIntent,
  ): Promise<HumanApprovalValidation | null> {
    if (!intent.humanApprovalId) return null;
    const { data, error } = await this.db
      .from("posting_human_authorizations")
      .select("*")
      .eq("id", intent.humanApprovalId)
      .maybeSingle();
    if (error) throw new Error(`Posting human approval lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      id: data.id,
      authorizedRequestFingerprint: normalizeHex(data.authorized_request_fingerprint),
      practiceId: data.practice_id,
      clientEntityId: data.client_entity_id,
      ledgerBookId: data.ledger_book_id,
      providerConnectionId: data.provider_connection_id,
      provider: data.provider,
      externalOrganisationId: data.external_organisation_id,
      operationKind: data.operation_kind,
      externalObjectType: data.external_object_type,
      action: data.action,
      approvedByUserId: data.approved_by_user_id,
      approvedAt: data.approved_at,
      expiresAt: data.expires_at,
      approverAuthorized: await this.actorAuthorized(
        data.approved_by_user_id,
        data.practice_id,
        data.client_entity_id,
      ),
    };
  }

  async loadValidationContext(
    intent: CanonicalPostingIntent,
    actor: PostingActor,
  ): Promise<PostingValidationContext> {
    const [clientResult, bookResult, connectionResult, currencyResult, evidence, accountMappings,
      actorAuthorized, humanApproval] = await Promise.all([
      this.db.from("client_entities").select("id,status").eq("id", intent.clientEntityId)
        .eq("practice_id", intent.practiceId).maybeSingle(),
      this.db.from("ledger_books").select("id,status").eq("id", intent.ledgerBookId)
        .eq("client_entity_id", intent.clientEntityId).maybeSingle(),
      this.db.from("provider_connections").select("id,status").eq("id", intent.providerConnectionId)
        .eq("client_entity_id", intent.clientEntityId).eq("ledger_book_id", intent.ledgerBookId)
        .eq("provider", intent.provider).eq("external_organisation_id", intent.externalOrganisationId)
        .maybeSingle(),
      this.db.from("currency_definitions").select("code")
        .eq("code", typeof intent.requestedObject.currency === "string"
          ? intent.requestedObject.currency
          : "")
        .maybeSingle(),
      this.validateEvidence(intent),
      this.validateMappings(intent),
      this.actorAuthorized(actor.userId, intent.practiceId, intent.clientEntityId),
      this.loadApproval(intent),
    ]);
    for (const result of [clientResult, bookResult, connectionResult, currencyResult]) {
      if (result.error) throw new Error(`Posting destination lookup failed: ${result.error.message}`);
    }
    return {
      destination: {
        clientExists: Boolean(clientResult.data),
        clientActive: clientResult.data?.status === "active",
        ledgerBookMatches: Boolean(bookResult.data),
        ledgerBookActive: bookResult.data?.status === "active",
        providerConnectionMatches: Boolean(connectionResult.data),
        providerConnectionActive: connectionResult.data?.status === "active",
        currencySupported: intent.externalObjectType !== "BILL" || Boolean(currencyResult.data),
      },
      actorAuthorized,
      evidence,
      accountMappings,
      humanApproval,
      now: new Date().toISOString(),
    };
  }

  async recordDecision(
    operation: PostingOperation,
    actor: PostingActor,
    reasonCode: PostingReasonCode,
    details: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_posting_decision_v1", {
      p_operation_id: operation.id,
      p_actor_user_id: actor.userId,
      p_reason_code: reasonCode,
      p_details: details,
    });
    if (error) throw new Error(`Posting decision persistence failed: ${error.message}`);
  }

  async transition(
    operation: PostingOperation,
    toState: PostingState,
    actor: PostingActor,
    reasonCode: PostingReasonCode,
    options: { humanAuthorizationId?: string; permissionDecisionId?: string } = {},
  ): Promise<TransitionResult> {
    const { data, error } = await this.db.rpc("transition_posting_operation_v1", {
      p_operation_id: operation.id,
      p_expected_state: operation.currentState,
      p_to_state: toState,
      p_actor_user_id: actor.userId,
      p_reason_code: reasonCode,
      p_human_authorization_id: options.humanAuthorizationId ?? null,
      p_permission_decision_id: options.permissionDecisionId ?? null,
      p_details: { fromService: "AuthoritativePostingService.submit" },
    });
    if (error) throw new Error(`Posting state transition failed: ${error.message}`);
    const payload = requiredRow<Record<string, unknown>>(
      data as Record<string, unknown>,
      "transition_posting_operation_v1",
    );
    return {
      kind: payload.outcome as TransitionResult["kind"],
      operation: unwrapRpcOperation(payload),
    } as TransitionResult;
  }
}

export const __postingStoreTestUtils = {
  documentEvidenceFingerprint,
  canonicalJson,
};
