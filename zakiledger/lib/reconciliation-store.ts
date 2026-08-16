import { getSupabase } from "./supabase";
import {
  matchTransactions,
  scorePair,
  DATE_PENDING_DAYS,
  reservesQbClaim,
  shouldSupersedeAutoMatch,
} from "./reconciliation-matching";
import { generateAuditMemos } from "./audit-memo-generator";
import { resolveTenantContextForUser } from "./tenant-context";
import {
  detectReconciliationSchemaCapability,
  detectReconciliationClaimGuardCapability,
} from "./reconciliation-schema-capability";
import { assertReconciliationWritesNotFrozen } from "./reconciliation-freeze";
import type { AuditMemo } from "./audit-memo-schema";
import type {
  BankTransaction,
  FlaggedLevel,
  ParsedStatement,
  ProposedMatch,
  QbTransaction,
  QbTransactionInput,
  ReconciliationMatch,
  ReconciliationReport,
} from "./reconciliation-schema";
import {
  ACCOUNTING_FINGERPRINT_VERSION,
  BANK_FINGERPRINT_VERSION,
  accountingTransactionFingerprint,
  bankTransactionFingerprint,
} from "./financial-identity";

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
  sourceProvider?: string | null;
  sourceOrganisationId?: string | null;
  sourceAccountId?: string | null;
  sourceArtifactHash?: string | null;
}

export interface BankIngestionOptions {
  sourceArtifactHash?: string | null;
}

