import type { DocumentType, InvoiceExtraction, ReviewableField } from "./schema";
import { getSupabase } from "./supabase";

/**
 * A single human correction — the atomic unit of the moat.
 * This mirrors the `corrections` table in db/schema.sql.
 *
 * Storage is Supabase/Postgres when configured (see lib/supabase.ts); otherwise
 * an in-memory fallback keeps the skeleton runnable without a database. The
 * interface is what matters; the storage is swappable.
 */
export interface Correction {
  id: string;
  createdAt: string;
  invoiceId?: string; // links the correction back to the approved invoice
  supplierName: string; // who the invoice was from — key for per-vendor learning
  field: ReviewableField; // which field the human changed
  aiValue: string; // what the AI predicted
  humanValue: string; // what the human corrected it to
  aiConfidence: number; // how confident the AI was when it got it wrong/right
}

/**
 * A single confirmation — the human approved a field exactly as the AI read it.
 * The counterpart to a Correction: evidence the read was right. Mirrors the
 * `confirmations` table in db/schema.sql. Aggregated per supplier + field to
 * calibrate confidence upward on a proven track record (see lib/calibration.ts).
 */
export interface Confirmation {
  id: string;
  createdAt: string;
  invoiceId?: string;
  supplierName: string;
  field: ReviewableField;
  value: string; // the confirmed value
  confidence: number; // the (calibrated) confidence shown when it was confirmed — the trust floor
}

/** The approved, human-verified final values written to the `invoices` table. */
export interface ApprovedInvoice {
  documentType: DocumentType;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string | null; // ISO date, or null when unreadable
  currency: string;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  overallConfidence: number;
}

/** Lightweight document identity used by duplicate detection. */
export interface StoredInvoiceSummary {
  id: string;
  documentType: DocumentType;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  /** Needed to identify a receipt, which often has no number to match on. */
  total: number | null;
  status: string; // 'approved' | 'pending_review'
  createdAt: string; // when it was first processed into the system
}

/**
 * How an approval pass ended for a pending document. Defined here (rather than in
 * the bulk-approve module) so the store, which records it, doesn't depend on the
 * higher-level module that produces it.
 */
export type PendingOutcome = "approved" | "blocked" | "error";

/**
 * A document that has been read but not yet approved — the queue bulk approve
 * operates on. Extraction is held verbatim so approval works from exactly what
 * the human saw, and so an ID is all a client needs to send.
 */
export interface PendingDocument {
  id: string;
  createdAt: string;
  filename: string | null;
  extraction: InvoiceExtraction;
  /** 'pending' while it still needs handling; 'resolved' once it entered the ledger. */
  status: "pending" | "resolved";
  /** Outcome of the most recent approval attempt (null until one is made). */
  lastOutcome: PendingOutcome | null;
  /** Why it was blocked or errored, in the human's words. */
  lastReason: string | null;
  /** The approved invoice row this became, when it got that far. */
  invoiceId: string | null;
}

// --- In-memory fallback (used only when Supabase isn't configured) ----------

/**
 * The fallback store is hung off `globalThis` rather than kept in module scope,
 * because module scope is not shared where it needs to be.
 *
 * Next.js bundles each route handler separately, so `lib/store.ts` is
 * instantiated once per route: a plain module-level array would give /api/extract
 * and /api/approve/bulk two different stores, and a document queued by one route
 * would simply not exist to the other. (Dev-mode hot reload re-instantiates
 * modules too, which would wipe the queue on every edit.) One global object gives
 * every bundle the same arrays.
 *
 * This only affects the keyless/no-database mode. With Supabase configured these
 * arrays are never touched — Postgres is the shared state.
 *
 * Every entry carries a `userId` tag (not part of the public interfaces above —
 * callers already scoped their query, so it isn't echoed back) purely so the
 * in-memory fallback can filter the same way `.eq("user_id", userId)` does
 * against Postgres.
 */
interface MemoryStore {
  corrections: (Correction & { userId: string })[];
  invoices: (StoredInvoiceSummary & { userId: string })[];
  confirmations: (Confirmation & { userId: string })[];
  pending: (PendingDocument & { userId: string })[];
}

const globalForMemory = globalThis as unknown as { __zakiLedgerMemory?: MemoryStore };
const memory: MemoryStore = (globalForMemory.__zakiLedgerMemory ??= {
  corrections: [],
  invoices: [],
  confirmations: [],
  pending: [],
});

