import { describe, expect, it, vi } from "vitest";
import { InMemoryAutonomyPolicyDecisionStore } from "../lib/autonomy-policy-store";
import { canonicalPolicyJson, clientPolicySnapshotSha256, policyBundleSha256 } from "../lib/autonomy-policy-canonicalization";
import { STEP7_INITIAL_POLICY_BUNDLE } from "../lib/autonomy-policy-evaluator";
import { ExtractionToCanonicalAdapter } from "../lib/orchestration/extraction-to-canonical-adapter";
import { ShadowExtractionRunService, type ShadowExtractionPersistence } from "../lib/orchestration/extraction-run-service";
import { ReadOnlyPolicyInputAssembler } from "../lib/orchestration/policy-input-assembler";
import {
  freshExtractionInvocationMetadata,
  runManualProductionShadow,
} from "../lib/orchestration/production-shadow-composition";
import { ShadowReconciliationAdapter } from "../lib/orchestration/reconciliation-adapter";
import { InMemoryShadowOrchestrationStore } from "../lib/orchestration/shadow-store";
import type { ShadowRunRequest } from "../lib/orchestration/shadow-contract";
import { BASE_INPUT, BASE_SNAPSHOT, CLIENT_ID, LEDGER_BOOK_ID } from "./autonomy-policy-fixtures";

const scope = {
  practiceId: "10000000-0000-4000-8000-000000000001",
  clientEntityId: CLIENT_ID,
  ledgerBookId: LEDGER_BOOK_ID,
};
const request: ShadowRunRequest = {
  ...scope, contractVersion: "step9-shadow-orchestration-v1",
  scheduleKey: "manual:fresh-artifact-a", requestedFor: "2026-09-08T01:00:00.000Z",
  mode: "SHADOW", executionPermitted: false, correlationId: "manual-correlation-a",
};

function fixture() {
  const extractionRows = new Map();
  const persistence: ShadowExtractionPersistence = {
    find: async (key) => extractionRows.get(key) ?? null,
    record: async (input) => {
      const value = { ...input, extractionRunId: "extraction-a", reused: false };
      extractionRows.set(input.extractionKey, value);
      return value;
    },
  };
  const extractor = vi.fn(async () => ({ rows: [{ sourceLocator: "row-1" }] }));
  const artifactEligibility = { verify: vi.fn(async () => true) };
  const snapshotRecord = vi.fn(async (input) => ({
    id: `${input.role.toLowerCase()}-snapshot`, fingerprint: "9".repeat(64), reused: false,
  }));
  const bundleSha = policyBundleSha256(STEP7_INITIAL_POLICY_BUNDLE);
  const snapshotSha = clientPolicySnapshotSha256(BASE_SNAPSHOT, bundleSha);
  const policyAssembler = new ReadOnlyPolicyInputAssembler({
    loadActiveBundle: async () => ({ id: "bundle-a", sha256: bundleSha,
      canonicalJson: canonicalPolicyJson(STEP7_INITIAL_POLICY_BUNDLE), value: STEP7_INITIAL_POLICY_BUNDLE }),
    loadCurrentSnapshot: async () => ({ id: "snapshot-a", sha256: snapshotSha,
      canonicalJson: canonicalPolicyJson(BASE_SNAPSHOT), value: BASE_SNAPSHOT }),
  });
  const member = { namespace: "bank_transaction" as const, id: "bank-a", fingerprint: "8".repeat(64) };
  const plan = {
    request,
    artifactNotRetainedBefore: "2026-09-08T00:00:00.000Z",
    extraction: {
      ...scope,
      artifact: { namespace: "import_artifact" as const, id: "artifact-a", fingerprint: "a".repeat(64) },
      artifactLength: 42, artifactRetainedAt: "2026-09-08T00:30:00.000Z",
      extractorName: "invoice", extractorVersion: "extractor-v1", modelProvider: "openai",
      modelName: "gpt-4o-mini", modelVersion: "gpt-4o-mini-2024-07-18",
      modelConfigurationFingerprint: "b".repeat(64), promptFingerprint: "c".repeat(64),
      hintsFingerprint: null, extractionContractVersion: "invoice-extraction-v1",
    },
    reconciliation: { statementId: "statement-a", reconciliationVersion: "canonical-013" },
    balanceProofInput: { scopeId: "balance-scope-a" },
    policyAssembly: {
      ...scope, evaluationAsOf: BASE_INPUT.evaluationAsOf,
      priorStageFingerprints: ["d".repeat(64)],
      normalizedInput: Object.fromEntries(Object.entries(BASE_INPUT)
        .filter(([key]) => key !== "evaluationAsOf")) as Omit<typeof BASE_INPUT, "evaluationAsOf">,
    },
    policyAudit: { policyBundleId: "bundle-a", clientPolicySnapshotId: "snapshot-a",
      requestedBy: "step9-shadow", correlationId: request.correlationId },
    canonicalInput: (_output: unknown, extractionReference: { id: string; fingerprint: string }) => ({
      ...scope, artifact: plan.extraction.artifact,
      extraction: { namespace: "shadow_extraction_run" as const, ...extractionReference },
      parserName: "step9-document", parserVersion: "v1",
      observations: [{ sourceLocator: "row-1", root: {}, revision: {}, identityClaims: [{}],
        eventRevision: {}, occurrence: {} }],
    }),
    planningInput: () => ({}) as never,
  };
  const bindings = {
    store: new InMemoryShadowOrchestrationStore(), workerId: "manual-worker-a",
    artifactEligibility,
    extractionRuns: new ShadowExtractionRunService(persistence, { verify: async () => true }), extractor,
    canonical: new ExtractionToCanonicalAdapter({
      startImport: async () => ({ runId: "import-a" }),
      ingestObservation: async () => ({ observationId: "observation-a", revisionId: "revision-a", eventId: "event-a" }),
      recordOccurrence: async () => ({ occurrenceId: "occurrence-a" }),
    }),
    reconciliation: new ShadowReconciliationAdapter({
      loadManifest: async () => [member], computeAndPersist: async () => ({ matchCount: 1 }),
      loadOutputManifest: async () => [member],
    }),
    reconciliationSnapshots: { record: snapshotRecord },
    balanceProof: { execute: vi.fn(async () => ({ state: "RECONCILED", fingerprint: "e".repeat(64) })) },
    policyAssembler, policyDecisions: new InMemoryAutonomyPolicyDecisionStore(),
    exceptionOutput: { record: vi.fn(async () => ({ id: "exception-a", exceptionKey: "f".repeat(64),
      payloadFingerprint: "1".repeat(64), reused: false })) },
    planner: vi.fn(() => ({ decision: "SAFE_METHOD" as const, reasonCodes: ["OBSERVED"], plan: null,
      capabilityBundleVersion: "step8-provider-reversibility-v1" as const,
      plannerVersion: "step8-pure-reversibility-planner-v1" as const, grantsExecutionPermission: false as const })),
  };
  return { plan, bindings, extractor, artifactEligibility, snapshotRecord };
}

