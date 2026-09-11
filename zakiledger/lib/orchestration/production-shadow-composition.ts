import type { PolicyEvaluationRequest, StoredPolicyDecision } from "../autonomy-policy-contract";
import {
  SupabaseAutonomyPolicyDecisionStore,
  type AutonomyPolicyDecisionStore,
  type PolicyDecisionAuditMetadata,
} from "../autonomy-policy-store";
import type { ReversibilityPlannerInput, ReversibilityPlannerResult } from "../reversibility-contract";
import { planReversibility } from "../reversibility-planner";
import {
  SupabaseShadowExceptionOutputStore,
  type ShadowExceptionOutputStore,
} from "./exception-output-store";
import type {
  ExtractionCanonicalInput,
  ExtractionToCanonicalAdapter,
} from "./extraction-to-canonical-adapter";
import {
  assertFreshExtractionInvocation,
  ShadowExtractionRunService,
  SupabaseShadowExtractionPersistence,
  type ShadowExtractionRequest,
  type ShadowExtractor,
} from "./extraction-run-service";
import type {
  ReadOnlyPolicyInputAssembler,
  ShadowPolicyAssemblyRequest,
} from "./policy-input-assembler";
import type {
  ShadowReconciliationAdapter,
  ShadowReconciliationSnapshotStore,
} from "./reconciliation-adapter";
import { SupabaseShadowReconciliationSnapshotStore } from "./reconciliation-adapter";
import { canonicalShadowJson, shadowSha256 } from "./shadow-canonicalization";
import type {
  ImmutableReference,
  ShadowRunRecord,
  ShadowRunRequest,
  ShadowScope,
} from "./shadow-contract";
import { SupabaseShadowOrchestrationStore, type ShadowOrchestrationStore } from "./shadow-store";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ShadowOrchestrationWorker,
  type ShadowStageHandlerResult,
  type ShadowStageHandlers,
} from "./shadow-worker";

type ExtractionInvocation = Omit<ShadowExtractionRequest,
  "runId" | "stageId" | "attemptId" | "workerId"
>;

export interface ProductionShadowRunPlan<TExtraction, TReconciliation, TBalance> {
  request: ShadowRunRequest;
  /** Earliest acceptable retention instant, fixed by the controlled-run operator. */
  artifactNotRetainedBefore: string;
  extraction: ExtractionInvocation;
  reconciliation: {
    statementId: string;
    reconciliationVersion: string;
  };
  balanceProofInput: unknown;
  policyAssembly: ShadowPolicyAssemblyRequest;
  policyAudit: PolicyDecisionAuditMetadata;
  canonicalInput(extraction: TExtraction, reference: ImmutableReference): ExtractionCanonicalInput;
  planningInput(input: {
    extraction: TExtraction;
    reconciliation: TReconciliation;
    balanceProof: TBalance;
    policyDecision: StoredPolicyDecision;
  }): ReversibilityPlannerInput;
}

/**
 * Only the already-approved shadow/domain boundaries are accepted here. There
 * is deliberately no posting store, execution actor, provider mutation port,
 * scheduler, or generic HTTP client in this capability set.
 */
export interface ProductionShadowBindings<TExtraction, TReconciliation, TBalance> {
  store: ShadowOrchestrationStore;
  workerId: string;
  artifactEligibility: {
    verify(input: ExtractionInvocation & { notRetainedBefore: string }): Promise<boolean>;
  };
  extractionRuns: ShadowExtractionRunService;
  extractor: ShadowExtractor<TExtraction>;
  canonical: ExtractionToCanonicalAdapter;
  reconciliation: ShadowReconciliationAdapter<TReconciliation>;
  reconciliationSnapshots: ShadowReconciliationSnapshotStore;
  balanceProof: { execute(input: unknown): Promise<TBalance> };
  policyAssembler: ReadOnlyPolicyInputAssembler;
  policyDecisions: AutonomyPolicyDecisionStore;
  exceptionOutput: ShadowExceptionOutputStore;
  planner?: (input: ReversibilityPlannerInput) => ReversibilityPlannerResult;
}

export interface FreshArtifactEligibilityPort {
  verify(input: ExtractionInvocation & { notRetainedBefore: string }): Promise<boolean>;
}

/** Exact, read-only eligibility proof for a newly retained controlled-run artifact. */
export class SupabaseFreshArtifactEligibility implements FreshArtifactEligibilityPort {
  constructor(private readonly db: SupabaseClient) {}

