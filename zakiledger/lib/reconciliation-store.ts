import { getSupabase } from "./supabase";
import { matchTransactions, scorePair, DATE_PENDING_DAYS } from "./reconciliation-matching";
import type {
  BankTransaction,
  FlaggedLevel,
  ParsedStatement,
  QbTransaction,
  QbTransactionInput,
  ReconciliationMatch,
  ReconciliationReport,
} from "./reconciliation-schema";

/**
 * Storage for the bank-reconciliation domain. Mirrors lib/store.ts and
 * lib/oauth-store.ts: Supabase/Postgres when configured, otherwise an
 * in-memory fallback on `globalThis` (each Next.js route handler is bundled
 * separately, so a plain module-level array wouldn't be shared between
 * /api/reconciliation/upload and /api/reconciliation/[id]/transactions — see
 * lib/oauth-store.ts for the fuller explanation). Every read/write is scoped
 * by `userId`.
 */

export interface BankStatementMeta {
  id: string;
  fileName: string | null;
  fileFormat: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  transactionCount: number;
}

// --- In-memory fallback ------------------------------------------------

interface MemStatement extends BankStatementMeta {
  userId: string;
}
interface MemBankTxn extends BankTransaction {
  userId: string;
}
interface MemQbTxn extends QbTransaction {
  userId: string;
}
interface MemMatch extends ReconciliationMatch {
  userId: string;
}
interface MemReport extends ReconciliationReport {
  userId: string;
}
interface MemAuditEntry {
  id: string;
  reconciliationMatchId: string;
  action: string;
  actionBy: string | null;
  actionAt: string;
  oldConfidence: number | null;
  newConfidence: number | null;
}

const globalForRecon = globalThis as unknown as {
  __zakiLedgerRecon?: {
    statements: MemStatement[];
    bankTxns: MemBankTxn[];
    qbTxns: MemQbTxn[];
    matches: MemMatch[];
    reports: MemReport[];
    auditLog: MemAuditEntry[];
  };
};
const mem = (globalForRecon.__zakiLedgerRecon ??= {
  statements: [],
  bankTxns: [],
  qbTxns: [],
  matches: [],
  reports: [],
  auditLog: [],
});

function newId(): string {
  return crypto.randomUUID();
}

// --- Row mappers (Supabase snake_case -> our camelCase types) ----------

function mapBankTxnRow(row: Record<string, unknown>): BankTransaction {
  return {
    id: row.id as string,
    statementId: row.statement_id as string,
    transactionDate: row.transaction_date as string,
    postedDate: (row.posted_date as string) ?? null,
    merchant: (row.merchant as string) ?? null,
    description: (row.description as string) ?? null,
    amount: Number(row.amount),
    currency: (row.currency as string) ?? null,
    transactionId: (row.transaction_id as string) ?? null,
    memo: (row.memo as string) ?? null,
  };
}

function mapQbTxnRow(row: Record<string, unknown>): QbTransaction {
  return {
    id: row.id as string,
    qbTransactionId: (row.qb_transaction_id as string) ?? null,
    qbAccountId: (row.qb_account_id as string) ?? null,
    postedDate: row.posted_date as string,
    amount: Number(row.amount),
    description: (row.description as string) ?? null,
    accountName: (row.account_name as string) ?? null,
    accountType: (row.account_type as string) ?? null,
    currency: (row.currency as string) ?? null,
  };
}

function mapMatchRow(row: Record<string, unknown>): ReconciliationMatch {
  return {
    id: row.id as string,
    statementId: row.statement_id as string,
    bankTransactionId: row.bank_transaction_id as string,
    qbTransactionId: (row.qb_transaction_id as string) ?? null,
    confidence: row.confidence !== null && row.confidence !== undefined ? Number(row.confidence) : null,
    matchReason: (row.match_reason as string) ?? null,
    flaggedLevel: row.flagged_level as FlaggedLevel,
    matchedBy: row.matched_by as "auto" | "manual",
    matchedAt: row.matched_at as string,
    approvedBy: (row.approved_by as string) ?? null,
    approvedAt: (row.approved_at as string) ?? null,
  };
}

