import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "..",
  "supabase",
  "migrations",
  "011_default_canonical_tenant_bootstrap.sql",
);
const sql = readFileSync(migrationPath, "utf8");
const withoutComments = sql.replace(/--.*$/gm, "");
const migration010 = readFileSync(resolve(process.cwd(), "..", "supabase", "migrations", "010_additive_canonical_financial_foundation.sql"));
const loginRoute = readFileSync(resolve(process.cwd(), "app", "api", "auth", "login", "route.ts"), "utf8");

describe("migration 011 default canonical tenant bootstrap contract", () => {
  it("is atomic, additive, and preserves Migration 010", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.default_tenant_identities/i);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(createHash("sha256").update(migration010).digest("hex")).toBe(
      "ad609305b040063a0c6186c9e3460f8bb886ce8429a1d03d8f48f6d17907902d",
    );
  });

  it("uses registry business identity and random canonical UUIDs, never auth UUID primary keys", () => {
    expect(sql).toMatch(/user_id\s+uuid PRIMARY KEY[\s\S]*REFERENCES auth\.users/i);
    expect(sql).toMatch(/v_practice_id uuid;[\s\S]*v_operation_id uuid := gen_random_uuid\(\)/i);
    expect(sql.match(/:= gen_random_uuid\(\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(withoutComments).not.toMatch(/VALUES\s*\(\s*p_user_id\s*,\s*['"]Default practice/i);
    expect(sql).toContain("UNIQUE (practice_id)");
    expect(sql).toContain("UNIQUE (client_entity_id)");
  });

  it("has separate, locked-down self and backfill RPCs sharing one implementation", () => {
    expect(sql).toMatch(/FUNCTION public\.ensure_default_tenant_for_self_v1\(\)[\s\S]*SECURITY DEFINER/i);
    expect(sql).toMatch(/FUNCTION public\.ensure_default_tenant_for_user_v1\(p_user_id uuid\)[\s\S]*SECURITY DEFINER/i);
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("ensure_default_tenant_impl_v1(v_user_id, 'user', v_user_id, NULL)");
    expect(sql).toContain("ensure_default_tenant_impl_v1(p_user_id, 'migration', NULL, 'canonical-backfill')");
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.ensure_default_tenant_for_self_v1\(\) TO authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.ensure_default_tenant_for_user_v1\(uuid\) TO service_role, postgres;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.ensure_default_tenant_for_user_v1\(uuid\)[\s\S]*authenticated/i);
    expect(sql.match(/SECURITY DEFINER\s+SET search_path = public, extensions, pg_temp/g)?.length).toBe(3);
  });

  it("serializes per user and repairs only registry-owned, relationship-checked entities", () => {
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(p_user_id::text, 11))");
    expect(sql).toContain("created_by_user_id = p_user_id");
    expect(sql).toContain("practice_id = v_practice_id");
    expect(sql).toContain("client_entity_id = v_client_entity_id");
    expect(sql).toContain("default practice identity ownership mismatch");
    expect(sql).toContain("default practice membership identity ownership mismatch");
    expect(sql).toContain("default client entity identity ownership mismatch");
    expect(sql).toContain("default internal ledger identity ownership mismatch");
    expect(sql).not.toMatch(/provider_connections\s*\(/i);
    expect(sql).not.toMatch(/financial_accounts\s*\(/i);
    expect(sql).not.toMatch(/client_access\s*\(/i);
    expect(sql).not.toMatch(/legacy_record_mappings\s*\(/i);
  });

  it("writes four sequential canonical audit records and backfills confirmed users only", () => {
    expect(sql.match(/canonical_write_audit_v1\(/g)).toHaveLength(4);
    for (const sequence of [1, 2, 3, 4]) expect(sql).toContain(`v_operation_id, ${sequence}`);
    expect(sql).toContain("'bootstrap_version', '011'");
    expect(sql).toContain("'bootstrap_target_user_id', p_user_id::text");
    expect(sql).toMatch(/WHERE confirmed_at IS NOT NULL[\s\S]*deleted_at IS NULL[\s\S]*is_anonymous/i);
    expect(sql).toContain("ALTER TABLE public.default_tenant_identities ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON TABLE public.default_tenant_identities");
  });

  it("boots a tenant only after successful authenticated password login", () => {
    expect(loginRoute).toMatch(/if \(error\) return[\s\S]*supabase\.rpc\("ensure_default_tenant_for_self_v1"\)/);
    expect(loginRoute).toContain("bootstrapError");
    expect(loginRoute).not.toContain("signUp");
  });
});