export interface AccountingIngestionOptions {
  provider?: string | null;
  organisationId?: string | null;
  externalObjectType?: string | null;
  sourceArtifactHash?: string | null;
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
  sourceArtifactHash?: string | null;
  sourceRowNumber?: number | null;
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
interface MemBankObservation {
  userId: string;
  statementId: string;
  bankTransactionId: string;
  sourceRowNumber: number;
}

const globalForRecon = globalThis as unknown as {
  __zakiLedgerRecon?: {
    statements: MemStatement[];
    bankTxns: MemBankTxn[];
    qbTxns: MemQbTxn[];
    matches: MemMatch[];
    reports: MemReport[];
    auditLog: MemAuditEntry[];
    bankObservations: MemBankObservation[];
  };
};
const mem = (globalForRecon.__zakiLedgerRecon ??= {
  statements: [],
  bankTxns: [],
  qbTxns: [],
  matches: [],
  reports: [],
  auditLog: [],
  bankObservations: [],
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
    externalTransactionId: (row.external_transaction_id as string) ?? null,
    sourceProvider: (row.source_provider as string) ?? null,
    sourceOrganisationId: (row.source_organisation_id as string) ?? null,
    sourceAccountId: (row.source_account_id as string) ?? null,
    identityFingerprint: (row.identity_fingerprint as string) ?? null,
    identityFingerprintVersion: numOrNull(row.identity_fingerprint_version),
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
    provider: (row.provider as string) ?? null,
    organisationId: (row.organisation_id as string) ?? null,
    externalObjectType: (row.external_object_type as string) ?? null,
    identityFingerprint: (row.identity_fingerprint as string) ?? null,
    identityFingerprintVersion: numOrNull(row.identity_fingerprint_version),
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
    auditMemo: (row.audit_memo as AuditMemo | null) ?? null,
    // 013 supersession columns — absent on pre-013 schemas, mapped to null.
    supersededAt: (row.superseded_at as string) ?? null,
    supersededByMatchId: (row.superseded_by_match_id as string) ?? null,
    supersedeReason: (row.supersede_reason as string) ?? null,
    supersedeOperationId: (row.supersede_operation_id as string) ?? null,
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
  options: BankIngestionOptions = {},
): Promise<BankStatementMeta> {
  // Freeze guard FIRST — before capability detection, tenant resolution, or
  // any mutation. Freeze ON means zero reconciliation writes on any schema.
  assertReconciliationWritesNotFrozen();

  const sourceProvider = parsed.sourceProvider ?? fileFormat;
  const sourceOrganisationId = parsed.sourceOrganisationId ?? null;
  const sourceAccountId = parsed.sourceAccountId ?? null;
  const sourceArtifactHash = options.sourceArtifactHash ?? null;
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
    sourceProvider,
    sourceOrganisationId,
    sourceAccountId,
    sourceArtifactHash,
  };

  const db = getSupabase();
  if (!db) {
    if (sourceArtifactHash) {
      const existing = mem.statements.find(
        (s) =>
          s.userId === userId &&
          s.sourceProvider === sourceProvider &&
          s.sourceOrganisationId === sourceOrganisationId &&
          s.sourceAccountId === sourceAccountId &&
          s.sourceArtifactHash === sourceArtifactHash,
      );
      if (existing) {
        const { userId: _userId, ...existingMeta } = existing;
        return existingMeta;
      }
    }
    mem.statements.push({ ...meta, userId });
    for (const [sourceRowNumber, t] of parsed.transactions.entries()) {
      const externalTransactionId = t.transactionId?.trim() || null;
      const strongIdentity = Boolean(sourceProvider && sourceAccountId && externalTransactionId);
      let canonical = strongIdentity
        ? mem.bankTxns.find(
            (row) =>
              row.userId === userId &&
              row.sourceProvider === sourceProvider &&
              row.sourceOrganisationId === sourceOrganisationId &&
              row.sourceAccountId === sourceAccountId &&
              row.externalTransactionId === externalTransactionId,
          )
        : undefined;
      if (!canonical) {
        canonical = {
          id: newId(),
          statementId,
          userId,
          transactionDate: t.transactionDate.value,
          postedDate: t.postedDate,
          merchant: t.merchant?.value ?? null,
          description: t.description?.value ?? null,
          amount: t.amount.value,
          currency: t.currency,
          transactionId: t.transactionId,
          memo: t.memo,
          externalTransactionId,
          sourceProvider,
          sourceOrganisationId,
          sourceAccountId,
          identityFingerprint: bankTransactionFingerprint({
            sourceProvider,
            sourceOrganisationId,
            sourceAccountId,
            transactionDate: t.transactionDate.value,
            postedDate: t.postedDate,
            amount: t.amount.value,
            currency: t.currency,
            merchant: t.merchant?.value ?? null,
            description: t.description?.value ?? null,
            reference: t.memo,
          }),
          identityFingerprintVersion: BANK_FINGERPRINT_VERSION,
        };
        mem.bankTxns.push(canonical);
      }
      if (!mem.bankObservations.some((o) => o.statementId === statementId && o.bankTransactionId === canonical!.id)) {
        mem.bankObservations.push({ userId, statementId, bankTransactionId: canonical.id, sourceRowNumber });
      }
    }
    return meta;
  }

  const transactions = parsed.transactions.map((t, sourceRowNumber) => ({
    source_row_number: sourceRowNumber,
    transaction_date: t.transactionDate.value,
    posted_date: t.postedDate,
    merchant: t.merchant?.value ?? null,
    description: t.description?.value ?? null,
    amount: t.amount.value,
    currency: t.currency,
    external_transaction_id: t.transactionId?.trim() || null,
    transaction_id: t.transactionId?.trim() || null,
    memo: t.memo,
    identity_fingerprint: bankTransactionFingerprint({
      sourceProvider,
      sourceOrganisationId,
      sourceAccountId,
      transactionDate: t.transactionDate.value,
      postedDate: t.postedDate,
      amount: t.amount.value,
      currency: t.currency,
      merchant: t.merchant?.value ?? null,
      description: t.description?.value ?? null,
      reference: t.memo,
    }),
    identity_fingerprint_version: BANK_FINGERPRINT_VERSION,
  }));

  // On a canonical-012 schema, tenant resolution and stamps are mandatory —
  // any resolution failure propagates (fail closed, no legacy fallback).
  // On pre-012, the pre-4C payload is sent unchanged: no canonical fields.
  const capability = await detectReconciliationSchemaCapability(db);
  const tenantCtx =
    capability.version === "canonical-012"
      ? await resolveTenantContextForUser(userId)
      : null;

  const { data, error } = await db.rpc("ingest_bank_statement_v1", {
    p_user_id: userId,
    p_statement: {
      id: statementId,
      file_name: fileName,
      file_format: fileFormat,
      statement_period_start: parsed.periodStart,
      statement_period_end: parsed.periodEnd,
      currency: parsed.currency,
      opening_balance: parsed.openingBalance,
      closing_balance: parsed.closingBalance,
      transaction_count: parsed.transactions.length,
      source_provider: sourceProvider,
      source_organisation_id: sourceOrganisationId,
      source_account_id: sourceAccountId,
      source_account_metadata: parsed.sourceAccountMetadata ?? null,
      source_artifact_hash: sourceArtifactHash,
      ...(tenantCtx
        ? {
            client_entity_id: tenantCtx.clientEntityId,
            ledger_book_id: tenantCtx.internalLedgerBookId,
          }
        : {}),
    },
    p_transactions: transactions,
  });
  if (error) throw new Error(`Failed to ingest bank statement atomically: ${error.message}`);
  const persistedId = (data as { statement_id?: string } | null)?.statement_id ?? statementId;
  const persisted = await getBankStatement(userId, persistedId);
  if (!persisted) throw new Error("Bank statement ingestion completed without a readable statement.");
  return persisted;
}

/**
 * The most recently uploaded statement's id, or null if the user hasn't
 * uploaded one — lets the sidebar's static "Review Matches"/"Batch Review"
 * links (no query param, unlike navigating there right after an upload) land
 * on the right statement instead of a dead end.
 */
export async function getLatestStatementId(userId: string): Promise<string | null> {
  const db = getSupabase();
  if (!db) {
    const mine = mem.statements.filter((s) => s.userId === userId);
    return mine.length > 0 ? mine[mine.length - 1].id : null;
  }

  const { data, error } = await db
    .from("bank_statements")
    .select("id")
    .eq("user_id", userId)
    .order("upload_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load latest statement: ${error.message}`);
  return (data?.id as string) ?? null;
}

/** All bank statements for a user, newest first. */
export async function listBankStatementsForUser(userId: string): Promise<BankStatementMeta[]> {
  const db = getSupabase();
  if (!db) {
    return mem.statements
      .filter((s) => s.userId === userId)
      .map(({ userId: _u, ...rest }) => rest)
      .reverse();
  }

  const { data, error } = await db
    .from("bank_statements")
    .select()
    .eq("user_id", userId)
    .order("upload_date", { ascending: false });
  if (error) throw new Error(`Failed to load bank statements: ${error.message}`);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    fileName: (row.file_name as string) ?? null,
    fileFormat: row.file_format as string,
    periodStart: (row.statement_period_start as string) ?? null,
    periodEnd: (row.statement_period_end as string) ?? null,
    currency: (row.currency as string) ?? null,
    openingBalance: numOrNull(row.opening_balance),
    closingBalance: numOrNull(row.closing_balance),
    transactionCount: Number(row.transaction_count ?? 0),
    sourceProvider: (row.source_provider as string) ?? null,
    sourceOrganisationId: (row.source_organisation_id as string) ?? null,
    sourceAccountId: (row.source_account_id as string) ?? null,
    sourceArtifactHash: (row.source_artifact_hash as string) ?? null,
  }));
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
    sourceProvider: (data.source_provider as string) ?? null,
    sourceOrganisationId: (data.source_organisation_id as string) ?? null,
    sourceAccountId: (data.source_account_id as string) ?? null,
    sourceArtifactHash: (data.source_artifact_hash as string) ?? null,
  };
}

