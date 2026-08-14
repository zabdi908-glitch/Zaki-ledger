SELECT '== N bs' AS k, count(*)::text AS v FROM public.bank_statements WHERE client_entity_id IS NULL OR ledger_book_id IS NULL
UNION ALL SELECT '== N bt', count(*)::text FROM public.bank_transactions WHERE client_entity_id IS NULL
UNION ALL SELECT '== N qt', count(*)::text FROM public.qb_transactions WHERE client_entity_id IS NULL OR ledger_book_id IS NULL
UNION ALL SELECT '== N rm', count(*)::text FROM public.reconciliation_matches WHERE client_entity_id IS NULL
UNION ALL SELECT '== N rr', count(*)::text FROM public.reconciliation_reports WHERE client_entity_id IS NULL
UNION ALL SELECT '== N rd', count(*)::text FROM public.reconciliation_decisions WHERE client_entity_id IS NULL
UNION ALL SELECT '== N audit_user', count(*)::text FROM public.reconciliation_audit_log WHERE user_id IS NULL
UNION ALL SELECT '== N audit_client', count(*)::text FROM public.reconciliation_audit_log WHERE client_entity_id IS NULL;
