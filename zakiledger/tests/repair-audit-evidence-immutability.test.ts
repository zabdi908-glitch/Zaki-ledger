/**
 * Repair-evidence immutability (013 Z1b) — regression suite.
 *
 * The four repair/transition evidence columns added by migration 013
 * (operation_id, previous_state, resulting_state, evidence) must be
 * append-only: written at INSERT time, immutable to UPDATE for every role —
 * including service_role (the app surface) and direct postgres connections.
 * This closes the gap left by 012's audit_log_evidence_immutable_v1, whose
 * UPDATE column list (action, action_by, action_at, confidence columns)
 * predates these columns.
 *
 * Executed against the local Supabase stack with migrations 001-013 applied.
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL
 * are unset.
 *
 * Seeded audit rows are append-only by design (012 no-delete trigger) and
 * stay behind, scoped to this suite's fixed operation id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const run = url && key && dbUrl ? describe : describe.skip;

const OP = "aa11bb22-0000-4000-8000-000000000001"; // fixed test-operation marker

run("013 Z1b — repair-evidence immutability", () => {
  const db = createClient(url!, key!, { auth: { persistSession: false } });
  let sql: pg.Client;
  let userId: string;
  let clientId: string;

  beforeAll(async () => {
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
    const users = await sql.query(
      "SELECT id FROM auth.users WHERE confirmed_at IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1",
    );
    if (users.rows.length === 0) throw new Error("no eligible auth user");
    userId = users.rows[0].id;
    const clients = await sql.query(
      "SELECT id FROM public.client_entities ORDER BY id LIMIT 1",
    );
    if (clients.rows.length === 0) throw new Error("no client entity available");
    clientId = clients.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await sql.end();
  }, 30000);

  it("function and trigger exist on reconciliation_audit_log", async () => {
    const fn = await sql.query(
      `SELECT 1 FROM pg_proc
       WHERE proname = 'audit_log_repair_evidence_immutable_v1'
         AND pronamespace = 'public'::regnamespace`,
    );
    expect(fn.rows.length).toBe(1);

    const tr = await sql.query(
      `SELECT 1 FROM information_schema.triggers
       WHERE trigger_name = 'audit_log_repair_evidence_immutable'
         AND event_object_table = 'reconciliation_audit_log'
         AND trigger_schema = 'public'`,
    );
    expect(tr.rows.length).toBe(1);
  }, 10000);

  it("repair-style audit INSERT with all four evidence columns succeeds through the service-role surface", async () => {
    const { error } = await db.from("reconciliation_audit_log").insert({
      reconciliation_match_id: null,
      action: "match_repair_superseded",
      action_by: "zaki-repair-immutability-test",
      user_id: userId,
      client_entity_id: clientId,
      old_confidence: 0.8,
      new_confidence: 0.8,
      operation_id: OP,
      previous_state: { approved_at: null },
      resulting_state: { superseded_at: "2026-08-17T00:00:00+00:00" },
      evidence: { stage: "1", reason: "immutability-seed" },
    });
    expect(error).toBeNull();
  }, 15000);

  it("service-role UPDATE of evidence fails (42806)", async () => {
    const { error } = await db
      .from("reconciliation_audit_log")
      .update({ evidence: { stage: "tampered" } })
      .eq("operation_id", OP);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/immutable|42806/i);
  }, 15000);

  it("service-role UPDATE of operation_id fails (42806)", async () => {
    const { error } = await db
      .from("reconciliation_audit_log")
      .update({ operation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" })
      .eq("operation_id", OP);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/immutable|42806/i);
  }, 15000);

  it("service-role UPDATE of previous_state fails (42806)", async () => {
    const { error } = await db
      .from("reconciliation_audit_log")
      .update({ previous_state: { tampered: true } })
      .eq("operation_id", OP);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/immutable|42806/i);
  }, 15000);

  it("service-role UPDATE of resulting_state fails (42806)", async () => {
    const { error } = await db
      .from("reconciliation_audit_log")
      .update({ resulting_state: { tampered: true } })
      .eq("operation_id", OP);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/immutable|42806/i);
  }, 15000);

  it("direct postgres UPDATE of the evidence columns fails (no role bypass)", async () => {
    const attempts = [
      `UPDATE public.reconciliation_audit_log SET evidence = '{"tampered": true}' WHERE operation_id = '${OP}'`,
      `UPDATE public.reconciliation_audit_log SET operation_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE operation_id = '${OP}'`,
      `UPDATE public.reconciliation_audit_log SET previous_state = '{"tampered": true}' WHERE operation_id = '${OP}'`,
      `UPDATE public.reconciliation_audit_log SET resulting_state = '{"tampered": true}' WHERE operation_id = '${OP}'`,
    ];
    for (const stmt of attempts) {
      let error: Error | null = null;
      try {
        await sql.query(stmt);
      } catch (err) {
        error = err as Error;
      }
      expect(error, `expected failure for: ${stmt}`).not.toBeNull();
      expect(error!.message).toMatch(/immutable|42806/i);
    }
  }, 15000);

  it("existing 012 protections remain: UPDATE of legacy evidence columns and DELETE fail", async () => {
    let updateError: Error | null = null;
    try {
      await sql.query(
        `UPDATE public.reconciliation_audit_log SET action = 'tampered' WHERE operation_id = '${OP}'`,
      );
    } catch (err) {
      updateError = err as Error;
    }
    expect(updateError).not.toBeNull();
    expect(updateError!.message).toMatch(/immutable|42806/i);

    let deleteError: Error | null = null;
    try {
      await sql.query(
        `DELETE FROM public.reconciliation_audit_log WHERE operation_id = '${OP}'`,
      );
    } catch (err) {
      deleteError = err as Error;
    }
    expect(deleteError).not.toBeNull();
    expect(deleteError!.message).toMatch(/immutable|42806/i);
  }, 15000);

  it("the seeded evidence row survives every attack unchanged", async () => {
    // Seeded rows are append-only and accumulate across re-runs; assert the
    // earliest seeded row is untouched.
    const rows = await sql.query(
      `SELECT operation_id, previous_state, resulting_state, evidence
       FROM public.reconciliation_audit_log
       WHERE operation_id = '${OP}' AND action_by = 'zaki-repair-immutability-test'
       ORDER BY action_at`,
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0].operation_id).toBe(OP);
    expect(rows.rows[0].previous_state).toEqual({ approved_at: null });
    expect(rows.rows[0].resulting_state).toEqual({
      superseded_at: "2026-08-17T00:00:00+00:00",
    });
    expect(rows.rows[0].evidence).toEqual({ stage: "1", reason: "immutability-seed" });
  }, 15000);
});
