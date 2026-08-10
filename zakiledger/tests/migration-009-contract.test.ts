import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "..", "supabase", "migrations", "009_financial_acl_hardening.sql"),
  "utf8",
);

const targetTables = [
  "public.bank_statements",
  "public.bank_transactions",
  "public.qb_transactions",
  "public.bank_statement_transaction_observations",
];

describe("migration 009 financial ACL contract", () => {
  it("is transactional and security-only", () => {
    const withoutComments = sql.replace(/--.*$/gm, "");
    expect(sql).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(withoutComments).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|DROP|ALTER\s+TABLE|CREATE\s+TABLE)\b/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it("resets exactly the four ingestion-table ACLs for application roles", () => {
    for (const table of targetTables) expect(sql).toContain(table);
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/i);
  });

  it("grants service_role only SELECT and INSERT on those tables", () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE[\s\S]*TO service_role;/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(?:UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*ON TABLE[^;]*TO (?:anon|authenticated|PUBLIC)/i);
  });

  it("preserves the reviewed RPC execution matrix", () => {
    const signatures = [
      "public.ingest_bank_statement_v1\\(uuid, jsonb, jsonb\\)",
      "public.ingest_accounting_transactions_v1\\(uuid, jsonb\\)",
      "public.list_statement_bank_transactions_v1\\(uuid, uuid\\)",
    ];
    for (const signature of signatures) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`, "i"));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`, "i"));
    }
  });
});
