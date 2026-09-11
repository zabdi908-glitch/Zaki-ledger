import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeManualShadow,
  MANUAL_OFX_EXTRACTION_IDENTITY,
  type ManualShadowRequest,
  type ManualShadowRuntime,
} from "../lib/orchestration/manual-shadow-entrypoint";

const scope = {
  practiceId: "10000000-0000-4000-8000-000000000001",
  clientEntityId: "20000000-0000-4000-8000-000000000001",
  ledgerBookId: "30000000-0000-4000-8000-000000000001",
};
const input: ManualShadowRequest = {
  ...scope,
  contractVersion: "step9-shadow-orchestration-v1",
  mode: "SHADOW",
  executionPermitted: false,
  requestedFor: "2026-09-09T01:00:00.000Z",
  correlationId: "manual-shadow-test-1",
  artifactNotRetainedBefore: "2026-09-09T00:00:00.000Z",
  artifact: {
    id: "40000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
    length: 42,
    retainedAt: "2026-09-09T00:30:00.000Z",
    ...MANUAL_OFX_EXTRACTION_IDENTITY,
  },
  reconciliation: {
    statementId: "50000000-0000-4000-8000-000000000001",
    reconciliationVersion: "canonical-013",
  },
  balanceProof: {
    scopeId: "60000000-0000-4000-8000-000000000001",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    openingArtifactId: "70000000-0000-4000-8000-000000000001",
    closingArtifactId: "40000000-0000-4000-8000-000000000001",
  },
};

function request(body: unknown) {
  return new Request("http://test/api/orchestration/shadow/manual", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("Step 9 manual shadow entrypoint", () => {
  const execute = vi.fn<ManualShadowRuntime["execute"]>();
  const authenticate = vi.fn();

  beforeEach(() => {
    authenticate.mockReset().mockResolvedValue({ id: "operator-a" });
    execute.mockReset().mockResolvedValue({
      ...input, scheduleKey: "manual:key", id: "run-a", runKey: "key-a",
      inputFingerprint: "d".repeat(64), state: "SUCCEEDED", reused: false,
    });
  });

  const invoke = (body: unknown) => invokeManualShadow(request(body), {
    authenticate,
    runtime: () => ({ execute }),
  });

  it("rejects unauthenticated public access before constructing or invoking runtime", async () => {
    authenticate.mockResolvedValueOnce(null);
    const response = await invoke(input);
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires exact scope, SHADOW mode, and executionPermitted=false", async () => {
    for (const invalid of [
      { ...input, practiceId: "" },
      { ...input, mode: "LIVE" },
      { ...input, executionPermitted: true },
      { ...input, ledgerBookId: "client-supplied-name" },
    ]) {
      const response = await invoke(invalid);
      expect(response.status).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires every fresh extraction identity component without guessing", async () => {
    const response = await invoke({ ...input, artifact: { ...input.artifact, promptFingerprint: "" } });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an identity that does not name the bound deterministic extractor", async () => {
    execute.mockRejectedValueOnce(new Error("MANUAL_SHADOW_EXTRACTOR_UNSUPPORTED"));
    const response = await invoke({ ...input, artifact: { ...input.artifact, modelName: "unbound-model" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "MANUAL_SHADOW_EXTRACTOR_UNSUPPORTED" });
  });

  it("binds the authenticated operator and invokes exactly one one-shot run", async () => {
    const response = await invoke(input);
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(input, "operator-a");
  });

  it("fails closed with a sanitized reason when a supported stage lacks grounded input", async () => {
    execute.mockRejectedValueOnce(new Error("POLICY_ARTIFACTS_MISSING_REVIEW:secret payload"));
    const response = await invoke(input);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "POLICY_ARTIFACTS_MISSING_REVIEW" });
  });

  it("contains exact supported bindings and no execution, provider mutation, or scheduler capability", () => {
    const source = readFileSync(join(process.cwd(), "lib", "orchestration", "manual-shadow-entrypoint.ts"), "utf8");
    const route = readFileSync(join(process.cwd(), "app", "api", "orchestration", "shadow", "manual", "route.ts"), "utf8");
    for (const binding of [
      "loadRetainedOfx", "parseOfxStatement", "ExtractionToCanonicalAdapter",
      "ShadowReconciliationAdapter", "BalanceReconciliationShadowExecutor",
      "ReadOnlyPolicyInputAssembler", "bindProductionShadowServices", "runManualProductionShadow",
    ]) expect(source).toContain(binding);
    expect(source).not.toMatch(/authoritative-posting-service|posting-store|PostingActor/);
    expect(source).not.toMatch(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
    expect(`${source}\n${route}`).not.toMatch(/cron|scheduleJob|setInterval/);
  });

  it("binds ofx_fitid to the canonical registered strong strength", () => {
    const source = readFileSync(join(process.cwd(), "lib", "orchestration", "manual-shadow-entrypoint.ts"), "utf8");
    const canonical = readFileSync(join(process.cwd(), "..", "supabase", "migrations",
      "010_additive_canonical_financial_foundation.sql"), "utf8");
    expect(source).toMatch(/claim_kind:\s*"ofx_fitid",\s*strength:\s*"strong"/);
    expect(source).not.toMatch(/claim_kind:\s*"ofx_fitid",\s*strength:\s*"authoritative"/);
    expect(canonical).toContain("('ofx_fitid', 'strong')");
  });

  it("keeps unsupported identity-kind/strength pairs fail-closed at the canonical foreign key", () => {
    const canonical = readFileSync(join(process.cwd(), "..", "supabase", "migrations",
      "010_additive_canonical_financial_foundation.sql"), "utf8");
    expect(canonical).not.toContain("('ofx_fitid', 'authoritative')");
    expect(canonical).toMatch(/FOREIGN KEY \(claim_kind, strength\)\s+REFERENCES public\.financial_identity_claim_kinds/);
  });

  it("keeps one failed atomic observation ingest from writing partial canonical graph state", () => {
    const canonical = readFileSync(join(process.cwd(), "..", "supabase", "migrations",
      "010_additive_canonical_financial_foundation.sql"), "utf8");
    const ingest = canonical.match(/CREATE OR REPLACE FUNCTION public\.ingest_financial_observation_v1\([\s\S]*?\n\$\$;\n/)?.[0];
    expect(ingest).toBeDefined();
    // A single PostgreSQL function statement owns observation, event, link, and
    // identity-claim creation. With no exception handler swallowing an error,
    // PostgreSQL rolls the entire failed statement back.
    expect(ingest).toContain("public.create_financial_observation_v1");
    expect(ingest).toContain("public.create_financial_event_v1");
    expect(ingest).toContain("public.attach_financial_observation_v1");
    expect(ingest).toContain("INSERT INTO public.financial_identity_claims");
    expect(ingest).not.toMatch(/EXCEPTION\s+WHEN/);
    expect(ingest).not.toMatch(/financial_relationships|financial_allocations/);
  });
});