  async verify(input: ExtractionInvocation & { notRetainedBefore?: string }): Promise<boolean> {
    const [{ data: artifact, error: artifactError }, { data: client, error: clientError },
      { data: book, error: bookError }] = await Promise.all([
      this.db.from("import_artifacts")
        .select("id,client_entity_id,content_sha256,content_length,storage_state,received_at,archived_at,metadata")
        .eq("id", input.artifact.id).eq("client_entity_id", input.clientEntityId).maybeSingle(),
      this.db.from("client_entities").select("id,practice_id,status")
        .eq("id", input.clientEntityId).eq("practice_id", input.practiceId).maybeSingle(),
      this.db.from("ledger_books").select("id,client_entity_id,status")
        .eq("id", input.ledgerBookId).eq("client_entity_id", input.clientEntityId).maybeSingle(),
    ]);
    if (artifactError || clientError || bookError || !artifact || !client || !book) return false;
    const sha = normalizeDatabaseSha256(artifact.content_sha256);
    const retainedAt = Date.parse(String(artifact.received_at));
    const cutoff = input.notRetainedBefore === undefined ? null : Date.parse(input.notRetainedBefore);
    const metadata = artifact.metadata as Record<string, unknown> | null;
    const recordedIdentity = metadata?.step9ExtractionInvocation;
    if (recordedIdentity === undefined) return false;
    const expectedIdentity = freshExtractionInvocationMetadata(input);
    return client.status === "active" && book.status === "active" &&
      artifact.storage_state === "retained" && artifact.archived_at === null &&
      sha === input.artifact.fingerprint && Number(artifact.content_length) === input.artifactLength &&
      Number.isFinite(retainedAt) &&
      (cutoff === null || (Number.isFinite(cutoff) && retainedAt >= cutoff)) &&
      new Date(retainedAt).toISOString() === new Date(input.artifactRetainedAt).toISOString() &&
      canonicalShadowJson(recordedIdentity) === canonicalShadowJson(expectedIdentity);
  }
}

export interface ProductionShadowDomainBindings<TExtraction, TReconciliation, TBalance> {
  extractor: ShadowExtractor<TExtraction>;
  canonical: ExtractionToCanonicalAdapter;
  reconciliation: ShadowReconciliationAdapter<TReconciliation>;
  balanceProof: { execute(input: unknown): Promise<TBalance> };
  policyAssembler: ReadOnlyPolicyInputAssembler;
}

/** Binds migration 034 persistence and the existing Step 7/8 services. */
export function bindProductionShadowServices<TExtraction, TReconciliation, TBalance>(input: {
  db: SupabaseClient;
  workerId: string;
  domain: ProductionShadowDomainBindings<TExtraction, TReconciliation, TBalance>;
}): ProductionShadowBindings<TExtraction, TReconciliation, TBalance> {
  const artifactEligibility = new SupabaseFreshArtifactEligibility(input.db);
  return {
    store: new SupabaseShadowOrchestrationStore(input.db), workerId: input.workerId,
    artifactEligibility,
    extractionRuns: new ShadowExtractionRunService(
      new SupabaseShadowExtractionPersistence(input.db), artifactEligibility,
    ),
    extractor: input.domain.extractor, canonical: input.domain.canonical,
    reconciliation: input.domain.reconciliation,
    reconciliationSnapshots: new SupabaseShadowReconciliationSnapshotStore(input.db),
    balanceProof: input.domain.balanceProof, policyAssembler: input.domain.policyAssembler,
    policyDecisions: new SupabaseAutonomyPolicyDecisionStore(input.db),
    exceptionOutput: new SupabaseShadowExceptionOutputStore(input.db), planner: planReversibility,
  };
}

function assertScope(expected: ShadowScope, actual: ShadowScope, label: string): void {
  if (expected.practiceId !== actual.practiceId ||
      expected.clientEntityId !== actual.clientEntityId ||
      expected.ledgerBookId !== actual.ledgerBookId) {
    throw new Error(`${label}_SCOPE_INTEGRITY_BLOCKED`);
  }
}

function reference(namespace: string, id: string, fingerprint: string): ImmutableReference {
  return { namespace, id, fingerprint };
}

