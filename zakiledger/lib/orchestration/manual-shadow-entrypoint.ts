import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actionFingerprint, canonicalPolicyJson } from "../autonomy-policy-canonicalization";
import type {
  AutonomyPolicyBundle,
  ClientPolicySnapshot,
  NormalizedPolicyInput,
} from "../autonomy-policy-contract";
import {
  BalanceReconciliationShadowExecutor,
  PairedOfxBalanceEvidenceReader,
  QuickBooksGeneralLedgerBalanceReader,
  SupabaseBalanceShadowStore,
  type BalanceShadowResult,
  type BalanceShadowScope,
} from "../balance-reconciliation-shadow";
import { parseOfxStatement } from "../bank-parsers";
import {
  amountToMinorUnits,
  currencyMinorUnitDigits,
  normalizeCurrency,
  sha256Hex,
} from "../financial-identity";
import {
  computeAndPersistMatches,
  loadStep4ReconciliationFrontier,
} from "../reconciliation-store";
import type { ParsedStatement } from "../reconciliation-schema";
import { getSupabase } from "../supabase";
import { resolveTenantContextForUser } from "../tenant-context";
import { ExtractionToCanonicalAdapter, type CanonicalDomainPort } from "./extraction-to-canonical-adapter";
import { ReadOnlyPolicyInputAssembler, type ReadOnlyPolicyArtifactPort } from "./policy-input-assembler";
import {
  bindProductionShadowServices,
  freshExtractionInvocationMetadata,
  runManualProductionShadow,
  type ProductionShadowRunPlan,
} from "./production-shadow-composition";
import {
  ShadowReconciliationAdapter,
  step4FrontierManifest,
  type ReconciliationDomainPort,
  type ReconciliationManifestMember,
} from "./reconciliation-adapter";
import { shadowSha256 } from "./shadow-canonicalization";
import type { ShadowRunRecord, ShadowRunRequest, ShadowScope } from "./shadow-contract";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const OFX_BUCKET = "document-evidence";

/** Honest identity of the only extractor this production entrypoint can invoke. */
export const MANUAL_OFX_EXTRACTION_IDENTITY = Object.freeze({
  extractorName: "ofx-statement-parser",
  extractorVersion: "step2-ofx-v1",
  modelProvider: "deterministic",
  modelName: "parseOfxStatement",
  modelVersion: "step2-ofx-v1",
  modelConfigurationFingerprint: shadowSha256({
    namespace: "step9-ofx-parser-configuration-v1", format: "OFX",
  }),
  promptFingerprint: shadowSha256({ namespace: "step9-no-model-prompt-v1" }),
  hintsFingerprint: null,
  extractionContractVersion: "step9-ofx-extraction-v1",
});

export interface ManualShadowRequest extends ShadowScope {
  contractVersion: "step9-shadow-orchestration-v1";
  mode: "SHADOW";
  executionPermitted: false;
  requestedFor: string;
  correlationId: string;
  artifactNotRetainedBefore: string;
  artifact: {
    id: string;
    sha256: string;
    length: number;
    retainedAt: string;
    extractorName: string;
    extractorVersion: string;
    modelProvider: string;
    modelName: string;
    modelVersion: string;
    modelConfigurationFingerprint: string;
    promptFingerprint: string;
    hintsFingerprint: string | null;
    extractionContractVersion: string;
  };
  reconciliation: { statementId: string; reconciliationVersion: string };
  balanceProof: {
    scopeId: string;
    periodStart: string;
    periodEnd: string;
    openingArtifactId: string;
    closingArtifactId: string;
  };
}

export interface ManualShadowRuntime {
  execute(input: ManualShadowRequest, actorUserId: string): Promise<ShadowRunRecord>;
}

