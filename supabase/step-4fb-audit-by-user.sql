SELECT user_id::text AS uid, count(*)::text AS n FROM public.reconciliation_audit_log GROUP BY user_id ORDER BY user_id;
