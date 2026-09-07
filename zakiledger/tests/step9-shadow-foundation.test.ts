import { describe, expect, it, vi } from "vitest";
import {
  assertShadowOnly, assertShadowTransition, SHADOW_STAGES,
  type ShadowRunRequest,
} from "../lib/orchestration/shadow-contract";
import {
  canonicalShadowJson, fingerprintSortedManifest, shadowSha256,
} from "../lib/orchestration/shadow-canonicalization";
import { InMemoryShadowOrchestrationStore } from "../lib/orchestration/shadow-store";
import { ShadowOrchestrationWorker } from "../lib/orchestration/shadow-worker";
import {
  ShadowExtractionRunService, type ShadowExtractionPersistence,
  type ShadowExtractionResult,
} from "../lib/orchestration/extraction-run-service";
import { prepareShadowException } from "../lib/orchestration/exception-output-store";
import { ExtractionToCanonicalAdapter } from "../lib/orchestration/extraction-to-canonical-adapter";
import { ShadowReconciliationAdapter } from "../lib/orchestration/reconciliation-adapter";

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

describe("Step 9 shadow foundation", () => {
  it("canonicalizes keys, bigints, and unordered manifests deterministically", () => {
    expect(canonicalShadowJson({ z: 2n, a: { y: true, x: "n" } }))
      .toBe('{"a":{"x":"n","y":true},"z":"2"}');
    const left = fingerprintSortedManifest("test", [{ id: "b" }, { id: "a" }], (v) => v.id);
    const right = fingerprintSortedManifest("test", [{ id: "a" }, { id: "b" }], (v) => v.id);
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed outside SHADOW and rejects illegal state changes", () => {
    expect(() => assertShadowOnly({ mode: "LIVE" as never, executionPermitted: false })).toThrow("STEP9_SHADOW_MODE_REQUIRED");
    expect(() => assertShadowOnly({ mode: "SHADOW", executionPermitted: true as false })).toThrow("STEP9_EXECUTION_MUST_BE_DISABLED");
    expect(() => assertShadowTransition("SUCCEEDED", "RUNNING")).toThrow("ILLEGAL_SHADOW_TRANSITION");
    expect(() => assertShadowTransition("PENDING", "RUNNING")).not.toThrow();
  });

  it("rejects stale fences and never reopens a terminal stage", async () => {
    const store = new InMemoryShadowOrchestrationStore();
    const run = await store.createOrReuseRun(request);
    const inputFingerprint = shadowSha256({ stage: "INGESTION" });
    const claimed = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "worker-a" });
    await expect(store.renewLease({ ...claimed.lease, fencingToken: claimed.lease.fencingToken + 1n }))
      .rejects.toThrow("STALE_SHADOW_FENCE");
    await store.finalizeStage({
      runId: run.id, stageId: claimed.stage.id, attemptId: claimed.attempt.id,
      stage: "INGESTION", workerId: "worker-a", fencingToken: claimed.lease.fencingToken,
      state: "SUCCEEDED", inputFingerprint, output: { retained: true }, provenance: [], reasonCode: null,
    });
    await expect(store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "worker-b" }))
      .rejects.toThrow("TERMINAL_SHADOW_STAGE_CANNOT_REOPEN");
  });

  it("releases a retryable attempt and issues a strictly larger fence", async () => {
    const store = new InMemoryShadowOrchestrationStore();
    const run = await store.createOrReuseRun(request);
    const inputFingerprint = shadowSha256({ stage: "INGESTION", retry: true });
    const first = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "worker-a" });
    await store.markStageRetryable({
      runId: run.id, stageId: first.stage.id, attemptId: first.attempt.id,
      workerId: "worker-a", fencingToken: first.lease.fencingToken, reasonCode: "TRANSIENT_STORAGE",
    });
    const second = await store.beginStage({ runId: run.id, stage: "INGESTION", inputFingerprint, workerId: "worker-b" });
    expect(second.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
  });

  it("replays a committed extraction without invoking the model again", async () => {
    const records = new Map<string, ShadowExtractionResult>();
    const persistence: ShadowExtractionPersistence = {
      find: async (key) => records.get(key) ?? null,
      record: async (input) => {
        const result = { ...input, extractionRunId: "extraction-1", reused: false };
        records.set(input.extractionKey, result);
        return result;
      },
    };
    const service = new ShadowExtractionRunService(persistence, { verify: async () => true });
    const extractor = vi.fn(async () => ({ totalMinor: 12000n, supplier: "A" }));
    const extractionRequest = {
      ...ids, runId: "run-1", stageId: "stage-1", attemptId: "attempt-1", workerId: "worker-a",
      artifact: { namespace: "import_artifact" as const, id: "artifact-1", fingerprint: "a".repeat(64) },
      artifactLength: 42, extractorName: "invoice", extractorVersion: "v1",
      modelConfigurationFingerprint: "b".repeat(64), promptFingerprint: "c".repeat(64), hintsFingerprint: null,
    };
    const first = await service.execute(extractionRequest, 1n, extractor);
    const second = await service.execute({ ...extractionRequest, attemptId: "attempt-2" }, 2n, extractor);
    expect(first.outputFingerprint).toBe(second.outputFingerprint);
    expect(second.reused).toBe(true);
    expect(extractor).toHaveBeenCalledTimes(1);
  });

  it("delegates canonical identity to the existing domain port in stable locator order", async () => {
    const calls: string[] = [];
    const adapter = new ExtractionToCanonicalAdapter({
      startImport: async () => ({ runId: "canonical-run" }),
      ingestObservation: async (input) => {
        calls.push(input.sourceLocator);
        return { observationId: `o-${input.sourceLocator}`, revisionId: `r-${input.sourceLocator}`, eventId: `e-${input.sourceLocator}` };
      },
      recordOccurrence: async (input) => ({ occurrenceId: `x-${input.observationId}` }),
    });
    const command = (sourceLocator: string) => ({
      sourceLocator, root: {}, revision: {}, identityClaims: [{}], eventRevision: {}, occurrence: {},
    });
    const result = await adapter.apply({
      ...ids,
      artifact: { namespace: "import_artifact", id: "artifact", fingerprint: "a".repeat(64) },
      extraction: { namespace: "shadow_extraction_run", id: "extraction", fingerprint: "b".repeat(64) },
      parserName: "invoice", parserVersion: "v1", observations: [command("row-2"), command("row-1")],
    });
    expect(calls).toEqual(["row-1", "row-2"]);
    expect(result.outputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails reconciliation closed when the frozen source frontier drifts", async () => {
    const bank = { namespace: "bank_transaction" as const, id: "bank-1", fingerprint: "a".repeat(64) };
    const changed = { ...bank, fingerprint: "b".repeat(64) };
    const adapter = new ShadowReconciliationAdapter({
      loadManifest: async () => [bank], computeAndPersist: async () => ({ matches: 0 }),
      loadOutputManifest: async () => [changed],
    });
    await expect(adapter.reconcile({
      ...ids, statementId: "statement-1", reconciliationVersion: "canonical-013",
    })).rejects.toThrow("RECONCILIATION_FRONTIER_DRIFT_UNCERTAIN");
  });

  it("records ALLOW and SAFE_METHOD as observations and stops at exception output", async () => {
    const store = new InMemoryShadowOrchestrationStore();
    const calls: string[] = [];
    const handlers = Object.fromEntries(SHADOW_STAGES.map((stage) => [stage, async () => {
      calls.push(stage);
      const output = stage === "POLICY_EVALUATION" ? { decision: "ALLOW" }
        : stage === "STEP8_PLANNING"
          ? { decision: "SAFE_METHOD", grantsExecutionPermission: false }
          : { stage };
      return { state: "SUCCEEDED" as const, output, provenance: [], reasonCode: null };
    }]));
    const worker = new ShadowOrchestrationWorker(store, "worker-a", handlers);
    const result = await worker.run(request);
    expect(calls).toEqual(SHADOW_STAGES);
    expect(result.state).toBe("SUCCEEDED");
  });

  it("rejects sensitive exception diagnostics", () => {
    expect(() => prepareShadowException({
      ...ids, runId: "run", stage: "EXTRACTION", subjectNamespace: "artifact",
      subjectId: "artifact-1", reasonCode: "READ_FAILED", evidence: [], correlationId: "c",
      diagnostics: { accessToken: "must-not-log" },
    })).toThrow("SENSITIVE_EXCEPTION_FIELD");
  });
});