const memCorrections = memory.corrections;
const memInvoices = memory.invoices;
const memConfirmations = memory.confirmations;
const memPending = memory.pending;

function mapCorrectionRow(row: Record<string, unknown>): Correction {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    invoiceId: (row.invoice_id as string) ?? undefined,
    supplierName: String(row.supplier_name),
    field: row.field as ReviewableField,
    aiValue: (row.ai_value as string) ?? "",
    humanValue: (row.human_value as string) ?? "",
    aiConfidence: Number(row.ai_confidence ?? 0),
  };
}

/** Columns needed to identify a stored document in a duplicate check. */
const DUP_COLUMNS = "id, document_type, supplier_name, invoice_number, invoice_date, total, status, created_at";

function mapSummaryRow(row: Record<string, unknown>): StoredInvoiceSummary {
  return {
    id: String(row.id),
    // Rows written before receipts existed have no document_type; they're invoices.
    documentType: ((row.document_type as DocumentType) ?? "invoice") as DocumentType,
    supplierName: String(row.supplier_name),
    invoiceNumber: String(row.invoice_number ?? ""),
    invoiceDate: (row.invoice_date as string) ?? null,
    total: row.total === null || row.total === undefined ? null : Number(row.total),
    status: String(row.status),
    createdAt: String(row.created_at),
  };
}

function mapConfirmationRow(row: Record<string, unknown>): Confirmation {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    invoiceId: (row.invoice_id as string) ?? undefined,
    supplierName: String(row.supplier_name),
    field: row.field as ReviewableField,
    value: (row.value as string) ?? "",
    confidence: Number(row.confidence ?? 0),
  };
}

/**
 * Append a correction to the ledger. Append-only: corrections are historical
 * facts, never updated or deleted.
 */
