export interface CriticalConfidence {
  merchant: number;
  date: number;
  amount: number;
}

export interface ReviewGateResult {
  needsReview: boolean;
  status: 'approved' | 'pending';
}

export function computeReviewStatus(critical: CriticalConfidence): ReviewGateResult {
  const values = [critical.merchant, critical.date, critical.amount];
  const needsReview = values.some((c) => c < 70);
  const status: ReviewGateResult['status'] = values.every((c) => c >= 95) ? 'approved' : 'pending';
  return { needsReview, status };
}
