SELECT jsonb_build_object(
  'bank_statements', (SELECT count(*) FROM public.bank_statements),
  'bank_transactions', (SELECT count(*) FROM public.bank_transactions),
  'qb_transactions', (SELECT count(*) FROM public.qb_transactions),
  'reconciliation_matches', (SELECT count(*) FROM public.reconciliation_matches),
  'reconciliation_reports', (SELECT count(*) FROM public.reconciliation_reports),
  'reconciliation_decisions', (SELECT count(*) FROM public.reconciliation_decisions),
  'reconciliation_audit_log', (SELECT count(*) FROM public.reconciliation_audit_log),
  'default_tenant_identities', (SELECT count(*) FROM public.default_tenant_identities),
  'canonical_audit_ledger', (SELECT count(*) FROM public.canonical_audit_ledger),
  'dup_live_auto', (SELECT count(*) FROM (SELECT qb_transaction_id FROM public.reconciliation_matches WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL GROUP BY qb_transaction_id HAVING count(*)>1) d),
  'approved_rows', (SELECT count(*) FROM public.reconciliation_matches WHERE approved_at IS NOT NULL),
  'manual_rows', (SELECT count(*) FROM public.reconciliation_matches WHERE matched_by='manual'),
  'sum_matches_conf', (SELECT round(sum(confidence)::numeric,3) FROM public.reconciliation_matches),
  'sum_bank_amounts', (SELECT round(sum(amount)::numeric,2) FROM public.bank_transactions),
  'sum_qb_amounts', (SELECT round(sum(amount)::numeric,2) FROM public.qb_transactions),
  'match_approved_audit', (SELECT count(*) FROM public.reconciliation_audit_log WHERE action='match_approved'),
  'test_qb_rows', (SELECT count(*) FROM public.qb_transactions WHERE description ILIKE '%4FB-CANONICAL-TEST%')
) AS result;
