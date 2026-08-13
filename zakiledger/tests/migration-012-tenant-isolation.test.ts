/**
 * Two-tenant isolation attacks — executed against the local Supabase stack
 * with REAL authenticated users (Auth admin API + password sign-in) and their
 * JWTs over PostgREST. Runs only when local env vars are set.
 *
 * Surface notes (migration 009/012):
 *  - bank_statements / bank_transactions / qb_transactions grant DML only to
 *    service_role; authenticated REST reads/writes are denied outright (42501)
 *    = fail-closed by ACL before RLS.
 *  - reconciliation_matches / reports / decisions grant ALL to authenticated +
 *    RLS (auth.uid() = user_id): cross-tenant rows invisible, own rows allowed.
 *  - reconciliation_audit_log: authenticated SELECT own rows only; DML denied.
 *  - ingest_bank_statement_v1 is service_role-only; tenant forgery is tested
 *    through the server surface (service_role key, forged stamps).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { setupTwoTenants, TenantUser } from "./helpers/tenant-setup";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const run = url && key ? describe : describe.skip;

run("Two-tenant isolation (real local Auth + PostgREST)", () => {
  let svc: SupabaseClient;
  let a: TenantUser;
  let b: TenantUser;
  let aClient: SupabaseClient;
  let bClient: SupabaseClient;

  // Fixtures for B
  let bStmtId: string;
  let bBtId: string;
  let bQtId: string;
  let bMatchId: string;
  // Fixtures for A (valid A->A ops)
  let aStmtId: string;
  let aBtId: string;
  let aQtId: string;

  // Unique run prefix so reruns never collide with leftover fixtures
  const runId = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0").slice(-8);
  const uuid = (n: number) =>
    `${runId}-0000-0000-0000-${String(n).padStart(12, "0")}`;

  // bank tables grant no privileges to authenticated (migration 009): REST
  // access is denied outright. We accept the ACL denial as fail-closed.
  const isAclDenied = (error: any) =>
    error !== null && /permission denied|42501/i.test(error.message ?? "");

  beforeAll(async () => {
    const tenants = await setupTwoTenants();
    a = tenants.a;
    b = tenants.b;
    svc = createClient(url!, key!, { auth: { persistSession: false } });
    aClient = createClient(url!, key!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${a.jwt}` } },
    });
    bClient = createClient(url!, key!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${b.jwt}` } },
    });

    // Seed B's data as service_role with B's canonical stamps
    const bStmt = await svc.from("bank_statements").insert({
      id: uuid(9001), user_id: b.id, file_format: "csv",
      client_entity_id: b.client_entity_id, ledger_book_id: b.ledger_book_id,
    }).select().single();
    if (bStmt.error) throw bStmt.error;
    bStmtId = bStmt.data.id;

    const bBt = await svc.from("bank_transactions").insert({
      id: uuid(9002), statement_id: bStmtId, user_id: b.id,
      transaction_date: "2025-01-01", amount: 200,
      client_entity_id: b.client_entity_id,
    }).select().single();
    if (bBt.error) throw bBt.error;
    bBtId = bBt.data.id;

    const bQt = await svc.from("qb_transactions").insert({
      id: uuid(9003), user_id: b.id, posted_date: "2025-01-01", amount: 200,
      client_entity_id: b.client_entity_id, ledger_book_id: b.ledger_book_id,
    }).select().single();
    if (bQt.error) throw bQt.error;
    bQtId = bQt.data.id;

    const bMatch = await svc.from("reconciliation_matches").insert({
      id: uuid(9004), user_id: b.id, statement_id: bStmtId,
      bank_transaction_id: bBtId, qb_transaction_id: bQtId,
      matched_by: "auto", client_entity_id: b.client_entity_id,
      flagged_level: "green",
    }).select().single();
    if (bMatch.error) throw bMatch.error;
    bMatchId = bMatch.data.id;

    // Seed A's own data for valid A->A checks
    const aStmt = await svc.from("bank_statements").insert({
      id: uuid(9101), user_id: a.id, file_format: "csv",
      client_entity_id: a.client_entity_id, ledger_book_id: a.ledger_book_id,
    }).select().single();
    if (aStmt.error) throw aStmt.error;
    aStmtId = aStmt.data.id;

    const aBt = await svc.from("bank_transactions").insert({
      id: uuid(9102), statement_id: aStmtId, user_id: a.id,
      transaction_date: "2025-01-01", amount: 100,
      client_entity_id: a.client_entity_id,
    }).select().single();
    if (aBt.error) throw aBt.error;
    aBtId = aBt.data.id;

    const aQt = await svc.from("qb_transactions").insert({
      id: uuid(9103), user_id: a.id, posted_date: "2025-01-01", amount: 100,
      client_entity_id: a.client_entity_id, ledger_book_id: a.ledger_book_id,
    }).select().single();
    if (aQt.error) throw aQt.error;
    aQtId = aQt.data.id;
  }, 60000);

  // ---------------------------------------------------------------------
  // A tries to READ B data
  // ---------------------------------------------------------------------
  describe("Read isolation", () => {
    it("A cannot read B statement (ACL/RLS fail-closed)", async () => {
      const { data, error } = await aClient
        .from("bank_statements").select("id").eq("id", bStmtId);
      if (isAclDenied(error)) return; // ACL denies authenticated entirely
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("A cannot read B match", async () => {
      const { data, error } = await aClient
        .from("reconciliation_matches").select("id").eq("id", bMatchId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("A cannot read B bank transaction (ACL/RLS fail-closed)", async () => {
      const { data, error } = await aClient
        .from("bank_transactions").select("id").eq("id", bBtId);
      if (isAclDenied(error)) return;
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // A tries to MUTATE B data
  // ---------------------------------------------------------------------
  describe("Mutate isolation", () => {
    it("A cannot UPDATE B match", async () => {
      const { data, error } = await aClient
        .from("reconciliation_matches")
        .update({ confidence: 0.99 })
        .eq("id", bMatchId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("A cannot DELETE B match", async () => {
      const { data, error } = await aClient
        .from("reconciliation_matches")
        .delete()
        .eq("id", bMatchId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
      // B's match must still exist
      const { data: still } = await svc
        .from("reconciliation_matches").select("id").eq("id", bMatchId);
      expect(still).toHaveLength(1);
    });

    it("A cannot UPDATE B statement (ACL/RLS fail-closed)", async () => {
      const { data, error } = await aClient
        .from("bank_statements")
        .update({ file_format: "xlsx" })
        .eq("id", bStmtId)
        .select();
      if (isAclDenied(error)) return;
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // A supplies B's client/book to ingestion (server surface, service_role)
  // ---------------------------------------------------------------------
  describe("Ingestion tenant forgery", () => {
    it("A's user_id + B stamps to ingest_bank_statement_v1 -> rejected (23514)", async () => {
      const { data, error } = await svc.rpc("ingest_bank_statement_v1", {
        p_user_id: a.id,
        p_statement: {
          id: uuid(9201),
          file_name: "forged.csv",
          file_format: "csv",
          source_provider: "bank-x",
          source_organisation_id: "org-x",
          source_account_id: "acct-x",
          source_artifact_hash: "artifact-forged-001",
          client_entity_id: b.client_entity_id,
          ledger_book_id: b.ledger_book_id,
        },
        p_transactions: [],
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/match user canonical|23514/i);
    });

    it("authenticated cannot EXECUTE ingest_bank_statement_v1 (service-only)", async () => {
      const { error } = await aClient.rpc("ingest_bank_statement_v1", {
        p_user_id: a.id,
        p_statement: {
          file_name: "x.csv",
          file_format: "csv",
          client_entity_id: a.client_entity_id,
          ledger_book_id: a.ledger_book_id,
        },
        p_transactions: [],
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied|42501/i);
    });

    it("A cannot read B's ledger_book via REST", async () => {
      const { data, error } = await aClient
        .from("ledger_books").select("id").eq("id", b.ledger_book_id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it("A cannot read B's client_entity via REST", async () => {
      const { data, error } = await aClient
        .from("client_entities").select("id").eq("id", b.client_entity_id);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // A uses B's transactions in a match
  // ---------------------------------------------------------------------
  describe("Cross-tenant transaction use", () => {
    it("A uses B bank_transaction in match -> rejected (composite FK)", async () => {
      const { error } = await aClient.from("reconciliation_matches").insert({
        id: uuid(9301), user_id: a.id, statement_id: aStmtId,
        bank_transaction_id: bBtId, matched_by: "auto",
        client_entity_id: a.client_entity_id, flagged_level: "green",
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/foreign key|not present|23503/i);
    });

    it("A uses B qb_transaction in match -> rejected (same-client trigger)", async () => {
      const { error } = await aClient.from("reconciliation_matches").insert({
        id: uuid(9302), user_id: a.id, statement_id: aStmtId,
        bank_transaction_id: aBtId, qb_transaction_id: bQtId,
        matched_by: "auto", client_entity_id: a.client_entity_id,
        flagged_level: "green",
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/same client|23514/i);
    });
  });

  // ---------------------------------------------------------------------
  // Forged IDs
  // ---------------------------------------------------------------------
  describe("Forged IDs", () => {
    it("forged statement ID in A bank_transaction -> rejected", async () => {
      const { error } = await aClient.from("bank_transactions").insert({
        id: uuid(9401), statement_id: uuid(9999), user_id: a.id,
        transaction_date: "2025-01-01", amount: 10,
        client_entity_id: a.client_entity_id,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/foreign key|not present|23503|permission denied|42501/i);
    });

    it("forged bank_transaction ID in A match -> rejected", async () => {
      const { error } = await aClient.from("reconciliation_matches").insert({
        id: uuid(9402), user_id: a.id, statement_id: aStmtId,
        bank_transaction_id: uuid(9998), matched_by: "auto",
        client_entity_id: a.client_entity_id, flagged_level: "green",
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/foreign key|not present|23503/i);
    });

    it("forged QB transaction ID in A match -> rejected", async () => {
      const { error } = await aClient.from("reconciliation_matches").insert({
        id: uuid(9403), user_id: a.id, statement_id: aStmtId,
        bank_transaction_id: aBtId, qb_transaction_id: uuid(9997),
        matched_by: "auto", client_entity_id: a.client_entity_id,
        flagged_level: "green",
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/same client|23514|foreign key|not present|23503/i);
    });

    it("forged match ID -> A cannot read it", async () => {
      const { data, error } = await aClient
        .from("reconciliation_matches").select("id").eq("id", uuid(9996));
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Authenticated direct audit DML — must fail (ACL REVOKE)
  // ---------------------------------------------------------------------
  describe("Audit log direct DML", () => {
    it("authenticated direct audit INSERT is denied", async () => {
      const { error } = await aClient.from("reconciliation_audit_log").insert({
        id: uuid(9501), reconciliation_match_id: uuid(9502),
        action: "match_approved", action_by: "test", action_at: new Date().toISOString(),
        user_id: a.id, client_entity_id: a.client_entity_id,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);
    });

    it("authenticated direct audit UPDATE is denied", async () => {
      const { data: audit } = await svc
        .from("reconciliation_audit_log").select("id").limit(1);
      const target = audit && audit.length ? (audit[0] as any).id : uuid(9500);
      const { error } = await aClient
        .from("reconciliation_audit_log").update({ action: "tampered" }).eq("id", target);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);
    });

    it("authenticated direct audit DELETE is denied", async () => {
      const { data: audit } = await svc
        .from("reconciliation_audit_log").select("id").limit(1);
      const target = audit && audit.length ? (audit[0] as any).id : uuid(9500);
      const { error } = await aClient
        .from("reconciliation_audit_log").delete().eq("id", target);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);
    });
  });

  // ---------------------------------------------------------------------
  // Valid A -> A operations succeed
  // ---------------------------------------------------------------------
  describe("Valid A->A operations", () => {
    it("A can read own statement via service-role surface", async () => {
      const { data, error } = await svc
        .from("bank_statements").select("id").eq("id", aStmtId).eq("user_id", a.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("A can read own bank_transaction via service-role surface", async () => {
      const { data, error } = await svc
        .from("bank_transactions").select("id").eq("id", aBtId).eq("user_id", a.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("A can create own match", async () => {
      const { data, error } = await aClient.from("reconciliation_matches").insert({
        id: uuid(9601), user_id: a.id, statement_id: aStmtId,
        bank_transaction_id: aBtId, qb_transaction_id: aQtId,
        matched_by: "manual", client_entity_id: a.client_entity_id,
        flagged_level: "green",
      }).select().single();
      expect(error).toBeNull();
      expect(data.id).toBe(uuid(9601));
    });

    it("A self-context RPC returns A's own client/ledger", async () => {
      const { data, error } = await aClient.rpc("canonical_default_tenant_context_for_self_v1");
      expect(error).toBeNull();
      // SETOF-returning function: PostgREST returns an array
      const row = Array.isArray(data) ? data[0] : data;
      expect(row.client_entity_id).toBe(a.client_entity_id);
      expect(row.internal_ledger_book_id).toBe(a.ledger_book_id);
    });
  });
});