export async function listBankTransactions(userId: string, statementId: string): Promise<BankTransaction[]> {
  const db = getSupabase();
  if (!db) {
    const observedIds = new Set(
      mem.bankObservations
        .filter((o) => o.statementId === statementId && o.userId === userId)
        .map((o) => o.bankTransactionId),
    );
    return mem.bankTxns
      .filter((t) => t.userId === userId && (observedIds.has(t.id) || t.statementId === statementId))
      .map(({ userId: _u, ...rest }) => ({ ...rest, statementId }));
  }

  const { data, error } = await db.rpc("list_statement_bank_transactions_v1", {
    p_user_id: userId,
    p_statement_id: statementId,
  });
  if (error) throw new Error(`Failed to load bank transactions: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => ({ ...mapBankTxnRow(r), statementId }));
}

// --- QB/Xero transactions ------------------------------------------------

/**
 * Bulk-import QB/Xero transactions for the current user. Today this is
 * called from POST /api/reconciliation/qb-transactions (a manual/test-data
 * stand-in); tomorrow's live QB/Xero sync calls this exact function with
 * data pulled from their APIs instead of growing a second write path.
 */
export async function saveQbTransactions(
  userId: string,
  transactions: QbTransactionInput[],
  options: AccountingIngestionOptions = {},
): Promise<number> {
  assertReconciliationWritesNotFrozen();

  const db = getSupabase();
  if (!db) {
    let inserted = 0;
    for (const [sourceRowNumber, t] of transactions.entries()) {
      const provider = t.provider ?? options.provider ?? null;
      const organisationId = t.organisationId ?? options.organisationId ?? null;
      const externalObjectType = t.externalObjectType ?? options.externalObjectType ?? null;
      const externalId = t.qbTransactionId?.trim() || null;
      const strongIdentity = Boolean(provider && organisationId && externalObjectType && externalId);
      const artifactMatch = options.sourceArtifactHash
        ? mem.qbTxns.find(
            (row) =>
              row.userId === userId &&
              row.provider === provider &&
              row.organisationId === organisationId &&
              row.sourceArtifactHash === options.sourceArtifactHash &&
              row.sourceRowNumber === sourceRowNumber,
          )
        : undefined;
      const identityMatch = strongIdentity
        ? mem.qbTxns.find(
            (row) =>
              row.userId === userId &&
              row.provider === provider &&
              row.organisationId === organisationId &&
              row.externalObjectType === externalObjectType &&
              row.qbTransactionId === externalId,
          )
        : undefined;
      if (artifactMatch && identityMatch && artifactMatch.id !== identityMatch.id) {
        // The two database-backed retry keys must identify one canonical row.
        // Picking either would silently collapse distinct financial records.
        throw new Error("Provider identity conflicts with artifact identity.");
      }
      if (artifactMatch || identityMatch) continue;
      mem.qbTxns.push({
        id: newId(),
        userId,
        qbTransactionId: externalId,
        qbAccountId: t.qbAccountId ?? null,
        postedDate: t.postedDate,
        amount: t.amount,
        description: t.description ?? null,
        accountName: t.accountName ?? null,
        accountType: t.accountType ?? null,
        currency: t.currency ?? null,
        provider,
        organisationId,
        externalObjectType,
        identityFingerprint: accountingTransactionFingerprint({
          provider,
          organisationId,
          externalObjectType,
          accountId: t.qbAccountId ?? null,
          postedDate: t.postedDate,
          amount: t.amount,
          currency: t.currency ?? null,
          description: t.description ?? null,
        }),
        identityFingerprintVersion: ACCOUNTING_FINGERPRINT_VERSION,
        sourceArtifactHash: options.sourceArtifactHash ?? null,
        sourceRowNumber,
      });
      inserted += 1;
    }
    return inserted;
  }

  if (transactions.length === 0) return 0;
  const payload = transactions.map((t, sourceRowNumber) => {
    const provider = t.provider ?? options.provider ?? null;
    const organisationId = t.organisationId ?? options.organisationId ?? null;
    const externalObjectType = t.externalObjectType ?? options.externalObjectType ?? null;
    return {
      id: newId(),
      qb_transaction_id: t.qbTransactionId?.trim() || null,
      qb_account_id: t.qbAccountId ?? null,
      posted_date: t.postedDate,
      amount: t.amount,
      description: t.description ?? null,
      account_name: t.accountName ?? null,
      account_type: t.accountType ?? null,
      currency: t.currency ?? null,
      provider,
      organisation_id: organisationId,
      external_object_type: externalObjectType,
      identity_fingerprint: accountingTransactionFingerprint({
        provider,
        organisationId,
        externalObjectType,
        accountId: t.qbAccountId ?? null,
        postedDate: t.postedDate,
        amount: t.amount,
        currency: t.currency ?? null,
        description: t.description ?? null,
      }),
      identity_fingerprint_version: ACCOUNTING_FINGERPRINT_VERSION,
      source_artifact_hash: options.sourceArtifactHash ?? null,
      source_row_number: sourceRowNumber,
    };
  });

  // Canonical-012: resolve tenant and stamp every item — mandatory, no
  // fallback. Pre-012: pre-4C payload without canonical fields.
  const capability = await detectReconciliationSchemaCapability(db);
  const tenantCtx =
    capability.version === "canonical-012"
      ? await resolveTenantContextForUser(userId)
      : null;
  const stampedPayload = tenantCtx
    ? payload.map((item) => ({
        ...item,
        client_entity_id: tenantCtx.clientEntityId,
        ledger_book_id: tenantCtx.internalLedgerBookId,
      }))
    : payload;

  const { data, error } = await db.rpc("ingest_accounting_transactions_v1", {
    p_user_id: userId,
    p_transactions: stampedPayload,
  });
  if (error) throw new Error(`Failed to ingest accounting transactions atomically: ${error.message}`);
  return Number((data as { inserted_count?: number } | null)?.inserted_count ?? 0);
}

/**
 * QB transactions posted within [start, end] (padded by DATE_PENDING_DAYS on
 * each side, since a transaction can legitimately match across that window —
 * see the matching algorithm's pending-clearance case). Falls back to every
 * QB transaction the user has when the statement carries no period.
 *
 * `scope` narrows the pool to one canonical client entity + ledger book
 * (hardening invariant G). Auto-matching passes it; manual matching
 * deliberately does not, so a human can override anything.
 */
export interface QbPeriodScope {
  clientEntityId: string;
  ledgerBookId: string;
}

export async function listQbTransactionsForPeriod(
  userId: string,
  periodStart: string | null,
  periodEnd: string | null,
  scope?: QbPeriodScope | null,
): Promise<QbTransaction[]> {
  const db = getSupabase();
  const paddedStart = periodStart ? addDays(periodStart, -DATE_PENDING_DAYS) : null;
  const paddedEnd = periodEnd ? addDays(periodEnd, DATE_PENDING_DAYS) : null;

  if (!db) {
    // The in-memory fallback has no tenant stamps on its rows, so scope is a
    // no-op here — tenant isolation is a Postgres-layer concern (see the
    // migration 012 tenant-isolation tests).
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
  if (scope) query = query.eq("client_entity_id", scope.clientEntityId).eq("ledger_book_id", scope.ledgerBookId);

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
 * Every match row belonging to this user, live and superseded.
 *
 * QB ids consumed by live matches: `listMatchedQbIds` below. On canonical-013
 * schemas the claim classes are split by `reservesQbClaim` — a sub-green
 * unapproved auto suggestion does NOT permanently reserve its QB row (defect
 * D2) — while approved/manual/green rows keep the hardening invariants A/B
 * (one QB row, one live claim). On pre-013 schemas every live match consumes
 * its QB row, exactly as before.
 */
async function listAllMatchesForUser(userId: string): Promise<ReconciliationMatch[]> {
  const db = getSupabase();
  if (!db) {
    return mem.matches
      .filter((m) => m.userId === userId)
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db.from("reconciliation_matches").select().eq("user_id", userId);
  if (error) throw new Error(`Failed to load matches: ${error.message}`);
  return (data ?? []).map((r) => mapMatchRow(r as Record<string, unknown>));
}

async function listMatchedQbIds(userId: string, claimGuard: "pre-013" | "canonical-013"): Promise<Set<string>> {
  const all = await listAllMatchesForUser(userId);
  const live = all.filter((m) => m.supersededAt === null);
  return new Set(
    live
      .filter((m) => (claimGuard === "canonical-013" ? reservesQbClaim(m) : true))
      .map((m) => m.qbTransactionId)
      .filter((id): id is string => id !== null),
  );
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
  assertReconciliationWritesNotFrozen();

  const statement = await getBankStatement(userId, statementId);
  if (!statement) throw new Error("Statement not found.");

  // Canonical-012 tenant scope + matched-QB exclusion both narrow the
  // candidate pool before scoring (hardening invariants A/B/G). On
  // canonical-013 the exclusion follows the claim classes
  // (reservesQbClaim), and persistence goes through the atomic RPC whose
  // exclusive-claim index + lock scan make the pre-read an optimization
  // rather than the safety mechanism (defects D1/D2).
  const db = getSupabase();
  const capability = db ? await detectReconciliationSchemaCapability(db) : null;
  const claimGuard = await detectReconciliationClaimGuardCapability(db);
  const tenantCtx =
    db && capability?.version === "canonical-012" ? await resolveTenantContextForUser(userId) : null;

  const bankTransactions = await listBankTransactions(userId, statementId);
  const qbTransactions = await listQbTransactionsForPeriod(
    userId,
    statement.periodStart,
    statement.periodEnd,
    tenantCtx ? { clientEntityId: tenantCtx.clientEntityId, ledgerBookId: tenantCtx.internalLedgerBookId } : null,
  );
  const existing = await listMatchesForStatement(userId, statementId);
  const alreadyMatchedBankIds = new Set(
    existing.filter((m) => m.supersededAt === null).map((m) => m.bankTransactionId),
  );

  // Canonical-013: split the user's live matches into reserved claims and
  // sub-green unapproved auto holders that stay re-scorable (D2).
  const allUserMatches = await listAllMatchesForUser(userId);
  const liveUserMatches = allUserMatches.filter((m) => m.supersededAt === null);
  const consumedQbIds = new Set(
    liveUserMatches
      .filter((m) => (claimGuard.version === "canonical-013" ? reservesQbClaim(m) : true))
      .map((m) => m.qbTransactionId)
      .filter((id): id is string => id !== null),
  );
  const holdersByQb = new Map<string, ReconciliationMatch>();
  if (claimGuard.version === "canonical-013") {
    for (const m of liveUserMatches) {
      const qbId = m.qbTransactionId;
      if (m.matchedBy === "auto" && m.approvedAt === null && qbId && !reservesQbClaim(m)) {
        holdersByQb.set(qbId, m);
      }
    }
  }

  const toScore = bankTransactions.filter((b) => !alreadyMatchedBankIds.has(b.id));
  const eligibleQbTransactions = qbTransactions.filter((q) => !consumedQbIds.has(q.id));
  let result = matchTransactions(toScore, eligibleQbTransactions);

  // Deterministic claim resolution: QB ids whose holder may not be
  // superseded are removed from the pool and the assignment is recomputed.
  // Supersedable holders stay in the proposal — the persist RPC performs
  // the supersession itself under row locks, so the app never mutates
  // historical rows directly.
  if (claimGuard.version === "canonical-013") {
    const blockedQbIds = new Set<string>();
    for (const m of result.matches) {
      const qbId = m.qbTransactionId;
      const holder = qbId ? holdersByQb.get(qbId) : undefined;
      if (holder && !shouldSupersedeAutoMatch(holder, Math.round(m.confidence * 100)) && qbId) {
        blockedQbIds.add(qbId);
      }
    }
    if (blockedQbIds.size > 0) {
      result = matchTransactions(
        toScore,
        eligibleQbTransactions.filter((q) => !blockedQbIds.has(q.id)),
      );
    }
  }

  // Generate audit memos for new auto-matches before persisting
  const auditMemos = await generateAuditMemos(result.matches, bankTransactions, qbTransactions);
  const memoByBankId = new Map(auditMemos.map((m) => [m.matchId, m]));

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
          auditMemo: memoByBankId.get(m.bankTransactionId) ?? null,
          supersededAt: null,
          supersededByMatchId: null,
          supersedeReason: null,
          supersedeOperationId: null,
        });
      }
    } else if (claimGuard.version === "canonical-013" && tenantCtx) {
      // Atomic persistence with exclusive-claim resolution (D1/D2). The RPC
      // re-checks every claim under row locks and the partial unique index —
      // a concurrent writer loses deterministically ('conflicted'), never
      // corrupting state. Supersession is audit-logged inside the RPC.
      const payload = result.matches.map((m) => ({
        id: newId(),
        bank_transaction_id: m.bankTransactionId,
        qb_transaction_id: m.qbTransactionId,
        confidence: m.confidence,
        match_reason: m.matchReason,
        flagged_level: m.flaggedLevel,
        matched_at: nowIso,
        audit_memo: memoByBankId.get(m.bankTransactionId) ?? null,
      }));
      const { data, error } = await db.rpc("persist_auto_matches_v1", {
        p_user_id: userId,
        p_statement_id: statementId,
        p_client_entity_id: tenantCtx.clientEntityId,
        p_matches: payload,
      });
      if (error) throw new Error(`Failed to persist auto matches: ${error.message}`);
      // Deterministic review result for concurrent losers: their proposed
      // bank rows land back in the unmatched pool below (no row persisted).
      void data;
    } else {
      // Pre-013 write path — unchanged legacy semantics.
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
          audit_memo: memoByBankId.get(m.bankTransactionId) ?? null,
          ...(tenantCtx ? { client_entity_id: tenantCtx.clientEntityId } : {}),
        })),
        { onConflict: "bank_transaction_id,statement_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`Failed to persist auto matches: ${error.message}`);
    }
  }

  const allMatches = await listMatchesForStatement(userId, statementId);
  const liveMatches = allMatches.filter((m) => m.supersededAt === null);
  const matchedBankIds = new Set(liveMatches.map((m) => m.bankTransactionId));
  const matchedQbIds = new Set(liveMatches.map((m) => m.qbTransactionId).filter((id): id is string => id !== null));

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
 *
 * Defect remediation semantics:
 *  - D4: an APPROVED row is never silently rewritten — the manual override
 *    refuses with a controlled error; the accountant must go through the
 *    audited unapprove path first.
 *  - D6: the human override may search the whole tenant client/book pool —
 *    the ±5-day window is an auto-matching heuristic, not an accounting
 *    boundary. Tenant/client/book checks are still enforced at write time
 *    by the 012 composite FKs, the same-client trigger, and the 013
 *    book-alignment trigger.
 *  - D2: creating the manual row supersedes (audit-logged) any live
 *    unapproved auto suggestion holding the same QB row — a human decision
 *    outranks a machine suggestion.
 */
export async function createManualMatch(
  userId: string,
  statementId: string,
  bankTransactionId: string,
  qbTransactionId: string,
): Promise<ReconciliationMatch> {
  assertReconciliationWritesNotFrozen();

  const bankTxns = await listBankTransactions(userId, statementId);
  const bank = bankTxns.find((t) => t.id === bankTransactionId);
  if (!bank) throw new Error("Bank transaction not found on this statement.");

  const statement = await getBankStatement(userId, statementId);

  const db = getSupabase();
  const capability = db ? await detectReconciliationSchemaCapability(db) : null;
  const tenantCtx =
    db && capability?.version === "canonical-012" ? await resolveTenantContextForUser(userId) : null;

  // D6: no date window for a manual override — search the full pool. On
  // canonical-012 the pool is additionally narrowed to the user's canonical
  // client + ledger book (invariant G's tenant scope stays intact).
  const qbTxns = await listQbTransactionsForPeriod(
    userId,
    null,
    null,
    tenantCtx ? { clientEntityId: tenantCtx.clientEntityId, ledgerBookId: tenantCtx.internalLedgerBookId } : null,
  );
  const qb = qbTxns.find((t) => t.id === qbTransactionId);
  if (!qb) throw new Error("QB transaction not found.");

  const { score, reasons } = scorePair(bank, qb);
  const confidence = Math.min(score / 100, 1);
  const flaggedLevel: FlaggedLevel = "green"; // a human confirmed it directly — no review needed
  const matchReason = reasons.length > 0 ? `manual override (${reasons.join(" + ")})` : "manual override";
  const nowIso = new Date().toISOString();

  // Generate a single PERFECT_MATCH audit memo for manual matches
  const manualProposedMatch: ProposedMatch = {
    bankTransactionId,
    qbTransactionId,
    confidence,
    matchReason,
    flaggedLevel,
  };
  const [manualMemo] = await generateAuditMemos([manualProposedMatch], [bank], [qb]);

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
      auditMemo: manualMemo ?? null,
      supersededAt: null,
      supersededByMatchId: null,
      supersedeReason: null,
      supersedeOperationId: null,
    };
    if (existingIdx >= 0) mem.matches[existingIdx] = row;
    else mem.matches.push(row);
    const { userId: _u, ...rest } = row;
    return rest;
  }

  // D4: an approved row is immutable-by-default — refuse the override with a
  // controlled error instead of letting the DB guard fire opaquely.
  const { data: existingRow, error: existingError } = await db
    .from("reconciliation_matches")
    .select("approved_at, matched_by, confidence, qb_transaction_id")
    .eq("statement_id", statementId)
    .eq("bank_transaction_id", bankTransactionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to load existing match: ${existingError.message}`);
  if (existingRow?.approved_at) {
    throw new Error(
      "This match is already approved. Clear its approval (unapprove) before overriding it.",
    );
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
        audit_memo: manualMemo ?? null,
        ...(tenantCtx ? { client_entity_id: tenantCtx.clientEntityId } : {}),
      },
      { onConflict: "bank_transaction_id,statement_id" },
    )
    .select()
    .single();
  if (error) throw new Error(`Failed to save manual match: ${error.message}`);
  const saved = mapMatchRow(data as Record<string, unknown>);

  // D2 sweep: the human decision supersedes live unapproved auto suggestions
  // holding the same QB row (audit-logged inside the RPC). Approved rows are
  // untouched by construction of the RPC.
  const claimGuard = await detectReconciliationClaimGuardCapability(db);
  if (claimGuard.version === "canonical-013" && tenantCtx) {
    const { error: sweepError } = await db.rpc("supersede_auto_claims_v1", {
      p_user_id: userId,
      p_client_entity_id: tenantCtx.clientEntityId,
      p_qb_transaction_id: qbTransactionId,
      p_reason: "manual_override",
      p_operation_id: crypto.randomUUID(),
    });
    if (sweepError) throw new Error(`Failed to sweep auto claims: ${sweepError.message}`);
  }

  // Audit the override itself when it replaced an automatic suggestion —
  // same append-only log the approval transitions use.
  if (existingRow && existingRow.matched_by === "auto") {
    const { error: auditError } = await db.from("reconciliation_audit_log").insert({
      id: newId(),
      reconciliation_match_id: saved.id,
      action: "match_manual_override",
      action_by: userId,
      action_at: nowIso,
      old_confidence: existingRow.confidence ?? null,
      new_confidence: confidence,
      ...(tenantCtx
        ? {
            user_id: userId,
            client_entity_id: tenantCtx.clientEntityId,
          }
        : {}),
    });
    if (auditError) throw new Error(`Failed to write audit log: ${auditError.message}`);
  }

  return saved;
}

