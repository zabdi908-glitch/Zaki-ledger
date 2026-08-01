import { getSupabase } from "./supabase";

/**
 * Storage for decision automation (Phase 3, Group B): the append-only log of
 * every approve/reject/categorise decision, and the per-user merchant ->
 * category preferences learned from them. Follows the same Supabase-or-
 * in-memory pattern as lib/reconciliation-store.ts.
 */

export type DecisionType = "approve" | "reject" | "accept_suggestion" | "category_set";

export interface DecisionInput {
  statementId: string;
  matchId: string | null;
  bankTransactionId: string;
  decisionType: DecisionType;
  merchantName: string | null;
  suggestedCategory: string | null;
  userChoiceCategory: string | null;
}

export interface Decision extends DecisionInput {
  id: string;
  createdAt: string;
}

export interface MerchantPreference {
  merchantName: string;
  category: string;
  approvalCount: number;
  lastApproved: string;
}

// --- In-memory fallback ------------------------------------------------

interface MemDecision extends Decision {
  userId: string;
}
interface MemPreference extends MerchantPreference {
  userId: string;
}

const globalForDecisions = globalThis as unknown as {
  __zakiLedgerDecisions?: {
    decisions: MemDecision[];
    preferences: MemPreference[];
  };
};
const mem = (globalForDecisions.__zakiLedgerDecisions ??= {
  decisions: [],
  preferences: [],
});

export function __clearDecisionMemForTests(): void {
  mem.decisions.length = 0;
  mem.preferences.length = 0;
}

function newId(): string {
  return crypto.randomUUID();
}

function normalizeMerchant(name: string): string {
  return name.trim().toLowerCase();
}

function mapDecisionRow(row: Record<string, unknown>): Decision {
  return {
    id: row.id as string,
    statementId: row.statement_id as string,
    matchId: (row.match_id as string) ?? null,
    bankTransactionId: row.bank_transaction_id as string,
    decisionType: row.decision_type as DecisionType,
    merchantName: (row.merchant_name as string) ?? null,
    suggestedCategory: (row.suggested_category as string) ?? null,
    userChoiceCategory: (row.user_choice_category as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapPreferenceRow(row: Record<string, unknown>): MerchantPreference {
  return {
    merchantName: row.merchant_name as string,
    category: row.category as string,
    approvalCount: Number(row.approval_count ?? 0),
    lastApproved: row.last_approved as string,
  };
}

// --- Decision log -----------------------------------------------------

export async function recordDecision(userId: string, d: DecisionInput): Promise<void> {
  const db = getSupabase();
  if (!db) {
    mem.decisions.push({
      id: newId(),
      userId,
      createdAt: new Date().toISOString(),
      ...d,
    });
    return;
  }

  const { error } = await db.from("reconciliation_decisions").insert({
    id: newId(),
    user_id: userId,
    statement_id: d.statementId,
    match_id: d.matchId,
    bank_transaction_id: d.bankTransactionId,
    decision_type: d.decisionType,
    merchant_name: d.merchantName,
    suggested_category: d.suggestedCategory,
    user_choice_category: d.userChoiceCategory,
  });
  if (error) throw new Error(`Failed to record decision: ${error.message}`);
}

export async function listDecisionsForStatement(userId: string, statementId: string): Promise<Decision[]> {
  const db = getSupabase();
  if (!db) {
    return mem.decisions
      .filter((d) => d.userId === userId && d.statementId === statementId)
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("reconciliation_decisions")
    .select()
    .eq("user_id", userId)
    .eq("statement_id", statementId);
  if (error) throw new Error(`Failed to load decisions: ${error.message}`);
  return (data ?? []).map((r) => mapDecisionRow(r as Record<string, unknown>));
}

// --- Merchant preferences -----------------------------------------------

export async function bumpMerchantPreference(userId: string, merchantName: string, category: string): Promise<void> {
  const key = normalizeMerchant(merchantName);
  const nowIso = new Date().toISOString();
  const db = getSupabase();

  if (!db) {
    const existing = mem.preferences.find((p) => p.userId === userId && p.merchantName === key);
    if (existing) {
      existing.approvalCount = existing.category === category ? existing.approvalCount + 1 : 1;
      existing.category = category;
      existing.lastApproved = nowIso;
    } else {
      mem.preferences.push({ userId, merchantName: key, category, approvalCount: 1, lastApproved: nowIso });
    }
    return;
  }

  const { data: existing, error: fetchError } = await db
    .from("user_merchant_preferences")
    .select()
    .eq("user_id", userId)
    .eq("merchant_name", key)
    .maybeSingle();
  if (fetchError) throw new Error(`Failed to load merchant preference: ${fetchError.message}`);

  const nextCount = existing && existing.category === category ? Number(existing.approval_count ?? 0) + 1 : 1;

  if (existing) {
    const { error } = await db
      .from("user_merchant_preferences")
      .update({ category, approval_count: nextCount, last_approved: nowIso })
      .eq("user_id", userId)
      .eq("merchant_name", key);
    if (error) throw new Error(`Failed to update merchant preference: ${error.message}`);
  } else {
    const { error } = await db.from("user_merchant_preferences").insert({
      id: newId(),
      user_id: userId,
      merchant_name: key,
      category,
      approval_count: nextCount,
      last_approved: nowIso,
    });
    if (error) throw new Error(`Failed to insert merchant preference: ${error.message}`);
  }
}

export async function setMerchantDefault(userId: string, merchantName: string, category: string): Promise<void> {
  const key = normalizeMerchant(merchantName);
  const nowIso = new Date().toISOString();
  const db = getSupabase();

  if (!db) {
    const existing = mem.preferences.find((p) => p.userId === userId && p.merchantName === key);
    if (existing) {
      existing.category = category;
      existing.approvalCount = 3;
      existing.lastApproved = nowIso;
    } else {
      mem.preferences.push({ userId, merchantName: key, category, approvalCount: 3, lastApproved: nowIso });
    }
    return;
  }

  const { data: existing, error: fetchError } = await db
    .from("user_merchant_preferences")
    .select("id")
    .eq("user_id", userId)
    .eq("merchant_name", key)
    .maybeSingle();
  if (fetchError) throw new Error(`Failed to load merchant preference: ${fetchError.message}`);

  if (existing) {
    const { error } = await db
      .from("user_merchant_preferences")
      .update({ category, approval_count: 3, last_approved: nowIso })
      .eq("user_id", userId)
      .eq("merchant_name", key);
    if (error) throw new Error(`Failed to update merchant preference: ${error.message}`);
  } else {
    const { error } = await db.from("user_merchant_preferences").insert({
      id: newId(),
      user_id: userId,
      merchant_name: key,
      category,
      approval_count: 3,
      last_approved: nowIso,
    });
    if (error) throw new Error(`Failed to insert merchant preference: ${error.message}`);
  }
}

export async function getMerchantPreferences(userId: string): Promise<MerchantPreference[]> {
  const db = getSupabase();
  if (!db) {
    return mem.preferences
      .filter((p) => p.userId === userId)
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("user_merchant_preferences")
    .select()
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to load merchant preferences: ${error.message}`);
  return (data ?? []).map((r) => mapPreferenceRow(r as Record<string, unknown>));
}
