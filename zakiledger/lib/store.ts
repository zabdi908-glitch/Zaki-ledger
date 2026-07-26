import type { ReviewableField } from "./schema";
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
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string | null; // ISO date, or null when unreadable
  currency: string;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  overallConfidence: number;
}

/** Lightweight invoice identity used by duplicate detection. */
export interface StoredInvoiceSummary {
  id: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  status: string; // 'approved' | 'pending_review'
  createdAt: string; // when it was first processed into the system
}

// --- In-memory fallback (used only when Supabase isn't configured) ----------
const memCorrections: Correction[] = [];
const memInvoices: StoredInvoiceSummary[] = [];
const memConfirmations: Confirmation[] = [];

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
  c: Omit<Correction, "id" | "createdAt">,
): Promise<Correction> {
  const db = getSupabase();
  if (!db) {
    const entry: Correction = {
      ...c,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    memCorrections.push(entry);
    return entry;
  }

  const { data, error } = await db
    .from("corrections")
    .insert({
      invoice_id: c.invoiceId ?? null,
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
  c: Omit<Confirmation, "id" | "createdAt">,
): Promise<Confirmation> {
  const db = getSupabase();
  if (!db) {
    const entry: Confirmation = {
      ...c,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    memConfirmations.push(entry);
    return entry;
  }

  const { data, error } = await db
    .from("confirmations")
    .insert({
      invoice_id: c.invoiceId ?? null,
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
 */
export async function confirmationStatsForSupplier(
  supplierName: string,
): Promise<Partial<Record<ReviewableField, ConfirmationStat>>> {
  const supplier = supplierName.toLowerCase();

  let corrections: Pick<Correction, "field" | "createdAt">[];
  let confirmations: Pick<Confirmation, "field" | "createdAt" | "confidence">[];

  const db = getSupabase();
  if (!db) {
    corrections = memCorrections.filter((c) => c.supplierName.toLowerCase() === supplier);
    confirmations = memConfirmations.filter((c) => c.supplierName.toLowerCase() === supplier);
  } else {
    const [corrRes, confRes] = await Promise.all([
      db.from("corrections").select("field, created_at").ilike("supplier_name", supplierName),
      db.from("confirmations").select("field, created_at, confidence").ilike("supplier_name", supplierName),
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
  supplierName: string,
  limit = 20,
): Promise<Correction[]> {
  const db = getSupabase();
  if (!db) {
    return memCorrections
      .filter((c) => c.supplierName.toLowerCase() === supplierName.toLowerCase())
      .slice(-limit);
  }

  const { data, error } = await db
    .from("corrections")
    .select()
    .ilike("supplier_name", supplierName)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load corrections: ${error.message}`);
  // Fetched newest-first for the limit; reverse to chronological (oldest→newest)
  // so hints read in the order the user corrected them.
  return (data ?? []).map((r) => mapCorrectionRow(r as Record<string, unknown>)).reverse();
}

/** Recent corrections across all suppliers — used before we know the supplier. */
export async function recentCorrections(limit = 20): Promise<Correction[]> {
  const db = getSupabase();
  if (!db) return memCorrections.slice(-limit);

  const { data, error } = await db
    .from("corrections")
    .select()
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
export async function saveApprovedInvoice(inv: ApprovedInvoice): Promise<string | null> {
  const db = getSupabase();
  if (!db) {
    const id = crypto.randomUUID();
    memInvoices.push({
      id,
      supplierName: inv.supplierName,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      status: "approved",
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  const { data, error } = await db
    .from("invoices")
    .insert({
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

/**
 * Find an existing invoice with the same supplier + invoice number (approved or
 * pending), for duplicate detection. Returns the most recent match, or null.
 * Scope is deliberately just supplier + invoice number — a supplier re-sending a
 * corrected version is explicitly out of scope until we have a pilot example.
 * A blank supplier or invoice number is unmatchable, so it never flags.
 */
export async function findDuplicateInvoice(
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
    .select("id, supplier_name, invoice_number, invoice_date, status, created_at")
    .ilike("supplier_name", supplierName)
    .eq("invoice_number", invoiceNumber)
    .in("status", ["approved", "pending_review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to check for duplicate invoice: ${error.message}`);
  if (!data) return null;

  const r = data as Record<string, unknown>;
  return {
    id: String(r.id),
    supplierName: String(r.supplier_name),
    invoiceNumber: String(r.invoice_number),
    invoiceDate: (r.invoice_date as string) ?? null,
    status: String(r.status),
    createdAt: String(r.created_at),
  };
}