/** Authenticated route seam. The default route supplies requireUser(). */
export async function invokeManualShadow(
  request: Request,
  dependencies: {
    authenticate(): Promise<Pick<User, "id"> | null>;
    runtime(): ManualShadowRuntime;
  },
): Promise<Response> {
  const user = await dependencies.authenticate();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let input: ManualShadowRequest;
  try {
    input = await request.json() as ManualShadowRequest;
    assertManualShadowRequest(input);
  } catch {
    return Response.json({ error: "INVALID_MANUAL_SHADOW_REQUEST" }, { status: 400 });
  }

  try {
    const result = await dependencies.runtime().execute(input, user.id);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const reasonCode = safeReasonCode(error);
    const status = reasonCode.includes("FORBIDDEN") || reasonCode.includes("SCOPE") ? 403 : 409;
    return Response.json({ error: reasonCode }, { status });
  }
}

export function createManualShadowRuntime(): ManualShadowRuntime {
  const db = getSupabase();
  if (!db) throw new Error("MANUAL_SHADOW_DATABASE_REQUIRED");
  return new SupabaseManualShadowRuntime(db);
}

class SupabaseManualShadowRuntime implements ManualShadowRuntime {
  constructor(private readonly db: SupabaseClient) {}

  async execute(input: ManualShadowRequest, actorUserId: string): Promise<ShadowRunRecord> {
    assertManualShadowRequest(input);
    assertSupportedExtractionIdentity(input);
    const tenant = await resolveTenantContextForUser(actorUserId);
    if (tenant.practiceId !== input.practiceId || tenant.clientEntityId !== input.clientEntityId ||
        tenant.internalLedgerBookId !== input.ledgerBookId) {
      throw new Error("MANUAL_SHADOW_OPERATOR_SCOPE_FORBIDDEN");
    }
    await assertOwnerOrAdmin(this.db, actorUserId, input.practiceId);

    const artifact = await loadRetainedOfx(this.db, input.artifact.id, input.clientEntityId);
    if (artifact.sha256 !== input.artifact.sha256 || artifact.length !== input.artifact.length ||
        artifact.retainedAt !== new Date(input.artifact.retainedAt).toISOString()) {
      throw new Error("MANUAL_SHADOW_ARTIFACT_INTEGRITY_BLOCKED");
    }
    const expectedInvocation = freshExtractionInvocationMetadata(extractionInvocation(input));
    if (canonicalPolicyJson(artifact.extractionIdentity) !== canonicalPolicyJson(expectedInvocation)) {
      throw new Error("MANUAL_SHADOW_EXTRACTION_IDENTITY_BLOCKED");
    }
    if (input.balanceProof.closingArtifactId !== input.artifact.id) {
      throw new Error("MANUAL_SHADOW_FRESH_ARTIFACT_MUST_BE_CLOSING_EVIDENCE");
    }

    const opening = await loadRetainedOfx(this.db, input.balanceProof.openingArtifactId, input.clientEntityId);
    const statement = await exactStatement(this.db, actorUserId, input);
    const balanceStore = new SupabaseBalanceShadowStore(this.db);
    const balanceScope = await balanceStore.prepareScope(actorUserId, input.balanceProof.scopeId);
    if (balanceScope.clientEntityId !== input.clientEntityId) {
      throw new Error("MANUAL_SHADOW_BALANCE_SCOPE_FORBIDDEN");
    }
    const account = await exactFinancialAccount(this.db, input, balanceScope);
    const policyArtifacts = new SupabaseReadOnlyPolicyArtifacts(this.db);
    const policy = await policyArtifacts.load(input.clientEntityId);

    const scheduleKey = `manual:${shadowSha256({
      namespace: "step9-manual-shadow-semantic-input-v1",
      scope: pickScope(input), requestedFor: input.requestedFor,
      artifact: input.artifact, reconciliation: input.reconciliation,
      balanceProof: input.balanceProof,
    })}`;
    const request: ShadowRunRequest = {
      ...pickScope(input), contractVersion: input.contractVersion, scheduleKey,
      requestedFor: input.requestedFor, mode: "SHADOW", executionPermitted: false,
      correlationId: input.correlationId,
    };
    const workerId = `manual-shadow:${actorUserId}`;
    const reconciliationDomain = new SupabaseReconciliationDomain(actorUserId, input);
    const balanceExecutor = new BalanceReconciliationShadowExecutor(
      balanceStore,
      new PairedOfxBalanceEvidenceReader(),
      new QuickBooksGeneralLedgerBalanceReader({
        actorUserId,
        providerConnectionId: balanceScope.ledgerProviderConnectionId,
        realmId: balanceScope.ledgerOrganisationId,
      }),
    );
    const canonical = new ExtractionToCanonicalAdapter(
      new SupabaseCanonicalDomain(this.db, actorUserId, input.correlationId),
    );
    const plan: ProductionShadowRunPlan<ParsedStatement, Awaited<ReturnType<typeof computeAndPersistMatches>>, BalanceShadowResult> = {
      request,
      artifactNotRetainedBefore: input.artifactNotRetainedBefore,
      extraction: extractionInvocation(input),
      reconciliation: input.reconciliation,
      balanceProofInput: {
        actorUserId, scopeId: input.balanceProof.scopeId,
        periodStart: input.balanceProof.periodStart, periodEnd: input.balanceProof.periodEnd,
        openingArtifactId: opening.id, closingArtifactId: artifact.id,
        openingOfx: opening.text, closingOfx: artifact.text,
      },
      policyAssembly: conservativePolicyAssembly(input, policy, artifact.sha256),
      policyAudit: {
        policyBundleId: policy.bundle.id, clientPolicySnapshotId: policy.snapshot.id,
        requestedBy: `step9-shadow-user:${actorUserId}`, correlationId: input.correlationId,
      },
      canonicalInput: (extraction, extractionReference) => ({
        ...pickScope(input),
        artifact: { namespace: "import_artifact", id: artifact.id, fingerprint: artifact.sha256 },
        extraction: { namespace: "shadow_extraction_run", id: extractionReference.id,
          fingerprint: extractionReference.fingerprint },
        parserName: input.artifact.extractorName,
        parserVersion: input.artifact.extractorVersion,
        observations: canonicalObservations(extraction, input, account),
      }),
      planningInput: () => ({
        contractVersion: "step8-reversibility-planner-v1",
        provider: "quickbooks", objectType: "QBO_BILL", lifecycleState: "UNKNOWN",
        desiredCorrection: "UPDATE_NON_FINANCIAL", originalOutcome: "CONFIRMED",
        currentState: { readCompleted: false, observedAt: null, providerObjectId: null,
          providerVersionToken: null, stateFingerprint: null },
        beforeState: { canonical: null, claimedFingerprint: null },
        checks: { dependencies: "UNKNOWN", periodLock: "UNKNOWN", tax: "UNKNOWN", reconciliation: "UNKNOWN" },
        evaluationAsOf: input.requestedFor,
      }),
    };
    const bindings = bindProductionShadowServices({
      db: this.db, workerId,
      domain: {
        extractor: async () => parseOfxStatement(artifact.text),
        canonical,
        reconciliation: new ShadowReconciliationAdapter(reconciliationDomain),
        balanceProof: balanceExecutor,
        policyAssembler: new ReadOnlyPolicyInputAssembler(policyArtifacts),
      },
    });
    return runManualProductionShadow(plan, bindings);
  }
}

