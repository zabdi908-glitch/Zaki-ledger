import { describe, it, expect } from 'vitest';
import { computeReviewStatus } from './confidenceGate.js';

describe('computeReviewStatus', () => {
  it('flags needs_review when merchant confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 65, date: 99, amount: 97 });
    expect(result.needsReview).toBe(true);
  });

  it('flags needs_review when date confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 90, date: 60, amount: 97 });
    expect(result.needsReview).toBe(true);
  });

  it('flags needs_review when amount confidence is below 70', () => {
    const result = computeReviewStatus({ merchant: 90, date: 99, amount: 50 });
    expect(result.needsReview).toBe(true);
  });

  it('does not flag needs_review when all three are 70 or above', () => {
    const result = computeReviewStatus({ merchant: 70, date: 70, amount: 70 });
    expect(result.needsReview).toBe(false);
  });

  it('sets status approved only when all three are 95 or above', () => {
    const result = computeReviewStatus({ merchant: 95, date: 95, amount: 95 });
    expect(result.status).toBe('approved');
  });

  it('sets status pending when any of the three is below 95', () => {
    const result = computeReviewStatus({ merchant: 94, date: 99, amount: 99 });
    expect(result.status).toBe('pending');
    expect(result.needsReview).toBe(false);
  });
});