export async function recordCorrection(
  userId: string,
  c: Omit<Correction, "id" | "createdAt">,
): Promise<Correction> {
  const db = getSupabase();
  if (!db) {
    const entry: Correction & { userId: string } = {
      ...c,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      userId,
    };
    memCorrections.push(entry);
    return entry;
  }

  const { data, error } = await db
    .from("corrections")
    .insert({
      invoice_id: c.invoiceId ?? null,
      user_id: userId,
      supplier_name: c.supplierName,
      field: c.field,
      ai_value: c.aiValue,
      human_value: c.humanValue,
      ai_confidence: c.aiConfidence,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to record correction: ${error.message}`);
  return mapCorrectionRow(data as Record<string, unknown>);
}

/**
 * Append a confirmation to the ledger — the human approved this field exactly as
 * read. Append-only, same as corrections: a historical fact about a correct read.
 */
export async function recordConfirmation(
  userId: string,
  c: Omit<Confirmation, "id" | "createdAt">,
): Promise<Confirmation> {
  const db = getSupabase();
  if (!db) {
    const entry: Confirmation & { userId: string } = {
      ...c,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      userId,
    };
    memConfirmations.push(entry);
    return entry;
  }

  const { data, error } = await db
    .from("confirmations")
    .insert({
      invoice_id: c.invoiceId ?? null,
      user_id: userId,
      supplier_name: c.supplierName,
      field: c.field,
      value: c.value,
      confidence: c.confidence,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to record confirmation: ${error.message}`);
  return mapConfirmationRow(data as Record<string, unknown>);
}

/** Per-field confirmation stats used to calibrate confidence. */
export interface ConfirmationStat {
  /** Confirmed-correct reads since the last correction for this supplier/field. */
  count: number;
  /** Highest confidence confirmed since then — the established-trust floor. */
  floor: number;
}

/**
 * Per-field confirmation stats for a supplier, counting only confirmations since
 * the most recent correction for that field. An edit means the system got that
 * field wrong, so it resets the track record: the count (calibration bonus) and
 * the floor (established trust) both rebuild from scratch afterwards.
 *
 * Scoped to `userId`: one bookkeeper's history with a supplier doesn't calibrate
 * another bookkeeper's reads of a similarly-named supplier.
 */
export async function confirmationStatsForSupplier(
  userId: string,
  supplierName: string,
): Promise<Partial<Record<ReviewableField, ConfirmationStat>>> {
  const supplier = supplierName.toLowerCase();

  let corrections: Pick<Correction, "field" | "createdAt">[];
  let confirmations: Pick<Confirmation, "field" | "createdAt" | "confidence">[];

  const db = getSupabase();
  if (!db) {
    corrections = memCorrections.filter(
      (c) => c.userId === userId && c.supplierName.toLowerCase() === supplier,
    );
    confirmations = memConfirmations.filter(
      (c) => c.userId === userId && c.supplierName.toLowerCase() === supplier,
    );
  } else {
    const [corrRes, confRes] = await Promise.all([
      db
        .from("corrections")
        .select("field, created_at")
        .eq("user_id", userId)
        .ilike("supplier_name", supplierName),
      db
        .from("confirmations")
        .select("field, created_at, confidence")
        .eq("user_id", userId)
        .ilike("supplier_name", supplierName),
    ]);
    if (corrRes.error) throw new Error(`Failed to load corrections: ${corrRes.error.message}`);
    if (confRes.error) throw new Error(`Failed to load confirmations: ${confRes.error.message}`);
    corrections = (corrRes.data ?? []).map((r: any) => ({ field: r.field, createdAt: String(r.created_at) }));
    confirmations = (confRes.data ?? []).map((r: any) => ({
      field: r.field,
      createdAt: String(r.created_at),
      confidence: Number(r.confidence ?? 0),
    }));
  }

  // Most recent correction time per field — confirmations at or before it don't count.
  const lastCorrectionAt: Partial<Record<ReviewableField, number>> = {};
  for (const c of corrections) {
    const t = Date.parse(c.createdAt);
    if (!lastCorrectionAt[c.field] || t > lastCorrectionAt[c.field]!) lastCorrectionAt[c.field] = t;
  }

  const stats: Partial<Record<ReviewableField, ConfirmationStat>> = {};
  for (const c of confirmations) {
    const cutoff = lastCorrectionAt[c.field];
    if (cutoff !== undefined && Date.parse(c.createdAt) <= cutoff) continue; // reset by a later edit
    const s = (stats[c.field] ??= { count: 0, floor: 0 });
    s.count += 1;
    if (c.confidence > s.floor) s.floor = c.confidence;
  }
  return stats;
}

/** Recent corrections for a supplier — the raw material for per-vendor learning. */
export async function correctionsForSupplier(
  userId: string,
  supplierName: string,
  limit = 20,
): Promise<Correction[]> {
  const db = getSupabase();
  if (!db) {
    return memCorrections
      .filter((c) => c.userId === userId && c.supplierName.toLowerCase() === supplierName.toLowerCase())
      .slice(-limit);
  }

  const { data, error } = await db
    .from("corrections")
    .select()
    .eq("user_id", userId)
    .ilike("supplier_name", supplierName)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load corrections: ${error.message}`);
  // Fetched newest-first for the limit; reverse to chronological (oldest→newest)
  // so hints read in the order the user corrected them.
  return (data ?? []).map((r) => mapCorrectionRow(r as Record<string, unknown>)).reverse();
}

/** Recent corrections across all suppliers — used before we know the supplier. */
export async function recentCorrections(userId: string, limit = 20): Promise<Correction[]> {
  const db = getSupabase();
  if (!db) return memCorrections.filter((c) => c.userId === userId).slice(-limit);

  const { data, error } = await db
    .from("corrections")
    .select()
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load corrections: ${error.message}`);
  return (data ?? []).map((r) => mapCorrectionRow(r as Record<string, unknown>)).reverse();
}

/**
 * Persist the human-approved invoice and return its id (used to link the
 * corrections back to it). In fallback mode it records a lightweight summary in
 * memory so duplicate detection still works without a database.
 */
