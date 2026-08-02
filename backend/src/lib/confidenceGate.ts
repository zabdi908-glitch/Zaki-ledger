export interface CriticalConfidence {
  merchant: number;
  date: number;
  amount: number;
}

export interface ReviewGateResult {
  needsReview: boolean;
  status: 'approved' | 'pending';
}

// ExtractionResult comes from unvalidated JSON.parse, so a confidence field can be
// undefined/NaN. Coerce anything non-finite to 0 so missing data fails CLOSED into
// review, instead of `undefined < 70` silently evaluating to false.
const n = (v: number) => (Number.isFinite(v) ? v : 0);

export function computeReviewStatus(critical: CriticalConfidence): ReviewGateResult {
  const values = [n(critical.merchant), n(critical.date), n(critical.amount)];
  const needsReview = values.some((c) => c < 70);
  const status: ReviewGateResult['status'] = values.every((c) => c >= 95) ? 'approved' : 'pending';
  return { needsReview, status };
}