/**
 * Reject a proposed (not-yet-approved) match — the human decided the
 * candidate is wrong, so the bank transaction goes back to unmatched rather
 * than being force-approved. Only unapproved matches can be rejected: once
 * `approveMatches` has stamped one, it's part of the immutable audit trail
 * (same compliance rule as the brief's "can't delete reconciliations") and
 * this refuses to touch it.
 */
export async function rejectMatch(userId: string, statementId: string, matchId: string): Promise<void> {
  assertReconciliationWritesNotFrozen();

  const db = getSupabase();
  if (!db) {
    const idx = mem.matches.findIndex((m) => m.id === matchId && m.statementId === statementId && m.userId === userId);
    if (idx < 0) throw new Error("Match not found.");
    if (mem.matches[idx].approvedAt) throw new Error("Cannot reject an already-approved match.");
    mem.matches.splice(idx, 1);
    return;
  }

  const { data: existing, error: fetchError } = await db
    .from("reconciliation_matches")
    .select("approved_at, superseded_at")
    .eq("id", matchId)
    .eq("statement_id", statementId)
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchError) throw new Error(`Failed to load match: ${fetchError.message}`);
  if (!existing) throw new Error("Match not found.");
  if (existing.approved_at) throw new Error("Cannot reject an already-approved match.");
  // Superseded rows are preserved historical evidence; the DB guard refuses
  // the delete anyway — surface the same rule with a readable message.
  if (existing.superseded_at) throw new Error("Match is already superseded.");

  const { error } = await db
    .from("reconciliation_matches")
    .delete()
    .eq("id", matchId)
    .eq("statement_id", statementId)
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to reject match: ${error.message}`);
}

/** Most recently approved matches — one of the sources for the Dashboard's "Recent activity" feed. */
export async function listRecentApprovedMatches(userId: string, limit = 5): Promise<{ approvedAt: string }[]> {
  const db = getSupabase();
  if (!db) {
    return mem.matches
      .filter((m) => m.userId === userId && m.approvedAt !== null)
      .sort((a, b) => (a.approvedAt! < b.approvedAt! ? 1 : -1))
      .slice(0, limit)
      .map((m) => ({ approvedAt: m.approvedAt! }));
  }

  const { data, error } = await db
    .from("reconciliation_matches")
    .select("approved_at")
    .eq("user_id", userId)
    .not("approved_at", "is", null)
    .order("approved_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load recent matches: ${error.message}`);
  return (data ?? []).map((r) => ({ approvedAt: r.approved_at as string }));
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
  assertReconciliationWritesNotFrozen();

  const allMatches = await listMatchesForStatement(userId, statementId);
  // Superseded rows are historical evidence — they can never be approved.
  const toApprove = allMatches.filter(
    (m) => matchIds.includes(m.id) && m.supersededAt === null,
  );
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
    const claimGuardApprove = await detectReconciliationClaimGuardCapability(db);
    if (claimGuardApprove.version === "canonical-013") {
      // Controlled approval (invariant L): the DB guard makes approval-field
      // transitions impossible through raw UPDATE, and this RPC is the only
      // way into the approved state. It applies the transition and its audit
      // evidence in one transaction, ownership- and eligibility-checked, and
      // skips already-approved/superseded ids deterministically.
      const { data, error } = await db.rpc("approve_reconciliation_matches_service_v1", {
        p_user_id: userId,
        p_statement_id: statementId,
        p_match_ids: toApprove.map((m) => m.id),
        p_approved_by: approvedBy,
        p_operation_id: crypto.randomUUID(),
      });
      if (error) throw new Error(`Failed to approve matches: ${error.message}`);
      void data;
      return generateReport(userId, statementId);
    }

    // Pre-013 write path — unchanged legacy semantics (no DB approval gate).
    // Scoped by statement_id + user_id, not just id — the ids in `toApprove`
    // are already filtered to this statement/user by listMatchesForStatement
    // above, but the write itself must enforce that too: an .update().in("id", ...)
    // with no other predicate is one bad/forged id away from stamping approval
    // on a row outside this statement or tenant. Belt + suspenders is what
    // "can't touch another user's ledger" has to mean at the database layer,
    // not just at the filter that built the id list.
    const { error: updateError } = await db
      .from("reconciliation_matches")
      .update({ approved_by: approvedBy, approved_at: nowIso })
      .in(
        "id",
        toApprove.map((m) => m.id),
      )
      .eq("statement_id", statementId)
      .eq("user_id", userId);
    if (updateError) throw new Error(`Failed to approve matches: ${updateError.message}`);

    const capabilityApprove = await detectReconciliationSchemaCapability(db);
    const tenantCtxApprove =
      capabilityApprove.version === "canonical-012"
        ? await resolveTenantContextForUser(userId)
        : null;
    const { error: auditError } = await db.from("reconciliation_audit_log").insert(
      toApprove.map((m) => ({
        id: newId(),
        reconciliation_match_id: m.id,
        action: "match_approved",
        action_by: approvedBy,
        action_at: nowIso,
        old_confidence: m.confidence,
        new_confidence: m.confidence,
        ...(tenantCtxApprove
          ? {
              user_id: userId,
              client_entity_id: tenantCtxApprove.clientEntityId,
            }
          : {}),
      })),
    );
    if (auditError) throw new Error(`Failed to write audit log: ${auditError.message}`);
  }

  return generateReport(userId, statementId);
}

