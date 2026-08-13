/**
 * Four-state compatibility matrix against the disposable staging database.
 *
 * Gate: runs only when Supabase env vars are set AND ZAKI_STAGING_SCHEMA is
 * "011" or "012". The Step 4E deployment simulation runs this file twice:
 *   - ZAKI_STAGING_SCHEMA=011 after restoring staging to Migration 011
 *     (T1 legacy writes, T2 freeze on 011)
 *   - ZAKI_STAGING_SCHEMA=012 after applying the frozen Migration 012
 *     (T3 canonical writes with stamps, T4 freeze on 012)
 *
 * Skipped silently otherwise (unit runs must not require a database).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const schema = process.env.ZAKI_STAGING_SCHEMA;

import {
  listBankTransactions,
  listQbTransactionsForPeriod,
  computeAndPersistMatches,
  createManualMatch,
  saveBankStatement,
  saveQbTransactions,
} from "../lib/reconciliation-store";
import { recordDecision } from "../lib/decision-store";
import { runNightlyMatch } from "../lib/nightly-match";
import { resolveTenantContextForUser } from "../lib/tenant-context";

const run011 = url && key && dbUrl && schema === "011" ? describe : describe.skip;
const run012 = url && key && dbUrl && schema === "012" ? describe : describe.skip;

const MARKER = "COMPAT-4E";

function parsedStatement(): Parameters<typeof saveBankStatement>[3] {
  return {
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    currency: "GBP",
    openingBalance: 0,
    closingBalance: 100,
    sourceProvider: "csv",
    sourceOrganisationId: null,
    sourceAccountId: null,
    sourceAccountMetadata: null,
    transactions: [
      {
        transactionDate: { value: "2026-01-06", confidence: 1, reason: "test" },
        postedDate: "2026-01-06",
        merchant: { value: MARKER, confidence: 1, reason: "test" },
        description: { value: `${MARKER} fuel`, confidence: 1, reason: "test" },
        amount: { value: 100, confidence: 1, reason: "test" },
        currency: "GBP",
        transactionId: `${MARKER}-txn-1`,
        memo: null,
      },
    ],
  };
}

let db: ReturnType<typeof createClient>;
let sql: pg.Client;
let userId: string;
const createdStatementIds: string[] = [];
const createdQbIds: string[] = [];

async function q(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await sql.query(text, params as never);
  return res.rows;
}

beforeAll(async () => {
  db = createClient(url!, key!, { auth: { persistSession: false } });
  sql = new pg.Client({ connectionString: dbUrl });
  await sql.connect();
  const users = await q(
    "SELECT id FROM auth.users WHERE confirmed_at IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1",
  );
  if (users.length === 0) throw new Error("staging has no eligible auth user");
  userId = users[0].id as string;
}, 30000);

afterAll(async () => {
  // Tidy the rows this suite created (staging is disposable, but the
  // simulation re-runs phases against the same restore).
  try {
    if (createdStatementIds.length > 0) {
      await q("DELETE FROM public.reconciliation_matches WHERE statement_id = ANY($1::uuid[])", [createdStatementIds]);
      await q("DELETE FROM public.reconciliation_decisions WHERE statement_id = ANY($1::uuid[])", [createdStatementIds]);
      await q("DELETE FROM public.bank_statement_transaction_observations WHERE statement_id = ANY($1::uuid[])", [createdStatementIds]);
      await q("DELETE FROM public.bank_transactions WHERE statement_id = ANY($1::uuid[])", [createdStatementIds]);
      await q("DELETE FROM public.reconciliation_audit_log WHERE reconciliation_match_id IN (SELECT id FROM public.reconciliation_matches WHERE statement_id = ANY($1::uuid[]))", [createdStatementIds]);
      await q("DELETE FROM public.bank_statements WHERE id = ANY($1::uuid[])", [createdStatementIds]);
    }
    if (createdQbIds.length > 0) {
      await q("DELETE FROM public.qb_transactions WHERE id = ANY($1::uuid[])", [createdQbIds]);
    }
  } catch (err) {
    console.warn("staging compat cleanup failed:", err);
  }
  await sql.end();
}, 30000);

async function countMatches(): Promise<number> {
  const rows = await q("SELECT count(*)::int AS n FROM public.reconciliation_matches");
  return rows[0].n as number;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await q(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
    [table, column],
  );
  return rows.length > 0;
}

// =========================================================================
// T1 — 011 / freeze OFF: legacy writes work, no canonical requirements
// =========================================================================
run011("T1 — schema 011, freeze OFF (legacy compatibility)", () => {
  it("the 011 schema has no canonical stamp columns on the reconciliation tables", async () => {
    expect(await columnExists("bank_statements", "client_entity_id")).toBe(false);
    expect(await columnExists("bank_statements", "ledger_book_id")).toBe(false);
    expect(await columnExists("reconciliation_matches", "client_entity_id")).toBe(false);
    expect(await columnExists("reconciliation_decisions", "client_entity_id")).toBe(false);
    expect(await columnExists("reconciliation_audit_log", "client_entity_id")).toBe(false);
  });

  it("bank upload succeeds without any 012-only tenant RPC", async () => {
    const meta = await saveBankStatement(userId, `${MARKER}-t1.csv`, "csv", parsedStatement());
    createdStatementIds.push(meta.id);
    const rows = await q("SELECT id FROM public.bank_statements WHERE id = $1", [meta.id]);
    expect(rows).toHaveLength(1);
  }, 30000);

  it("QB ingestion succeeds on the 011 schema", async () => {
    const n = await saveQbTransactions(userId, [
      { qbTransactionId: `${MARKER}-qb-1`, postedDate: "2026-01-06", amount: 100, description: `${MARKER} fuel` },
    ]);
    expect(n).toBeGreaterThanOrEqual(0);
    const rows = await q(
      "SELECT id FROM public.qb_transactions WHERE user_id = $1 AND description = $2",
      [userId, `${MARKER} fuel`],
    );
    for (const r of rows) createdQbIds.push(r.id as string);
    expect(rows.length).toBeGreaterThan(0);
  }, 30000);

  it("reconciliation write path (auto-match) succeeds with pre-4C semantics", async () => {
    const statementId = createdStatementIds[createdStatementIds.length - 1];
    const result = await computeAndPersistMatches(userId, statementId);
    expect(result.matches.length).toBeGreaterThan(0);
    const rows = await q(
      "SELECT id FROM public.reconciliation_matches WHERE statement_id = $1",
      [statementId],
    );
    expect(rows.length).toBeGreaterThan(0);
  }, 30000);

  it("manual match write succeeds on the 011 schema", async () => {
    const statementId = createdStatementIds[createdStatementIds.length - 1];
    const bank = await listBankTransactions(userId, statementId);
    const qbs = await listQbTransactionsForPeriod(userId, "2026-01-01", "2026-01-31");
    expect(bank.length).toBeGreaterThan(0);
    expect(qbs.length).toBeGreaterThan(0);
    const match = await createManualMatch(userId, statementId, bank[0].id, qbs[0].id);
    expect(match.bankTransactionId).toBe(bank[0].id);
  }, 30000);

  it("decision log write succeeds without a client stamp (column absent)", async () => {
    const statementId = createdStatementIds[createdStatementIds.length - 1];
    await recordDecision(userId, null, {
      statementId,
      matchId: null,
      bankTransactionId: "00000000-0000-0000-0000-0000000000aa",
      decisionType: "reject",
      merchantName: null,
      suggestedCategory: null,
      userChoiceCategory: null,
    });
    const rows = await q("SELECT id FROM public.reconciliation_decisions WHERE statement_id = $1", [statementId]);
    expect(rows.length).toBeGreaterThan(0);
  }, 30000);
});

// =========================================================================
// T2 — 011 / freeze ON: zero mutation everywhere
// =========================================================================
run011("T2 — schema 011, freeze ON (zero reconciliation mutation)", () => {
  it("every store writer throws the frozen error", async () => {
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
    try {
      await expect(
        saveBankStatement(userId, `${MARKER}-frozen.csv`, "csv", parsedStatement()),
      ).rejects.toThrow("frozen");
      await expect(
        saveQbTransactions(userId, [{ postedDate: "2026-01-06", amount: 1, description: "x" }]),
      ).rejects.toThrow("frozen");
      await expect(computeAndPersistMatches(userId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow("frozen");
    } finally {
      delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
    }
  });

  it("nightly performs zero mutations while frozen", async () => {
    const before = await countMatches();
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
    try {
      const result = await runNightlyMatch(userId);
      expect(result.statementsProcessed).toBe(0);
      expect(result.errors).toContain("Reconciliation writes are frozen — nightly match aborted.");
    } finally {
      delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
    }
    const after = await countMatches();
    expect(after).toBe(before);
  }, 30000);
});

// =========================================================================
// T3 — 012 / freeze OFF: canonical writes with mandatory stamps
// =========================================================================
run012("T3 — schema 012, freeze OFF (canonical stamps mandatory)", () => {
  it("the 012 schema carries the canonical stamp columns", async () => {
    expect(await columnExists("bank_statements", "client_entity_id")).toBe(true);
    expect(await columnExists("bank_statements", "ledger_book_id")).toBe(true);
    expect(await columnExists("reconciliation_matches", "client_entity_id")).toBe(true);
    expect(await columnExists("reconciliation_decisions", "client_entity_id")).toBe(true);
    expect(await columnExists("reconciliation_audit_log", "client_entity_id")).toBe(true);
  });

  it("canonical tenant resolver works through the 012 RPC", async () => {
    const tenant = await resolveTenantContextForUser(userId);
    expect(tenant.clientEntityId).toBeTruthy();
    expect(tenant.internalLedgerBookId).toBeTruthy();
  }, 30000);

  it("bank upload succeeds and stamps the registry client/book ids", async () => {
    const tenant = await resolveTenantContextForUser(userId);
    const meta = await saveBankStatement(userId, `${MARKER}-t3.csv`, "csv", parsedStatement());
    createdStatementIds.push(meta.id);
    const rows = await q(
      "SELECT client_entity_id, ledger_book_id FROM public.bank_statements WHERE id = $1",
      [meta.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_entity_id).toBe(tenant.clientEntityId);
    expect(rows[0].ledger_book_id).toBe(tenant.internalLedgerBookId);
  }, 30000);

  it("QB ingestion succeeds with canonical stamps", async () => {
    const tenant = await resolveTenantContextForUser(userId);
    await saveQbTransactions(userId, [
      { qbTransactionId: `${MARKER}-qb-2`, postedDate: "2026-01-06", amount: 100, description: `${MARKER} fuel` },
    ]);
    const rows = await q(
      "SELECT id, client_entity_id, ledger_book_id FROM public.qb_transactions WHERE user_id = $1 AND description = $2",
      [userId, `${MARKER} fuel`],
    );
    for (const r of rows) createdQbIds.push(r.id as string);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.client_entity_id).toBe(tenant.clientEntityId);
      expect(r.ledger_book_id).toBe(tenant.internalLedgerBookId);
    }
  }, 30000);

  it("match writes carry the canonical client stamp", async () => {
    const tenant = await resolveTenantContextForUser(userId);
    const statementId = createdStatementIds[createdStatementIds.length - 1];
    const result = await computeAndPersistMatches(userId, statementId);
    expect(result.matches.length).toBeGreaterThan(0);
    const rows = await q(
      "SELECT client_entity_id FROM public.reconciliation_matches WHERE statement_id = $1",
      [statementId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.client_entity_id).toBe(tenant.clientEntityId);
  }, 30000);

  it("decision log writes carry the canonical client stamp", async () => {
    const tenant = await resolveTenantContextForUser(userId);
    const statementId = createdStatementIds[createdStatementIds.length - 1];
    await recordDecision(userId, tenant.clientEntityId, {
      statementId,
      matchId: null,
      bankTransactionId: "00000000-0000-0000-0000-0000000000bb",
      decisionType: "reject",
      merchantName: null,
      suggestedCategory: null,
      userChoiceCategory: null,
    });
    const rows = await q(
      "SELECT client_entity_id FROM public.reconciliation_decisions WHERE statement_id = $1 AND bank_transaction_id = $2",
      [statementId, "00000000-0000-0000-0000-0000000000bb"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_entity_id).toBe(tenant.clientEntityId);
  }, 30000);
});

// =========================================================================
// T4 — 012 / freeze ON: zero mutation
// =========================================================================
run012("T4 — schema 012, freeze ON (zero reconciliation mutation)", () => {
  it("every store writer throws the frozen error", async () => {
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
    try {
      await expect(
        saveBankStatement(userId, `${MARKER}-frozen.csv`, "csv", parsedStatement()),
      ).rejects.toThrow("frozen");
      await expect(
        saveQbTransactions(userId, [{ postedDate: "2026-01-06", amount: 1, description: "x" }]),
      ).rejects.toThrow("frozen");
      await expect(computeAndPersistMatches(userId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow("frozen");
    } finally {
      delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
    }
  });

  it("nightly performs zero mutations while frozen", async () => {
    const before = await countMatches();
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
    try {
      const result = await runNightlyMatch(userId);
      expect(result.statementsProcessed).toBe(0);
    } finally {
      delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
    }
    const after = await countMatches();
    expect(after).toBe(before);
  }, 30000);
});
