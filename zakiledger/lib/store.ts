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
