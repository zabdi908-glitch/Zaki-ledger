-- RECONCILIATION HARDENING — PRODUCTION IMPACT SCAN (READ-ONLY)
-- Date: 2026-08-14. Target: production fqvekbzwghjurkcawpgg via --linked CLI.
-- SELECT-only. No DML, no DDL. Classifies data impact of the hardening fix;
-- any repair is a separate explicit task.

SELECT 'TOTAL_MATCHES' AS metric, count(*) AS value FROM public.reconciliation_matches;

-- 1. Active matches reusing the same qb_transaction_id
SELECT 'QB_REUSED_ACROSS_MATCHES' AS metric, count(*) AS value
FROM (
  SELECT qb_transaction_id
  FROM public.reconciliation_matches
  WHERE qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id
  HAVING count(*) > 1
) reused;

-- 2. Approved matches sharing a QB transaction
SELECT 'QB_SHARED_BY_APPROVED' AS metric, count(*) AS value
FROM (
  SELECT qb_transaction_id
  FROM public.reconciliation_matches
  WHERE qb_transaction_id IS NOT NULL AND approved_at IS NOT NULL
  GROUP BY qb_transaction_id
  HAVING count(*) > 1
) approved_shared;

-- 3. Unapproved auto-matches pointing to a QB row already approved elsewhere
SELECT 'UNAPPROVED_POINTING_AT_APPROVED_QB' AS metric, count(*) AS value
FROM public.reconciliation_matches m
WHERE m.approved_at IS NULL
  AND m.qb_transaction_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.reconciliation_matches a
    WHERE a.qb_transaction_id = m.qb_transaction_id
      AND a.approved_at IS NOT NULL
      AND a.id <> m.id
  );

-- 4a. Confidence/flag distribution
SELECT 'MATCHES_' || flagged_level AS metric, count(*) AS value
FROM public.reconciliation_matches
GROUP BY flagged_level
ORDER BY flagged_level;

-- 4b. Very-low-confidence persisted matches
SELECT 'VERY_LOW_CONFIDENCE_LT_40' AS metric, count(*) AS value
FROM public.reconciliation_matches
WHERE confidence IS NOT NULL AND confidence < 0.4;

SELECT 'LOW_CONFIDENCE_LT_70' AS metric, count(*) AS value
FROM public.reconciliation_matches
WHERE confidence IS NOT NULL AND confidence < 0.7;

-- 4c. Unapproved auto matches (the pool hardening would stop growing)
SELECT 'UNAPPROVED_AUTO_MATCHES' AS metric, count(*) AS value
FROM public.reconciliation_matches
WHERE approved_at IS NULL AND matched_by = 'auto';

-- 5. Matches involving the known 4FB smoke/test QB rows
SELECT 'MATCHES_ON_4FB_TEST_QB' AS metric, count(*) AS value
FROM public.reconciliation_matches m
JOIN public.qb_transactions q ON q.id = m.qb_transaction_id
WHERE q.description LIKE '4FB-CANONICAL-TEST%';

-- 5b. 4FB test QB rows still present (context)
SELECT '4FB_TEST_QB_ROWS_PRESENT' AS metric, count(*) AS value
FROM public.qb_transactions
WHERE description LIKE '4FB-CANONICAL-TEST%';