export async function saveApprovedInvoice(userId: string, inv: ApprovedInvoice): Promise<string | null> {
  const db = getSupabase();
  if (!db) {
    const id = crypto.randomUUID();
    memInvoices.push({
      id,
      documentType: inv.documentType,
      supplierName: inv.supplierName,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      total: inv.total,
      status: "approved",
      createdAt: new Date().toISOString(),
      userId,
    });
    return id;
  }

  const { data, error } = await db
    .from("invoices")
    .insert({
      document_type: inv.documentType,
      user_id: userId,
      supplier_name: inv.supplierName,
      invoice_number: inv.invoiceNumber,
      invoice_date: inv.invoiceDate,
      currency: inv.currency,
      subtotal: inv.subtotal,
      tax: inv.tax,
      total: inv.total,
      overall_confidence: inv.overallConfidence,
      status: "approved",
      approved_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save approved invoice: ${error.message}`);
  return (data as { id: string }).id;
}

export interface MonthlyCount {
  /** "2026-07" */
  month: string;
  /** "Jul" */
  label: string;
  count: number;
}

/**
 * Approved-invoice counts for the last `months` calendar months (oldest
 * first) — backs the Dashboard's extraction-volume chart with real counts
 * instead of the mockup's fixed 60/72/68/85/78/100 bar heights.
 */
export async function getMonthlyInvoiceCounts(userId: string, months = 6): Promise<MonthlyCount[]> {
  const now = new Date();
  const buckets: MonthlyCount[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en-US", { month: "short" }),
      count: 0,
    });
  }
  const indexOf = new Map(buckets.map((b, i) => [b.month, i]));

  const db = getSupabase();
  if (!db) {
    for (const inv of memInvoices) {
      if (inv.userId !== userId) continue;
      const idx = indexOf.get(inv.createdAt.slice(0, 7));
      if (idx !== undefined) buckets[idx].count += 1;
    }
    return buckets;
  }

  const { data, error } = await db
    .from("invoices")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", `${buckets[0].month}-01`);
  if (error) throw new Error(`Failed to load monthly counts: ${error.message}`);
  for (const row of data ?? []) {
    const idx = indexOf.get(String(row.created_at).slice(0, 7));
    if (idx !== undefined) buckets[idx].count += 1;
  }
  return buckets;
}

/**
 * Average `overallConfidence` across every approved invoice — the Dashboard's
 * "Avg. confidence" stat. Null (shown as "—") rather than 0 when there's
 * nothing to average, or in in-memory mode, which doesn't track confidence on
 * the lightweight `StoredInvoiceSummary` row.
 */
export async function getAverageConfidence(userId: string): Promise<number | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db.from("invoices").select("overall_confidence").eq("user_id", userId);
  if (error) throw new Error(`Failed to load confidence: ${error.message}`);
  const values = (data ?? []).map((r) => Number(r.overall_confidence)).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Most recently approved invoices — one of the sources for the Dashboard's "Recent activity" feed. */
export async function listRecentApprovedInvoices(
  userId: string,
  limit = 5,
): Promise<{ supplierName: string; createdAt: string }[]> {
  const db = getSupabase();
  if (!db) {
    return memInvoices
      .filter((i) => i.userId === userId)
      .slice(-limit)
      .reverse()
      .map((i) => ({ supplierName: i.supplierName, createdAt: i.createdAt }));
  }

  const { data, error } = await db
    .from("invoices")
    .select("supplier_name, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load recent invoices: ${error.message}`);
  return (data ?? []).map((r) => ({ supplierName: String(r.supplier_name), createdAt: String(r.created_at) }));
}

/**
 * All approved invoices for a user, with the full identity fields the
 * bank-to-invoice matcher (lib/invoice-matching.ts) needs — unlike
 * listRecentApprovedInvoices above, which only returns the two fields the
 * Dashboard's activity feed uses. Capped at `limit` (newest first) since a
 * matching pass compares every bank line against every candidate.
 */
export async function listApprovedInvoicesForMatching(userId: string, limit = 500): Promise<StoredInvoiceSummary[]> {
  const db = getSupabase();
  if (!db) {
    return memInvoices
      .filter((i) => i.userId === userId && i.status === "approved")
      .slice(-limit)
      .reverse()
      .map(({ userId: _u, ...rest }) => rest);
  }

  const { data, error } = await db
    .from("invoices")
    .select(DUP_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load approved invoices: ${error.message}`);
  return (data ?? []).map((r) => mapSummaryRow(r as Record<string, unknown>));
}

/**
 * Find an existing invoice with the same supplier + invoice number (approved or
 * pending), for duplicate detection. Returns the most recent match, or null.
 * Scope is deliberately just supplier + invoice number — a supplier re-sending a
 * corrected version is explicitly out of scope until we have a pilot example.
 * A blank supplier or invoice number is unmatchable, so it never flags.
 *
 * Scoped to `userId`: two different bookkeepers legitimately both having a
 * supplier called "Acme Ltd" must never flag each other's invoices as duplicates.
 */
export async function findDuplicateInvoice(
  userId: string,
  supplierName: string,
  invoiceNumber: string,
): Promise<StoredInvoiceSummary | null> {
  if (!supplierName.trim() || !invoiceNumber.trim()) return null;

  const db = getSupabase();
  if (!db) {
    // Newest match first, mirroring the DB ordering below.
    for (let i = memInvoices.length - 1; i >= 0; i--) {
      const inv = memInvoices[i];
      if (
        inv.userId === userId &&
        inv.supplierName.toLowerCase() === supplierName.toLowerCase() &&
        inv.invoiceNumber === invoiceNumber
      ) {
        return inv;
      }
    }
    return null;
  }

  const { data, error } = await db
    .from("invoices")
    .select(DUP_COLUMNS)
    .eq("user_id", userId)
    .ilike("supplier_name", supplierName)
    .eq("invoice_number", invoiceNumber)
    .in("status", ["approved", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to check for duplicate invoice: ${error.message}`);
  if (!data) return null;
  return mapSummaryRow(data as Record<string, unknown>);
}

/**
 * Find an existing receipt from the same merchant, on the same date, for the same
 * total. That trio is a receipt's practical identity: unlike an invoice it usually
 * carries no number to match on, so matching on supplier + number alone would
 * silently never fire and every re-uploaded receipt would sail through.
 *
 * Deliberately strict — all three must match. Same merchant twice in a day for
 * genuinely different amounts won't flag, and two identical purchases on one day
 * (a real possibility: two identical coffees) will flag as a *warning* the human
 * can wave through. Same contract as the invoice check: warn, never block.
 *
 * A blank merchant, missing date, or absent total is unmatchable, so it never flags.
 * Scoped to `userId`, same reasoning as findDuplicateInvoice.
 */
export async function findDuplicateReceipt(
  userId: string,
  merchantName: string,
  receiptDate: string | null,
  total: number | null,
): Promise<StoredInvoiceSummary | null> {
  if (!merchantName.trim() || !receiptDate || total === null || !Number.isFinite(total)) {
    return null;
  }

  const db = getSupabase();
  if (!db) {
    for (let i = memInvoices.length - 1; i >= 0; i--) {
      const inv = memInvoices[i];
      if (
        inv.userId === userId &&
        inv.documentType === "receipt" &&
        inv.supplierName.toLowerCase() === merchantName.toLowerCase() &&
        inv.invoiceDate === receiptDate &&
        inv.total !== null &&
        Math.abs(inv.total - total) < 0.005
      ) {
        return inv;
      }
    }
    return null;
  }

  const { data, error } = await db
    .from("invoices")
    .select(DUP_COLUMNS)
    .eq("user_id", userId)
    .eq("document_type", "receipt")
    .ilike("supplier_name", merchantName)
    .eq("invoice_date", receiptDate)
    .eq("total", total)
    .in("status", ["approved", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to check for duplicate receipt: ${error.message}`);
  if (!data) return null;
  return mapSummaryRow(data as Record<string, unknown>);
}

/**
 * Duplicate check for either document type — the single entry point used at both
 * checkpoints (upload-time in /api/extract, approve-time in /api/approve) so the
 * two stay in lockstep as the rules evolve.
 */
export async function findDuplicateDocument(
  userId: string,
  documentType: DocumentType,
  d: { supplierName: string; invoiceNumber: string; invoiceDate: string | null; total: number | null },
): Promise<StoredInvoiceSummary | null> {
  return documentType === "receipt"
    ? findDuplicateReceipt(userId, d.supplierName, d.invoiceDate, d.total)
    : findDuplicateInvoice(userId, d.supplierName, d.invoiceNumber);
}

// --- Pending queue ----------------------------------------------------------

function mapPendingRow(row: Record<string, unknown>): PendingDocument {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    filename: (row.filename as string) ?? null,
    extraction: row.extraction as InvoiceExtraction,
    status: (row.status as PendingDocument["status"]) ?? "pending",
    lastOutcome: (row.last_outcome as PendingOutcome) ?? null,
    lastReason: (row.last_reason as string) ?? null,
    invoiceId: (row.invoice_id as string) ?? null,
  };
}

/**
 * Park a freshly-read document in the queue and return its id. This is what makes
 * a document addressable: until now an extraction only existed in the browser, so
 * "approve these five" had nothing to name them by.
 */
export async function savePendingDocument(
  userId: string,
  p: { extraction: InvoiceExtraction; filename?: string | null },
): Promise<string> {
  const db = getSupabase();
  if (!db) {
    const entry: PendingDocument & { userId: string } = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      filename: p.filename ?? null,
      extraction: p.extraction,
      status: "pending",
      lastOutcome: null,
      lastReason: null,
      invoiceId: null,
      userId,
    };
    memPending.push(entry);
    return entry.id;
  }

  const { data, error } = await db
    .from("pending_documents")
    .insert({
      extraction: p.extraction,
      filename: p.filename ?? null,
      status: "pending",
      user_id: userId,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save pending document: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * The queue, oldest first — a work queue reads FIFO. Resolved documents drop out;
 * blocked and errored ones stay, because they still need a human. Scoped to
 * `userId`: one bookkeeper's queue is never another's.
 */
export async function listPendingDocuments(userId: string, limit = 100): Promise<PendingDocument[]> {
  const db = getSupabase();
  if (!db) {
    return memPending.filter((p) => p.userId === userId && p.status === "pending").slice(0, limit);
  }

  const { data, error } = await db
    .from("pending_documents")
    .select()
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to load pending documents: ${error.message}`);
  return (data ?? []).map((r) => mapPendingRow(r as Record<string, unknown>));
}

/**
 * One pending document by id, or null when the id is unknown OR belongs to a
 * different user — a foreign id looks exactly like an unknown one, rather than
 * revealing that it exists.
 */
export async function getPendingDocument(userId: string, id: string): Promise<PendingDocument | null> {
  const db = getSupabase();
  if (!db) return memPending.find((p) => p.id === id && p.userId === userId) ?? null;

  const { data, error } = await db
    .from("pending_documents")
    .select()
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load pending document: ${error.message}`);
  return data ? mapPendingRow(data as Record<string, unknown>) : null;
}

/** What `deletePendingDocument` did, so the caller can answer honestly. */
export type DeletePendingResult = "deleted" | "not_found" | "already_resolved";

/**
 * Drop a queued document for good — the escape hatch for a duplicate or a
 * misfired upload that should never become a bill.
 *
 * Refuses once a document is resolved, and that refusal is the point: a resolved
 * row is the link between an approved invoice and the extraction it came from.
 * Deleting it would leave a bill in the ledger (and possibly in Xero) whose
 * origin can no longer be shown, which is exactly the thing a bookkeeping audit
 * trail exists to prevent. The queue list only offers pending documents anyway,
 * so this guards the endpoint, not the button.
 */
export async function deletePendingDocument(userId: string, id: string): Promise<DeletePendingResult> {
  const existing = await getPendingDocument(userId, id);
  if (!existing) return "not_found";
  if (existing.status === "resolved") return "already_resolved";

  const db = getSupabase();
  if (!db) {
    const i = memPending.findIndex((p) => p.id === id && p.userId === userId);
    if (i === -1) return "not_found";
    memPending.splice(i, 1);
    return "deleted";
  }

  // Scoped to still-pending rows owned by this user, so a document approved
  // between the check above and this write is not deleted out from under the
  // ledger, and one user can never delete another's queue entry.
  const { error } = await db
    .from("pending_documents")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending");

  if (error) throw new Error(`Failed to delete pending document: ${error.message}`);
  return "deleted";
}

/**
 * Record how an approval attempt ended.
 *
 * Whether the document leaves the queue is decided by ONE thing: did it reach the
 * ledger (`invoiceId` set)? Not by the outcome. A document that saved but failed
 * to post to the accounting platform is reported as an error to the human, yet is
 * resolved here — it is already in the ledger, and re-running it would post a
 * second bill. Blocked and precondition-error documents never saved anything, so
 * they stay queued for the human to fix and re-submit.
 */
export async function resolvePendingDocument(
  userId: string,
  id: string,
  r: { outcome: PendingOutcome; reason?: string | null; invoiceId?: string | null },
): Promise<void> {
  const status = r.invoiceId ? "resolved" : "pending";

  const db = getSupabase();
  if (!db) {
    const entry = memPending.find((p) => p.id === id && p.userId === userId);
    if (!entry) return;
    entry.status = status;
    entry.lastOutcome = r.outcome;
    entry.lastReason = r.reason ?? null;
    entry.invoiceId = r.invoiceId ?? null;
    return;
  }

  const { error } = await db
    .from("pending_documents")
    .update({
      status,
      last_outcome: r.outcome,
      last_reason: r.reason ?? null,
      invoice_id: r.invoiceId ?? null,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update pending document: ${error.message}`);
}
