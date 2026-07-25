/**
 * Client-side invoice arithmetic validation for the review screen.
 *
 * Pure calculation on numbers we already hold — no API calls, no AI calls, so it
 * recomputes instantly as the human edits the amounts. We flag inconsistencies;
 * we never gate approval. The accountant stays the human in the loop.
 */

/** Rounding tolerance (in currency units) when checking subtotal + tax = total. */
export const TOTALS_TOLERANCE = 0.01;

export interface TotalsCheck {
  /** True when subtotal + tax equals total within TOTALS_TOLERANCE. */
  ok: boolean;
  /** The arithmetic expectation: subtotal + tax. */
  expected: number;
  /** The total as entered/extracted. */
  found: number;
}

/**
 * Verify subtotal + tax = total within a small rounding tolerance.
 * Returns null when any input isn't a finite number (nothing to check yet).
 */
export function checkTotals(
  subtotal: number | null,
  tax: number | null,
  total: number | null,
): TotalsCheck | null {
  if (subtotal === null || tax === null || total === null) return null;
  if (!Number.isFinite(subtotal) || !Number.isFinite(tax) || !Number.isFinite(total)) return null;

  const expected = subtotal + tax;
  return { ok: Math.abs(expected - total) <= TOTALS_TOLERANCE, expected, found: total };
}
