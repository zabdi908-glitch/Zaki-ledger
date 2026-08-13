/**
 * Migration 012 contract tests (runnable against a real local Supabase).
 *
 * Structural introspection uses a direct Postgres connection (SUPABASE_DB_URL)
 * because PostgREST does not expose information_schema / pg_indexes.
 * Behavioral write-guard and immutability checks run through PostgREST with the
 * service-role key (or direct SQL when a role switch is required).
 *
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL are unset.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const run = url && key && dbUrl ? describe : describe.skip;

run("Migration 012 — reconciliation tenant spine contract", () => {
  const db = createClient(url!, key!, { auth: { persistSession: false } });
  const { Client } = pg;
  let sql: pg.Client;

  beforeAll(async () => {
    sql = new Client({ connectionString: dbUrl });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function q(text: string, params?: unknown[]): Promise<any[]> {
    const res = await sql.query(text, params as never);
    return res.rows;
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await q(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows.length > 0;
  }

  // -----------------------------------------------------------------------
  // Z1 — additive columns exist
  // -----------------------------------------------------------------------
  describe("Z1 — additive canonical columns", () => {
    const tables: Record<string, string[]> = {
      bank_statements: ["client_entity_id", "ledger_book_id"],
      bank_transactions: ["client_entity_id"],
      qb_transactions: ["client_entity_id", "ledger_book_id"],
      reconciliation_matches: ["client_entity_id"],
      reconciliation_reports: ["client_entity_id"],
      reconciliation_decisions: ["client_entity_id"],
      reconciliation_audit_log: ["client_entity_id", "user_id"],
    };

    for (const [table, columns] of Object.entries(tables)) {
      for (const col of columns) {
        it(`${table}.${col} exists`, async () => {
          expect(await columnExists(table, col)).toBe(true);
        }, 10000);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Z5 — composite FKs exist
  // -----------------------------------------------------------------------
  describe("Z5 — composite foreign keys", () => {
    const fks = [
      "fk_bank_transactions_statement_client",
      "fk_bank_statements_ledger_client",
      "fk_bank_statements_client",
      "fk_qb_transactions_ledger_client",
      "fk_qb_transactions_client",
      "fk_matches_statement_client",
      "fk_matches_bank_txn_client",
      "fk_matches_statement_bank_txn",
      "fk_reports_statement_client",
      "fk_decisions_statement_client",
    ];

    for (const fk of fks) {
      it(`FK ${fk} exists`, async () => {
        const rows = await q(
          `SELECT 1 FROM information_schema.table_constraints
           WHERE constraint_name = $1 AND constraint_schema = 'public'`,
          [fk],
        );
        expect(rows.length).toBeGreaterThan(0);
      }, 10000);
    }
  });

  // -----------------------------------------------------------------------
  // Z6 — audit log redesign
  // -----------------------------------------------------------------------
  describe("Z6 — audit log redesign", () => {
    it("reconciliation_match_id is nullable", async () => {
      const rows = await q(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='reconciliation_audit_log'
           AND column_name='reconciliation_match_id'`,
      );
      expect(rows[0]?.is_nullable).toBe("YES");
    }, 10000);

    it("user_id is NOT NULL", async () => {
      const rows = await q(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='reconciliation_audit_log'
           AND column_name='user_id'`,
      );
      expect(rows[0]?.is_nullable).toBe("NO");
    }, 10000);

    it("user_id FK is ON DELETE RESTRICT", async () => {
      const rows = await q(
        `SELECT delete_rule FROM information_schema.referential_constraints
         WHERE constraint_name = 'fk_audit_log_user' AND constraint_schema = 'public'`,
      );
      expect(rows[0]?.delete_rule).toBe("RESTRICT");
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Z8 — write-guard triggers exist
  // -----------------------------------------------------------------------
  describe("Z8 — write-guard triggers", () => {
    const rootTables = ["bank_statements", "qb_transactions"];
    const childTables = [
      "bank_transactions",
      "reconciliation_matches",
      "reconciliation_reports",
      "reconciliation_decisions",
    ];

    async function triggerExists(table: string, trigger: string): Promise<boolean> {
      const rows = await q(
        `SELECT 1 FROM information_schema.triggers
         WHERE trigger_name = $1 AND event_object_table = $2 AND trigger_schema = 'public'`,
        [trigger, table],
      );
      return rows.length > 0;
    }

    for (const table of rootTables) {
      it(`write_guard_root_stamp exists on ${table}`, async () => {
        expect(await triggerExists(table, "write_guard_root_stamp")).toBe(true);
      }, 10000);
    }

    for (const table of childTables) {
      it(`write_guard_client_stamp exists on ${table}`, async () => {
        expect(await triggerExists(table, "write_guard_client_stamp")).toBe(true);
      }, 10000);
    }

    it("audit_log_write_guard exists", async () => {
      expect(await triggerExists("reconciliation_audit_log", "audit_log_write_guard")).toBe(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Z9 — immutability triggers
  // -----------------------------------------------------------------------
  describe("Z9 — immutability triggers", () => {
    const stampTables = [
      "bank_statements",
      "bank_transactions",
      "qb_transactions",
      "reconciliation_matches",
      "reconciliation_reports",
      "reconciliation_decisions",
    ];

    async function triggerExists(table: string, trigger: string): Promise<boolean> {
      const rows = await q(
        `SELECT 1 FROM information_schema.triggers
         WHERE trigger_name = $1 AND event_object_table = $2 AND trigger_schema = 'public'`,
        [trigger, table],
      );
      return rows.length > 0;
    }

    for (const table of stampTables) {
      it(`client_stamp_immutable exists on ${table}`, async () => {
        expect(await triggerExists(table, "client_stamp_immutable")).toBe(true);
      }, 10000);
    }

    for (const table of ["bank_statements", "qb_transactions"]) {
      it(`ledger_book_id_immutable exists on ${table}`, async () => {
        expect(await triggerExists(table, "ledger_book_id_immutable")).toBe(true);
      }, 10000);
    }

    it("audit_log_evidence_immutable exists", async () => {
      expect(await triggerExists("reconciliation_audit_log", "audit_log_evidence_immutable")).toBe(true);
    }, 10000);

    it("audit_log_no_delete exists", async () => {
      expect(await triggerExists("reconciliation_audit_log", "audit_log_no_delete")).toBe(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Z10 — RPCs exist
  // -----------------------------------------------------------------------
  describe("Z10 — RPCs exist", () => {
    async function rpcExists(name: string): Promise<boolean> {
      const rows = await q(
        `SELECT 1 FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
        [name],
      );
      return rows.length > 0;
    }

    it("canonical_default_tenant_context_for_self_v1 exists", async () => {
      expect(await rpcExists("canonical_default_tenant_context_for_self_v1")).toBe(true);
    }, 10000);

    it("canonical_default_tenant_ids_v1 exists", async () => {
      expect(await rpcExists("canonical_default_tenant_ids_v1")).toBe(true);
    }, 10000);

    it("ingest_bank_statement_v1 exists", async () => {
      expect(await rpcExists("ingest_bank_statement_v1")).toBe(true);
    }, 10000);

    it("ingest_accounting_transactions_v1 exists", async () => {
      expect(await rpcExists("ingest_accounting_transactions_v1")).toBe(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Z12 — audit ACL/RLS
  // -----------------------------------------------------------------------
  describe("Z12 — audit ACL/RLS", () => {
    async function granteePrivilege(grantee: string, privilege: string): Promise<boolean> {
      const rows = await q(
        `SELECT 1 FROM information_schema.table_privileges
         WHERE table_schema='public' AND table_name='reconciliation_audit_log'
           AND grantee = $1 AND privilege_type = $2`,
        [grantee, privilege],
      );
      return rows.length > 0;
    }

    it("authenticated has no INSERT on reconciliation_audit_log", async () => {
      expect(await granteePrivilege("authenticated", "INSERT")).toBe(false);
    }, 10000);

    it("authenticated has no UPDATE on reconciliation_audit_log", async () => {
      expect(await granteePrivilege("authenticated", "UPDATE")).toBe(false);
    }, 10000);

    it("authenticated has no DELETE on reconciliation_audit_log", async () => {
      expect(await granteePrivilege("authenticated", "DELETE")).toBe(false);
    }, 10000);

    it("authenticated has no DML on reconciliation_audit_log (B11)", async () => {
      expect(await granteePrivilege("authenticated", "INSERT")).toBe(false);
      expect(await granteePrivilege("authenticated", "UPDATE")).toBe(false);
      expect(await granteePrivilege("authenticated", "DELETE")).toBe(false);
    }, 10000);

    it("service_role retains DML (trusted server path) per production ACL", async () => {
      expect(await granteePrivilege("service_role", "INSERT")).toBe(true);
      expect(await granteePrivilege("service_role", "UPDATE")).toBe(true);
      expect(await granteePrivilege("service_role", "DELETE")).toBe(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Z11 — read-path indexes
  // -----------------------------------------------------------------------
  describe("Z11 — read-path indexes", () => {
    const clientIdx = [
      "idx_bank_statements_client",
      "idx_bank_transactions_client",
      "idx_qb_transactions_client",
      "idx_reconciliation_matches_client",
      "idx_reconciliation_reports_client",
      "idx_reconciliation_decisions_client",
      "idx_reconciliation_audit_log_client",
    ];

    for (const idx of clientIdx) {
      it(`index ${idx} exists`, async () => {
        const rows = await q(
          `SELECT 1 FROM pg_indexes WHERE indexname = $1 AND schemaname = 'public'`,
          [idx],
        );
        expect(rows.length).toBeGreaterThan(0);
      }, 10000);
    }
  });

  // -----------------------------------------------------------------------
  // Write-guard rejection tests (service_role REST)
  // -----------------------------------------------------------------------
  describe("Write-guard — INSERT rejection", () => {
    it("R1: bank_statements INSERT without ledger_book_id is rejected", async () => {
      const { error } = await db.from("bank_statements").insert({
        id: "00000000-0000-0000-0000-000000000001",
        user_id: "00000000-0000-0000-0000-000000000000",
        file_format: "csv",
        client_entity_id: "00000000-0000-0000-0000-000000000002",
        // ledger_book_id intentionally missing
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/ledger_book_id|23502|reconciliation writes/i);
    }, 10000);

    it("R3: bank_statements INSERT with both stamps NULL is rejected", async () => {
      const { error } = await db.from("bank_statements").insert({
        id: "00000000-0000-0000-0000-000000000003",
        user_id: "00000000-0000-0000-0000-000000000000",
        file_format: "csv",
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/client_entity_id|23502|reconciliation writes/i);
    }, 10000);

    it("R9: bank_transactions INSERT without client_entity_id is rejected", async () => {
      const { error } = await db.from("bank_transactions").insert({
        id: "00000000-0000-0000-0000-000000000010",
        statement_id: "00000000-0000-0000-0000-000000000001",
        user_id: "00000000-0000-0000-0000-000000000000",
        transaction_date: "2025-01-01",
        amount: 100.0,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/client_entity_id|23502|reconciliation writes/i);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Audit evidence immutability (real row; service_role hits the triggers)
  // -----------------------------------------------------------------------
  describe("Audit evidence immutability", () => {
    let auditRowId: string;

    beforeAll(async () => {
      // user_id is FK -> auth.users (ON DELETE RESTRICT); create a real user.
      const testUserId = crypto.randomUUID();
      await sql.query(
        `INSERT INTO auth.users
           (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
            aud, role, created_at, updated_at, email_confirmed_at)
         VALUES ($1, $2, 'x', '{}'::jsonb, '{}'::jsonb, 'authenticated',
                 'authenticated', now(), now(), now())`,
        [testUserId, `audit-contract-${crypto.randomUUID()}@test.local`],
      );
      const { data, error } = await db
        .from("reconciliation_audit_log")
        .insert({
          id: crypto.randomUUID(),
          reconciliation_match_id: null,
          action: "match_approved",
          action_by: "contract-test",
          action_at: new Date().toISOString(),
          user_id: testUserId,
          client_entity_id: crypto.randomUUID(),
        })
        .select("id")
        .single();
      if (error) throw error;
      auditRowId = data.id;
    }, 10000);

    it("A12: UPDATE on audit evidence columns is rejected by trigger", async () => {
      const { error } = await db
        .from("reconciliation_audit_log")
        .update({ action: "tampered" })
        .eq("id", auditRowId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    }, 10000);

    it("A13: DELETE on audit log is rejected by trigger", async () => {
      const { error } = await db
        .from("reconciliation_audit_log")
        .delete()
        .eq("id", auditRowId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    }, 10000);

    it("A12b: audit log user_id stamp is immutable (trigger, not only ACL)", async () => {
      // service_role holds table-level UPDATE (trusted server path), so the
      // authenticated-ACL check lives in Z12 and the real-JWT isolation suite.
      // Here we prove the stamp-immutability trigger also blocks a stamp change.
      const { error } = await db
        .from("reconciliation_audit_log")
        .update({ user_id: crypto.randomUUID() })
        .eq("id", auditRowId)
        .select();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    }, 10000);
  });
});
