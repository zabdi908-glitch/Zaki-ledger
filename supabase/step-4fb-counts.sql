-- Step 4F-B: single-statement row-count evidence (read-only).
SELECT 'counts' AS k,
  (SELECT count(*) FROM public.bank_statements)::text AS bank_statements,
  (SELECT count(*) FROM public.bank_transactions)::text AS bank_transactions,
  (SELECT count(*) FROM public.qb_transactions)::text AS qb_transactions,
  (SELECT count(*) FROM public.reconciliation_matches)::text AS reconciliation_matches,
  (SELECT count(*) FROM public.reconciliation_reports)::text AS reconciliation_reports,
  (SELECT count(*) FROM public.reconciliation_decisions)::text AS reconciliation_decisions,
  (SELECT count(*) FROM public.reconciliation_audit_log)::text AS reconciliation_audit_log,
  (SELECT count(*) FROM public.default_tenant_identities)::text AS default_tenant_identities,
  (SELECT count(*) FROM public.canonical_audit_ledger)::text AS canonical_audit_ledger;