function assertManualShadowRequest(input: ManualShadowRequest): void {
  if (!input || input.contractVersion !== "step9-shadow-orchestration-v1" || input.mode !== "SHADOW" ||
      input.executionPermitted !== false) throw new Error("STEP9_SHADOW_ONLY");
  for (const value of [input.practiceId, input.clientEntityId, input.ledgerBookId, input.artifact?.id,
    input.reconciliation?.statementId, input.balanceProof?.scopeId, input.balanceProof?.openingArtifactId,
    input.balanceProof?.closingArtifactId]) if (!UUID.test(value ?? "")) throw new Error("INVALID_SCOPE_ID");
  for (const value of [input.artifact?.sha256, input.artifact?.modelConfigurationFingerprint,
    input.artifact?.promptFingerprint]) if (!SHA256.test(value ?? "")) throw new Error("INVALID_FINGERPRINT");
  if (input.artifact?.hintsFingerprint !== null && !SHA256.test(input.artifact?.hintsFingerprint ?? "")) {
    throw new Error("INVALID_HINTS_FINGERPRINT");
  }
  if (!Number.isSafeInteger(input.artifact?.length) || input.artifact.length <= 0) throw new Error("INVALID_ARTIFACT_LENGTH");
  for (const value of [input.artifact.extractorName, input.artifact.extractorVersion, input.artifact.modelProvider,
    input.artifact.modelName, input.artifact.modelVersion, input.artifact.extractionContractVersion,
    input.reconciliation.reconciliationVersion, input.correlationId]) {
    if (!SAFE_LABEL.test(value ?? "")) throw new Error("INVALID_IDENTITY_LABEL");
  }
  for (const value of [input.requestedFor, input.artifactNotRetainedBefore, input.artifact.retainedAt]) {
    if (!value || !Number.isFinite(Date.parse(value))) throw new Error("INVALID_TIMESTAMP");
  }
  for (const value of [input.balanceProof.periodStart, input.balanceProof.periodEnd]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error("INVALID_PERIOD");
  }
}