/** Manual, one-shot production composition. Calling it performs exactly one run; it schedules nothing. */
export async function runManualProductionShadow<TExtraction, TReconciliation, TBalance>(
  plan: ProductionShadowRunPlan<TExtraction, TReconciliation, TBalance>,
  bindings: ProductionShadowBindings<TExtraction, TReconciliation, TBalance>,
): Promise<ShadowRunRecord> {
  assertScope(plan.request, plan.extraction, "EXTRACTION");
  assertScope(plan.request, plan.policyAssembly, "POLICY");
  if (plan.policyAudit.correlationId !== plan.request.correlationId) {
    throw new Error("POLICY_CORRELATION_INTEGRITY_BLOCKED");
  }
  const cutoff = Date.parse(plan.artifactNotRetainedBefore);
  const retainedAt = Date.parse(plan.extraction.artifactRetainedAt);
  if (!Number.isFinite(cutoff) || !Number.isFinite(retainedAt) || retainedAt < cutoff) {
    throw new Error("LEGACY_EXTRACTION_ARTIFACT_INELIGIBLE");
  }
  assertFreshExtractionInvocation({
    ...plan.extraction, runId: "identity-check", stageId: "identity-check",
    attemptId: "identity-check", workerId: bindings.workerId,
  });

  let extractionValue: TExtraction | undefined;
  let extractionRef: ImmutableReference | undefined;
  let reconciliationValue: TReconciliation | undefined;
  let balanceValue: TBalance | undefined;
  let policyValue: StoredPolicyDecision | undefined;
  let stoppedAt: { stage: keyof ShadowStageHandlers; result: ShadowStageHandlerResult } | null = null;

  const handlers: ShadowStageHandlers = {
    INGESTION: async () => {
      if (!await bindings.artifactEligibility.verify({
        ...plan.extraction, notRetainedBefore: plan.artifactNotRetainedBefore,
      })) throw new Error("EXTRACTION_ARTIFACT_SCOPE_OR_IDENTITY_INTEGRITY_BLOCKED");
      return success({
        artifactId: plan.extraction.artifact.id,
        artifactFingerprint: plan.extraction.artifact.fingerprint,
        artifactLength: plan.extraction.artifactLength,
        artifactRetainedAt: plan.extraction.artifactRetainedAt,
        extractionIdentityFingerprint: extractionIdentityFingerprint(plan.extraction),
      }, [plan.extraction.artifact]);
    },
    EXTRACTION: async (context) => {
      const extracted = await bindings.extractionRuns.execute({
        ...plan.extraction, runId: context.run.id, stageId: context.stageRecord.id,
        attemptId: context.attempt.id, workerId: bindings.workerId,
      }, context.lease.fencingToken, bindings.extractor);
      extractionValue = JSON.parse(extracted.outputCanonicalJson) as TExtraction;
      extractionRef = reference("shadow_extraction_run", extracted.extractionRunId, extracted.outputFingerprint);
      return success({
        ...extracted,
        artifactRetainedAt: plan.extraction.artifactRetainedAt,
        invocation: freshExtractionInvocationMetadata(plan.extraction),
        invocationFingerprint: extractionIdentityFingerprint(plan.extraction),
      }, [
        plan.extraction.artifact, extractionRef,
      ]);
    },
    CANONICAL_UPDATE: async () => {
      if (extractionValue === undefined || !extractionRef) throw new Error("EXTRACTION_OUTPUT_MISSING_BLOCKED");
      const input = plan.canonicalInput(extractionValue, extractionRef);
      assertScope(plan.request, input, "CANONICAL");
      if (input.artifact.id !== plan.extraction.artifact.id || input.extraction.id !== extractionRef.id) {
        throw new Error("CANONICAL_PROVENANCE_INTEGRITY_BLOCKED");
      }
      const result = await bindings.canonical.apply(input);
      return success(result, [plan.extraction.artifact, extractionRef,
        reference("canonical_import_run", result.importRunId, result.outputFingerprint)]);
    },
    RECONCILIATION: async (context) => {
      const snapshot = (role: "INPUT" | "OUTPUT") => async (members: Parameters<
        ShadowReconciliationSnapshotStore["record"]
      >[0]["members"]) => {
        await bindings.reconciliationSnapshots.record({
          ...plan.request, runId: context.run.id, stageId: context.stageRecord.id,
          attemptId: context.attempt.id, workerId: bindings.workerId,
          fencingToken: context.lease.fencingToken, statementId: plan.reconciliation.statementId,
          role, reconciliationVersion: plan.reconciliation.reconciliationVersion, members,
        });
      };
      const result = await bindings.reconciliation.reconcile({
        ...plan.request, statementId: plan.reconciliation.statementId,
        reconciliationVersion: plan.reconciliation.reconciliationVersion,
      }, { input: snapshot("INPUT"), output: snapshot("OUTPUT") });
      reconciliationValue = result.result;
      return success(result, [reference("bank_statement", plan.reconciliation.statementId, result.inputFingerprint)]);
    },
    BALANCE_PROOF: async () => {
      balanceValue = await bindings.balanceProof.execute(plan.balanceProofInput);
      return success(balanceValue, [reference("balance_proof", "result", shadowSha256(balanceValue))]);
    },
    POLICY_EVALUATION: async () => {
      if (reconciliationValue === undefined || balanceValue === undefined) {
        throw new Error("POLICY_DEPENDENCIES_MISSING_BLOCKED");
      }
      const assembly = await bindings.policyAssembler.assemble(plan.policyAssembly);
      const evaluation: PolicyEvaluationRequest = {
        bundle: assembly.bundle.value, bundleSha256: assembly.bundle.sha256,
        clientSnapshot: assembly.snapshot.value, clientSnapshotSha256: assembly.snapshot.sha256,
        canonicalInput: assembly.canonicalInput,
      };
      policyValue = await bindings.policyDecisions.evaluateAndRecord(evaluation, plan.policyAudit);
      return success(policyValue, [
        reference("autonomy_policy_bundle", assembly.bundle.id, assembly.bundle.sha256),
        reference("client_policy_snapshot", assembly.snapshot.id, assembly.snapshot.sha256),
        reference("autonomy_policy_decision", policyValue.id, policyValue.resultSha256),
      ]);
    },
    STEP8_PLANNING: async () => {
      if (extractionValue === undefined || reconciliationValue === undefined ||
          balanceValue === undefined || policyValue === undefined) {
        throw new Error("STEP8_DEPENDENCIES_MISSING_BLOCKED");
      }
      const result = (bindings.planner ?? planReversibility)(plan.planningInput({
        extraction: extractionValue, reconciliation: reconciliationValue,
        balanceProof: balanceValue, policyDecision: policyValue,
      }));
      return success(result, [reference("autonomy_policy_decision", policyValue.id, policyValue.resultSha256)]);
    },
    EXCEPTION_OUTPUT: async (context) => {
      if (!context.priorTerminalOutcome) return success({ emitted: false }, []);
      const result = await bindings.exceptionOutput.record({
        ...plan.request, runId: context.run.id, stage: context.stage,
        subjectNamespace: "shadow_orchestration_run", subjectId: context.run.id,
        reasonCode: context.priorTerminalOutcome, evidence: [],
        diagnostics: { stoppedStage: stoppedAt?.stage ?? "UNKNOWN", outcome: context.priorTerminalOutcome },
        correlationId: plan.request.correlationId,
      });
      return success({ emitted: true, ...result }, []);
    },
  };

  // Capture the first fail-closed outcome for sanitized operator diagnostics.
  for (const stage of Object.keys(handlers) as (keyof ShadowStageHandlers)[]) {
    const original = handlers[stage];
    if (!original) continue;
    handlers[stage] = async (context) => {
      const result = await original(context);
      if (result.state !== "SUCCEEDED" && !stoppedAt) stoppedAt = { stage, result };
      return result;
    };
  }
  const resumeHydrators = {
    INGESTION: ({ output }: { output: unknown }) => {
      const value = resumeRecord(output, "INGESTION");
      if (value.artifactId !== plan.extraction.artifact.id ||
          value.artifactFingerprint !== plan.extraction.artifact.fingerprint ||
          value.artifactLength !== plan.extraction.artifactLength ||
          value.artifactRetainedAt !== plan.extraction.artifactRetainedAt ||
          value.extractionIdentityFingerprint !== extractionIdentityFingerprint(plan.extraction)) {
        throw new Error("SHADOW_RESUME_INGESTION_OUTPUT_MISMATCH");
      }
    },
    EXTRACTION: ({ output, provenance }: { output: unknown; provenance: readonly ImmutableReference[] }) => {
      const value = resumeRecord(output, "EXTRACTION");
      if (typeof value.outputCanonicalJson !== "string" ||
          typeof value.extractionRunId !== "string" || !value.extractionRunId ||
          typeof value.extractionKey !== "string" || !/^[0-9a-f]{64}$/.test(value.extractionKey) ||
          typeof value.outputFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.outputFingerprint) ||
          value.artifactRetainedAt !== plan.extraction.artifactRetainedAt ||
          value.invocationFingerprint !== extractionIdentityFingerprint(plan.extraction) ||
          canonicalShadowJson(value.invocation) !== canonicalShadowJson(freshExtractionInvocationMetadata(plan.extraction))) {
        throw new Error("SHADOW_RESUME_EXTRACTION_OUTPUT_MALFORMED");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.outputCanonicalJson);
      } catch {
        throw new Error("SHADOW_RESUME_EXTRACTION_OUTPUT_MALFORMED");
      }
      if (canonicalShadowJson(parsed) !== value.outputCanonicalJson) {
        throw new Error("SHADOW_RESUME_EXTRACTION_OUTPUT_MALFORMED");
      }
      const expectedExtractionFingerprint = shadowSha256({
        namespace: "step9-shadow-extraction-output-v1",
        extractionKey: value.extractionKey, output: parsed,
      });
      if (expectedExtractionFingerprint !== value.outputFingerprint) {
        throw new Error("SHADOW_RESUME_EXTRACTION_OUTPUT_FINGERPRINT_MISMATCH");
      }
      const artifactReference = provenance.find((item) => item.namespace === "import_artifact");
      const persistedReference = provenance.find((item) => item.namespace === "shadow_extraction_run");
      if (!artifactReference || artifactReference.id !== plan.extraction.artifact.id ||
          artifactReference.fingerprint !== plan.extraction.artifact.fingerprint ||
          !persistedReference || persistedReference.id !== value.extractionRunId ||
          persistedReference.fingerprint !== value.outputFingerprint) {
        throw new Error("SHADOW_RESUME_EXTRACTION_PROVENANCE_MISMATCH");
      }
      extractionValue = parsed as TExtraction;
      extractionRef = reference("shadow_extraction_run", value.extractionRunId, value.outputFingerprint);
    },
    RECONCILIATION: ({ output }: { output: unknown }) => {
      const value = resumeRecord(output, "RECONCILIATION");
      if (!("result" in value)) throw new Error("SHADOW_RESUME_RECONCILIATION_OUTPUT_MALFORMED");
      reconciliationValue = value.result as TReconciliation;
    },
    BALANCE_PROOF: ({ output }: { output: unknown }) => {
      resumeRecord(output, "BALANCE_PROOF");
      balanceValue = output as TBalance;
    },
    POLICY_EVALUATION: ({ output }: { output: unknown }) => {
      const value = resumeRecord(output, "POLICY_EVALUATION");
      if (typeof value.id !== "string" || typeof value.resultSha256 !== "string" ||
          !["ALLOW", "REVIEW", "DENY"].includes(String(value.decision))) {
        throw new Error("SHADOW_RESUME_POLICY_OUTPUT_MALFORMED");
      }
      policyValue = value as unknown as StoredPolicyDecision;
    },
  };
  return new ShadowOrchestrationWorker(
    bindings.store, bindings.workerId, handlers, resumeHydrators,
  ).run(plan.request);
}