function mapReportRow(row: Record<string, unknown>): ReconciliationReport {
  return {
    id: row.id as string,
    statementId: row.statement_id as string,
    periodStart: (row.period_start as string) ?? null,
    periodEnd: (row.period_end as string) ?? null,
    bankOpeningBalance: numOrNull(row.bank_opening_balance),
    bankClosingBalance: numOrNull(row.bank_closing_balance),
    qbOpeningBalance: numOrNull(row.qb_opening_balance),
    qbClosingBalance: numOrNull(row.qb_closing_balance),
    totalMatched: Number(row.total_matched ?? 0),
    totalUnmatchedBank: Number(row.total_unmatched_bank ?? 0),
    totalUnmatchedQb: Number(row.total_unmatched_qb ?? 0),
    variance: Number(row.variance ?? 0),
    isReconciled: Boolean(row.is_reconciled),
    reconciledAt: (row.reconciled_at as string) ?? null,
  };
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

// --- Bank statements + transactions -------------------------------------

/**
 * Persist an uploaded statement and its parsed transactions in one call —
 * the upload route hands over exactly what `parseCsvStatement`/
 * `parseOfxStatement` produced.
 */
export async function saveBankStatement(
  userId: string,
  fileName: string | null,
  fileFormat: "csv" | "ofx" | "pdf",
  parsed: ParsedStatement,
): Promise<BankStatementMeta> {
  const statementId = newId();
  const meta: BankStatementMeta = {
    id: statementId,
    fileName,
    fileFormat,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    currency: parsed.currency,
    openingBalance: parsed.openingBalance,
    closingBalance: parsed.closingBalance,
    transactionCount: parsed.transactions.length,
  };

  const db = getSupabase();
  if (!db) {
    mem.statements.push({ ...meta, userId });
    for (const t of parsed.transactions) {
      mem.bankTxns.push({
        id: newId(),
        statementId,
        userId,
        transactionDate: t.transactionDate,
        postedDate: t.postedDate,
        merchant: t.merchant,
        description: t.description,
        amount: t.amount,
        currency: t.currency,
        transactionId: t.transactionId,
        memo: t.memo,
      });
    }
    return meta;
  }

  const { error: statementError } = await db.from("bank_statements").insert({
    id: statementId,
    user_id: userId,
    file_name: fileName,
    file_format: fileFormat,
    statement_period_start: parsed.periodStart,
    statement_period_end: parsed.periodEnd,
    currency: parsed.currency,
    opening_balance: parsed.openingBalance,
    closing_balance: parsed.closingBalance,
    transaction_count: parsed.transactions.length,
  });
  if (statementError) throw new Error(`Failed to save bank statement: ${statementError.message}`);

  if (parsed.transactions.length > 0) {
    const { error: txnError } = await db.from("bank_transactions").insert(
      parsed.transactions.map((t) => ({
        id: newId(),
        statement_id: statementId,
        user_id: userId,
        transaction_date: t.transactionDate,
        posted_date: t.postedDate,
        merchant: t.merchant,
        description: t.description,
        amount: t.amount,
        currency: t.currency,
        transaction_id: t.transactionId,
        memo: t.memo,
      })),
    );
    if (txnError) throw new Error(`Failed to save bank transactions: ${txnError.message}`);
  }

  return meta;
}

/** The statement's metadata, or null if it doesn't exist or belongs to another user. */
export async function getBankStatement(userId: string, statementId: string): Promise<BankStatementMeta | null> {
  const db = getSupabase();
  if (!db) {
    const s = mem.statements.find((s) => s.id === statementId && s.userId === userId);
    return s ? { ...s } : null;
  }

  const { data, error } = await db
    .from("bank_statements")
    .select()
    .eq("id", statementId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load bank statement: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id as string,
    fileName: (data.file_name as string) ?? null,
    fileFormat: data.file_format as string,
    periodStart: (data.statement_period_start as string) ?? null,
    periodEnd: (data.statement_period_end as string) ?? null,
    currency: (data.currency as string) ?? null,
    openingBalance: numOrNull(data.opening_balance),
    closingBalance: numOrNull(data.closing_balance),
    transactionCount: Number(data.transaction_count ?? 0),
  };
}

export async function listBankTransactions(userId: string, statementId: string): Promise<BankTransaction[]> {
  const db = getSupabase();
  if (!db) {
    return mem.bankTxns
      .filter((t) => t.statementId === statementId && t.userId === userId)
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("bank_transactions")
    .select()
    .eq("statement_id", statementId)
    .eq("user_id", userId)
    .order("transaction_date", { ascending: true });
  if (error) throw new Error(`Failed to load bank transactions: ${error.message}`);
  return (data ?? []).map((r) => mapBankTxnRow(r as Record<string, unknown>));
}

// --- QB/Xero transactions ------------------------------------------------

/**
 * Bulk-import QB/Xero transactions for the current user. Today this is
 * called from POST /api/reconciliation/qb-transactions (a manual/test-data
 * stand-in); tomorrow's live QB/Xero sync calls this exact function with
 * data pulled from their APIs instead of growing a second write path.
 */
export async function saveQbTransactions(userId: string, transactions: QbTransactionInput[]): Promise<number> {
  const db = getSupabase();
  if (!db) {
    for (const t of transactions) {
      mem.qbTxns.push({
        id: newId(),
        userId,
        qbTransactionId: t.qbTransactionId ?? null,
        qbAccountId: t.qbAccountId ?? null,
        postedDate: t.postedDate,
        amount: t.amount,
        description: t.description ?? null,
        accountName: t.accountName ?? null,
        accountType: t.accountType ?? null,
        currency: t.currency ?? null,
      });
    }
    return transactions.length;
  }

  if (transactions.length === 0) return 0;
  const { error } = await db.from("qb_transactions").insert(
    transactions.map((t) => ({
      id: newId(),
      user_id: userId,
      qb_transaction_id: t.qbTransactionId ?? null,
      qb_account_id: t.qbAccountId ?? null,
      posted_date: t.postedDate,
      amount: t.amount,
      description: t.description ?? null,
      account_name: t.accountName ?? null,
      account_type: t.accountType ?? null,
      currency: t.currency ?? null,
      synced_from_qb_at: new Date().toISOString(),
    })),
  );
  if (error) throw new Error(`Failed to save QB transactions: ${error.message}`);
  return transactions.length;
}

/**
 * QB transactions posted within [start, end] (padded by DATE_PENDING_DAYS on
 * each side, since a transaction can legitimately match across that window —
 * see the matching algorithm's pending-clearance case). Falls back to every
 * QB transaction the user has when the statement carries no period.
 */
export async function listQbTransactionsForPeriod(
  userId: string,
  periodStart: string | null,
  periodEnd: string | null,
): Promise<QbTransaction[]> {
  const db = getSupabase();
  const paddedStart = periodStart ? addDays(periodStart, -DATE_PENDING_DAYS) : null;
  const paddedEnd = periodEnd ? addDays(periodEnd, DATE_PENDING_DAYS) : null;

  if (!db) {
    return mem.qbTxns
      .filter((t) => {
        if (t.userId !== userId) return false;
        if (paddedStart && t.postedDate < paddedStart) return false;
        if (paddedEnd && t.postedDate > paddedEnd) return false;
        return true;
      })
      .map(({ userId: _u, ...rest }) => rest);
  }

  let query = db.from("qb_transactions").select().eq("user_id", userId);
  if (paddedStart) query = query.gte("posted_date", paddedStart);
  if (paddedEnd) query = query.lte("posted_date", paddedEnd);

  const { data, error } = await query.order("posted_date", { ascending: true });
  if (error) throw new Error(`Failed to load QB transactions: ${error.message}`);
  return (data ?? []).map((r) => mapQbTxnRow(r as Record<string, unknown>));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Matches --------------------------------------------------------------

export async function listMatchesForStatement(userId: string, statementId: string): Promise<ReconciliationMatch[]> {
  const db = getSupabase();
  if (!db) {
    return mem.matches
      .filter((m) => m.statementId === statementId && m.userId === userId)
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("reconciliation_matches")
    .select()
    .eq("statement_id", statementId)
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to load matches: ${error.message}`);
  return (data ?? []).map((r) => mapMatchRow(r as Record<string, unknown>));
}

/**
 * Run the matching algorithm for a statement and persist the results as
 * `matched_by: 'auto'` rows, then return the full picture (bank + QB
 * transactions, matches, unmatched ids).
 *
 * Auto-matching never overwrites a row that already exists for a given bank
 * transaction (manual override or a prior auto run) — see the `ignoreDuplicates`
 * upsert below. That keeps re-fetching this endpoint idempotent and never
 * clobbers a human's manual match, at the cost of not re-scoring a bank
 * transaction after new QB data arrives later; re-running matching against
 * fresh QB data for an already-matched statement is a follow-up, not
 * something Session 1 needs.
 */
export async function computeAndPersistMatches(
  userId: string,
  statementId: string,
): Promise<{
  bankTransactions: BankTransaction[];
  qbTransactions: QbTransaction[];
  matches: ReconciliationMatch[];
  unmatchedBankIds: string[];
  unmatchedQbIds: string[];
}> {
  const statement = await getBankStatement(userId, statementId);
  if (!statement) throw new Error("Statement not found.");

  const bankTransactions = await listBankTransactions(userId, statementId);
  const qbTransactions = await listQbTransactionsForPeriod(userId, statement.periodStart, statement.periodEnd);
  const existing = await listMatchesForStatement(userId, statementId);
  const alreadyMatchedBankIds = new Set(existing.map((m) => m.bankTransactionId));

  const toScore = bankTransactions.filter((b) => !alreadyMatchedBankIds.has(b.id));
  const result = matchTransactions(toScore, qbTransactions);

  const db = getSupabase();
  const nowIso = new Date().toISOString();

  if (result.matches.length > 0) {
    if (!db) {
      for (const m of result.matches) {
        mem.matches.push({
          id: newId(),
          userId,
          statementId,
          bankTransactionId: m.bankTransactionId,
          qbTransactionId: m.qbTransactionId,
          confidence: m.confidence,
          matchReason: m.matchReason,
          flaggedLevel: m.flaggedLevel,
          matchedBy: "auto",
          matchedAt: nowIso,
          approvedBy: null,
          approvedAt: null,
        });
      }
    } else {
      const { error } = await db.from("reconciliation_matches").upsert(
        result.matches.map((m) => ({
          id: newId(),
          user_id: userId,
          statement_id: statementId,
          bank_transaction_id: m.bankTransactionId,
          qb_transaction_id: m.qbTransactionId,
          confidence: m.confidence,
          match_reason: m.matchReason,
          flagged_level: m.flaggedLevel,
          matched_by: "auto",
          matched_at: nowIso,
        })),
        { onConflict: "bank_transaction_id,statement_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`Failed to persist auto matches: ${error.message}`);
    }
  }

  const allMatches = await listMatchesForStatement(userId, statementId);
  const matchedBankIds = new Set(allMatches.map((m) => m.bankTransactionId));
  const matchedQbIds = new Set(allMatches.map((m) => m.qbTransactionId).filter((id): id is string => id !== null));

  return {
    bankTransactions,
    qbTransactions,
    matches: allMatches,
    unmatchedBankIds: bankTransactions.filter((b) => !matchedBankIds.has(b.id)).map((b) => b.id),
    unmatchedQbIds: qbTransactions.filter((q) => !matchedQbIds.has(q.id)).map((q) => q.id),
  };
}

/**
 * A human-created or human-overridden match. Unlike auto-matching, this DOES
 * overwrite any existing row for the bank transaction — the whole point of a
 * manual match is overriding whatever the algorithm decided (see the brief's
 * "Create Manual Match (User Override)" endpoint).
 */
export async function createManualMatch(
  userId: string,
  statementId: string,
  bankTransactionId: string,
  qbTransactionId: string,
): Promise<ReconciliationMatch> {
  const bankTxns = await listBankTransactions(userId, statementId);
  const bank = bankTxns.find((t) => t.id === bankTransactionId);
  if (!bank) throw new Error("Bank transaction not found on this statement.");

  const statement = await getBankStatement(userId, statementId);
  const qbTxns = await listQbTransactionsForPeriod(userId, statement?.periodStart ?? null, statement?.periodEnd ?? null);
  const qb = qbTxns.find((t) => t.id === qbTransactionId);
  if (!qb) throw new Error("QB transaction not found.");

  const { score, reasons } = scorePair(bank, qb);
  const confidence = Math.min(score / 100, 1);
  const flaggedLevel: FlaggedLevel = "green"; // a human confirmed it directly — no review needed
  const matchReason = reasons.length > 0 ? `manual override (${reasons.join(" + ")})` : "manual override";
  const nowIso = new Date().toISOString();

  const db = getSupabase();
  if (!db) {
    const existingIdx = mem.matches.findIndex((m) => m.statementId === statementId && m.bankTransactionId === bankTransactionId);
    const row: MemMatch = {
      id: existingIdx >= 0 ? mem.matches[existingIdx].id : newId(),
      userId,
      statementId,
      bankTransactionId,
      qbTransactionId,
      confidence,
      matchReason,
      flaggedLevel,
      matchedBy: "manual",
      matchedAt: nowIso,
      approvedBy: null,
      approvedAt: null,
    };
    if (existingIdx >= 0) mem.matches[existingIdx] = row;
    else mem.matches.push(row);
    const { userId: _u, ...rest } = row;
    return rest;
  }

  const { data, error } = await db
    .from("reconciliation_matches")
    .upsert(
      {
        user_id: userId,
        statement_id: statementId,
        bank_transaction_id: bankTransactionId,
        qb_transaction_id: qbTransactionId,
        confidence,
        match_reason: matchReason,
        flagged_level: flaggedLevel,
        matched_by: "manual",
        matched_at: nowIso,
      },
      { onConflict: "bank_transaction_id,statement_id" },
    )
    .select()
    .single();
  if (error) throw new Error(`Failed to save manual match: ${error.message}`);
  return mapMatchRow(data as Record<string, unknown>);
}

// --- Approval + reporting --------------------------------------------------

/**
 * Approve a set of matches: stamps them approved, writes an immutable audit
 * log entry per match (never updated/deleted — same rule as the
 * corrections/confirmations ledgers in db/schema.sql), and (re)generates the
 * statement's reconciliation report from current totals.
 */
export async function approveMatches(
  userId: string,
  statementId: string,
  matchIds: string[],
  approvedBy: string,
): Promise<ReconciliationReport> {
  const allMatches = await listMatchesForStatement(userId, statementId);
  const toApprove = allMatches.filter((m) => matchIds.includes(m.id));
  if (toApprove.length === 0) throw new Error("None of the given match ids belong to this statement.");

  const nowIso = new Date().toISOString();
  const db = getSupabase();

  if (!db) {
    for (const m of toApprove) {
      const idx = mem.matches.findIndex((row) => row.id === m.id);
      if (idx >= 0) {
        mem.matches[idx] = { ...mem.matches[idx], approvedBy, approvedAt: nowIso };
      }
      mem.auditLog.push({
        id: newId(),
        reconciliationMatchId: m.id,
        action: "match_approved",
        actionBy: approvedBy,
        actionAt: nowIso,
        oldConfidence: m.confidence,
        newConfidence: m.confidence,
      });
    }
  } else {
    const { error: updateError } = await db
      .from("reconciliation_matches")
      .update({ approved_by: approvedBy, approved_at: nowIso })
      .in(
        "id",
        toApprove.map((m) => m.id),
      );
    if (updateError) throw new Error(`Failed to approve matches: ${updateError.message}`);

    const { error: auditError } = await db.from("reconciliation_audit_log").insert(
      toApprove.map((m) => ({
        id: newId(),
        reconciliation_match_id: m.id,
        action: "match_approved",
        action_by: approvedBy,
        action_at: nowIso,
        old_confidence: m.confidence,
        new_confidence: m.confidence,
      })),
    );
    if (auditError) throw new Error(`Failed to write audit log: ${auditError.message}`);
  }

  return generateReport(userId, statementId);
}

/**
 * Variance here is `sum(unmatched bank amounts) - sum(unmatched QB amounts)`
 * — a working proxy for how far apart the two ledgers currently are, not a
 * true bank-vs-book balance difference. A real balance-based variance needs
 * QB's account balance, which isn't part of `qb_transactions` (individual
 * transactions only) — that's tomorrow's live QB/Xero sync, which does have
 * account-balance access.
 */
async function generateReport(userId: string, statementId: string): Promise<ReconciliationReport> {
  const statement = await getBankStatement(userId, statementId);
  if (!statement) throw new Error("Statement not found.");

  const bankTransactions = await listBankTransactions(userId, statementId);
  const matches = await listMatchesForStatement(userId, statementId);
  const qbTransactions = await listQbTransactionsForPeriod(userId, statement.periodStart, statement.periodEnd);

  const approvedMatches = matches.filter((m) => m.approvedAt !== null);
  const matchedBankIds = new Set(approvedMatches.map((m) => m.bankTransactionId));
  const matchedQbIds = new Set(approvedMatches.map((m) => m.qbTransactionId).filter((id): id is string => id !== null));

  const unmatchedBank = bankTransactions.filter((b) => !matchedBankIds.has(b.id));
  const unmatchedQb = qbTransactions.filter((q) => !matchedQbIds.has(q.id));

  const totalMatched = bankTransactions.filter((b) => matchedBankIds.has(b.id)).reduce((sum, b) => sum + b.amount, 0);
  const totalUnmatchedBank = unmatchedBank.reduce((sum, b) => sum + b.amount, 0);
  const totalUnmatchedQb = unmatchedQb.reduce((sum, q) => sum + q.amount, 0);
  const variance = totalUnmatchedBank - totalUnmatchedQb;
  const isReconciled = unmatchedBank.length === 0 && unmatchedQb.length === 0;
  const nowIso = new Date().toISOString();

  const report: ReconciliationReport = {
    id: newId(),
    statementId,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    bankOpeningBalance: statement.openingBalance,
    bankClosingBalance: statement.closingBalance,
    qbOpeningBalance: null,
    qbClosingBalance: null,
    totalMatched,
    totalUnmatchedBank,
    totalUnmatchedQb,
    variance,
    isReconciled,
    reconciledAt: isReconciled ? nowIso : null,
  };

  const db = getSupabase();
  if (!db) {
    const existingIdx = mem.reports.findIndex((r) => r.statementId === statementId && r.userId === userId);
    const row: MemReport = { ...report, userId };
    if (existingIdx >= 0) mem.reports[existingIdx] = row;
    else mem.reports.push(row);
    return report;
  }

  const { data, error } = await db
    .from("reconciliation_reports")
    .upsert(
      {
        id: report.id,
        user_id: userId,
        statement_id: statementId,
        period_start: report.periodStart,
        period_end: report.periodEnd,
        bank_opening_balance: report.bankOpeningBalance,
        bank_closing_balance: report.bankClosingBalance,
        qb_opening_balance: report.qbOpeningBalance,
        qb_closing_balance: report.qbClosingBalance,
        total_matched: report.totalMatched,
        total_unmatched_bank: report.totalUnmatchedBank,
        total_unmatched_qb: report.totalUnmatchedQb,
        variance: report.variance,
        is_reconciled: report.isReconciled,
        reconciled_at: report.reconciledAt,
      },
      { onConflict: "statement_id" },
    )
    .select()
    .single();
  if (error) throw new Error(`Failed to save reconciliation report: ${error.message}`);
  return mapReportRow(data as Record<string, unknown>);
}

export async function getReconciliationReport(userId: string, statementId: string): Promise<ReconciliationReport | null> {
  const db = getSupabase();
  if (!db) {
    const r = mem.reports.find((r) => r.statementId === statementId && r.userId === userId);
    if (!r) return null;
    const { userId: _u, ...rest } = r;
    return rest;
  }

  const { data, error } = await db
    .from("reconciliation_reports")
    .select()
    .eq("statement_id", statementId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load reconciliation report: ${error.message}`);
  return data ? mapReportRow(data as Record<string, unknown>) : null;
}