describe("Step 9 production shadow composition", () => {
  it("binds all supported stages and exact replay performs no domain work", async () => {
    const { plan, bindings, extractor, snapshotRecord } = fixture();
    const first = await runManualProductionShadow(plan, bindings);
    const replay = await runManualProductionShadow({ ...plan, request: { ...plan.request, correlationId: "redelivery" },
      policyAudit: { ...plan.policyAudit, correlationId: "redelivery" } }, bindings);
    expect(first.state).toBe("SUCCEEDED");
    expect(replay).toMatchObject({ id: first.id, state: "SUCCEEDED", reused: true });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(snapshotRecord).toHaveBeenCalledTimes(2);
  });

  it("rejects an old/incomplete extraction identity before claiming or extracting", async () => {
    const { plan, bindings, extractor } = fixture();
    await expect(runManualProductionShadow({ ...plan,
      artifactNotRetainedBefore: "2026-09-08T00:31:00.000Z" }, bindings))
      .rejects.toThrow("LEGACY_EXTRACTION_ARTIFACT_INELIGIBLE");
    await expect(runManualProductionShadow({ ...plan,
      extraction: { ...plan.extraction, promptFingerprint: "" } }, bindings))
      .rejects.toThrow("PROMPT_FINGERPRINT_REQUIRED");
    expect(extractor).not.toHaveBeenCalled();
  });

  it("records every required fresh extraction identity component without guessing", () => {
    const { plan } = fixture();
    expect(freshExtractionInvocationMetadata(plan.extraction)).toEqual({
      namespace: "step9-fresh-extraction-invocation-v1", ...scope,
      artifactSha256: "a".repeat(64), artifactLength: 42,
      extractorName: "invoice", extractorVersion: "extractor-v1", modelProvider: "openai",
      modelName: "gpt-4o-mini", modelVersion: "gpt-4o-mini-2024-07-18",
      modelConfigurationFingerprint: "b".repeat(64), promptFingerprint: "c".repeat(64),
      hintsFingerprint: null, extractionContractVersion: "invoice-extraction-v1",
    });
  });

  it("fails closed on explicit client/book scope mismatch", async () => {
    const { plan, bindings } = fixture();
    await expect(runManualProductionShadow({ ...plan,
      extraction: { ...plan.extraction, ledgerBookId: "wrong-book" } }, bindings))
      .rejects.toThrow("EXTRACTION_SCOPE_INTEGRITY_BLOCKED");
  });
});