function assertSupportedExtractionIdentity(input: ManualShadowRequest): void {
  const claimed = {
    extractorName: input.artifact.extractorName,
    extractorVersion: input.artifact.extractorVersion,
    modelProvider: input.artifact.modelProvider,
    modelName: input.artifact.modelName,
    modelVersion: input.artifact.modelVersion,
    modelConfigurationFingerprint: input.artifact.modelConfigurationFingerprint,
    promptFingerprint: input.artifact.promptFingerprint,
    hintsFingerprint: input.artifact.hintsFingerprint,
    extractionContractVersion: input.artifact.extractionContractVersion,
  };
  if (canonicalPolicyJson(claimed) !== canonicalPolicyJson(MANUAL_OFX_EXTRACTION_IDENTITY)) {
    throw new Error("MANUAL_SHADOW_EXTRACTOR_UNSUPPORTED");
  }
}

function extractionInvocation(input: ManualShadowRequest) {
  return {
    ...pickScope(input),
    artifact: { namespace: "import_artifact" as const, id: input.artifact.id, fingerprint: input.artifact.sha256 },
    artifactLength: input.artifact.length, artifactRetainedAt: input.artifact.retainedAt,
    extractorName: input.artifact.extractorName, extractorVersion: input.artifact.extractorVersion,
    modelProvider: input.artifact.modelProvider, modelName: input.artifact.modelName,
    modelVersion: input.artifact.modelVersion,
    modelConfigurationFingerprint: input.artifact.modelConfigurationFingerprint,
    promptFingerprint: input.artifact.promptFingerprint, hintsFingerprint: input.artifact.hintsFingerprint,
    extractionContractVersion: input.artifact.extractionContractVersion,
  };
}

function pickScope(input: ShadowScope): ShadowScope {
  return { practiceId: input.practiceId, clientEntityId: input.clientEntityId, ledgerBookId: input.ledgerBookId };
}

function safeReasonCode(error: unknown): string {
  const raw = error instanceof Error ? error.message.split(":", 1)[0] : "MANUAL_SHADOW_FAILED_CLOSED";
  return /^[A-Z0-9_]+$/.test(raw) ? raw : "MANUAL_SHADOW_FAILED_CLOSED";
}

