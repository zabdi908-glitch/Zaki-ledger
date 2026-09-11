import { describe, expect, it, vi } from "vitest";
import { canonicalShadowJson, fingerprintStageOutput } from "../lib/orchestration/shadow-canonicalization";
import { SupabaseShadowOrchestrationStore } from "../lib/orchestration/shadow-store";

const runId = "10000000-0000-4000-8000-000000000001";
const stageId = "20000000-0000-4000-8000-000000000001";
const scope = {
  practice_id: "30000000-0000-4000-8000-000000000001",
  client_entity_id: "40000000-0000-4000-8000-000000000001",
  ledger_book_id: "50000000-0000-4000-8000-000000000001",
};
const inputFingerprint = "a".repeat(64);
const output = { artifactId: "artifact-a", retained: true };
const provenance = [{ namespace: "import_artifact", id: "artifact-a", fingerprint: "b".repeat(64) }];
const outputFingerprint = fingerprintStageOutput("INGESTION", output, provenance);

function query(result: { data: unknown; error: unknown }) {
  const value = {
    select: vi.fn(() => value),
    eq: vi.fn(() => value),
    maybeSingle: vi.fn(async () => result),
  };
  return value;
}

function database(outputResult: { data: unknown; error: unknown }) {
  return {
    from: vi.fn((table: string) => table === "shadow_orchestration_stages"
      ? query({ data: {
        id: stageId, run_id: runId, ...scope, stage: "INGESTION", stage_ordinal: 1,
        state: "SUCCEEDED", input_fingerprint: `\\x${inputFingerprint}`,
        output_fingerprint: `\\x${outputFingerprint}`,
      }, error: null })
      : query(outputResult)),
  };
}

function persistedOutput(overrides: Record<string, unknown> = {}) {
  return {
    stage_id: stageId, run_id: runId, ...scope,
    input_fingerprint: `\\x${inputFingerprint}`,
    output_fingerprint: `\\x${outputFingerprint}`,
    output_payload: output, output_canonical_json: canonicalShadowJson(output),
    provenance, provenance_canonical_json: canonicalShadowJson(provenance),
    ...overrides,
  };
}

describe("Step 9 persisted resume checkpoint store", () => {
  it("hydrates a succeeded checkpoint only after normalizing and validating every fingerprint", async () => {
    const db = database({ data: persistedOutput(), error: null });
    const checkpoint = await new SupabaseShadowOrchestrationStore(db as never)
      .loadSucceededStage(runId, "INGESTION");
    expect(checkpoint).toMatchObject({
      stage: { runId, stage: "INGESTION", inputFingerprint, outputFingerprint },
      scope: {
        practiceId: scope.practice_id,
        clientEntityId: scope.client_entity_id,
        ledgerBookId: scope.ledger_book_id,
      },
      output,
      provenance,
    });
  });

  it("fails closed when the succeeded stage output is missing", async () => {
    const db = database({ data: null, error: null });
    await expect(new SupabaseShadowOrchestrationStore(db as never)
      .loadSucceededStage(runId, "INGESTION"))
      .rejects.toThrow("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_MISSING");
  });

  it("fails closed when persisted payload and output fingerprint disagree", async () => {
    const db = database({ data: persistedOutput({ output_payload: { retained: false } }), error: null });
    await expect(new SupabaseShadowOrchestrationStore(db as never)
      .loadSucceededStage(runId, "INGESTION"))
      .rejects.toThrow("SHADOW_RESUME_COMPLETED_STAGE_OUTPUT_FINGERPRINT_MISMATCH");
  });
});
