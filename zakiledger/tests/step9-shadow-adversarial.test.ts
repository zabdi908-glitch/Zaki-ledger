import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertShadowTransition, rollupShadowRunState, SHADOW_STAGES,
  type ShadowRunRequest, type ShadowState,
} from "../lib/orchestration/shadow-contract";
import { shadowSha256 } from "../lib/orchestration/shadow-canonicalization";
import { InMemoryShadowOrchestrationStore } from "../lib/orchestration/shadow-store";
import { ShadowOrchestrationWorker, type ShadowStageHandlers } from "../lib/orchestration/shadow-worker";
import {
  ShadowExtractionRunService, type ShadowExtractionPersistence,
  type ShadowExtractionRequest, type ShadowExtractionResult,
} from "../lib/orchestration/extraction-run-service";
import { ExtractionToCanonicalAdapter } from "../lib/orchestration/extraction-to-canonical-adapter";
import { ShadowReconciliationAdapter } from "../lib/orchestration/reconciliation-adapter";
import { prepareShadowException } from "../lib/orchestration/exception-output-store";
import { ReadOnlyPolicyInputAssembler } from "../lib/orchestration/policy-input-assembler";
import {
  canonicalPolicyJson, clientPolicySnapshotSha256, policyBundleSha256,
} from "../lib/autonomy-policy-canonicalization";
import { STEP7_INITIAL_POLICY_BUNDLE } from "../lib/autonomy-policy-evaluator";
import { BASE_INPUT, BASE_SNAPSHOT, CLIENT_ID, LEDGER_BOOK_ID } from "./autonomy-policy-fixtures";

const ids = {
  practiceId: "10000000-0000-4000-8000-000000000001",
  clientEntityId: "20000000-0000-4000-8000-000000000001",
  ledgerBookId: "30000000-0000-4000-8000-000000000001",
};
const request: ShadowRunRequest = {
  ...ids, contractVersion: "step9-shadow-orchestration-v1", scheduleKey: "nightly:2026-09-07",
  requestedFor: "2026-09-07T01:00:00.000Z", mode: "SHADOW", executionPermitted: false,
  correlationId: "correlation-a",
};

afterEach(() => vi.useRealTimers());

function successfulHandlers(overrides: ShadowStageHandlers = {}): ShadowStageHandlers {
  return Object.fromEntries(SHADOW_STAGES.map((stage) => [stage, overrides[stage] ?? (async () => ({
    state: "SUCCEEDED" as const,
    output: stage === "POLICY_EVALUATION" ? { decision: "ALLOW" }
      : stage === "STEP8_PLANNING" ? { decision: "SAFE_METHOD", grantsExecutionPermission: false }
        : { stage },
    provenance: [], reasonCode: null,
  }))]));
}

function extractionRequest(changes: Partial<ShadowExtractionRequest> = {}): ShadowExtractionRequest {
  return {
    ...ids, runId: "run-1", stageId: "stage-1", attemptId: "attempt-1", workerId: "worker-a",
    artifact: { namespace: "import_artifact", id: "artifact-1", fingerprint: "a".repeat(64) },
    artifactLength: 42, artifactRetainedAt: "2026-09-07T00:59:00.000Z",
    extractorName: "invoice", extractorVersion: "v1", modelProvider: "openai",
    modelName: "gpt-4o-mini", modelVersion: "gpt-4o-mini-2024-07-18",
    modelConfigurationFingerprint: "b".repeat(64), promptFingerprint: "c".repeat(64),
    hintsFingerprint: null, extractionContractVersion: "invoice-extraction-v1", ...changes,
  };
}