async function assertOwnerOrAdmin(db: SupabaseClient, userId: string, practiceId: string): Promise<void> {
  const { data, error } = await db.from("practice_memberships").select("id")
    .eq("practice_id", practiceId).eq("user_id", userId).eq("status", "active")
    .in("role", ["owner", "admin"]).maybeSingle();
  if (error || !data) throw new Error("MANUAL_SHADOW_OPERATOR_FORBIDDEN");
}

interface RetainedOfx {
  id: string; sha256: string; length: number; retainedAt: string; text: string;
  extractionIdentity: unknown;
}

async function loadRetainedOfx(db: SupabaseClient, id: string, clientEntityId: string): Promise<RetainedOfx> {
  const { data, error } = await db.from("import_artifacts")
    .select("id,artifact_kind,content_sha256,content_length,storage_state,received_at,archived_at,metadata")
    .eq("id", id).eq("client_entity_id", clientEntityId).maybeSingle();
  const metadata = data?.metadata as Record<string, unknown> | undefined;
  if (error || !data || data.artifact_kind !== "ofx_statement" || data.storage_state !== "retained" ||
      data.archived_at !== null || metadata?.storageBucket !== OFX_BUCKET ||
      typeof metadata.storageObjectKey !== "string") throw new Error("MANUAL_SHADOW_RETAINED_OFX_REQUIRED");
  const sha256 = normalizeHash(data.content_sha256);
  const { data: blob, error: downloadError } = await db.storage.from(OFX_BUCKET).download(metadata.storageObjectKey);
  if (!sha256 || downloadError || !blob) throw new Error("MANUAL_SHADOW_ARTIFACT_UNAVAILABLE");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== Number(data.content_length) || sha256Hex(bytes) !== sha256) {
    throw new Error("MANUAL_SHADOW_ARTIFACT_INTEGRITY_BLOCKED");
  }
  return { id: String(data.id), sha256, length: bytes.byteLength,
    retainedAt: new Date(String(data.received_at)).toISOString(), text: new TextDecoder().decode(bytes),
    extractionIdentity: metadata.step9ExtractionInvocation };
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hash = value.startsWith("\\x") ? value.slice(2) : value;
  return SHA256.test(hash) ? hash.toLowerCase() : null;
}

async function exactStatement(db: SupabaseClient, actorUserId: string, input: ManualShadowRequest) {
  const { data, error } = await db.from("bank_statements")
    .select("id,user_id,client_entity_id,ledger_book_id,statement_period_start,statement_period_end")
    .eq("id", input.reconciliation.statementId).eq("user_id", actorUserId)
    .eq("client_entity_id", input.clientEntityId).eq("ledger_book_id", input.ledgerBookId).maybeSingle();
  if (error || !data || !data.statement_period_start || !data.statement_period_end ||
      data.statement_period_start !== input.balanceProof.periodStart ||
      data.statement_period_end !== input.balanceProof.periodEnd) {
    throw new Error("MANUAL_SHADOW_STATEMENT_SCOPE_OR_PERIOD_BLOCKED");
  }
  return { periodStart: String(data.statement_period_start), periodEnd: String(data.statement_period_end) };
}

async function exactFinancialAccount(db: SupabaseClient, input: ManualShadowRequest, scope: BalanceShadowScope) {
  const { data, error } = await db.from("balance_reconciliation_scopes")
    .select("financial_account_id,ledger_book_id,client_entity_id,source_account_id")
    .eq("id", input.balanceProof.scopeId).eq("client_entity_id", input.clientEntityId)
    .eq("ledger_book_id", input.ledgerBookId).eq("source_account_id", scope.sourceAccountId).maybeSingle();
  if (error || !data) throw new Error("MANUAL_SHADOW_FINANCIAL_ACCOUNT_SCOPE_BLOCKED");
  const { data: account, error: accountError } = await db.from("financial_accounts")
    .select("id,stable_account_key_canonical,status").eq("id", data.financial_account_id)
    .eq("client_entity_id", input.clientEntityId).maybeSingle();
  if (accountError || !account || account.status !== "active" || !account.stable_account_key_canonical) {
    throw new Error("MANUAL_SHADOW_FINANCIAL_ACCOUNT_IDENTITY_BLOCKED");
  }
  return { id: String(account.id), stableKey: String(account.stable_account_key_canonical) };
}

