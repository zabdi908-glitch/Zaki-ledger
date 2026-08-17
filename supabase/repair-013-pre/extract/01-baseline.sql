SET default_transaction_read_only = on;
SELECT 'table_counts' AS k,
  (SELECT count(*) FROM public.bank_statements)::int AS bank_statements,
  (SELECT count(*) FROM public.bank_transactions)::int AS bank_transactions,
  (SELECT count(*) FROM public.qb_transactions)::int AS qb_transactions,
  (SELECT count(*) FROM public.reconciliation_matches)::int AS reconciliation_matches,
  (SELECT count(*) FROM public.reconciliation_reports)::int AS reconciliation_reports,
  (SELECT count(*) FROM public.reconciliation_decisions)::int AS reconciliation_decisions,
  (SELECT count(*) FROM public.reconciliation_audit_log)::int AS reconciliation_audit_log,
  (SELECT count(*) FROM public.default_tenant_identities)::int AS default_tenant_identities,
  (SELECT count(*) FROM public.canonical_audit_ledger)::int AS canonical_audit_ledger;
SELECT 'origin_mix' AS k,
  count(*) FILTER (WHERE matched_by='auto')::int AS auto_rows,
  count(*) FILTER (WHERE matched_by='manual')::int AS manual_rows,
  count(*) FILTER (WHERE approved_at IS NOT NULL)::int AS approved_rows,
  count(*) FILTER (WHERE approved_at IS NULL)::int AS unapproved_rows,
  min(matched_at)::text AS min_matched,
  max(matched_at)::text AS max_matched
FROM public.reconciliation_matches;
SELECT 'dup_live_auto' AS k,
  count(*)::int AS endpoints,
  sum(c)::int AS rows_affected,
  sum(c_approved)::int AS approved_rows,
  sum(c_unapproved)::int AS unapproved_rows,
  count(*) FILTER (WHERE c_approved = 0)::int AS all_unapproved_endpoints,
  count(*) FILTER (WHERE c_approved >= 2)::int AS endpoints_two_plus_approved,
  count(*) FILTER (WHERE s_stmt > 1)::int AS same_statement_multiplicity,
  count(*) FILTER (WHERE n_stmt > 1)::int AS multi_statement_endpoints
FROM (
  SELECT qb_transaction_id,
         count(*) c,
         count(*) FILTER (WHERE approved_at IS NOT NULL) c_approved,
         count(*) FILTER (WHERE approved_at IS NULL) c_unapproved,
         count(DISTINCT statement_id) n_stmt,
         max(dup_stmt) s_stmt
  FROM (
    SELECT qb_transaction_id, statement_id, approved_at,
           count(*) OVER (PARTITION BY qb_transaction_id, statement_id) dup_stmt
    FROM public.reconciliation_matches
    WHERE matched_by = 'auto' AND qb_transaction_id IS NOT NULL
  ) x
  GROUP BY qb_transaction_id
  HAVING count(*) > 1
) d;
SELECT 'rows_per_qb' AS k, c AS rows_per_qb, count(*)::int AS endpoints
FROM (
  SELECT qb_transaction_id, count(*) c
  FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
) d GROUP BY c ORDER BY c;