describe("Step 9 run, lease, and state adversarial contract", () => {
  it("converges duplicate triggers and supersedes a changed scheduled frontier", async () => {
    const store = new InMemoryShadowOrchestrationStore();
    const first = await store.createOrReuseRun(request);
    const duplicate = await store.createOrReuseRun({ ...request, correlationId: "delivery-b" });
    const superseding = await store.createOrReuseRun({
      ...request, scheduleKey: "incremental:frontier-b", requestedFor: "2026-09-07T01:05:00.000Z",
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.reused).toBe(true);
    expect(superseding.id).not.toBe(first.id);
  });

  it("permits every declared transition and rejects undeclared/unsafe cancellation transitions", () => {
    const allowed: readonly (readonly [ShadowState, ShadowState])[] = [
      ["PENDING", "RUNNING"], ["PENDING", "CANCELLED"], ["PENDING", "BLOCKED"],
      ["RUNNING", "SUCCEEDED"], ["RUNNING", "FAILED_SAFE"], ["RUNNING", "RETRYABLE"],
      ["RUNNING", "REVIEW_REQUIRED"], ["RUNNING", "BLOCKED"], ["RUNNING", "UNCERTAIN"],
      ["RETRYABLE", "RUNNING"], ["RETRYABLE", "FAILED_SAFE"], ["RETRYABLE", "REVIEW_REQUIRED"],
      ["RETRYABLE", "BLOCKED"], ["RETRYABLE", "UNCERTAIN"], ["RETRYABLE", "CANCELLED"],
    ];
    for (const [from, to] of allowed) expect(() => assertShadowTransition(from, to)).not.toThrow();
    expect(() => assertShadowTransition("RUNNING", "CANCELLED")).toThrow("ILLEGAL_SHADOW_TRANSITION");
    expect(() => assertShadowTransition("SUCCEEDED", "RUNNING")).toThrow("ILLEGAL_SHADOW_TRANSITION");
  });

  it("applies the exact fail-closed run roll-up precedence", () => {
    expect(rollupShadowRunState(["SUCCEEDED", "FAILED_SAFE"])).toBe("FAILED_SAFE");
    expect(rollupShadowRunState(["FAILED_SAFE", "RETRYABLE"])).toBe("RETRYABLE");
    expect(rollupShadowRunState(["RETRYABLE", "REVIEW_REQUIRED"])).toBe("REVIEW_REQUIRED");
    expect(rollupShadowRunState(["REVIEW_REQUIRED", "BLOCKED"])).toBe("BLOCKED");
    expect(rollupShadowRunState(["BLOCKED", "UNCERTAIN"])).toBe("UNCERTAIN");
  });

  it("enforces one owner, takeover fencing, stale commit rejection, and no heartbeat revival", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T01:00:00.000Z"));
    const store = new InMemoryShadowOrchestrationStore();
    const run = await store.createOrReuseRun(request);
    const inputFingerprint = shadowSha256({ frontier: "a" });
    const first = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "a", leaseSeconds: 30 });
    await expect(store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "b" }))
      .rejects.toThrow("SHADOW_LEASE_HELD");
    vi.advanceTimersByTime(30_001);
    await expect(store.renewLease(first.lease)).rejects.toThrow("STALE_SHADOW_FENCE");
    const second = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "b" });
    expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
    await expect(store.renewLease(first.lease)).rejects.toThrow("STALE_SHADOW_FENCE");
    await expect(store.finalizeStage({
      runId: run.id, stageId: first.stage.id, attemptId: first.attempt.id, stage: "INGESTION",
      workerId: "a", fencingToken: first.lease.fencingToken, state: "SUCCEEDED",
      inputFingerprint, output: { computed: true }, provenance: [], reasonCode: null,
    })).rejects.toThrow("STALE_SHADOW_FENCE");
  });

  it("recovers a crash after computation and reuses an identical committed output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T01:00:00.000Z"));
    const store = new InMemoryShadowOrchestrationStore();
    const run = await store.createOrReuseRun(request);
    const inputFingerprint = shadowSha256({ frontier: "crash" });
    await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "crashed", leaseSeconds: 30 });
    vi.advanceTimersByTime(30_001);
    const recovered = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "replacement" });
    const completion = {
      runId: run.id, stageId: recovered.stage.id, attemptId: recovered.attempt.id, stage: "INGESTION" as const,
      workerId: "replacement", fencingToken: recovered.lease.fencingToken, state: "SUCCEEDED" as const,
      inputFingerprint, output: { computed: true }, provenance: [], reasonCode: null,
    };
    expect((await store.finalizeStage(completion)).reused).toBe(false);
    expect((await store.finalizeStage(completion)).reused).toBe(true);
    await expect(store.finalizeStage({ ...completion, output: { computed: false } }))
      .rejects.toThrow("SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT");
    await expect(store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "c" }))
      .rejects.toThrow("TERMINAL_SHADOW_STAGE_CANNOT_REOPEN");
  });
});