class SupabaseCanonicalDomain implements CanonicalDomainPort {
  constructor(private readonly db: SupabaseClient, private readonly actorUserId: string, private readonly requestId: string) {}

  async startImport(input: Parameters<CanonicalDomainPort["startImport"]>[0]) {
    const { data, error } = await this.db.rpc("start_import_run_v1", {
      p_client_entity_id: input.clientEntityId, p_artifact_id: input.artifactId,
      p_provider_connection_id: null, p_idempotency_key: input.idempotencyKey,
      p_request_hash_hex: input.requestFingerprint, p_parser_name: input.parserName,
      p_parser_version: input.parserVersion, p_actor_kind: "user", p_actor_user_id: this.actorUserId,
      p_actor_service: null, p_request_id: this.requestId,
    });
    if (error) throw new Error(`CANONICAL_IMPORT_FAILED:${error.message}`);
    return { runId: rpcText(data, "run_id", "CANONICAL_IMPORT_RETURN_INVALID") };
  }

  async ingestObservation(input: Parameters<CanonicalDomainPort["ingestObservation"]>[0]) {
    const { data, error } = await this.db.rpc("ingest_financial_observation_v1", {
      p_client_entity_id: input.clientEntityId, p_root: input.root, p_revision: input.revision,
      p_identity_claims: input.identityClaims, p_event_revision: input.eventRevision,
      p_actor_kind: "user", p_actor_user_id: this.actorUserId, p_actor_service: null,
      p_request_id: this.requestId,
    });
    if (error) throw new Error(`CANONICAL_OBSERVATION_FAILED:${error.message}`);
    return { observationId: rpcText(data, "observation_id", "CANONICAL_OBSERVATION_RETURN_INVALID"),
      revisionId: rpcText(data, "revision_id", "CANONICAL_OBSERVATION_RETURN_INVALID"),
      eventId: rpcText(data, "event_id", "CANONICAL_OBSERVATION_RETURN_INVALID") };
  }

  async recordOccurrence(input: Parameters<CanonicalDomainPort["recordOccurrence"]>[0]) {
    const { data, error } = await this.db.rpc("record_financial_observation_occurrence_v1", {
      p_client_entity_id: input.clientEntityId, p_observation_id: input.observationId,
      p_import_run_id: input.importRunId, p_artifact_id: input.artifactId,
      p_occurrence: input.occurrence, p_actor_kind: "user", p_actor_user_id: this.actorUserId,
      p_actor_service: null, p_request_id: this.requestId,
    });
    if (error) throw new Error(`CANONICAL_OCCURRENCE_FAILED:${error.message}`);
    return { occurrenceId: rpcText(data, "occurrence_id", "CANONICAL_OCCURRENCE_RETURN_INVALID") };
  }
}

function rpcText(value: unknown, key: string, reason: string): string {
  const row = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
  const result = row?.[key];
  if (typeof result !== "string" || !result) throw new Error(reason);
  return result;
}

