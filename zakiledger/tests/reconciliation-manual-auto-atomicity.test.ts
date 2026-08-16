/**
 * Invariant M — manual/automatic serialization and manual-transition atomicity.
 *
 * These cases use real local Postgres/PostgREST transactions. Test-only
 * triggers make the critical interleavings deterministic; every trigger is
 * removed in a finally block and no production function contains test hooks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  createManualMatch,
  saveBankStatement,
} from "../lib/reconciliation-store";
import { setupTwoTenants, type TenantUser } from "./helpers/tenant-setup";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const run = url && key && dbUrl ? describe : describe.skip;

const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";
const CONCURRENCY_REPEATS = 3;

type Endpoint = { statementId: string; bankId: string };

function parsedTxn(tag: string, amount: number) {
  return {
    transactionDate: { value: "2026-08-15", confidence: 1, reason: "atomicity fixture" },
    postedDate: null,
    merchant: { value: tag, confidence: 1, reason: "atomicity fixture" },
    description: { value: tag, confidence: 1, reason: "atomicity fixture" },
    amount: { value: amount, confidence: 1, reason: "atomicity fixture" },
    currency: "GBP",
    transactionId: null,
    memo: null,
  };
}

run("Invariant M — manual/automatic serialization (local Supabase)", () => {
  let svc: SupabaseClient;
  let sql: pg.Client;
  let a: TenantUser;
  const statementIds: string[] = [];
  const qbIds: string[] = [];

  beforeAll(async () => {
    ({ a } = await setupTwoTenants());
    svc = createClient(url!, key!, { auth: { persistSession: false } });
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    await dropTestObjects();
  }, 60000);

  afterAll(async () => {
    try {
      await dropTestObjects();
      const approved = await sql.query(
        `SELECT id FROM public.reconciliation_matches
         WHERE user_id = $1 AND approved_at IS NOT NULL`,
        [a.id],
      );
      if (approved.rows.length > 0) {
        await svc.rpc("unapprove_reconciliation_matches_v1", {
          p_user_id: a.id,
          p_match_ids: approved.rows.map((row) => row.id as string),
        });
      }
      await sql.query(`DELETE FROM public.reconciliation_matches WHERE user_id = $1`, [a.id]);
      if (statementIds.length > 0) {
        await sql.query(
          `DELETE FROM public.bank_statement_transaction_observations
           WHERE statement_id = ANY($1::uuid[])`,
          [statementIds],
        );
        await sql.query(
          `DELETE FROM public.bank_transactions WHERE statement_id = ANY($1::uuid[])`,
          [statementIds],
        );
        await sql.query(`DELETE FROM public.bank_statements WHERE id = ANY($1::uuid[])`, [
          statementIds,
        ]);
      }
      if (qbIds.length > 0) {
        await sql.query(`DELETE FROM public.qb_transactions WHERE id = ANY($1::uuid[])`, [qbIds]);
      }
    } finally {
      await sql.end();
    }
  }, 60000);

  async function endpoint(tag: string, amount = 100): Promise<Endpoint> {
    const saved = await saveBankStatement(a.id, `${tag}.csv`, "csv", {
      transactions: [parsedTxn(tag, amount)],
      openingBalance: 0,
      closingBalance: 0,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      currency: "GBP",
    });
    statementIds.push(saved.id);
    const bank = await sql.query(
      `SELECT id FROM public.bank_transactions WHERE statement_id = $1`,
      [saved.id],
    );
    return { statementId: saved.id, bankId: bank.rows[0].id as string };
  }

  async function qb(tag: string, amount = 100): Promise<string> {
    const result = await sql.query(
      `INSERT INTO public.qb_transactions
         (id, user_id, qb_transaction_id, posted_date, amount, description,
          client_entity_id, ledger_book_id)
       VALUES (gen_random_uuid(), $1, $2, '2026-08-15', $3, $4, $5, $6)
       RETURNING id`,
      [
        a.id,
        `atomicity-${crypto.randomUUID()}`,
        amount,
        tag,
        a.client_entity_id,
        a.ledger_book_id,
      ],
    );
    const id = result.rows[0].id as string;
    qbIds.push(id);
    return id;
  }

  async function persistAuto(
    target: Endpoint,
    qbId: string,
    confidence = 1,
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    return svc.rpc("persist_auto_matches_v1", {
      p_user_id: a.id,
      p_statement_id: target.statementId,
      p_client_entity_id: a.client_entity_id,
      p_matches: [
        {
          id: crypto.randomUUID(),
          bank_transaction_id: target.bankId,
          qb_transaction_id: qbId,
          confidence,
          match_reason: "atomicity fixture",
          flagged_level: confidence >= 0.95 ? "green" : "red",
          matched_at: new Date().toISOString(),
          audit_memo: null,
        },
      ],
    });
  }

  async function live(qbId: string) {
    const result = await sql.query(
      `SELECT id, bank_transaction_id, matched_by, approved_at, superseded_at
       FROM public.reconciliation_matches
       WHERE qb_transaction_id = $1 AND superseded_at IS NULL
       ORDER BY matched_by, id`,
      [qbId],
    );
    return result.rows;
  }

  async function auditsFor(qbId: string) {
    const result = await sql.query(
      `SELECT ral.action, ral.operation_id, ral.reconciliation_match_id
       FROM public.reconciliation_audit_log ral
       LEFT JOIN public.reconciliation_matches rm
         ON rm.id = ral.reconciliation_match_id
       WHERE rm.qb_transaction_id = $1
       ORDER BY ral.action_at, ral.id`,
      [qbId],
    );
    return result.rows;
  }

  async function dropTestObjects(): Promise<void> {
    await sql.query(`
      DROP TRIGGER IF EXISTS reconciliation_atomicity_match_gate
        ON public.reconciliation_matches;
      DROP TRIGGER IF EXISTS reconciliation_atomicity_audit_gate
        ON public.reconciliation_audit_log;
      DROP FUNCTION IF EXISTS public.reconciliation_atomicity_match_gate_v1();
      DROP FUNCTION IF EXISTS public.reconciliation_atomicity_audit_gate_v1();
      DROP TABLE IF EXISTS public.reconciliation_atomicity_test_gate;
    `);
  }

  async function installBlockingMatchGate(matchedBy: "auto" | "manual", keyValue: number) {
    await dropTestObjects();
    await sql.query(`
      CREATE TABLE public.reconciliation_atomicity_test_gate (
        matched_by text NOT NULL,
        advisory_key bigint NOT NULL
      );
      INSERT INTO public.reconciliation_atomicity_test_gate
      VALUES ($$${matchedBy}$$, ${keyValue});
      CREATE FUNCTION public.reconciliation_atomicity_match_gate_v1()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $gate$
      DECLARE v_key bigint;
      BEGIN
        SELECT advisory_key INTO v_key
        FROM public.reconciliation_atomicity_test_gate
        WHERE matched_by = NEW.matched_by;
        IF v_key IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(v_key);
        END IF;
        RETURN NEW;
      END;
      $gate$;
      CREATE TRIGGER reconciliation_atomicity_match_gate
        BEFORE INSERT OR UPDATE ON public.reconciliation_matches
        FOR EACH ROW EXECUTE FUNCTION public.reconciliation_atomicity_match_gate_v1();
    `);
    await sql.query(`SELECT pg_advisory_lock($1)`, [keyValue]);
  }

  async function waitForGate(): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const waiting = await sql.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted = false LIMIT 1`,
      );
      if (waiting.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("worker did not reach the deterministic transaction gate");
  }

  async function unlockGate(keyValue: number): Promise<void> {
    await sql.query(`SELECT pg_advisory_unlock($1)`, [keyValue]);
  }

  async function installRejectingMatchTrigger(timing: "BEFORE" | "AFTER", message: string) {
    await dropTestObjects();
    await sql.query(`
      CREATE FUNCTION public.reconciliation_atomicity_match_gate_v1()
      RETURNS trigger LANGUAGE plpgsql AS $gate$
      BEGIN
        IF NEW.matched_by = 'manual' THEN
          RAISE EXCEPTION '${message}';
        END IF;
        RETURN NEW;
      END;
      $gate$;
      CREATE TRIGGER reconciliation_atomicity_match_gate
        ${timing} INSERT OR UPDATE ON public.reconciliation_matches
        FOR EACH ROW EXECUTE FUNCTION public.reconciliation_atomicity_match_gate_v1();
    `);
  }

  async function installRejectingAuditTrigger(actionPattern: string, message: string) {
    await dropTestObjects();
    await sql.query(`
      CREATE FUNCTION public.reconciliation_atomicity_audit_gate_v1()
      RETURNS trigger LANGUAGE plpgsql AS $gate$
      BEGIN
        IF NEW.action LIKE '${actionPattern}' THEN
          RAISE EXCEPTION '${message}';
        END IF;
        RETURN NEW;
      END;
      $gate$;
      CREATE TRIGGER reconciliation_atomicity_audit_gate
        BEFORE INSERT ON public.reconciliation_audit_log
        FOR EACH ROW EXECUTE FUNCTION public.reconciliation_atomicity_audit_gate_v1();
    `);
  }

  it("1: AUTO starts first; concurrent MANUAL serializes and leaves one manual final state", async () => {
    for (let repeat = 0; repeat < CONCURRENCY_REPEATS; repeat += 1) {
      const autoTarget = await endpoint(`m-auto-first-auto-${repeat}`, 101 + repeat);
      const manualTarget = await endpoint(`m-auto-first-manual-${repeat}`, 101 + repeat);
      const qbId = await qb(`m-auto-first-${repeat}`, 101 + repeat);
      const lockKey = 91310000 + repeat;
      await installBlockingMatchGate("auto", lockKey);
      try {
        const automatic = persistAuto(autoTarget, qbId);
        await waitForGate();
        const manual = createManualMatch(
          a.id,
          manualTarget.statementId,
          manualTarget.bankId,
          qbId,
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        await unlockGate(lockKey);
        const [autoResult, manualResult] = await Promise.all([automatic, manual]);
        expect(autoResult.error).toBeNull();
        expect(manualResult.matchedBy).toBe("manual");
      } finally {
        await unlockGate(lockKey);
        await dropTestObjects();
      }
      const rows = await live(qbId);
      expect(rows.filter((row) => row.matched_by === "manual")).toHaveLength(1);
      expect(rows.filter((row) => row.matched_by === "auto")).toHaveLength(0);
    }
  }, 60000);

  it("2: MANUAL starts first; concurrent AUTO waits and then observes the manual relationship", async () => {
    for (let repeat = 0; repeat < CONCURRENCY_REPEATS; repeat += 1) {
      const manualTarget = await endpoint(`m-manual-first-manual-${repeat}`, 111 + repeat);
      const autoTarget = await endpoint(`m-manual-first-auto-${repeat}`, 111 + repeat);
      const qbId = await qb(`m-manual-first-${repeat}`, 111 + repeat);
      const lockKey = 91311000 + repeat;
      await installBlockingMatchGate("manual", lockKey);
      try {
        const manual = createManualMatch(
          a.id,
          manualTarget.statementId,
          manualTarget.bankId,
          qbId,
        );
        await waitForGate();
        let automaticSettled = false;
        const automatic = persistAuto(autoTarget, qbId).finally(() => {
          automaticSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(automaticSettled, "AUTO did not wait behind MANUAL's QB lock").toBe(false);
        await unlockGate(lockKey);
        const [manualResult, autoResult] = await Promise.all([manual, automatic]);
        expect(manualResult.matchedBy).toBe("manual");
        expect(autoResult.error).toBeNull();
      } finally {
        await unlockGate(lockKey);
        await dropTestObjects();
      }
      const rows = await live(qbId);
      expect(rows.filter((row) => row.matched_by === "manual")).toHaveLength(1);
      expect(rows.filter((row) => row.matched_by === "auto")).toHaveLength(0);
    }
  }, 60000);

  it("3: two AUTO workers plus one MANUAL worker converge deterministically", async () => {
    for (let repeat = 0; repeat < CONCURRENCY_REPEATS; repeat += 1) {
      const auto1 = await endpoint(`m-three-auto-1-${repeat}`, 121 + repeat);
      const auto2 = await endpoint(`m-three-auto-2-${repeat}`, 121 + repeat);
      const manualTarget = await endpoint(`m-three-manual-${repeat}`, 121 + repeat);
      const qbId = await qb(`m-three-${repeat}`, 121 + repeat);
      const lockKey = 91312000 + repeat;
      await installBlockingMatchGate("auto", lockKey);
      try {
        const worker1 = persistAuto(auto1, qbId);
        const worker2 = persistAuto(auto2, qbId);
        await waitForGate();
        const manual = createManualMatch(
          a.id,
          manualTarget.statementId,
          manualTarget.bankId,
          qbId,
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        await unlockGate(lockKey);
        const results = await Promise.all([worker1, worker2, manual]);
        expect(results[0].error).toBeNull();
        expect(results[1].error).toBeNull();
      } finally {
        await unlockGate(lockKey);
        await dropTestObjects();
      }
      const rows = await live(qbId);
      expect(rows.filter((row) => row.matched_by === "manual")).toHaveLength(1);
      expect(rows.filter((row) => row.matched_by === "auto")).toHaveLength(0);
    }
  }, 60000);

  it("4: manual override atomically supersedes a weak unapproved automatic claim", async () => {
    const autoTarget = await endpoint("m-weak-auto", 131);
    const manualTarget = await endpoint("m-weak-manual", 131);
    const qbId = await qb("m-weak", 131);
    expect((await persistAuto(autoTarget, qbId, 0.6)).error).toBeNull();
    await createManualMatch(a.id, manualTarget.statementId, manualTarget.bankId, qbId);

    const rows = await live(qbId);
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_by).toBe("manual");
    const history = await sql.query(
      `SELECT superseded_at, supersede_reason
       FROM public.reconciliation_matches WHERE bank_transaction_id = $1`,
      [autoTarget.bankId],
    );
    expect(history.rows[0].superseded_at).not.toBeNull();
    expect(history.rows[0].supersede_reason).toBe("manual_override");
    expect((await auditsFor(qbId)).map((row) => row.action)).toEqual(
      expect.arrayContaining(["match_superseded", "match_manual_created"]),
    );
  }, 60000);

  it("5: manual operation fails closed against an approved automatic claim", async () => {
    const autoTarget = await endpoint("m-approved-auto", 141);
    const manualTarget = await endpoint("m-approved-manual", 141);
    const qbId = await qb("m-approved", 141);
    expect((await persistAuto(autoTarget, qbId)).error).toBeNull();
    const autoRow = (await live(qbId))[0];
    const approval = await svc.rpc("approve_reconciliation_matches_service_v1", {
      p_user_id: a.id,
      p_statement_id: autoTarget.statementId,
      p_match_ids: [autoRow.id],
      p_approved_by: a.email,
      p_operation_id: crypto.randomUUID(),
    });
    expect(approval.error).toBeNull();

    await expect(
      createManualMatch(a.id, manualTarget.statementId, manualTarget.bankId, qbId),
    ).rejects.toThrow(/approved automatic|protected automatic/i);
    const rows = await live(qbId);
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_by).toBe("auto");
    expect(rows[0].approved_at).not.toBeNull();
  }, 60000);

  it("6: legitimate manual many:1 remains allowed", async () => {
    const manual1 = await endpoint("m-many-one-a", 151);
    const manual2 = await endpoint("m-many-one-b", 151);
    const qbId = await qb("m-many-one", 151);
    await createManualMatch(a.id, manual1.statementId, manual1.bankId, qbId);
    await createManualMatch(a.id, manual2.statementId, manual2.bankId, qbId);
    const rows = await live(qbId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.matched_by === "manual")).toBe(true);
  }, 60000);

  it("7: failure after automatic resolution but before manual write rolls everything back", async () => {
    const autoTarget = await endpoint("m-before-write-auto", 161);
    const manualTarget = await endpoint("m-before-write-manual", 161);
    const qbId = await qb("m-before-write", 161);
    expect((await persistAuto(autoTarget, qbId, 0.6)).error).toBeNull();
    await installRejectingMatchTrigger("BEFORE", "forced before manual write");
    try {
      await expect(
        createManualMatch(a.id, manualTarget.statementId, manualTarget.bankId, qbId),
      ).rejects.toThrow(/forced before manual write/i);
    } finally {
      await dropTestObjects();
    }
    const rows = await live(qbId);
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_by).toBe("auto");
    expect((await auditsFor(qbId)).filter((row) => row.action === "match_superseded")).toHaveLength(0);
  }, 60000);

  it("8: failure after manual row write but before audit rolls the manual row back", async () => {
    const target = await endpoint("m-after-write", 171);
    const qbId = await qb("m-after-write", 171);
    await installRejectingMatchTrigger("AFTER", "forced after manual write");
    try {
      await expect(
        createManualMatch(a.id, target.statementId, target.bankId, qbId),
      ).rejects.toThrow(/forced after manual write/i);
    } finally {
      await dropTestObjects();
    }
    expect(await live(qbId)).toHaveLength(0);
    expect(await auditsFor(qbId)).toHaveLength(0);
  }, 60000);

  it("9: audit insertion failure rolls back automatic resolution and manual persistence", async () => {
    const autoTarget = await endpoint("m-audit-fail-auto", 181);
    const manualTarget = await endpoint("m-audit-fail-manual", 181);
    const qbId = await qb("m-audit-fail", 181);
    expect((await persistAuto(autoTarget, qbId, 0.6)).error).toBeNull();
    await installRejectingAuditTrigger("match_%", "forced manual audit failure");
    try {
      await expect(
        createManualMatch(a.id, manualTarget.statementId, manualTarget.bankId, qbId),
      ).rejects.toThrow(/forced manual audit failure/i);
    } finally {
      await dropTestObjects();
    }
    const rows = await live(qbId);
    expect(rows).toHaveLength(1);
    expect(rows[0].matched_by).toBe("auto");
    expect(await auditsFor(qbId)).toHaveLength(0);
  }, 60000);

  it("10: an identical retry is deterministic and does not duplicate state or audit", async () => {
    const target = await endpoint("m-retry", 191);
    const qbId = await qb("m-retry", 191);
    const first = await createManualMatch(a.id, target.statementId, target.bankId, qbId);
    const second = await createManualMatch(a.id, target.statementId, target.bankId, qbId);
    expect(second.id).toBe(first.id);
    expect(await live(qbId)).toHaveLength(1);
    const manualAudits = (await auditsFor(qbId)).filter((row) =>
      String(row.action).startsWith("match_manual_"),
    );
    expect(manualAudits).toHaveLength(1);
    expect(manualAudits[0].operation_id).not.toBeNull();
  }, 60000);

  it("11: automatic approval fails closed when a protected manual relationship already exists", async () => {
    const autoTarget = await endpoint("m-approval-auto", 201);
    const manualTarget = await endpoint("m-approval-manual", 201);
    const qbId = await qb("m-approval", 201);
    await createManualMatch(a.id, manualTarget.statementId, manualTarget.bankId, qbId);
    // Reproduce inconsistent historical state without repairing it: a raw
    // automatic row can coexist because the partial unique index constrains
    // auto-vs-auto only, exactly as required.
    const autoId = crypto.randomUUID();
    await sql.query("BEGIN");
    try {
      await sql.query(`SET LOCAL session_replication_role = replica`);
      await sql.query(
        `INSERT INTO public.reconciliation_matches
         (id, user_id, statement_id, bank_transaction_id, qb_transaction_id,
          confidence, match_reason, flagged_level, matched_by, matched_at,
          client_entity_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'historical inconsistency', 'green',
               'auto', now(), $6)`,
        [autoId, a.id, autoTarget.statementId, autoTarget.bankId, qbId, a.client_entity_id],
      );
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK");
      throw error;
    }

    const approval = await svc.rpc("approve_reconciliation_matches_service_v1", {
      p_user_id: a.id,
      p_statement_id: autoTarget.statementId,
      p_match_ids: [autoId],
      p_approved_by: a.email,
      p_operation_id: crypto.randomUUID(),
    });
    expect(approval.error).not.toBeNull();
    expect(approval.error!.message).toMatch(/manual relationship|protected manual/i);
    const state = await sql.query(
      `SELECT approved_at, approved_by FROM public.reconciliation_matches WHERE id = $1`,
      [autoId],
    );
    expect(state.rows[0].approved_at).toBeNull();
    expect(state.rows[0].approved_by).toBeNull();
  }, 60000);
});
