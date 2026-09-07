import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const path = resolve(process.cwd(), "..", "supabase", "migrations", "034_step9_shadow_orchestration.sql");
const sql = readFileSync(path, "utf8");
const code = sql.replace(/--.*$/gm, "");

const tables = [
  "shadow_orchestration_runs", "shadow_orchestration_stages",
  "shadow_orchestration_stage_attempts", "shadow_orchestration_transition_events",
  "shadow_orchestration_stage_outputs", "shadow_extraction_runs",
  "shadow_reconciliation_snapshots", "shadow_orchestration_exceptions",
  "shadow_orchestration_leases",
];

describe("migration 034 shadow orchestration foundation", () => {
  it("is atomic, additive, and contains every frozen record family", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    for (const table of tables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${table}\\b`, "i"));
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"));
    }
  });

  it("hard-codes SHADOW mode and disabled execution", () => {
    expect(sql).toContain("CHECK (mode = 'SHADOW')");
    expect(sql).toContain("CHECK (NOT execution_permitted)");
    expect(sql).toContain("STEP9_SHADOW_MODE_REQUIRED");
    expect(sql).toContain("STEP9_EXECUTION_MUST_BE_DISABLED");
  });

  it("enforces transitions, terminal closure, immutable outputs, and monotonic fencing", () => {
    expect(sql).toContain("step9_shadow_transition_allowed_v1");
    expect(sql).toContain("step9_shadow_run_rollup_v1");
    expect(sql).not.toMatch(/WHEN 'RUNNING' THEN p_to IN \([^)]*'CANCELLED'/);
    expect(sql).toContain("TERMINAL_SHADOW_RUN_CANNOT_REOPEN");
    expect(sql).toContain("TERMINAL_SHADOW_STAGE_CANNOT_REOPEN");
    expect(sql).toContain("SHADOW_STAGE_OUTPUT_IS_IMMUTABLE");
    expect(sql).toContain("shadow_stage_outputs_immutable");
    expect(sql).toContain("fencing_token = public.shadow_orchestration_leases.fencing_token + 1");
    expect(sql).toContain("extensions.digest(convert_to(");
    expect(sql).toContain("SHADOW_FENCING_TOKEN_MUST_BE_MONOTONIC");
    expect(sql).toContain("shadow_leases_no_delete");
    expect(sql).toContain("STALE_SHADOW_FENCE");
    expect(sql).toContain("SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT");
    expect(sql).toContain("SHADOW_RUN_HAS_ACTIVE_STAGE");
  });

  it("exposes only service-role mutation RPCs and tenant-scoped reads", () => {
    expect(sql).toContain("canonical_can_access_client_v1(client_entity_id)");
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*TO\s+(?:authenticated|anon)/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_shadow_orchestration_run_v1[\s\S]*TO service_role/);
  });

  it("fails closed on semantic replay conflicts while reusing exact durable records", () => {
    expect(sql).toContain("SHADOW_RUN_KEY_INTEGRITY_CONFLICT");
    expect(sql).toContain("SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT");
    expect(sql).toContain("SHADOW_EXTRACTION_KEY_INTEGRITY_CONFLICT");
    expect(sql).toContain("SHADOW_RECONCILIATION_SNAPSHOT_CONFLICT");
    expect(sql).toContain("SHADOW_EXCEPTION_KEY_INTEGRITY_CONFLICT");
    expect(sql).toMatch(/ON CONFLICT \(run_key\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(extraction_key\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(exception_key\) DO NOTHING/);
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('step9-run:'");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('step9-lease:'");
  });

  it("does not alter or invoke posting, correction execution, or provider mutation surfaces", () => {
    expect(code).not.toMatch(/ALTER\s+TABLE\s+public\.(?:posting_|provider_posting|correction_)/i);
    expect(code).not.toMatch(/\b(?:posting_operations|posting_attempts|provider_posting|correction_operations)\b/i);
    expect(code).not.toMatch(/\b(?:qboPost|executeQuickBooks|postApprovedBill|PostingActor)\b/);
  });
});