function canonicalObservations(parsed: ParsedStatement, input: ManualShadowRequest,
  account: { id: string; stableKey: string }) {
  if (parsed.transactions.length === 0 || parsed.sourceProvider !== "ofx" || !parsed.sourceAccountId) {
    throw new Error("CANONICAL_MAPPING_REVIEW_REQUIRED");
  }
  return parsed.transactions.map((transaction, index) => {
    const fitId = transaction.transactionId?.trim();
    const currency = normalizeCurrency(transaction.currency ?? parsed.currency);
    if (!fitId || !currency) throw new Error("CANONICAL_MAPPING_REVIEW_REQUIRED");
    const amountMinor = amountToMinorUnits(Math.abs(transaction.amount.value), currency);
    const direction = transaction.amount.value >= 0 ? "outflow" : "inflow";
    const sourceLocator = `ofx-transaction:${index + 1}`;
    const rawHash = shadowSha256({ namespace: "step9-ofx-transaction-v1", transaction });
    return {
      sourceLocator,
      root: { observation_kind: "bank_transaction", ledger_book_id: input.ledgerBookId,
        financial_account_id: account.id },
      revision: { source_status: "posted", amount_minor: String(amountMinor), currency_code: currency,
        minor_unit_exponent: String(currencyMinorUnitDigits(currency)), direction,
        raw_amount_text: String(transaction.amount.value), raw_currency_text: transaction.currency ?? parsed.currency,
        source_transaction_on: transaction.transactionDate.value, posted_on: transaction.postedDate,
        description: transaction.description?.value ?? null, counterparty: transaction.merchant?.value ?? null,
        reference_text: transaction.memo, raw_payload_hash_hex: rawHash,
        change_reason: "Step 9 retained OFX shadow extraction" },
      identityClaims: [{ claim_kind: "ofx_fitid", strength: "strong", canonicalisation_version: 1,
        namespace_canonical: `ofx|${account.stableKey}`, claim_key_canonical: fitId,
        components: { fitid: fitId }, source_artifact_id: input.artifact.id }],
      eventRevision: { event_kind: "bank_transaction", lifecycle_status: "active", resolution_status: "resolved",
        occurred_on: transaction.postedDate ?? transaction.transactionDate.value,
        amount_minor: String(amountMinor), currency_code: currency,
        minor_unit_exponent: String(currencyMinorUnitDigits(currency)), direction,
        display_label: transaction.merchant?.value ?? transaction.description?.value ?? "Bank transaction",
        change_reason: "Step 9 retained OFX shadow extraction",
        provenance: { artifactId: input.artifact.id, artifactSha256: input.artifact.sha256, sourceLocator } },
      occurrence: { source_locator: sourceLocator, source_row_number: index + 1,
        source_reference_hash_hex: sha256Hex(fitId), raw_payload_hash_hex: rawHash,
        observed_at: input.artifact.retainedAt },
    };
  });
}

class SupabaseReconciliationDomain implements ReconciliationDomainPort<Awaited<ReturnType<typeof computeAndPersistMatches>>> {
  constructor(private readonly actorUserId: string, private readonly input: ManualShadowRequest) {}

  async loadManifest() { return this.manifest(); }
  async computeAndPersist() { return computeAndPersistMatches(this.actorUserId, this.input.reconciliation.statementId); }
  async loadOutputManifest() { return this.manifest(); }

  private async manifest(): Promise<readonly ReconciliationManifestMember[]> {
    const frontier = await loadStep4ReconciliationFrontier(
      this.actorUserId,
      this.input.reconciliation.statementId,
      { clientEntityId: this.input.clientEntityId, ledgerBookId: this.input.ledgerBookId },
    );
    return step4FrontierManifest(frontier);
  }
}

class SupabaseReadOnlyPolicyArtifacts implements ReadOnlyPolicyArtifactPort {
  constructor(private readonly db: SupabaseClient) {}

  async load(clientEntityId: string) {
    const [bundle, snapshot] = await Promise.all([this.loadActiveBundle(clientEntityId), this.loadCurrentSnapshot(clientEntityId)]);
    if (!bundle || !snapshot) throw new Error("POLICY_ARTIFACTS_MISSING_REVIEW");
    return { bundle, snapshot };
  }

