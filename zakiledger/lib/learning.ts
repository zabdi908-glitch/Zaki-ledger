import { recentCorrections, correctionsForSupplier, type Correction } from "./store";

/**
 * The learning loop, layer 2 (few-shot from corrections).
 *
 * Turns past human corrections into short natural-language hints that get injected
 * into the next extraction. No model retraining — the system gets smarter tonight,
 * per client, and it's fully explainable (you can see exactly which correction
 * produced which hint).
 *
 * Chicken-and-egg note: we don't know the supplier until AFTER extraction. So the
 * FIRST pass uses recent cross-supplier corrections; a future refinement re-runs
 * with supplier-specific corrections once the supplier is known (see README).
 */
export async function buildHints(userId: string, supplierName?: string): Promise<string | undefined> {
  const corrections: Correction[] = supplierName
    ? await correctionsForSupplier(userId, supplierName)
    : await recentCorrections(userId);

  if (corrections.length === 0) return undefined;

  const lines = corrections.map(
    (c) =>
      `- For "${c.supplierName}", the field ${c.field} was previously read as "${c.aiValue}" but corrected to "${c.humanValue}".`,
  );

  return lines.join("\n");
}
