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
  const store = new InMemoryShadowOrchestrationStore();
  const bindings = {
    store, workerId: "manual-worker-a",
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
  return { plan, bindings, store, extractor, artifactEligibility, snapshotRecord };
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

  it("resumes at CANONICAL_UPDATE with hydrated extraction and no duplicate canonical identity", async () => {
    const { plan, bindings, store, extractor } = fixture();
    const beginStage = vi.spyOn(store, "beginStage");
    const hydrated: unknown[] = [];
    const canonicalInput = plan.canonicalInput;
    plan.canonicalInput = (extraction, reference) => {
      hydrated.push(extraction);
      const input = canonicalInput(extraction, reference);
      return { ...input, observations: [
        ...input.observations,
        { ...input.observations[0], sourceLocator: "row-2" },
      ] };
    };
    let failFirst = true;
    const observations = new Map<string, { observationId: string; revisionId: string; eventId: string }>();
    bindings.canonical = new ExtractionToCanonicalAdapter({
      startImport: async () => ({ runId: "import-a" }),
      ingestObservation: async (input) => {
        if (failFirst && input.sourceLocator === "row-2") {
          failFirst = false;
          throw new Error("CANONICAL_OBSERVATION_FAILED");
        }
        const existing = observations.get(input.sourceLocator) ?? {
          observationId: `observation-${input.sourceLocator}`,
          revisionId: `revision-${input.sourceLocator}`,
          eventId: `event-${input.sourceLocator}`,
        };
        observations.set(input.sourceLocator, existing);
        return existing;
      },
      recordOccurrence: async (input) => ({ occurrenceId: `occurrence-${input.observationId}` }),
    });

    await expect(runManualProductionShadow(plan, bindings))
      .rejects.toThrow("CANONICAL_OBSERVATION_FAILED");
    const failed = await store.createOrReuseRun(plan.request);
    expect(failed).toMatchObject({ state: "RETRYABLE", reused: true });

    const resumed = await runManualProductionShadow(plan, bindings);
    expect(resumed).toMatchObject({ id: failed.id, runKey: failed.runKey, state: "SUCCEEDED", reused: true });
    expect(resumed.inputFingerprint).toBe(failed.inputFingerprint);
    const stageClaims = beginStage.mock.calls.map(([input]) => input.stage);
    const claimedAttempts = (await Promise.all(beginStage.mock.results.map((result) => result.value)))
      .map(({ stage, attempt }) => ({ stage: stage.stage, attemptNumber: attempt.attemptNumber }));
    expect(stageClaims.filter((stage) => stage === "INGESTION")).toHaveLength(1);
    expect(stageClaims.filter((stage) => stage === "EXTRACTION")).toHaveLength(1);
    expect(stageClaims.filter((stage) => stage === "CANONICAL_UPDATE")).toHaveLength(2);
    expect(claimedAttempts.filter(({ stage }) => stage === "INGESTION"))
      .toEqual([{ stage: "INGESTION", attemptNumber: 1 }]);
    expect(claimedAttempts.filter(({ stage }) => stage === "EXTRACTION"))
      .toEqual([{ stage: "EXTRACTION", attemptNumber: 1 }]);
    expect(claimedAttempts.filter(({ stage }) => stage === "CANONICAL_UPDATE"))
      .toEqual([
        { stage: "CANONICAL_UPDATE", attemptNumber: 1 },
        { stage: "CANONICAL_UPDATE", attemptNumber: 2 },
      ]);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(hydrated).toHaveLength(2);
    // Canonical bytes and parsed semantics survive the persistence round trip.
    expect(canonicalPolicyJson(hydrated[1])).toBe(canonicalPolicyJson(hydrated[0]));
    expect(hydrated[1]).toEqual(hydrated[0]);
    // row-1 was committed before row-2 failed; retry reuses it by source identity.
    expect(observations.size).toBe(2);

    const terminalReplay = await runManualProductionShadow(plan, bindings);
    expect(terminalReplay).toMatchObject({ id: failed.id, state: "SUCCEEDED", reused: true });
    expect(beginStage.mock.calls.map(([input]) => input.stage)).toEqual(stageClaims);
    expect(observations.size).toBe(2);
  });

  it.each([
    ["missing", "SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_MISSING"],
    ["fingerprint", "SHADOW_RESUME_COMPLETED_STAGE_INPUT_FINGERPRINT_MISMATCH"],
  ] as const)("fails closed when a completed extraction checkpoint has a %s defect", async (defect, reason) => {
    const { plan, bindings, store } = fixture();
    bindings.canonical = new ExtractionToCanonicalAdapter({
      startImport: async () => ({ runId: "import-a" }),
      ingestObservation: async () => { throw new Error("CANONICAL_OBSERVATION_FAILED"); },
      recordOccurrence: async () => ({ occurrenceId: "must-not-run" }),
    });
    await expect(runManualProductionShadow(plan, bindings))
      .rejects.toThrow("CANONICAL_OBSERVATION_FAILED");
    const load = store.loadSucceededStage.bind(store);
    vi.spyOn(store, "loadSucceededStage").mockImplementation(async (runId, stage) => {
      const checkpoint = await load(runId, stage);
      if (stage !== "EXTRACTION") return checkpoint;
      if (defect === "missing") throw new Error("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_MISSING");
      if (!checkpoint) throw new Error("test checkpoint missing");
      return { ...checkpoint, stage: { ...checkpoint.stage, inputFingerprint: "f".repeat(64) } };
    });
    await expect(runManualProductionShadow(plan, bindings)).rejects.toThrow(reason);
  });

  it("does not treat changed semantic run input as a resume", async () => {
    const { plan, store } = fixture();
    const original = await store.createOrReuseRun(plan.request);
    const changed = await store.createOrReuseRun({
      ...plan.request, requestedFor: "2026-09-08T01:00:01.000Z",
    });
    expect(changed).toMatchObject({ reused: false });
    expect(changed.id).not.toBe(original.id);
    expect(changed.runKey).not.toBe(original.runKey);
    expect(changed.inputFingerprint).not.toBe(original.inputFingerprint);
  });
});
