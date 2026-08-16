/**
 * Reconciliation approval control — regression suite (invariant L).
 *
 * A reconciliation match may enter the approved state only through the
 * controlled, audited path. Raw table UPDATEs (authenticated OR
 * service_role) must fail; the approval RPC must be atomic with its audit
 * evidence, idempotent, tenant-checked, and service-role-only.
 *
 * Executed against the local Supabase stack; skipped when env vars are
 * unset. Written test-first against migration 013 before the approval gate
 * existed — every DB case below fails there.
 *
 * Mandatory-test map:
 *   01-03 raw authenticated self-approval (approved_at / approved_by / both)
 *   04     foreign tenant raw approval
 *   05     controlled RPC succeeds for valid owner
 *   06     exactly one audit event
 *   07     approval + audit atomicity
 *   08     duplicate/retry deterministic, no duplicate audit
 *   09     superseded match cannot be approved
 *   10     approved match cannot be repointed/deleted afterward
 *   11     authorized unapprove/correction still works and is audited
 *   12     bulk approval uses the controlled path
 *   13     authenticated cannot invoke the service-only approval RPC
 *   14     anon cannot approve
 *   15     authenticated owner cannot approve a foreign tenant row
 *   16     approval boundary rejects a controlled wrong-client fixture
 *   17     approval boundary rejects a controlled wrong-book fixture
 *   18/19  approval boundary rejects both malformed state permutations
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  approveMatches,
  computeAndPersistMatches,
  saveBankStatement,
  saveQbTransactions,
  unapproveMatches,
} from "../lib/reconciliation-store";
import { setupTwoTenants, type TenantUser } from "./helpers/tenant-setup";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const run = url && key && anonKey && dbUrl ? describe : describe.skip;

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

run("Reconciliation approval control (local Supabase)", () => {
  let svc: SupabaseClient;
  let sql: pg.Client;
  let a: TenantUser;
  let b: TenantUser;
  let aClient: SupabaseClient;
  let anonClient: SupabaseClient;

  const createdStatementIds: string[] = [];

  beforeAll(async () => {
    const tenants = await setupTwoTenants();
    a = tenants.a;
    b = tenants.b;
    svc = createClient(url!, key!, { auth: { persistSession: false } });
    aClient = createClient(url!, key!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${a.jwt}` } },
    });
    anonClient = createClient(url!, anonKey!, { auth: { persistSession: false } });
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
  }, 60000);

  afterAll(async () => {
    try {
      for (const uid of [a.id, b.id]) {
        const approved = await sql.query(
          `SELECT id FROM public.reconciliation_matches
           WHERE user_id = $1 AND approved_at IS NOT NULL`,
          [uid],
        );
        const approvedIds = approved.rows.map((r) => r.id as string);
        if (approvedIds.length > 0) {
          await svc.rpc("unapprove_reconciliation_matches_v1", {
            p_user_id: uid,
            p_match_ids: approvedIds,
          });
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
      await sql.query(
        `DELETE FROM public.qb_transactions WHERE user_id = ANY($1::uuid[])`,
        [[a.id, b.id]],
      );
    } catch (err) {
      console.warn("approval-control cleanup failed:", err);
    }
    await sql.end();
  }, 60000);

  async function q(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const res = await sql.query(text, params as never);
    return res.rows;
  }

  /** One statement with one exact bank row + matching QB row -> one unapproved auto match. */
  async function seedUnapprovedMatch(
    userId: string,
    tag: string,
  ): Promise<{ statementId: string; matchId: string }> {
    const statementId = await (async () => {
      const meta = await saveBankStatement(userId, `${tag}.csv`, "csv", {
        transactions: [parsedTxn("2026-07-15", tag, 100)],
        openingBalance: 0,
        closingBalance: 0,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        currency: "GBP",
      });
      return meta.id;
    })();
    createdStatementIds.push(statementId);
    await saveQbTransactions(userId, [
      { postedDate: "2026-07-15", amount: 100, description: tag },
    ]);
    const result = await computeAndPersistMatches(userId, statementId);
    expect(result.matches).toHaveLength(1);
    return { statementId, matchId: result.matches[0].id };
  }

  async function approvalState(matchId: string): Promise<{ approved_at: unknown; approved_by: unknown }> {
    const rows = await q(
      `SELECT approved_at, approved_by FROM public.reconciliation_matches WHERE id = $1`,
      [matchId],
    );
    return rows[0] as { approved_at: unknown; approved_by: unknown };
  }

  async function auditCount(matchId: string, action: string): Promise<number> {
    const rows = await q(
      `SELECT count(*)::int AS n FROM public.reconciliation_audit_log
       WHERE reconciliation_match_id = $1 AND action = $2`,
      [matchId, action],
    );
    return rows[0].n as number;
  }

  async function matchEndpointIds(matchId: string): Promise<{
    qbId: string;
    statementId: string;
  }> {
    const rows = await q(
      `SELECT qb_transaction_id, statement_id
       FROM public.reconciliation_matches WHERE id = $1`,
      [matchId],
    );
    return {
      qbId: rows[0].qb_transaction_id as string,
      statementId: rows[0].statement_id as string,
    };
  }

  /**
   * Establish endpoint/state drift that normal writes correctly prohibit.
   * This is local-admin fixture setup only; triggers are bypassed for one
   * committed update so the real authenticated PostgREST/RPC path can be
   * attacked. Every call is paired with a finally restoration.
   */
  async function adminFixtureUpdate(sqlText: string, params: unknown[]): Promise<void> {
    await sql.query("BEGIN");
    try {
      await sql.query("SET LOCAL session_replication_role = replica");
      await sql.query(sqlText, params as never);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }
  }

  describe("raw authenticated approval attacks (tests 01-04)", () => {
    it("01: owner raw UPDATE approved_at NULL -> non-NULL fails", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 1");
      const { error } = await aClient
        .from("reconciliation_matches")
        .update({ approved_at: new Date().toISOString() })
        .eq("id", matchId)
        .select();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/approval|42806/i);
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
    }, 60000);

    it("02: owner raw UPDATE approved_by NULL -> own id fails", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 2");
      const { error } = await aClient
        .from("reconciliation_matches")
        .update({ approved_by: a.id })
        .eq("id", matchId)
        .select();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/approval|42806/i);
      const state = await approvalState(matchId);
      expect(state.approved_by).toBeNull();
    }, 60000);

    it("03: owner raw UPDATE of both approval fields fails", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 3");
      const { error } = await aClient
        .from("reconciliation_matches")
        .update({ approved_at: new Date().toISOString(), approved_by: a.id })
        .eq("id", matchId)
        .select();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/approval|42806/i);
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
      expect(state.approved_by).toBeNull();
    }, 60000);

    it("01b: even service_role raw approval-field UPDATE is blocked (DB gate, not just ACL)", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 1b");
      const { error } = await svc
        .from("reconciliation_matches")
        .update({ approved_at: new Date().toISOString(), approved_by: "system" })
        .eq("id", matchId);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/approval|42806/i);
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
    }, 60000);

    it("04: foreign tenant raw approval fails (RLS) and changes nothing", async () => {
      const { matchId } = await seedUnapprovedMatch(b.id, "ApprCtrl Co B");
      const { data, error } = await aClient
        .from("reconciliation_matches")
        .update({ approved_at: new Date().toISOString(), approved_by: a.id })
        .eq("id", matchId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(0); // invisible to A
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
    }, 60000);
  });

  describe("controlled approval path (tests 05-08)", () => {
    it("05: approval RPC succeeds for the valid owner", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 5");
      const { data, error } = await aClient.rpc("approve_reconciliation_matches_v1", {
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_operation_id: crypto.randomUUID(),
      });
      expect(error).toBeNull();
      const approved = (data as { approved?: string[] } | null)?.approved ?? [];
      expect(approved).toEqual([matchId]);

      const state = await approvalState(matchId);
      expect(state.approved_at).not.toBeNull();
      expect(state.approved_by).toBe(a.id);
    }, 60000);

    it("06: controlled approval creates exactly one audit event", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 6");
      const before = await auditCount(matchId, "match_approved");
      await svc.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_approved_by: a.email,
        p_operation_id: crypto.randomUUID(),
      });
      const after = await auditCount(matchId, "match_approved");
      expect(after).toBe(before + 1);

      const rows = await q(
        `SELECT action_by, old_confidence, new_confidence, action_at
         FROM public.reconciliation_audit_log
         WHERE reconciliation_match_id = $1 AND action = 'match_approved'`,
        [matchId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action_by).toBe(a.email);
      expect(Number(rows[0].old_confidence)).toBeCloseTo(1.0);
      expect(Number(rows[0].new_confidence)).toBeCloseTo(1.0);
      expect(rows[0].action_at).not.toBeNull();
    }, 60000);

    it("07: approval and audit are atomic — audit failure rolls the approval back", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 7");
      await sql.query(`
        CREATE OR REPLACE FUNCTION public.test_reject_approval_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.action = 'match_approved' THEN RAISE EXCEPTION 'forced audit failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_reject_approval_audit
        BEFORE INSERT ON public.reconciliation_audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_reject_approval_audit()
      `);
      try {
        const { error } = await svc.rpc("approve_reconciliation_matches_service_v1", {
          p_user_id: a.id,
          p_statement_id: statementId,
          p_match_ids: [matchId],
          p_approved_by: a.email,
          p_operation_id: crypto.randomUUID(),
        });
        expect(error).not.toBeNull();
        // The failure must be the audit insert itself — not a missing
        // function or an earlier guard.
        expect(error!.message).toMatch(/forced audit failure/i);
      } finally {
        await sql.query(`DROP TRIGGER IF EXISTS test_reject_approval_audit ON public.reconciliation_audit_log`);
        await sql.query(`DROP FUNCTION IF EXISTS public.test_reject_approval_audit()`);
      }
      // Rolled back: the match is still unapproved and no audit row exists.
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
      expect(await auditCount(matchId, "match_approved")).toBe(0);
    }, 60000);

    it("08: duplicate approval is deterministic and does not duplicate audit evidence", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 8");
      const retryOperationId = crypto.randomUUID();
      const first = await svc.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_approved_by: a.email,
        p_operation_id: retryOperationId,
      });
      expect(first.error).toBeNull();
      const second = await svc.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_approved_by: a.email,
        p_operation_id: retryOperationId,
      });
      expect(second.error).toBeNull();
      const secondData = second.data as { approved?: string[]; skipped?: string[] } | null;
      expect(secondData?.approved ?? []).toEqual([]);
      expect(secondData?.skipped ?? []).toEqual([matchId]);
      expect(await auditCount(matchId, "match_approved")).toBe(1);
    }, 60000);
  });

  describe("eligibility + immutability interplay (tests 09-11)", () => {
    it("09: a superseded match cannot be approved", async () => {
      // Weak holder on stmt1, exact candidate on stmt2 supersedes it.
      const stmt1 = await (async () => {
        const meta = await saveBankStatement(a.id, "ApprCtrl weak.csv", "csv", {
          transactions: [parsedTxn("2026-07-15", "ApprCtrl Sup Co", 500)],
          openingBalance: 0,
          closingBalance: 0,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          currency: "GBP",
        });
        return meta.id;
      })();
      createdStatementIds.push(stmt1);
      await saveQbTransactions(a.id, [
        { postedDate: "2026-07-15", amount: 100, description: "ApprCtrl Sup Co" },
      ]);
      const run1 = await computeAndPersistMatches(a.id, stmt1);
      const weakId = run1.matches[0].id;

      const stmt2 = await (async () => {
        const meta = await saveBankStatement(a.id, "ApprCtrl exact.csv", "csv", {
          transactions: [parsedTxn("2026-07-15", "ApprCtrl Sup Co", 100)],
          openingBalance: 0,
          closingBalance: 0,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          currency: "GBP",
        });
        return meta.id;
      })();
      createdStatementIds.push(stmt2);
      const run2 = await computeAndPersistMatches(a.id, stmt2);
      expect(run2.matches).toHaveLength(1);

      const { data, error } = await svc.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: stmt1,
        p_match_ids: [weakId],
        p_approved_by: a.email,
        p_operation_id: crypto.randomUUID(),
      });
      expect(error).toBeNull();
      const skipped = (data as { skipped?: string[] } | null)?.skipped ?? [];
      expect(skipped).toEqual([weakId]);
      const state = await approvalState(weakId);
      expect(state.approved_at).toBeNull();
      expect(await auditCount(weakId, "match_approved")).toBe(0);
    }, 60000);

    it("10: an approved match cannot be repointed or deleted afterward", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 10");
      await svc.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_approved_by: a.email,
        p_operation_id: crypto.randomUUID(),
      });

      // A real, valid same-client QB row — the meaningful repoint attack
      // (a bogus id would be caught by the same-client trigger first).
      await saveQbTransactions(a.id, [
        { postedDate: "2026-07-15", amount: 55, description: "ApprCtrl Co 10 Other" },
      ]);
      const otherQb = await q(
        `SELECT id FROM public.qb_transactions
         WHERE user_id = $1 AND amount = 55 ORDER BY posted_date DESC LIMIT 1`,
        [a.id],
      );
      const { error: repointErr } = await svc
        .from("reconciliation_matches")
        .update({ qb_transaction_id: otherQb[0].id as string })
        .eq("id", matchId);
      expect(repointErr).not.toBeNull();
      expect(repointErr!.message).toMatch(/immutable|42806/i);

      const { error: delErr } = await svc
        .from("reconciliation_matches")
        .delete()
        .eq("id", matchId);
      expect(delErr).not.toBeNull();
      expect(delErr!.message).toMatch(/immutable|42806/i);
    }, 60000);

    it("11: authorized unapprove/correction path still works and is audited", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 11");
      await approveMatches(a.id, statementId, [matchId], a.email);
      const before = await auditCount(matchId, "match_unapproved");

      const n = await unapproveMatches(a.id, statementId, [matchId]);
      expect(n).toBe(1);
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
      expect(state.approved_by).toBeNull();
      expect(await auditCount(matchId, "match_unapproved")).toBe(before + 1);
    }, 60000);
  });

  describe("bulk + role boundaries (tests 12-14)", () => {
    it("12: bulk approval through the store uses the controlled path", async () => {
      const statementId = await (async () => {
        const meta = await saveBankStatement(a.id, "ApprCtrl bulk.csv", "csv", {
          transactions: [
            parsedTxn("2026-07-15", "ApprCtrl Bulk A", 10),
            parsedTxn("2026-07-16", "ApprCtrl Bulk B", 20),
            parsedTxn("2026-07-17", "ApprCtrl Bulk C", 30),
          ],
          openingBalance: 0,
          closingBalance: 0,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          currency: "GBP",
        });
        return meta.id;
      })();
      createdStatementIds.push(statementId);
      await saveQbTransactions(a.id, [
        { postedDate: "2026-07-15", amount: 10, description: "ApprCtrl Bulk A" },
        { postedDate: "2026-07-16", amount: 20, description: "ApprCtrl Bulk B" },
        { postedDate: "2026-07-17", amount: 30, description: "ApprCtrl Bulk C" },
      ]);
      const result = await computeAndPersistMatches(a.id, statementId);
      expect(result.matches).toHaveLength(3);
      const ids = result.matches.map((m) => m.id);

      const report = await approveMatches(a.id, statementId, ids, a.email);
      expect(report.id).toBeTruthy();

      for (const id of ids) {
        const state = await approvalState(id);
        expect(state.approved_at, id).not.toBeNull();
        expect(await auditCount(id, "match_approved"), id).toBe(1);
      }
    }, 60000);

    it("13: authenticated cannot invoke the service-only approval RPC", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 13");
      const { error } = await aClient.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: a.id,
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_approved_by: a.email,
        p_operation_id: crypto.randomUUID(),
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/permission denied|42501/i);
      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
    }, 60000);

    it("14: anon cannot approve — RPC denied and raw UPDATE denied", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Co 14");

      const { error: rpcErr } = await anonClient.rpc("approve_reconciliation_matches_v1", {
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_operation_id: crypto.randomUUID(),
      });
      expect(rpcErr).not.toBeNull();

      const { error: updErr } = await anonClient
        .from("reconciliation_matches")
        .update({ approved_at: new Date().toISOString() })
        .eq("id", matchId);
      expect(updErr).not.toBeNull();
      expect(updErr!.message).toMatch(/permission denied|42501/i);

      const state = await approvalState(matchId);
      expect(state.approved_at).toBeNull();
    }, 60000);
  });

  describe("direct controlled-approval validation matrix (tests 15-19)", () => {
    it("15: authenticated owner cannot approve a foreign tenant match", async () => {
      const { statementId, matchId } = await seedUnapprovedMatch(b.id, "ApprCtrl Foreign 15");
      const { error } = await aClient.rpc("approve_reconciliation_matches_v1", {
        p_statement_id: statementId,
        p_match_ids: [matchId],
        p_operation_id: crypto.randomUUID(),
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/statement does not belong|23514/i);
      expect((await approvalState(matchId)).approved_at).toBeNull();
      expect(await auditCount(matchId, "match_approved")).toBe(0);
    }, 60000);

    it("16: correct owner is rejected when the QB endpoint belongs to another client", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Client 16");
      const { qbId, statementId } = await matchEndpointIds(matchId);

      await adminFixtureUpdate(
        `UPDATE public.qb_transactions
         SET client_entity_id = $2, ledger_book_id = $3
         WHERE id = $1`,
        [qbId, b.client_entity_id, b.ledger_book_id],
      );
      try {
        const { error } = await aClient.rpc("approve_reconciliation_matches_v1", {
          p_statement_id: statementId,
          p_match_ids: [matchId],
          p_operation_id: crypto.randomUUID(),
        });
        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/malformed|ineligible|23514/i);
        expect((await approvalState(matchId)).approved_at).toBeNull();
        expect(await auditCount(matchId, "match_approved")).toBe(0);
      } finally {
        await adminFixtureUpdate(
          `UPDATE public.qb_transactions
           SET client_entity_id = $2, ledger_book_id = $3
           WHERE id = $1`,
          [qbId, a.client_entity_id, a.ledger_book_id],
        );
      }
    }, 60000);

    it("17: correct owner/client is rejected when the QB endpoint is in another ledger book", async () => {
      const { matchId } = await seedUnapprovedMatch(a.id, "ApprCtrl Book 17");
      const { qbId, statementId } = await matchEndpointIds(matchId);
      const otherBook = (
        await q(
          `INSERT INTO public.ledger_books
             (id, client_entity_id, book_kind, display_name, status)
           VALUES (gen_random_uuid(), $1, 'other', $2, 'active')
           RETURNING id`,
          [a.client_entity_id, `approval-attack-${crypto.randomUUID()}`],
        )
      )[0].id as string;

      await adminFixtureUpdate(
        `UPDATE public.qb_transactions SET ledger_book_id = $2 WHERE id = $1`,
        [qbId, otherBook],
      );
      try {
        const { error } = await aClient.rpc("approve_reconciliation_matches_v1", {
          p_statement_id: statementId,
          p_match_ids: [matchId],
          p_operation_id: crypto.randomUUID(),
        });
        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/malformed|ineligible|23514/i);
        expect((await approvalState(matchId)).approved_at).toBeNull();
        expect(await auditCount(matchId, "match_approved")).toBe(0);
      } finally {
        await adminFixtureUpdate(
          `UPDATE public.qb_transactions SET ledger_book_id = $2 WHERE id = $1`,
          [qbId, a.ledger_book_id],
        );
        await sql.query(`DELETE FROM public.ledger_books WHERE id = $1`, [otherBook]);
      }
    }, 60000);

    it.each([
      {
        caseNo: "18",
        label: "approved_at set while approved_by is null",
        fixtureSql: `UPDATE public.reconciliation_matches
                     SET approved_at = now(), approved_by = NULL WHERE id = $1`,
      },
      {
        caseNo: "19",
        label: "approved_by set while approved_at is null",
        fixtureSql: `UPDATE public.reconciliation_matches
                     SET approved_at = NULL, approved_by = 'malformed-fixture' WHERE id = $1`,
      },
    ])("$caseNo: rejects malformed state: $label", async ({ fixtureSql, caseNo }) => {
      const { statementId, matchId } = await seedUnapprovedMatch(
        a.id,
        `ApprCtrl Malformed ${caseNo}`,
      );
      await adminFixtureUpdate(fixtureSql, [matchId]);
      try {
        const { error } = await aClient.rpc("approve_reconciliation_matches_v1", {
          p_statement_id: statementId,
          p_match_ids: [matchId],
          p_operation_id: crypto.randomUUID(),
        });
        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/malformed approval state|23514/i);
        expect(await auditCount(matchId, "match_approved")).toBe(0);
      } finally {
        await adminFixtureUpdate(
          `UPDATE public.reconciliation_matches
           SET approved_at = NULL, approved_by = NULL WHERE id = $1`,
          [matchId],
        );
      }
    }, 60000);
  });
});
