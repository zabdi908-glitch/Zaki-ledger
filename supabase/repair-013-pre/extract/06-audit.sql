SET default_transaction_read_only = on;
WITH dup AS (
  SELECT qb_transaction_id
  FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
)
SELECT jsonb_agg(
  jsonb_build_object(
    'audit_id', a.id::text,
    'match_id', a.reconciliation_match_id::text,
    'action', a.action,
    'action_by', a.action_by,
    'action_at', a.action_at,
    'old_confidence', a.old_confidence,
    'new_confidence', a.new_confidence,
    'client_entity_id', a.client_entity_id::text,
    'user_id', a.user_id::text
  )
) AS result
FROM public.reconciliation_audit_log a
WHERE a.reconciliation_match_id IN (
  SELECT m.id FROM public.reconciliation_matches m
  JOIN dup d ON d.qb_transaction_id = m.qb_transaction_id
  WHERE m.matched_by = 'auto'
);
