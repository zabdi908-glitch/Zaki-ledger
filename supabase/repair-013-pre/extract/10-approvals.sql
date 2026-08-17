SET default_transaction_read_only = on;
WITH dup AS (
  SELECT qb_transaction_id FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
)
SELECT jsonb_agg(jsonb_build_object(
  'match_id', m.id::text, 'qb_id', m.qb_transaction_id::text,
  'approved_at', m.approved_at, 'approved_by', m.approved_by,
  'action_at', a.action_at, 'action_by', a.action_by
)) AS result
FROM public.reconciliation_matches m
JOIN dup d ON d.qb_transaction_id = m.qb_transaction_id
LEFT JOIN public.reconciliation_audit_log a ON a.reconciliation_match_id = m.id AND a.action = 'match_approved'
WHERE m.matched_by='auto' AND m.approved_at IS NOT NULL
