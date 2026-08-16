/**
 * Direct manual-override attack matrix.
 *
 * Every case invokes createManualMatch, the real application/manual-store
 * path, against the fresh local Auth/PostgREST/database stack. Controlled
 * foreign-client/book fixtures are created only through the local admin SQL
 * connection; the attack itself always traverses the application path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  approveMatches,
  createManualMatch,
  saveBankStatement,
  saveQbTransactions,
} from "../lib/reconciliation-store";
import { setupTwoTenants, type TenantUser } from "./helpers/tenant-setup";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const run = url && key && dbUrl ? describe : describe.skip;

function parsedTxn(date: string, description: string, amount = 100) {
  return {
    transactionDate: { value: date, confidence: 1, reason: "manual attack fixture" },
    postedDate: null,
    merchant: { value: description, confidence: 1, reason: "manual attack fixture" },
    description: { value: description, confidence: 1, reason: "manual attack fixture" },
    amount: { value: amount, confidence: 1, reason: "manual attack fixture" },
    currency: "GBP",
    transactionId: null,
    memo: null,
  };
}

run("Direct createManualMatch attack matrix (local Supabase)", () => {
  let sql: pg.Client;
  let svc: SupabaseClient;
  let a: TenantUser;
  let b: TenantUser;

  const statementIds: string[] = [];
  const qbIds: string[] = [];
  const extraBookIds: string[] = [];

  beforeAll(async () => {
    ({ a, b } = await setupTwoTenants());
    svc = createClient(url!, key!, { auth: { persistSession: false } });
    sql = new pg.Client({ connectionString: dbUrl });
    await sql.connect();
  }, 60000);

  afterAll(async () => {
    try {
      for (const user of [a, b]) {
        const approved = await sql.query(
          `SELECT id FROM public.reconciliation_matches
           WHERE user_id = $1 AND approved_at IS NOT NULL`,
          [user.id],
        );
        const ids = approved.rows.map((row) => row.id as string);
        if (ids.length > 0) {
          await svc.rpc("unapprove_reconciliation_matches_v1", {
            p_user_id: user.id,
            p_match_ids: ids,
          });
        }
        await sql.query(`DELETE FROM public.reconciliation_matches WHERE user_id = $1`, [user.id]);
      }
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
      if (extraBookIds.length > 0) {
        await sql.query(`DELETE FROM public.ledger_books WHERE id = ANY($1::uuid[])`, [
          extraBookIds,
        ]);
      }
    } catch (error) {
      console.warn("manual-override attack cleanup failed:", error);
    }
    await sql.end();
  }, 60000);

  async function statement(
    userId: string,
    tag: string,
    date = "2026-07-10",
  ): Promise<{ statementId: string; bankId: string }> {
    const saved = await saveBankStatement(userId, `${tag}.csv`, "csv", {
      transactions: [parsedTxn(date, tag)],
      openingBalance: 0,
      closingBalance: 0,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      currency: "GBP",
    });
    statementIds.push(saved.id);
    const bank = await sql.query(
      `SELECT id FROM public.bank_transactions WHERE statement_id = $1`,
      [saved.id],
    );
    return { statementId: saved.id, bankId: bank.rows[0].id as string };
  }

  async function canonicalQb(
    user: TenantUser,
    tag: string,
    date = "2026-07-10",
    amount = 100,
  ): Promise<string> {
    await saveQbTransactions(user.id, [{ postedDate: date, amount, description: tag }]);
    const result = await sql.query(
      `SELECT id FROM public.qb_transactions
       WHERE user_id = $1 AND description = $2
       ORDER BY posted_date DESC, id DESC LIMIT 1`,
      [user.id, tag],
    );
    const id = result.rows[0].id as string;
    qbIds.push(id);
    return id;
  }

  async function adminQb(
    userId: string,
    clientId: string,
    bookId: string,
    tag: string,
  ): Promise<string> {
    const result = await sql.query(
      `INSERT INTO public.qb_transactions
         (id, user_id, qb_transaction_id, posted_date, amount, description,
          client_entity_id, ledger_book_id)
       VALUES (gen_random_uuid(), $1, $2, '2026-07-10', 100, $3, $4, $5)
       RETURNING id`,
      [userId, `manual-attack-${crypto.randomUUID()}`, tag, clientId, bookId],
    );
    const id = result.rows[0].id as string;
    qbIds.push(id);
    return id;
  }

  it("1: valid same-tenant/client/book QB outside ±5 days succeeds", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Valid Far");
    const qbId = await canonicalQb(a, "Manual Valid Far", "2026-09-10");
    const match = await createManualMatch(a.id, statementId, bankId, qbId);
    expect(match.qbTransactionId).toBe(qbId);
    expect(match.matchedBy).toBe("manual");
  }, 60000);

  it("2: foreign-tenant QB fails through createManualMatch", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Foreign Tenant");
    const qbId = await canonicalQb(b, "Manual Foreign Tenant");
    await expect(createManualMatch(a.id, statementId, bankId, qbId)).rejects.toThrow(
      /QB transaction not found/i,
    );
  }, 60000);

  it("3: foreign-client QB fails through createManualMatch", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Foreign Client");
    const qbId = await adminQb(
      a.id,
      b.client_entity_id,
      b.ledger_book_id,
      "Manual Foreign Client QB",
    );
    await expect(createManualMatch(a.id, statementId, bankId, qbId)).rejects.toThrow(
      /QB transaction not found/i,
    );
  }, 60000);

  it("4: same-client QB in a different ledger book fails", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Wrong Book");
    const book = await sql.query(
      `INSERT INTO public.ledger_books
         (id, client_entity_id, book_kind, display_name, status)
       VALUES (gen_random_uuid(), $1, 'other', $2, 'active')
       RETURNING id`,
      [a.client_entity_id, `manual-attack-${crypto.randomUUID()}`],
    );
    const bookId = book.rows[0].id as string;
    extraBookIds.push(bookId);
    const qbId = await adminQb(a.id, a.client_entity_id, bookId, "Manual Wrong Book QB");
    await expect(createManualMatch(a.id, statementId, bankId, qbId)).rejects.toThrow(
      /QB transaction not found/i,
    );
  }, 60000);

  it("5: forged QB id fails", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Forged QB");
    await expect(
      createManualMatch(a.id, statementId, bankId, crypto.randomUUID()),
    ).rejects.toThrow(/QB transaction not found/i);
  }, 60000);

  it("6: foreign bank transaction fails", async () => {
    const own = await statement(a.id, "Manual Own Bank");
    const foreign = await statement(b.id, "Manual Foreign Bank");
    const qbId = await canonicalQb(a, "Manual Own Bank");
    await expect(
      createManualMatch(a.id, own.statementId, foreign.bankId, qbId),
    ).rejects.toThrow(/Bank transaction not found on this statement/i);
  }, 60000);

  it("7: approved row replacement/repoint is refused", async () => {
    const { statementId, bankId } = await statement(a.id, "Manual Approved Original");
    const originalQb = await canonicalQb(a, "Manual Approved Original");
    const original = await createManualMatch(a.id, statementId, bankId, originalQb);
    await approveMatches(a.id, statementId, [original.id], a.email);

    const replacementQb = await canonicalQb(a, "Manual Approved Replacement", "2026-07-11", 125);
    await expect(
      createManualMatch(a.id, statementId, bankId, replacementQb),
    ).rejects.toThrow(/already approved.*unapprove/i);

    const current = await sql.query(
      `SELECT qb_transaction_id, approved_at
       FROM public.reconciliation_matches WHERE id = $1`,
      [original.id],
    );
    expect(current.rows[0].qb_transaction_id).toBe(originalQb);
    expect(current.rows[0].approved_at).not.toBeNull();
  }, 60000);
});
