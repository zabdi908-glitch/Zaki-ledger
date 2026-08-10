import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "..", "supabase", "migrations", "008_financial_ingestion_identity.sql"),
  "utf8",
);

describe("migration 008 safety contract", () => {
  it("is additive and contains no destructive historical operation", () => {
    const withoutComments = sql.replace(/--.*$/gm, "");
    expect(withoutComments).not.toMatch(/^\s*(?:DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|DROP)\b/im);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("bank_statement_transaction_observations");
  });

  it("keeps fingerprints non-unique and provider identities partial-unique", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS bank_transactions_fingerprint_candidate_idx/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS qb_transactions_fingerprint_candidate_idx/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_provider_identity_key/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS qb_transactions_provider_identity_key/i);
    expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*fingerprint/is);
  });

  it("defines atomic RPCs and observation uniqueness", () => {
    expect(sql).toContain("ingest_bank_statement_v1");
    expect(sql).toContain("ingest_accounting_transactions_v1");
    expect(sql).toContain("UNIQUE (statement_id, bank_transaction_id)");
    expect(sql.trimStart()).toMatch(/^--/);
    expect(sql).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it("revokes PUBLIC, anon, and unused authenticated execution for every RPC", () => {
    const signatures = [
      "public.ingest_bank_statement_v1\\(uuid, jsonb, jsonb\\)",
      "public.ingest_accounting_transactions_v1\\(uuid, jsonb\\)",
      "public.list_statement_bank_transactions_v1\\(uuid, uuid\\)",
    ];
    for (const signature of signatures) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${signature} FROM anon;`, "i"));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${signature} FROM authenticated;`, "i"));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`, "i"));
    }
  });

  it("guards every RPC against caller-supplied cross-user access", () => {
    expect(sql.match(/auth\.uid\(\) IS DISTINCT FROM p_user_id/g)).toHaveLength(3);
    expect(sql.match(/current_user <> 'service_role'/g)).toHaveLength(3);
    expect(sql.match(/ERRCODE = '42501'/g)).toHaveLength(6);
  });

  it("ignores only the expected duplicate observation identity", () => {
    const observationWrites = sql.match(/INSERT INTO public\.bank_statement_transaction_observations[\s\S]*?;/g) ?? [];
    expect(observationWrites).toHaveLength(2);
    for (const write of observationWrites) {
      expect(write).toMatch(/ON CONFLICT \(statement_id, bank_transaction_id\) DO NOTHING;/);
      expect(write).not.toMatch(/ON CONFLICT DO NOTHING;/);
    }
  });

  it("resolves accounting retries through both identities and rejects disagreement", () => {
    expect(sql).toContain("v_provider_identity_id");
    expect(sql).toContain("v_artifact_identity_id");
    expect(sql).toMatch(/v_provider_identity_id IS DISTINCT FROM v_artifact_identity_id/);
    expect(sql).toContain("Provider identity conflicts with artifact identity");
    expect(sql).toMatch(/COALESCE\(v_provider_identity_id, v_artifact_identity_id\)/);
    expect(sql).not.toMatch(/ELSIF v_provider IS NOT NULL AND v_artifact_hash IS NOT NULL/);
  });

  it("does not introduce SECURITY DEFINER", () => {
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(sql.match(/SECURITY\s+INVOKER/gi)).toHaveLength(3);
  });
});