/**
 * Undo: clears approval on a set of matches, restoring them to the open
 * (unapproved) pool, with the same audit-log entry approveMatches writes —
 * "undo" is a real, logged action, not a silent state rewind. Only matches
 * that belong to this statement/user and are currently approved are
 * touched; the returned count is how many actually were.
 */
export async function unapproveMatches(userId: string, statementId: string, matchIds: string[]): Promise<number> {
  assertReconciliationWritesNotFrozen();

  const allMatches = await listMatchesForStatement(userId, statementId);
  const toRevert = allMatches.filter(
    (m) => matchIds.includes(m.id) && m.approvedAt !== null && m.supersededAt === null,
  );
  if (toRevert.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const db = getSupabase();

  if (!db) {
    for (const m of toRevert) {
      const idx = mem.matches.findIndex((row) => row.id === m.id);
      if (idx >= 0) {
        mem.matches[idx] = { ...mem.matches[idx], approvedBy: null, approvedAt: null };
      }
      mem.auditLog.push({
        id: newId(),
        reconciliationMatchId: m.id,
        action: "match_unapproved",
        actionBy: userId,
        actionAt: nowIso,
        oldConfidence: m.confidence,
        newConfidence: m.confidence,
      });
    }
  } else {
    const claimGuard = await detectReconciliationClaimGuardCapability(db);
    if (claimGuard.version === "canonical-013") {
      // Controlled correction path (D4): the DB guard makes approved rows
      // immutable to raw DML, and this RPC is the only way to clear
      // approval. It writes the audit event itself, inside the same
      // transaction as the update.
      const { data, error } = await db.rpc("unapprove_reconciliation_matches_v1", {
        p_user_id: userId,
        p_match_ids: toRevert.map((m) => m.id),
      });
      if (error) throw new Error(`Failed to unapprove matches: ${error.message}`);
      const unapproved = (data as { unapproved?: string[] } | null)?.unapproved ?? [];
      return unapproved.length;
    }

    // Pre-013 write path — unchanged legacy semantics.
    // Same statement_id + user_id scoping as approveMatches above — an id-only
    // .in() filter on a mutating update is never enough on its own.
    const { error: updateError } = await db
      .from("reconciliation_matches")
      .update({ approved_by: null, approved_at: null })
      .in(
        "id",
        toRevert.map((m) => m.id),
      )
      .eq("statement_id", statementId)
      .eq("user_id", userId);
    if (updateError) throw new Error(`Failed to unapprove matches: ${updateError.message}`);

    const capabilityUnapprove = await detectReconciliationSchemaCapability(db);
    const tenantCtxUnapprove =
      capabilityUnapprove.version === "canonical-012"
        ? await resolveTenantContextForUser(userId)
        : null;
    const { error: auditError } = await db.from("reconciliation_audit_log").insert(
      toRevert.map((m) => ({
        id: newId(),
        reconciliation_match_id: m.id,
        action: "match_unapproved",
        action_by: userId,
        action_at: nowIso,
        old_confidence: m.confidence,
        new_confidence: m.confidence,
        ...(tenantCtxUnapprove
          ? {
              user_id: userId,
              client_entity_id: tenantCtxUnapprove.clientEntityId,
            }
          : {}),
      })),
    );
    if (auditError) throw new Error(`Failed to write audit log: ${auditError.message}`);
  }

  return toRevert.length;
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
  // generateReport is only reached through approveMatches, which already
  // asserts not-frozen; the guard repeats here so a future direct caller
  // cannot persist a report while the freeze is on.
  assertReconciliationWritesNotFrozen();

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

  // Preserve the existing report's id on update instead of minting a fresh
  // uuid every regeneration — otherwise `report.id` changes (and old
  // reconciliation_reports rows with a now-orphaned id survive if
  // onConflict:"statement_id" ever stops matching, e.g. under a future
  // composite key). Reading the current id first keeps this upsert genuinely
  // idempotent on the row's primary key, not just on statement_id.
  const { data: existingReport } = await db
    .from("reconciliation_reports")
    .select("id")
    .eq("statement_id", statementId)
    .eq("user_id", userId)
    .maybeSingle();
  const reportId = (existingReport?.id as string) ?? report.id;

  const capabilityReport = await detectReconciliationSchemaCapability(db);
  const tenantCtxReport =
    capabilityReport.version === "canonical-012"
      ? await resolveTenantContextForUser(userId)
      : null;
  const { data, error } = await db
    .from("reconciliation_reports")
    .upsert(
      {
        id: reportId,
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
        ...(tenantCtxReport ? { client_entity_id: tenantCtxReport.clientEntityId } : {}),
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
