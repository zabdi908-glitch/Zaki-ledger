import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const path = resolve(process.cwd(), "..", "supabase", "migrations", "032_step7_autonomy_policy_engine.sql");
const sql = readFileSync(path, "utf8");
const withoutComments = sql.replace(/--.*$/gm, "");

describe("migration 032 Step 7 policy foundation", () => {
  it("is atomic, additive, and does not touch Step 5 tables or functions", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(withoutComments).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.)\b/i);
    expect(withoutComments).not.toMatch(/ALTER\s+TABLE\s+public\.(?:posting_|provider_posting|quickbooks_)/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(?:claim_posting|transition_posting|prepare_quickbooks)/i);
  });

  it("creates exactly the four immutable policy record families", () => {
    for (const table of ["autonomy_policy_bundles", "client_policy_snapshots", "normalized_policy_inputs", "autonomy_policy_decisions"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${table}\\b`, "i"));
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER ${table}_[a-z_]*immutable`, "i"));
    }
    expect(sql.match(/EXECUTE FUNCTION public\.canonical_reject_update_delete_v1\(\)/g)).toHaveLength(4);
  });

  it("uses bigint signed minor-unit columns and excludes decimal policy columns", () => {
    expect(sql).toMatch(/amount_minor\s+bigint/);
    expect(sql).toMatch(/max_single_action_amount_minor\s+bigint/);
    expect(sql).not.toMatch(/amount_(?:decimal|numeric)\s+(?:numeric|decimal)/i);
    expect(sql).toContain("NOT (snapshot_json ? 'amountDecimal')");
  });

  it("binds exact fingerprints, hashes, tenants, and an atomic decision key", () => {
    expect(sql).toContain("digest(convert_to(p_action_snapshot_canonical_json");
    expect(sql).toContain("normalized_input_json->'action'->>'claimedActionFingerprint'");
    expect(sql).toMatch(/action_fingerprint\s+bytea NOT NULL/);
    expect(sql).toContain("UNIQUE (decision_key)");
    expect(sql).toContain("DECISION_KEY_INTEGRITY_CONFLICT");
    expect(sql).toContain("p_decision_key_material_canonical_json");
    expect(sql).toContain("p_result_canonical_json");
    expect(sql).toMatch(/FOREIGN KEY \(client_policy_snapshot_id, client_entity_id, policy_bundle_id, client_policy_snapshot_sha256\)/);
  });

  it("exposes no direct mutation grant and no posting capability", () => {
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*TO/i);
    expect(sql).not.toMatch(/\b(?:posting_operations|posting_attempts|provider_object_bindings|quickbooks_|dispatch_)\b/i);
  });
});
