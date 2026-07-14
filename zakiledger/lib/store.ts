import type { ReviewableField } from "./schema";

/**
 * A single human correction — the atomic unit of the moat.
 * This mirrors the `corrections` table in db/schema.sql.
 *
 * ⚠️ In-memory stub for the skeleton. Replace with Supabase/Postgres reads/writes
 * (see README → Next steps). The interface is what matters; the storage is swappable.
 */
export interface Correction {
  id: string;
  createdAt: string;
  supplierName: string; // who the invoice was from — key for per-vendor learning
  field: ReviewableField; // which field the human changed
  aiValue: string; // what the AI predicted
  humanValue: string; // what the human corrected it to
  aiConfidence: number; // how confident the AI was when it got it wrong/right
  documentRef?: string; // pointer to the source document (storage key)
}

const corrections: Correction[] = [];

export function recordCorrection(c: Omit<Correction, "id" | "createdAt">): Correction {
  const entry: Correction = {
    ...c,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  corrections.push(entry);
  return entry;
}

/** Recent corrections for a supplier — the raw material for per-vendor learning. */
export function correctionsForSupplier(supplierName: string, limit = 20): Correction[] {
  return corrections
    .filter((c) => c.supplierName.toLowerCase() === supplierName.toLowerCase())
    .slice(-limit);
}

/** Recent corrections across all suppliers — used before we know the supplier. */
export function recentCorrections(limit = 20): Correction[] {
  return corrections.slice(-limit);
}
