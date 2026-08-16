/**
 * Reconciliation defect remediation — regression suite (D1–D6).
 *
 * Executed against the local Supabase stack with the service-role REST surface
 * (the app's real write path) plus a direct Postgres connection for seeding,
 * inspection, and cleanup. Skipped when local env vars are unset.
 *
 * These tests were written FIRST against the current schema (fresh reset,
 * migrations 001–012 only) where they fail — that failure is the defect
 * reproduction. After migration 013 + the store changes, every test passes
 * with no manual grants or harness patches.
 *
 * Mandatory-test map (from the remediation brief):
 *   01/02  concurrent double-claim / second writer fails safely     -> D1
 *   03     retry does not duplicate                                 -> D1
 *   04/05  weak reservation blocks exact candidate (repro) + supersede -> D2
 *   06     approved match never auto-superseded                     -> D2
 *   07     approved immutable through raw mutation                  -> D4
 *   08     authorized correction/unapprove path works               -> D4
 *   09     fresh reset requires no manual grants                    -> D3
 *   10     authenticated tenant cannot mutate another tenant        -> D3/tenant
 *   11     service/application role performs intended store ops     -> D3
 *   12     audit table remains protected                            -> D3/D4
 *   13     explicit manual many:1 not blocked by D1 protection      -> D1
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  approveMatches,
  computeAndPersistMatches,
  createManualMatch,
  rejectMatch,
  saveBankStatement,
  saveQbTransactions,
  unapproveMatches,
} from "../lib/reconciliation-store";
import { setupTwoTenants, type TenantUser } from "./helpers/tenant-setup";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const run = url && key && dbUrl ? describe : describe.skip;

const PERIOD_START = "2026-07-01";
const PERIOD_END = "2026-07-31";

function parsedTxn(
  date: string,
  description: string,
  amount: number,
): Parameters<typeof saveBankStatement>[3]["transactions"][number] {
  return {
    transactionDate: { value: date, confidence: 1.0, reason: "test" },
    postedDate: null,
    merchant: { value: description, confidence: 1.0, reason: "test" },
    description: { value: description, confidence: 1.0, reason: "test" },
    amount: { value: amount, confidence: 1.0, reason: "test" },
    currency: "GBP",
    transactionId: null,
    memo: null,
  };
}

async function newStatement(
  userId: string,
  tag: string,
  txns: ReturnType<typeof parsedTxn>[],
): Promise<string> {
  const meta = await saveBankStatement(userId, `${tag}.csv`, "csv", {
    transactions: txns,
    openingBalance: 0,
    closingBalance: 0,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    currency: "GBP",
  });
  return meta.id;
}

run("Reconciliation defect remediation regression (local Supabase)", () => {
  let svc: SupabaseClient;
  let sql: pg.Client;
  let a: TenantUser;
  let b: TenantUser;
  let aClient: SupabaseClient;

  const createdStatementIds: string[] = [];
  const createdQbIds: string[] = [];

  beforeAll(async () => {
    const tenants = await setupTwoTenants();
    a = tenants.a;
    b = tenants.b;
    svc = createClient(url!, key!, { auth: { persistSession: false } });
    aClient = createClient(url!, key!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${a.jwt}` } },
    });
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
  }, 60000);

  afterAll(async () => {
    // Best-effort cleanup: clear approval through the controlled path first,
    // then remove rows in FK order. Approved rows of BOTH tenants are
    // unapproved via the 013 correction RPC so a prior run's leftovers can
    // never pollute the next run's candidate pools. Audit rows are
    // append-only by design (012 no-delete trigger) and stay behind.
    try {
      for (const uid of [a.id, b.id]) {
        const approved = await sql.query(
          `SELECT id FROM public.reconciliation_matches
           WHERE user_id = $1 AND approved_at IS NOT NULL`,
          [uid],
        );
        const approvedIds = approved.rows.map((r) => r.id as string);
        if (approvedIds.length > 0) {
          const { error } = await svc.rpc("unapprove_reconciliation_matches_v1", {
            p_user_id: uid,
            p_match_ids: approvedIds,
          });
          if (error) console.warn("cleanup unapprove failed:", error.message);
        }
        await sql.query(`DELETE FROM public.reconciliation_matches WHERE user_id = $1`, [uid]);
      }
      await sql.query(
        `DELETE FROM public.bank_statement_transaction_observations WHERE statement_id = ANY($1::uuid[])`,
        [createdStatementIds],
      );
      await sql.query(
        `DELETE FROM public.bank_transactions WHERE statement_id = ANY($1::uuid[])`,
        [createdStatementIds],
      );
      await sql.query(`DELETE FROM public.bank_statements WHERE id = ANY($1::uuid[])`, [
        createdStatementIds,
      ]);
      if (createdQbIds.length > 0) {
        await sql.query(`DELETE FROM public.qb_transactions WHERE id = ANY($1::uuid[])`, [
          createdQbIds,
        ]);
      }
      await sql.query(`DELETE FROM public.ledger_books WHERE display_name LIKE '013-regression-%'`);
    } catch (err) {
      console.warn("defect-regression cleanup failed:", err);
    }
    await sql.end();
  }, 60000);

  async function q(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const res = await sql.query(text, params as never);
    return res.rows;
  }

  async function liveMatchesForQb(qbId: string): Promise<Record<string, unknown>[]> {
    return q(
      `SELECT id, superseded_at, matched_by, approved_at, confidence
       FROM public.reconciliation_matches
       WHERE qb_transaction_id = $1 AND superseded_at IS NULL`,
      [qbId],
    );
  }

  async function seedQbRow(
    userId: string,
    clientId: string,
    bookId: string,
    postedDate: string,
    amount: number,
    description: string,
  ): Promise<string> {
    const row = await q(
      `INSERT INTO public.qb_transactions
         (id, user_id, qb_transaction_id, posted_date, amount, description,
          client_entity_id, ledger_book_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [userId, `qb-${crypto.randomUUID()}`, postedDate, amount, description, clientId, bookId],
    );
    createdQbIds.push(row[0].id as string);
    return row[0].id as string;
  }

  // =====================================================================
  // D3 — fresh-reset privilege lineage + full store round-trip (tests 09, 11)
  // =====================================================================
  describe("D3: grants + service-role store round-trip (no manual grants)", () => {
    async function granteePrivileges(table: string, grantee: string): Promise<string[]> {
      const rows = await q(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema='public' AND table_name=$1 AND grantee=$2
         ORDER BY privilege_type`,
        [table, grantee],
      );
      return rows.map((r) => r.privilege_type as string);
    }

    it("09a: service_role holds required DML on all reconciliation tables", async () => {
      for (const table of [
        "reconciliation_matches",
        "reconciliation_reports",
        "reconciliation_decisions",
        "reconciliation_audit_log",
      ]) {
        const privs = await granteePrivileges(table, "service_role");
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(privs, `${table} service_role ${p}`).toContain(p);
        }
      }
      const pref = await granteePrivileges("user_merchant_preferences", "service_role");
      expect(pref).toEqual(expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]));
    });

    it("09b: authenticated holds ALL+RLS on matches/reports/decisions, SELECT-only on audit", async () => {
      for (const table of [
        "reconciliation_matches",
        "reconciliation_reports",
        "reconciliation_decisions",
      ]) {
        const privs = await granteePrivileges(table, "authenticated");
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(privs, `${table} authenticated ${p}`).toContain(p);
        }
      }
      const audit = await granteePrivileges("reconciliation_audit_log", "authenticated");
      expect(audit).toContain("SELECT");
      expect(audit).not.toContain("INSERT");
      expect(audit).not.toContain("UPDATE");
      expect(audit).not.toContain("DELETE");
    });

    it("09c: anon holds no privileges on reconciliation tables", async () => {
      for (const table of [
        "reconciliation_matches",
        "reconciliation_reports",
        "reconciliation_decisions",
        "reconciliation_audit_log",
      ]) {
        const privs = await granteePrivileges(table, "anon");
        expect(privs, table).toEqual([]);
      }
    });

    it("11: full store round-trip works through the app surface with no manual grants", async () => {
      const statementId = await newStatement(a.id, "d3-roundtrip", [
        parsedTxn("2026-07-15", "Roundtrip Co", 100),
      ]);
      createdStatementIds.push(statementId);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Roundtrip Co");

      const result = await computeAndPersistMatches(a.id, statementId);
      expect(result.matches).toHaveLength(1);
      const matchId = result.matches[0].id;

      await approveMatches(a.id, statementId, [matchId], a.email);
      await unapproveMatches(a.id, statementId, [matchId]);
      await approveMatches(a.id, statementId, [matchId], a.email);
      await rejectMatch(a.id, statementId, matchId).catch((e: unknown) => {
        // approved rows are immutable — reject must refuse; that IS the safe path
        expect(String((e as Error).message)).toMatch(/approved/i);
      });
      // controlled unapprove then reject completes the lifecycle
      await unapproveMatches(a.id, statementId, [matchId]);
      await rejectMatch(a.id, statementId, matchId);
      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(0);

      // Remove the QB row too so later suites' candidate pools stay clean.
      await sql.query(`DELETE FROM public.qb_transactions WHERE id = $1`, [qbId]);
      const idx = createdQbIds.indexOf(qbId);
      if (idx >= 0) createdQbIds.splice(idx, 1);
    }, 60000);
  });

  // =====================================================================
  // D1 — exclusive auto 1:1 claim (tests 01, 02, 03, 13)
  // =====================================================================
  describe("D1: concurrent auto workers cannot double-claim one QB row", () => {
    let d1Stmt1: string;
    let d1Stmt2: string;
    let d1QbId: string;

    it("01/02: two concurrent workers — exactly one live claim, loser gets a clean unmatched result", async () => {
      const stmt1 = await newStatement(a.id, "d1-w1", [
        parsedTxn("2026-07-15", "Shared Co", 100),
      ]);
      const stmt2 = await newStatement(a.id, "d1-w2", [
        parsedTxn("2026-07-15", "Shared Co", 100),
      ]);
      createdStatementIds.push(stmt1, stmt2);
      d1Stmt1 = stmt1;
      d1Stmt2 = stmt2;
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Shared Co");
      d1QbId = qbId;

      const [r1, r2] = await Promise.allSettled([
        computeAndPersistMatches(a.id, stmt1),
        computeAndPersistMatches(a.id, stmt2),
      ]);
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");
      const p1 = r1.status === "fulfilled" ? r1.value : null;
      const p2 = r2.status === "fulfilled" ? r2.value : null;
      const totalMatches = (p1!.matches.length ?? 0) + (p2!.matches.length ?? 0);
      expect(totalMatches).toBe(1);

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].matched_by).toBe("auto");
      expect(live[0].approved_at).toBeNull();

      // The loser surfaced its bank row as unmatched — a review result, not corruption
      const loser = (p1!.matches.length === 0 ? p1 : p2)!;
      expect(loser.unmatchedBankIds).toHaveLength(1);
    }, 60000);

    it("03: retry of the losing worker does not create a duplicate claim", async () => {
      // Re-run against the loser's statement from test 01 (same user/QB pool).
      const rows = await q(
        `SELECT s.id AS stmt_id, m.bank_transaction_id, m.qb_transaction_id
         FROM public.reconciliation_matches m
         JOIN public.bank_statements s ON s.id = m.statement_id
         WHERE s.id IN ($1, $2) AND m.superseded_at IS NULL`,
        [d1Stmt1, d1Stmt2],
      );
      const live = rows[0];
      const loserStmt = live.stmt_id === d1Stmt1 ? d1Stmt2 : d1Stmt1;
      const retry = await computeAndPersistMatches(a.id, loserStmt);
      expect(retry.matches).toHaveLength(0);
      const stillLive = await liveMatchesForQb(d1QbId);
      expect(stillLive).toHaveLength(1);
    }, 60000);

    it("01b: the partial unique index rejects a second live auto claim at the DB layer", async () => {
      // Seed one live auto claim, then attempt a second one directly.
      const stmt1 = await newStatement(a.id, "d1-idx", [
        parsedTxn("2026-07-16", "Index Co", 42),
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-16", 42, "Index Co");
      const result = await computeAndPersistMatches(a.id, stmt1);
      expect(result.matches).toHaveLength(1);

      // A second statement + bank row targeting the same QB row
      const stmt2 = await newStatement(a.id, "d1-idx2", [
        parsedTxn("2026-07-16", "Index Co", 42),
      ]);
      createdStatementIds.push(stmt2);
      const bankRows = await q(
        `SELECT bt.id FROM public.bank_transactions bt
         JOIN public.bank_statements bs ON bs.id = bt.statement_id
         WHERE bs.id = $1`,
        [stmt2],
      );
      const { error } = await svc.from("reconciliation_matches").insert({
        id: crypto.randomUUID(),
        user_id: a.id,
        statement_id: stmt2,
        bank_transaction_id: bankRows[0].id as string,
        qb_transaction_id: qbId,
        confidence: 1.0,
        flagged_level: "green",
        matched_by: "auto",
        matched_at: new Date().toISOString(),
        client_entity_id: a.client_entity_id,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/duplicate key|23505|uk_matches_auto_live_qb/i);
      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
    }, 60000);

    it("13: explicit manual many:1 (two bank rows -> one QB row) is not blocked", async () => {
      const stmt1 = await newStatement(a.id, "d1-many1a", [
        parsedTxn("2026-07-17", "Split Co", 300),
      ]);
      const stmt2 = await newStatement(a.id, "d1-many1b", [
        parsedTxn("2026-07-18", "Split Co", 300),
      ]);
      createdStatementIds.push(stmt1, stmt2);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-17", 300, "Split Co");

      const bank1 = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [stmt1],
      );
      const bank2 = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [stmt2],
      );
      await createManualMatch(a.id, stmt1, bank1.rows[0].id as string, qbId);
      await createManualMatch(a.id, stmt2, bank2.rows[0].id as string, qbId);

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(2);
      expect(live.every((r) => r.matched_by === "manual")).toBe(true);
    }, 60000);
  });

  // =====================================================================
  // D2 — temporal stronger-evidence semantics (tests 04, 05, 06)
  // =====================================================================
  describe("D2: weak unapproved suggestions yield to materially stronger evidence", () => {
    it("04/05: exact later candidate supersedes a weak unapproved auto suggestion", async () => {
      // Run 1: weak (red, 60) suggestion claims the QB row.
      const stmt1 = await newStatement(a.id, "d2-weak", [
        parsedTxn("2026-07-15", "Exact Co", 500), // merchant+date only: 25+35=60 red
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Exact Co");

      const run1 = await computeAndPersistMatches(a.id, stmt1);
      expect(run1.matches).toHaveLength(1);
      const weak = run1.matches[0];
      expect(weak.flaggedLevel).toBe("red");

      // Run 2: exact (100) candidate arrives on a second statement.
      const stmt2 = await newStatement(a.id, "d2-exact", [
        parsedTxn("2026-07-15", "Exact Co", 100),
      ]);
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(1);
      const strong = run2.matches[0];
      expect(strong.qbTransactionId).toBe(qbId);
      expect(strong.flaggedLevel).toBe("green");

      // Old row preserved as superseded evidence — never deleted or rewritten.
      const oldRows = await q(
        `SELECT id, superseded_at, superseded_by_match_id, supersede_reason,
                supersede_operation_id, confidence, qb_transaction_id
         FROM public.reconciliation_matches WHERE id = $1`,
        [weak.id],
      );
      expect(oldRows).toHaveLength(1);
      const old = oldRows[0];
      expect(old.superseded_at).not.toBeNull();
      expect(old.superseded_by_match_id).toBe(strong.id);
      expect(old.supersede_reason).toBe("stronger_evidence");
      expect(old.supersede_operation_id).not.toBeNull();
      expect(Number(old.confidence)).toBeCloseTo(0.6);

      // Audit event records old/new relationship ids and scores.
      const audit = await q(
        `SELECT action, reconciliation_match_id, old_confidence, new_confidence, action_at
         FROM public.reconciliation_audit_log
         WHERE reconciliation_match_id = $1 AND action = 'match_superseded'`,
        [weak.id],
      );
      expect(audit).toHaveLength(1);
      expect(Number(audit[0].old_confidence)).toBeCloseTo(0.6);
      expect(Number(audit[0].new_confidence)).toBeCloseTo(1.0);
      expect(audit[0].action_at).not.toBeNull();

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(strong.id);
    }, 60000);

    it("04b: a sub-green later candidate does NOT supersede (deterministic floor)", async () => {
      const stmt1 = await newStatement(a.id, "d2-floor-w", [
        parsedTxn("2026-07-15", "Floor Co", 500),
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Floor Co");
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      expect(run1.matches).toHaveLength(1);
      const weakId = run1.matches[0].id;

      // Yellow candidate (85: amount+date+partial merchant) — below the 95 floor.
      const stmt2 = await newStatement(a.id, "d2-floor-y", [
        parsedTxn("2026-07-15", "Floor Supplies", 100),
      ]);
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(0);
      expect(run2.unmatchedBankIds).toHaveLength(1);

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(weakId);
    }, 60000);

    it("04c: a green unapproved claim is never superseded (equal candidates)", async () => {
      const stmt1 = await newStatement(a.id, "d2-green", [
        parsedTxn("2026-07-15", "Green Co", 100),
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Green Co");
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      expect(run1.matches).toHaveLength(1);
      const greenId = run1.matches[0].id;

      const stmt2 = await newStatement(a.id, "d2-green2", [
        parsedTxn("2026-07-15", "Green Co", 100),
      ]);
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(0);

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(greenId);
    }, 60000);

    it("06: an approved match is never auto-superseded", async () => {
      const stmt1 = await newStatement(a.id, "d2-appr", [
        parsedTxn("2026-07-15", "Approved Co", 500),
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Approved Co");
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      expect(run1.matches).toHaveLength(1);
      await approveMatches(a.id, stmt1, [run1.matches[0].id], a.email);

      const stmt2 = await newStatement(a.id, "d2-appr2", [
        parsedTxn("2026-07-15", "Approved Co", 100),
      ]);
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(0);

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(run1.matches[0].id);
      expect(live[0].approved_at).not.toBeNull();
      const supersededAudit = await q(
        `SELECT 1 FROM public.reconciliation_audit_log
         WHERE reconciliation_match_id = $1 AND action = 'match_superseded'`,
        [run1.matches[0].id],
      );
      expect(supersededAudit).toHaveLength(0);
    }, 60000);

    it("manual decision supersedes a live unapproved auto suggestion (sweep)", async () => {
      const stmt1 = await newStatement(a.id, "d2-sweep-w", [
        parsedTxn("2026-07-15", "Sweep Co", 500),
      ]);
      createdStatementIds.push(stmt1);
      const qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Sweep Co");
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      expect(run1.matches).toHaveLength(1);
      const autoId = run1.matches[0].id;

      const stmt2 = await newStatement(a.id, "d2-sweep-m", [
        parsedTxn("2026-07-15", "Sweep Co", 100),
      ]);
      createdStatementIds.push(stmt2);
      const bank2 = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [stmt2],
      );
      await createManualMatch(a.id, stmt2, bank2.rows[0].id as string, qbId);

      const oldRow = await q(
        `SELECT superseded_at, supersede_reason FROM public.reconciliation_matches WHERE id = $1`,
        [autoId],
      );
      expect(oldRow[0].superseded_at).not.toBeNull();
      expect(oldRow[0].supersede_reason).toBe("manual_override");

      const live = await liveMatchesForQb(qbId);
      expect(live).toHaveLength(1);
      expect(live[0].matched_by).toBe("manual");
    }, 60000);
  });

  // =====================================================================
  // D4 — approved-match immutability + controlled correction (tests 07, 08)
  // =====================================================================
  describe("D4: approved matches are immutable through raw table operations", () => {
    let statementId: string;
    let matchId: string;
    let qbId: string;

    beforeAll(async () => {
      statementId = await newStatement(a.id, "d4", [
        parsedTxn("2026-07-15", "Immutable Co", 100),
      ]);
      createdStatementIds.push(statementId);
      qbId = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 100, "Immutable Co");
      const result = await computeAndPersistMatches(a.id, statementId);
      expect(result.matches).toHaveLength(1);
      matchId = result.matches[0].id;
      await approveMatches(a.id, statementId, [matchId], a.email);
    }, 60000);

    it("07a: raw UPDATE of an approved match fails (42806)", async () => {
      const { error } = await svc
        .from("reconciliation_matches")
        .update({ confidence: 0.5 })
        .eq("id", matchId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    });

    it("07b: raw DELETE of an approved match fails (42806)", async () => {
      const { error } = await svc
        .from("reconciliation_matches")
        .delete()
        .eq("id", matchId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    });

    it("07c: raw repoint of an approved match to another QB row fails (42806)", async () => {
      // A real, valid same-client QB row — the meaningful repoint attack.
      const otherQb = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-15", 55, "Immutable Co");
      const { error } = await svc
        .from("reconciliation_matches")
        .update({ qb_transaction_id: otherQb })
        .eq("id", matchId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    });

    it("07d: authenticated raw UPDATE of its OWN approved match fails (42806)", async () => {
      const { error } = await aClient
        .from("reconciliation_matches")
        .update({ match_reason: "tampered" })
        .eq("id", matchId)
        .select();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    });

    it("07e: app manual override refuses to rewrite an approved match", async () => {
      const bankRows = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [statementId],
      );
      await expect(
        createManualMatch(a.id, statementId, bankRows.rows[0].id as string, qbId),
      ).rejects.toThrow(/approved/i);
    });

    it("08: the controlled unapprove path works and re-opens the row", async () => {
      const { data, error } = await svc.rpc("unapprove_reconciliation_matches_v1", {
        p_user_id: a.id,
        p_match_ids: [matchId],
      });
      expect(error).toBeNull();
      expect(data).not.toBeNull();

      // Row is cleared of approval...
      const row = await q(
        `SELECT approved_at, approved_by FROM public.reconciliation_matches WHERE id = $1`,
        [matchId],
      );
      expect(row[0].approved_at).toBeNull();
      expect(row[0].approved_by).toBeNull();

      // ...audited...
      const audit = await q(
        `SELECT action FROM public.reconciliation_audit_log
         WHERE reconciliation_match_id = $1 AND action = 'match_unapproved'
         ORDER BY action_at DESC LIMIT 1`,
        [matchId],
      );
      expect(audit).toHaveLength(1);

      // ...and editable again (re-match/approve lifecycle works).
      await approveMatches(a.id, statementId, [matchId], a.email);
      const approved = await q(
        `SELECT approved_at FROM public.reconciliation_matches WHERE id = $1`,
        [matchId],
      );
      expect(approved[0].approved_at).not.toBeNull();
    }, 60000);

    it("superseded rows are historical evidence — UPDATE and DELETE fail", async () => {
      // Seed a weak-then-strong supersession, then attack the superseded row.
      const stmt1 = await newStatement(a.id, "d4-super-w", [
        parsedTxn("2026-07-19", "Super Co", 500),
      ]);
      createdStatementIds.push(stmt1);
      const qb2 = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-07-19", 100, "Super Co");
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      const weakId = run1.matches[0].id;

      const stmt2 = await newStatement(a.id, "d4-super-s", [
        parsedTxn("2026-07-19", "Super Co", 100),
      ]);
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(1);

      const { error: upErr } = await svc
        .from("reconciliation_matches")
        .update({ confidence: 0.9 })
        .eq("id", weakId);
      expect(upErr).not.toBeNull();
      expect(upErr!.message).toMatch(/immutable|superseded|42806/i);

      const { error: delErr } = await svc
        .from("reconciliation_matches")
        .delete()
        .eq("id", weakId);
      expect(delErr).not.toBeNull();
      expect(delErr!.message).toMatch(/immutable|superseded|42806/i);
      void qb2;
    }, 60000);
  });

  // =====================================================================
  // D5 — ledger book boundary
  // =====================================================================
  describe("D5: match endpoints must belong to the same ledger book", () => {
    it("same-client/different-book match is rejected (23514)", async () => {
      const stmtId = await newStatement(a.id, "d5", [
        parsedTxn("2026-07-20", "Book Co", 100),
      ]);
      createdStatementIds.push(stmtId);

      // A second, distinct ledger book for the same client.
      const bookRow = await q(
        `INSERT INTO public.ledger_books
           (id, client_entity_id, book_kind, display_name, status)
         VALUES (gen_random_uuid(), $1, 'other', '013-regression-book-b', 'active')
         RETURNING id`,
        [a.client_entity_id],
      );
      const bookB = bookRow[0].id as string;
      const qbInBookB = await seedQbRow(a.id, a.client_entity_id, bookB, "2026-07-20", 100, "Book Co");

      const bankRows = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [stmtId],
      );
      const { error } = await svc.from("reconciliation_matches").insert({
        id: crypto.randomUUID(),
        user_id: a.id,
        statement_id: stmtId,
        bank_transaction_id: bankRows.rows[0].id as string,
        qb_transaction_id: qbInBookB,
        confidence: 1.0,
        flagged_level: "green",
        matched_by: "manual",
        matched_at: new Date().toISOString(),
        client_entity_id: a.client_entity_id,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/ledger book|23514/i);
    }, 60000);
  });

  // =====================================================================
  // D6 — manual override window
  // =====================================================================
  describe("D6: manual override may search outside the ±5-day window", () => {
    it("manual match succeeds against a QB row 40 days after the statement period", async () => {
      const stmtId = await newStatement(a.id, "d6", [
        parsedTxn("2026-07-20", "Late Co", 100),
      ]);
      createdStatementIds.push(stmtId);
      const qbLate = await seedQbRow(a.id, a.client_entity_id, a.ledger_book_id, "2026-09-10", 100, "Late Co");

      const bankRows = await sql.query(
        `SELECT bt.id FROM public.bank_transactions bt WHERE bt.statement_id = $1`,
        [stmtId],
      );
      const match = await createManualMatch(a.id, stmtId, bankRows.rows[0].id as string, qbLate);
      expect(match.qbTransactionId).toBe(qbLate);
    }, 60000);
  });

  // =====================================================================
  // Tenant isolation (test 10) + audit protection (test 12)
  // =====================================================================
  describe("tenant isolation + audit protection", () => {
    it("10: authenticated tenant A cannot mutate tenant B's approved match", async () => {
      // Seed B's approved match via the service surface.
      const stmtB = await newStatement(b.id, "d3-tenant-b", [
        parsedTxn("2026-07-21", "Tenant B Co", 100),
      ]);
      createdStatementIds.push(stmtB);
      const qbB = await seedQbRow(b.id, b.client_entity_id, b.ledger_book_id, "2026-07-21", 100, "Tenant B Co");
      const result = await computeAndPersistMatches(b.id, stmtB);
      expect(result.matches).toHaveLength(1);
      const bMatchId = result.matches[0].id;
      await approveMatches(b.id, stmtB, [bMatchId], b.email);

      // A (authenticated JWT) tries to mutate B's approved row.
      const { data, error } = await aClient
        .from("reconciliation_matches")
        .update({ confidence: 0.1 })
        .eq("id", bMatchId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(0); // RLS: invisible to A

      // B's row is untouched and still approved.
      const after = await q(
        `SELECT confidence, approved_at FROM public.reconciliation_matches WHERE id = $1`,
        [bMatchId],
      );
      expect(Number(after[0].confidence)).toBeCloseTo(1.0);
      expect(after[0].approved_at).not.toBeNull();
      void qbB;
    }, 60000);

    it("12: audit log stays trigger-protected after the 013 grants", async () => {
      const auditRow = await q(
        `SELECT id FROM public.reconciliation_audit_log ORDER BY action_at DESC LIMIT 1`,
      );
      expect(auditRow.length).toBeGreaterThan(0);

      const { error: upErr } = await svc
        .from("reconciliation_audit_log")
        .update({ action: "tampered" })
        .eq("id", auditRow[0].id);
      expect(upErr).not.toBeNull();
      expect(upErr!.message).toMatch(/immutable|42806/i);

      const { error: delErr } = await svc
        .from("reconciliation_audit_log")
        .delete()
        .eq("id", auditRow[0].id);
      expect(delErr).not.toBeNull();
      expect(delErr!.message).toMatch(/immutable|42806/i);

      const { error: insErr } = await aClient.from("reconciliation_audit_log").insert({
        id: crypto.randomUUID(),
        reconciliation_match_id: null,
        action: "match_approved",
        action_by: "attacker",
        action_at: new Date().toISOString(),
        user_id: a.id,
        client_entity_id: a.client_entity_id,
      });
      expect(insErr).not.toBeNull();
      expect(insErr!.message).toMatch(/permission denied/i);
    }, 60000);
  });
});
