/**
 * Confidence calibration — the confirmation half of the learning loop.
 *
 * The model scores each read in isolation, so an inherently ambiguous field
 * (an invoice number with O/0, I/1) keeps getting the same middling score even
 * after a human has approved that supplier's reads correct again and again. That
 * track record is real evidence the read is reliable, and it should show up in
 * the number.
 *
 * `calibrateConfidence` folds a per-supplier, per-field count of past confirmed-
 * correct reads into the model's raw confidence, closing the remaining gap to
 * 1.0 with diminishing returns. It is a pure function — deterministic and fully
 * explainable (n confirmations → exactly this adjustment), no retraining.
 */

/**
 * Fraction of the *remaining* gap to 1.0 that each confirmation leaves open.
 * 0.7 means every confirmation closes 30% of what's left: the boost is quick at
 * first, then flattens, so we never sprint to false certainty on a few reads.
 */
export const CONFIRMATION_GAP_RETENTION = 0.7;

/** Ceiling for a calibrated score — a track record earns high trust, never 100%. */
export const MAX_CALIBRATED_CONFIDENCE = 0.99;

/**
 * Raise `base` confidence (0–1) given `confirmations`, the number of times this
 * supplier + field has been approved unchanged. Monotonic in `confirmations`,
 * never lowers the score, and caps at MAX_CALIBRATED_CONFIDENCE.
 *
 *   calibrated = base + (1 - base) * (1 - retention^n)
 *
 * e.g. base 0.72 with 3 confirmations → ~0.90.
 */
export function calibrateConfidence(base: number, confirmations: number): number {
  if (!Number.isFinite(base)) return base;
  if (confirmations <= 0) return base;

  const gapClosed = 1 - Math.pow(CONFIRMATION_GAP_RETENTION, confirmations);
  const calibrated = base + (1 - base) * gapClosed;
  return Math.min(calibrated, MAX_CALIBRATED_CONFIDENCE);
}