describe("Step 9 extraction, canonical, and reconciliation adversarial contract", () => {
  it("does not re-extract exact replays and changes identity for model/prompt/schema/hints", async () => {
    const rows = new Map<string, ShadowExtractionResult>();
    const persistence: ShadowExtractionPersistence = {
      find: async (key) => rows.get(key) ?? null,
      record: async (input) => {
        const row = { ...input, extractionRunId: `x-${rows.size + 1}`, reused: false };
        rows.set(input.extractionKey, row);
        return row;
      },
    };
    const service = new ShadowExtractionRunService(persistence, { verify: async () => true });
    const extractor = vi.fn(async () => ({ amountMinor: 10_000n }));
    const base = extractionRequest();
    const exact = await service.execute(base, 1n, extractor);
    expect((await service.execute({ ...base, attemptId: "attempt-2" }, 2n, extractor)).extractionKey).toBe(exact.extractionKey);
    for (const changed of [
      { modelConfigurationFingerprint: "d".repeat(64) }, { promptFingerprint: "e".repeat(64) },
      { extractorVersion: "v2" }, { modelVersion: "model-v2" },
      { hintsFingerprint: "f".repeat(64) }, { extractionContractVersion: "invoice-extraction-v2" },
    ]) await service.execute(extractionRequest(changed), 3n, extractor);
    expect(extractor).toHaveBeenCalledTimes(7);
    expect(rows.size).toBe(7);
  });

  it("fails closed on artifact hash/scope mismatch before model invocation", async () => {
    const persistence: ShadowExtractionPersistence = { find: async () => null, record: vi.fn() };
    const extractor = vi.fn();
    const service = new ShadowExtractionRunService(persistence, { verify: async () => false });
    await expect(service.execute(extractionRequest(), 1n, extractor))
      .rejects.toThrow("EXTRACTION_ARTIFACT_SCOPE_OR_HASH_INTEGRITY_BLOCKED");
    expect(extractor).not.toHaveBeenCalled();
  });

  it("allows concurrent extraction computation but commits one authoritative result", async () => {
    let authoritative: ShadowExtractionResult | null = null;
    const persistence: ShadowExtractionPersistence = {
      find: async () => null,
      record: async (input) => {
        if (!authoritative) authoritative = { ...input, extractionRunId: "authoritative", reused: false };
        if (authoritative.outputFingerprint !== input.outputFingerprint) throw new Error("SHADOW_EXTRACTION_KEY_INTEGRITY_CONFLICT");
        return { ...authoritative, reused: authoritative !== input };
      },
    };
    const service = new ShadowExtractionRunService(persistence, { verify: async () => true });
    const [left, right] = await Promise.all([
      service.execute(extractionRequest(), 1n, async () => ({ supplier: "A" })),
      service.execute(extractionRequest({ attemptId: "attempt-2" }), 2n, async () => ({ supplier: "A" })),
    ]);
    expect(left.extractionRunId).toBe("authoritative");
    expect(right.extractionRunId).toBe("authoritative");
  });

  it("reuses Step 3 identities and escalates ambiguous canonical mapping to review", async () => {
    const port = {
      startImport: vi.fn(async () => ({ runId: "canonical-run" })),
      ingestObservation: vi.fn(async () => ({ observationId: "o", revisionId: "r", eventId: "e" })),
      recordOccurrence: vi.fn(async () => ({ occurrenceId: "x" })),
    };
    const adapter = new ExtractionToCanonicalAdapter(port);
    const input = {
      ...ids,
      artifact: { namespace: "import_artifact" as const, id: "artifact", fingerprint: "a".repeat(64) },
      extraction: { namespace: "shadow_extraction_run" as const, id: "extraction", fingerprint: "b".repeat(64) },
      parserName: "invoice", parserVersion: "v1",
      observations: [{ sourceLocator: "row-1", root: {}, revision: {}, identityClaims: [{}], eventRevision: {}, occurrence: {} }],
    };
    const first = await adapter.apply(input);
    const second = await adapter.apply(input);
    expect(second).toEqual(first);
    await expect(adapter.apply({ ...input, observations: [{ ...input.observations[0], identityClaims: [] }] }))
      .rejects.toThrow("CANONICAL_MAPPING_REVIEW_REQUIRED");
  });

  it("is sorted-order invariant and never silently reuses an old identity for changed evidence", async () => {
    const a = { namespace: "bank_transaction" as const, id: "a", fingerprint: "a".repeat(64) };
    const b = { namespace: "accounting_transaction" as const, id: "b", fingerprint: "b".repeat(64) };
    let manifest = [a, b];
    const adapter = new ShadowReconciliationAdapter({
      loadManifest: async () => manifest,
      computeAndPersist: async () => ({ matches: 0 }),
      loadOutputManifest: async () => manifest,
    });
    const base = { ...ids, statementId: "statement", reconciliationVersion: "v1" };
    const first = await adapter.reconcile(base);
    manifest = [b, a];
    expect((await adapter.reconcile(base)).inputFingerprint).toBe(first.inputFingerprint);
    manifest = [{ ...a, fingerprint: "c".repeat(64) }, b];
    expect((await adapter.reconcile(base)).inputFingerprint).not.toBe(first.inputFingerprint);
  });
});