function resumeRecord(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SHADOW_RESUME_${stage}_OUTPUT_MALFORMED`);
  }
  return value as Record<string, unknown>;
}

function success(output: unknown, provenance: readonly ImmutableReference[]): ShadowStageHandlerResult {
  return { state: "SUCCEEDED", output, provenance, reasonCode: null };
}

function extractionIdentityFingerprint(input: ExtractionInvocation): string {
  return shadowSha256(freshExtractionInvocationMetadata(input));
}

/** Exact metadata to persist with the artifact before the controlled invocation. */
export function freshExtractionInvocationMetadata(input: ExtractionInvocation) {
  return {
    namespace: "step9-fresh-extraction-invocation-v1",
    practiceId: input.practiceId, clientEntityId: input.clientEntityId,
    ledgerBookId: input.ledgerBookId,
    artifactSha256: input.artifact.fingerprint, artifactLength: input.artifactLength,
    extractorName: input.extractorName,
    extractorVersion: input.extractorVersion, modelProvider: input.modelProvider,
    modelName: input.modelName, modelVersion: input.modelVersion,
    modelConfigurationFingerprint: input.modelConfigurationFingerprint,
    promptFingerprint: input.promptFingerprint, hintsFingerprint: input.hintsFingerprint,
    extractionContractVersion: input.extractionContractVersion,
  };
}

function normalizeDatabaseSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  return /^[0-9a-f]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}
