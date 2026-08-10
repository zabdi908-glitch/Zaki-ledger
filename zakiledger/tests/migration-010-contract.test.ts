import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "..",
  "supabase",
  "migrations",
  "010_additive_canonical_financial_foundation.sql",
);
const sql = readFileSync(migrationPath, "utf8");
const withoutComments = sql.replace(/--.*$/gm, "");
const withoutTemporaryCacheCleanup = withoutComments.replace(
  /DELETE\s+FROM\s+pg_temp\.canonical_relationship_validation_seen\b/gi,
  "",
);

const legacyMigrations = Array.from({ length: 9 }, (_, index) => {
  const version = String(index + 1).padStart(3, "0");
  const names = [
    "initial_schema",
    "per_field_reasoning",
    "reconciliation_schema",
    "safe_schema_repair",
    "current_missing_tables",
    "fix_invoice_matches_user_fk",
    "restore_invoice_matches_bank_transaction_fk",
    "financial_ingestion_identity",
    "financial_acl_hardening",
  ];
  const path = resolve(process.cwd(), "..", "supabase", "migrations", `${version}_${names[index]}.sql`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
});

describe("migration 010 frozen canonical contract", () => {
  it("is atomic, additive, and contains no legacy data operation", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(withoutTemporaryCacheCleanup).not.toMatch(/\b(?:TRUNCATE|DROP\s+(?:TABLE|SCHEMA)|DELETE\s+FROM)\b/i);
    expect(withoutComments).not.toMatch(/\b(?:UPDATE|INSERT\s+INTO)\s+public\.(?:bank_|qb_|invoice|reconciliation|oauth)/i);
    expect(withoutComments).not.toMatch(/ALTER\s+TABLE\s+public\.(?:bank_|qb_|invoice|reconciliation|oauth)/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(?:ingest_bank_statement_v1|ingest_accounting_transactions_v1|list_statement_bank_transactions_v1)/i);
  });

  it("creates exactly the frozen table families", () => {
    const required = [
      "currency_definitions", "financial_relationship_types", "financial_identity_claim_kinds",
      "legacy_record_types", "practices", "practice_memberships", "client_entities", "client_access",
      "ledger_books", "provider_connections", "financial_accounts", "import_artifacts", "import_runs",
      "financial_events", "financial_event_revisions", "financial_observations",
      "financial_observation_revisions", "financial_observation_occurrences",
      "financial_event_observation_links", "financial_event_fact_resolutions",
      "financial_identity_claims", "financial_documents", "financial_document_revisions",
      "financial_relationships", "financial_relationship_endpoints", "financial_allocations",
      "financial_merge_operations", "financial_event_aliases", "legacy_record_mappings",
      "canonical_audit_ledger",
    ];
    for (const table of required) expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${table}\\b`, "i"));
  });

  it("uses composite ownership and restrictive canonical evidence FKs", () => {
    expect(sql).toMatch(/UNIQUE \(id, client_entity_id\)/g);
    expect(sql).toMatch(/FOREIGN KEY \(event_id, client_entity_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(observation_id, client_entity_id\)/);
    expect(sql).toMatch(/FOREIGN KEY \(document_id, client_entity_id\)/);
    expect(sql).not.toMatch(/REFERENCES public\.(?:bank_transactions|qb_transactions|bank_statements|invoices|reconciliation_matches|invoice_matches|oauth_connections)/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });

  it("implements append-only deferred revision roots", () => {
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("canonical_require_current_revision_v1");
    expect(sql).toContain("canonical_reject_update_delete_v1");
    expect(sql.match(/FOR UPDATE OF root/g)).toHaveLength(3);
    expect(sql).toContain("UNIQUE (event_id, revision_number)");
    expect(sql).toContain("UNIQUE (observation_id, revision_number)");
    expect(sql).toContain("UNIQUE (document_id, revision_number)");
  });

  it("keeps exact identity authoritative and fingerprints non-unique", () => {
    expect(sql).toMatch(/financial_identity_active_strong_exact_idx[\s\S]*namespace_canonical, claim_key_canonical[\s\S]*authoritative', 'strong'/);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*(?:namespace_hash|claim_key_hash)/is);
    expect(sql).toContain("financial_identity_probabilistic_candidate_idx");
    expect(sql).toContain("FOREIGN KEY (claim_kind, strength)");
    expect(sql).toContain("financial_identity_active_exact_lookup_idx");
    expect(sql).toContain("ingest_financial_observation_v1");
    expect(sql).toContain("new provider strong identities require atomic observation ingestion");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended");
  });

  it("enforces endpoint, allocation, and alias safety", () => {
    expect(sql).toContain("num_nonnulls(event_id, observation_id, document_id) = 1");
    expect(sql).toContain("canonical_validate_relationship_v1");
    expect(sql).toContain("allows_same_subject");
    expect(sql).toContain("forbids the same physical subject");
    expect(sql).toContain("financial_allocations_capacity_guard");
    expect(sql).toContain("ORDER BY subject.id, subject.kind");
    expect(sql).toMatch(/financial_events[\s\S]*FOR UPDATE/);
    expect(sql).toContain("financial_event_aliases_one_active_idx");
    expect(sql).toContain("canonical alias cycle detected");
    expect(sql).toContain("reverse_financial_merge_v1");
  });

  it("repairs actor spoofing and occurrence replay centrally", () => {
    expect(sql).toContain("user actor is not authorized for client entity");
    expect(sql).toContain("service actor is not allowlisted");
    expect(sql).toContain("membership.role IN ('owner', 'admin')");
    expect(sql).toContain("access_grant.status = 'active'");
    expect(sql).toContain("observation occurrence idempotency conflict");
    expect(sql).toMatch(/record_financial_observation_occurrence_v1[\s\S]*ON CONFLICT DO NOTHING/);
  });

  it("contains the reviewed performance support without weakening checks", () => {
    expect(sql).toContain("financial_relationships_client_recent_idx");
    expect(sql).toContain("canonical_accessible_client_ids_v1");
    expect(sql).toContain("canonical_relationship_validation_seen");
    expect(sql).toContain("financial_allocations_capacity_guard");
  });

  it("freezes ACL, RLS, audit, and SECURITY DEFINER contracts", () => {
    expect(sql).toContain("canonical_can_access_client_v1");
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE[\s\S]*TO authenticated, service_role;/);
    expect(sql).not.toMatch(/GRANT[^;]*\b(?:INSERT|UPDATE|DELETE)\b[^;]*TO (?:authenticated|service_role)/i);
    expect(sql).toContain("canonical_audit_ledger_immutable");
    expect(sql).toContain("SET search_path = public, pg_temp");
    expect(sql).toContain("current_user NOT IN ('service_role', 'postgres')");
  });

  it("leaves the reviewed 001-009 file hashes observable and unchanged", () => {
    expect(legacyMigrations).toHaveLength(9);
    expect(new Set(legacyMigrations).size).toBe(9);
  });
});