  async loadActiveBundle(_clientEntityId: string) {
    const { data, error } = await this.db.from("autonomy_policy_bundles")
      .select("id,bundle_json,bundle_sha256").order("published_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    const value = data.bundle_json as unknown as AutonomyPolicyBundle;
    return { id: String(data.id), sha256: normalizeHash(data.bundle_sha256) ?? "",
      canonicalJson: canonicalPolicyJson(value), value };
  }

  async loadCurrentSnapshot(clientEntityId: string) {
    const { data, error } = await this.db.from("client_policy_snapshots")
      .select("id,snapshot_json,snapshot_sha256").eq("client_entity_id", clientEntityId)
      .order("snapshot_version", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    const raw = data.snapshot_json as unknown as ClientPolicySnapshot;
    const value: ClientPolicySnapshot = { ...raw,
      maxSingleActionAmountMinor: toBigIntOrNull(raw.maxSingleActionAmountMinor),
      maxDailyAggregateAmountMinor: toBigIntOrNull(raw.maxDailyAggregateAmountMinor) };
    return { id: String(data.id), sha256: normalizeHash(data.snapshot_sha256) ?? "",
      canonicalJson: canonicalPolicyJson(value), value };
  }
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value === "bigint") return value;
  if ((typeof value === "string" || typeof value === "number") && /^\d+$/.test(String(value))) return BigInt(value);
  throw new Error("POLICY_SNAPSHOT_MONEY_INVALID");
}

function conservativePolicyAssembly(input: ManualShadowRequest,
  policy: { bundle: { id: string }; snapshot: { id: string } }, artifactSha256: string) {
  void policy;
  const snapshot = { actionType: "SHADOW_RECONCILIATION", clientEntityId: input.clientEntityId,
    ledgerBookId: input.ledgerBookId, statementId: input.reconciliation.statementId,
    balanceScopeId: input.balanceProof.scopeId, artifactId: input.artifact.id };
  const fingerprint = actionFingerprint(snapshot);
  const normalizedInput: Omit<NormalizedPolicyInput, "evaluationAsOf"> = {
    schemaVersion: "step7-normalized-policy-input-v1",
    client: { clientEntityId: input.clientEntityId, ledgerBookId: input.ledgerBookId, active: true },
    action: { actionType: "SHADOW_RECONCILIATION", fingerprintVersion: "step7-action-fingerprint-v1",
      claimedActionFingerprint: fingerprint, computedActionFingerprint: fingerprint,
      step5AuthorizedRequestFingerprint: null, snapshot },
    amount: { amountMinor: null, currencyCode: null, dailyAggregateBeforeMinor: null, rawSourceDecimal: null },
    evidence: { quality: "STRONG", completeness: "COMPLETE", facts: [{ evidenceId: input.artifact.id,
      revisionId: null, sha256: artifactSha256, verifiedSha256: artifactSha256,
      clientEntityId: input.clientEntityId, ledgerBookId: input.ledgerBookId,
      retained: true, verified: true, provenance: "DETERMINISTIC" }] },
    confidence: [{ fact: "retained_artifact_integrity", basisPoints: 10_000, provenance: "DETERMINISTIC" }],
    transactionType: "BANK_RECONCILIATION", accountTreatment: { certainty: "NOT_APPLICABLE", mappingId: null, verified: true },
    taxTreatment: { certainty: "NOT_APPLICABLE", treatmentId: null, verified: true }, reversibility: "UNKNOWN",
    history: { priorVerifiedActions: 0, stablePattern: false, hasCorrectionsOrReversals: false,
      snapshotSha256: shadowSha256({ namespace: "step9-shadow-history-v1", scope: pickScope(input) }) },
    riskFlags: [], humanAuthorization: { state: "MISSING", authorizationId: null,
      authorizedActionFingerprint: null, authorizedClientEntityId: null,
      authorizedLedgerBookId: null, authorizedActionType: null },
    profileFacts: { existingVendorMatch: "NOT_APPLICABLE", billArithmeticVerified: null,
      duplicateCheck: "NOT_APPLICABLE", vendorBindingVerified: null }, modelProposedPermission: null,
  };
  return { ...pickScope(input), evaluationAsOf: input.requestedFor,
    priorStageFingerprints: [artifactSha256], normalizedInput };
}