describe("Step 9 policy, planning, and exception adversarial contract", () => {
  it("assembles identical Step 7 policy inputs deterministically", async () => {
    const bundleSha = policyBundleSha256(STEP7_INITIAL_POLICY_BUNDLE);
    const snapshotSha = clientPolicySnapshotSha256(BASE_SNAPSHOT, bundleSha);
    const assembler = new ReadOnlyPolicyInputAssembler({
      loadActiveBundle: async () => ({ id: "bundle", sha256: bundleSha, canonicalJson: canonicalPolicyJson(STEP7_INITIAL_POLICY_BUNDLE), value: STEP7_INITIAL_POLICY_BUNDLE }),
      loadCurrentSnapshot: async () => ({ id: "snapshot", sha256: snapshotSha, canonicalJson: canonicalPolicyJson(BASE_SNAPSHOT), value: BASE_SNAPSHOT }),
    });
    const input = {
      practiceId: ids.practiceId, clientEntityId: CLIENT_ID, ledgerBookId: LEDGER_BOOK_ID,
      evaluationAsOf: BASE_INPUT.evaluationAsOf, priorStageFingerprints: ["a".repeat(64)],
      normalizedInput: Object.fromEntries(Object.entries(BASE_INPUT).filter(([key]) => key !== "evaluationAsOf")) as Omit<typeof BASE_INPUT, "evaluationAsOf">,
    };
    expect((await assembler.assemble(input)).canonicalInput)
      .toEqual((await assembler.assemble(input)).canonicalInput);
  });

  it.each([
    ["REVIEW", "REVIEW_REQUIRED"], ["DENY", "BLOCKED"],
  ] as const)("stops after Step 7 %s and emits only the exception stage", async (decision, expected) => {
    const calls: string[] = [];
    const handlers = successfulHandlers({
      POLICY_EVALUATION: async () => {
        calls.push("POLICY_EVALUATION");
        return { state: "SUCCEEDED", output: { decision }, provenance: [], reasonCode: null };
      },
      STEP8_PLANNING: async () => { calls.push("STEP8_PLANNING"); throw new Error("must not run"); },
      EXCEPTION_OUTPUT: async () => {
        calls.push("EXCEPTION_OUTPUT");
        return { state: "SUCCEEDED", output: {}, provenance: [], reasonCode: null };
      },
    });
    const result = await new ShadowOrchestrationWorker(new InMemoryShadowOrchestrationStore(), "w", handlers).run(request);
    expect(calls).toEqual(["POLICY_EVALUATION", "EXCEPTION_OUTPUT"]);
    expect(result.state).toBe(expected);
  });

  it.each([
    ["AMBIGUOUS_MAPPING_REVIEW", "REVIEW_REQUIRED"],
    ["EVIDENCE_INTEGRITY_BLOCKED", "BLOCKED"],
    ["RECONCILIATION_FRONTIER_DRIFT_UNCERTAIN", "UNCERTAIN"],
  ] as const)("stops downstream work after %s", async (reasonCode, expected) => {
    const calls: string[] = [];
    const handlers = successfulHandlers({
      RECONCILIATION: async () => { calls.push("RECONCILIATION"); throw new Error(reasonCode); },
      BALANCE_PROOF: async () => { calls.push("BALANCE_PROOF"); throw new Error("must not run"); },
      EXCEPTION_OUTPUT: async () => {
        calls.push("EXCEPTION_OUTPUT");
        return { state: "SUCCEEDED", output: {}, provenance: [], reasonCode: null };
      },
    });
    const result = await new ShadowOrchestrationWorker(new InMemoryShadowOrchestrationStore(), "w", handlers).run(request);
    expect(calls).toEqual(["RECONCILIATION", "EXCEPTION_OUTPUT"]);
    expect(result.state).toBe(expected);
  });

  it.each([
    ["SAFE_METHOD", "SUCCEEDED"], ["REVIEW", "REVIEW_REQUIRED"], ["NO_SAFE_METHOD", "FAILED_SAFE"],
  ] as const)("keeps Step 8 %s observational and ends at exception output", async (decision, expected) => {
    const calls: string[] = [];
    const handlers = successfulHandlers({
      STEP8_PLANNING: async () => {
        calls.push("STEP8_PLANNING");
        return { state: "SUCCEEDED", output: { decision, grantsExecutionPermission: false }, provenance: [], reasonCode: null };
      },
      EXCEPTION_OUTPUT: async () => {
        calls.push("EXCEPTION_OUTPUT");
        return { state: "SUCCEEDED", output: {}, provenance: [], reasonCode: null };
      },
    });
    const result = await new ShadowOrchestrationWorker(new InMemoryShadowOrchestrationStore(), "w", handlers).run(request);
    expect(calls).toEqual(["STEP8_PLANNING", "EXCEPTION_OUTPUT"]);
    expect(result.state).toBe(expected);
  });

  it("stops safely when durable exception persistence fails", async () => {
    const store = new InMemoryShadowOrchestrationStore();
    const handlers = successfulHandlers({ EXCEPTION_OUTPUT: async () => { throw new Error("DATABASE_UNAVAILABLE"); } });
    await expect(new ShadowOrchestrationWorker(store, "w", handlers).run(request))
      .rejects.toThrow("DATABASE_UNAVAILABLE");
    expect((await store.createOrReuseRun(request)).state).toBe("RETRYABLE");
  });

  it("fingerprints duplicate exceptions identically, detects changed content, and rejects raw payloads", () => {
    const base = {
      ...ids, runId: "run", stage: "EXTRACTION" as const, subjectNamespace: "artifact",
      subjectId: "artifact-1", reasonCode: "READ_FAILED", evidence: [], correlationId: "c",
      diagnostics: { retryCount: 2 },
    };
    const first = prepareShadowException(base);
    expect(prepareShadowException(base).payloadFingerprint).toBe(first.payloadFingerprint);
    expect(prepareShadowException({ ...base, diagnostics: { retryCount: 3 } }).payloadFingerprint)
      .not.toBe(first.payloadFingerprint);
    expect(() => prepareShadowException({ ...base, diagnostics: { rawFinancialPayload: "sensitive" } }))
      .toThrow("SENSITIVE_EXCEPTION_FIELD");
  });
});
