import { getSupabase } from "./supabase";

/**
 * Storage for confirmed bank-line -> extracted-invoice matches (Phase 3,
 * Group C). Follows the same Supabase-or-in-memory pattern as
 * lib/decision-store.ts / lib/reconciliation-store.ts. Re-matching a bank
 * transaction replaces its earlier match — a bank line can only ever settle
 * one invoice, so the `unique (user_id, bank_transaction_id)` constraint is
 * enforced by deleting any existing row before inserting the new one.
 */

export interface InvoiceMatchInput {
  bankTransactionId: string;
  invoiceId: string;
  confidencePct: number;
  matchedBy: "reference" | "amount_date";
}

export interface StoredInvoiceMatch extends InvoiceMatchInput {
  id: string;
  status: string; // 'matched' | 'rejected'
  createdAt: string;
}

// --- In-memory fallback ------------------------------------------------

interface MemInvoiceMatch extends StoredInvoiceMatch {
  userId: string;
}

const globalForInvoiceMatches = globalThis as unknown as {
  __zakiLedgerInvoiceMatches?: MemInvoiceMatch[];
};
const mem = (globalForInvoiceMatches.__zakiLedgerInvoiceMatches ??= []);

export function __clearInvoiceMatchMemForTests(): void {
  mem.length = 0;
}

function newId(): string {
  return crypto.randomUUID();
}

function mapRow(row: Record<string, unknown>): StoredInvoiceMatch {
  return {
    id: row.id as string,
    bankTransactionId: row.bank_transaction_id as string,
    invoiceId: row.invoice_id as string,
    confidencePct: Number(row.confidence_pct ?? 0),
    matchedBy: row.matched_by as "reference" | "amount_date",
    status: row.status as string,
    createdAt: row.created_at as string,
  };
}

export async function saveInvoiceMatch(userId: string, m: InvoiceMatchInput): Promise<string> {
  const db = getSupabase();

  if (!db) {
    const existingIdx = mem.findIndex((r) => r.userId === userId && r.bankTransactionId === m.bankTransactionId);
    if (existingIdx !== -1) mem.splice(existingIdx, 1);
    const id = newId();
    mem.push({
      id,
      userId,
      bankTransactionId: m.bankTransactionId,
      invoiceId: m.invoiceId,
      confidencePct: m.confidencePct,
      matchedBy: m.matchedBy,
      status: "matched",
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  const { error: deleteError } = await db
    .from("invoice_matches")
    .delete()
    .eq("user_id", userId)
    .eq("bank_transaction_id", m.bankTransactionId);
  if (deleteError) throw new Error(`Failed to clear earlier invoice match: ${deleteError.message}`);

  const { data, error } = await db
    .from("invoice_matches")
    .insert({
      id: newId(),
      user_id: userId,
      bank_transaction_id: m.bankTransactionId,
      invoice_id: m.invoiceId,
      confidence_pct: m.confidencePct,
      matched_by: m.matchedBy,
      status: "matched",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to save invoice match: ${error.message}`);
  return (data as { id: string }).id;
}

export async function listInvoiceMatches(userId: string, bankTransactionIds: string[]): Promise<StoredInvoiceMatch[]> {
  const db = getSupabase();
  if (!db) {
    const ids = new Set(bankTransactionIds);
    return mem
      .filter((r) => r.userId === userId && ids.has(r.bankTransactionId))
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("invoice_matches")
    .select()
    .eq("user_id", userId)
    .in("bank_transaction_id", bankTransactionIds);
  if (error) throw new Error(`Failed to load invoice matches: ${error.message}`);
  return (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
}
