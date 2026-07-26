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

// --- In-memory fallback (used only when Supabase isn't configured) ----------
const memCorrections: Correction[] = [];
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
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to record confirmation: ${error.message}`);
  return mapConfirmationRow(data as Record<string, unknown>);
}

/**
 * How many times each field has been confirmed correct for a supplier, as a
 * `{ field: count }` map. This is the raw material for confidence calibration:
 * a proven per-supplier, per-field track record of correct reads.
 */
export async function confirmationCountsForSupplier(
  supplierName: string,
): Promise<Partial<Record<ReviewableField, number>>> {
  const counts: Partial<Record<ReviewableField, number>> = {};
  const tally = (field: ReviewableField) => {
    counts[field] = (counts[field] ?? 0) + 1;
  };

  const db = getSupabase();
  if (!db) {
    for (const c of memConfirmations) {
      if (c.supplierName.toLowerCase() === supplierName.toLowerCase()) tally(c.field);
    }
    return counts;
  }

  const { data, error } = await db
    .from("confirmations")
    .select("field")
    .ilike("supplier_name", supplierName);

  if (error) throw new Error(`Failed to load confirmations: ${error.message}`);
  for (const row of data ?? []) tally((row as { field: ReviewableField }).field);
  return counts;
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
 * corrections back to it). Returns null in fallback mode — corrections still
 * record, just without an invoice_id.
 */
export async function saveApprovedInvoice(inv: ApprovedInvoice): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;

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
