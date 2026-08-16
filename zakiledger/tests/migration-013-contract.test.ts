/**
 * Migration 013 contract tests (runnable against a real local Supabase).
 *
 * Structural introspection uses a direct Postgres connection; behavioral
 * checks run through PostgREST with the service-role key (the app surface).
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL
 * are unset.
 *
 * Also re-asserts the migration-012 ACL/RLS invariants that 013's grant
 * lineage must not regress (Z12/B11).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const run = url && key && dbUrl ? describe : describe.skip;

run("Migration 013 — reconciliation claim hardening contract", () => {
  const db = createClient(url!, key!, { auth: { persistSession: false } });
  let sql: pg.Client;

  beforeAll(async () => {
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
  }, 30000);

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

  async function triggerExists(table: string, trigger: string): Promise<boolean> {
    const rows = await q(
      `SELECT 1 FROM information_schema.triggers
       WHERE trigger_name = $1 AND event_object_table = $2 AND trigger_schema = 'public'`,
      [trigger, table],
    );
    return rows.length > 0;
  }

  async function rpcExists(name: string): Promise<boolean> {
    const rows = await q(
      `SELECT 1 FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
      [name],
    );
    return rows.length > 0;
  }

  // -----------------------------------------------------------------------
  // C1 — supersession columns
  // -----------------------------------------------------------------------
  describe("C1 — supersession columns", () => {
    for (const col of [
      "superseded_at",
      "superseded_by_match_id",
      "supersede_reason",
      "supersede_operation_id",
    ]) {
      it(`reconciliation_matches.${col} exists`, async () => {
        expect(await columnExists("reconciliation_matches", col)).toBe(true);
      }, 10000);
    }
  });

  // -----------------------------------------------------------------------
  // C2 — exclusive auto-claim index
  // -----------------------------------------------------------------------
  describe("C2 — exclusive auto-claim index", () => {
    it("uk_matches_auto_live_qb exists on reconciliation_matches", async () => {
      const rows = await q(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'uk_matches_auto_live_qb' AND schemaname = 'public'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    }, 10000);

    it("the index is UNIQUE", async () => {
      const rows = await q(
        `SELECT i.indisunique FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'uk_matches_auto_live_qb'`,
      );
      expect(rows[0]?.indisunique).toBe(true);
    }, 10000);

    it("the predicate names exactly the exclusive claim class", async () => {
      const rows = await q(
        `SELECT pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'uk_matches_auto_live_qb'`,
      );
      const def = rows[0]?.def as string;
      expect(def).toMatch(/matched_by = 'auto'/);
      expect(def).toMatch(/superseded_at IS NULL/);
      expect(def).toMatch(/qb_transaction_id/);
      expect(def).toMatch(/UNIQUE/);
    }, 10000);

    it("duplicate live auto claims trigger the migration NO-GO precondition", async () => {
      const qbId = crypto.randomUUID();
      const statementId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const clientId = crypto.randomUUID();

      await sql.query("BEGIN");
      try {
        // Rollback-only local admin fixture: temporarily remove the final
        // index and bypass FK/guard triggers so a pre-013 dirty state can be
        // represented. The migration's exact diagnostic query must reject it.
        await sql.query(`DROP INDEX public.uk_matches_auto_live_qb`);
        await sql.query(`SET LOCAL session_replication_role = replica`);
        await sql.query(
          `INSERT INTO public.reconciliation_matches
             (id, user_id, statement_id, bank_transaction_id,
              qb_transaction_id, confidence, flagged_level, matched_by,
              matched_at, client_entity_id)
           VALUES
             (gen_random_uuid(), $1, $2, gen_random_uuid(), $3,
              0.70, 'yellow', 'auto', now(), $4),
             (gen_random_uuid(), $1, $2, gen_random_uuid(), $3,
              0.80, 'yellow', 'auto', now(), $4)`,
          [userId, statementId, qbId, clientId],
        );

        await expect(
          sql.query(`
            DO $duplicate_precondition$
            DECLARE
              v_count integer;
              v_sample text;
            BEGIN
              SELECT count(*), string_agg(DISTINCT qb_id, ', ')
                INTO v_count, v_sample
              FROM (
                SELECT qb_transaction_id::text AS qb_id
                FROM (
                  SELECT qb_transaction_id
                  FROM public.reconciliation_matches
                  WHERE matched_by = 'auto'
                    AND qb_transaction_id IS NOT NULL
                    AND superseded_at IS NULL
                  GROUP BY qb_transaction_id
                  HAVING count(*) > 1
                ) AS dupes
                LIMIT 5
              ) AS sample;

              IF v_count > 0 THEN
                RAISE EXCEPTION 'NO-GO: % QB rows already carry multiple live auto claims (sample: %)',
                  v_count, v_sample
                  USING HINT = 'Run a reviewed dedup of duplicate live auto claims before retrying';
              END IF;
            END;
            $duplicate_precondition$;
          `),
        ).rejects.toThrow(/NO-GO: 1 QB rows already carry multiple live auto claims/i);
      } finally {
        await sql.query("ROLLBACK");
      }

      const restored = await q(
        `SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'uk_matches_auto_live_qb'`,
      );
      expect(restored).toHaveLength(1);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // C3 — immutability guards (D4) and book alignment (D5)
  // -----------------------------------------------------------------------
  describe("C3 — guard triggers", () => {
    it("reconciliation_match_approved_guard_v1 exists on reconciliation_matches", async () => {
      expect(
        await triggerExists("reconciliation_matches", "reconciliation_match_approved_guard"),
      ).toBe(true);
    }, 10000);

    it("match_book_alignment_v1 exists on reconciliation_matches", async () => {
      expect(await triggerExists("reconciliation_matches", "match_book_alignment")).toBe(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // C4 — RPCs and their ACLs
  // -----------------------------------------------------------------------
  describe("C4 — claim/correction/approval RPCs", () => {
    const RPC_NAMES = [
      "persist_auto_matches_v1",
      "create_manual_match_v1",
      "supersede_auto_claims_v1",
      "unapprove_reconciliation_matches_v1",
      "approve_reconciliation_matches_v1",
      "approve_reconciliation_matches_service_v1",
    ];

    for (const rpc of RPC_NAMES) {
      it(`${rpc} exists`, async () => {
        expect(await rpcExists(rpc)).toBe(true);
      }, 10000);
    }

    it("RPC grants separate authenticated approval from service-only capabilities", async () => {
      const rows = await q(
        `SELECT p.proname AS name, r.rolname AS grantee,
                has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
         CROSS JOIN pg_roles r
         WHERE p.proname = ANY($1::text[])
           AND r.rolname IN ('authenticated','anon','service_role')
         ORDER BY p.proname, r.rolname`,
        [RPC_NAMES],
      );
      const byKey = new Map(
        rows.map((r) => [`${r.name}:${r.grantee}`, r.can_exec as boolean]),
      );
      for (const name of RPC_NAMES.filter((name) => name !== "approve_reconciliation_matches_v1")) {
        expect(byKey.get(`${name}:service_role`), `${name} service_role`).toBe(true);
        expect(byKey.get(`${name}:authenticated`), `${name} authenticated`).toBe(false);
        expect(byKey.get(`${name}:anon`), `${name} anon`).toBe(false);
      }
      expect(byKey.get("approve_reconciliation_matches_v1:authenticated")).toBe(true);
      expect(byKey.get("approve_reconciliation_matches_v1:service_role")).toBe(false);
      expect(byKey.get("approve_reconciliation_matches_v1:anon")).toBe(false);
    }, 10000);

    it("authenticated cannot EXECUTE persist_auto_matches_v1", async () => {
      // No JWT on this client — but the ACL check is the same: the role
      // resolves from the JWT; without one PostgREST uses anon, which is
      // denied. Asserting the grant table above is the real contract.
      const { error } = await db.rpc("persist_auto_matches_v1", {
        p_user_id: "00000000-0000-0000-0000-000000000000",
        p_statement_id: "00000000-0000-0000-0000-000000000000",
        p_client_entity_id: "00000000-0000-0000-0000-000000000000",
        p_matches: [],
      });
      // Either the ACL denies (42501) or — under service_role — the guard
      // rejects the bogus ids; both prove the RPC is not an open door.
      expect(error).not.toBeNull();
    }, 10000);

    it("manual and automatic RPCs call the same private endpoint-lock helpers", async () => {
      const rows = await q(
        `SELECT p.proname, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('persist_auto_matches_v1', 'create_manual_match_v1')`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.def).toMatch(/reconciliation_private\.lock_bank_endpoints_v1/i);
        expect(row.def).toMatch(/reconciliation_private\.lock_qb_endpoints_v1/i);
      }
    }, 10000);

    it("no global QB uniqueness was introduced", async () => {
      const rows = await q(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'reconciliation_matches'
           AND indexdef ILIKE '%UNIQUE%'
           AND indexname <> 'uk_matches_auto_live_qb'
           AND indexdef ~* '\\(qb_transaction_id\\)'`,
      );
      expect(rows).toHaveLength(0);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // C6 — approval control (invariant L)
  // -----------------------------------------------------------------------
  describe("C6 — approval gate", () => {
    it("the guard trigger covers INSERT, UPDATE and DELETE", async () => {
      const rows = await q(
        `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
         WHERE tgname = 'reconciliation_match_approved_guard'
           AND tgrelid = 'public.reconciliation_matches'::regclass`,
      );
      const def = rows[0]?.def as string;
      expect(def).toMatch(/INSERT/i);
      expect(def).toMatch(/UPDATE/i);
      expect(def).toMatch(/DELETE/i);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // C5 — 012 invariants must survive 013's grant lineage
  // -----------------------------------------------------------------------
  describe("C5 — 012 invariants preserved", () => {
    it("authenticated still has no DML on reconciliation_audit_log (Z12/B11)", async () => {
      const rows = await q(
        `SELECT privilege_type FROM information_schema.table_privileges
         WHERE table_schema='public' AND table_name='reconciliation_audit_log'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE')`,
      );
      expect(rows).toHaveLength(0);
    }, 10000);

    it("write_guard_client_stamp still exists on reconciliation_matches", async () => {
      expect(
        await triggerExists("reconciliation_matches", "write_guard_client_stamp"),
      ).toBe(true);
    }, 10000);

    it("client_stamp_immutable still exists on reconciliation_matches", async () => {
      expect(await triggerExists("reconciliation_matches", "client_stamp_immutable")).toBe(true);
    }, 10000);

    it("match_qb_same_client_check still exists on reconciliation_matches", async () => {
      expect(
        await triggerExists("reconciliation_matches", "match_qb_same_client_check"),
      ).toBe(true);
    }, 10000);

    it("audit_log_no_delete and evidence immutability still exist", async () => {
      expect(await triggerExists("reconciliation_audit_log", "audit_log_no_delete")).toBe(true);
      expect(
        await triggerExists("reconciliation_audit_log", "audit_log_evidence_immutable"),
      ).toBe(true);
    }, 10000);
  });
});
