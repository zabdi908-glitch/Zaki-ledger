SELECT '== M on unfreeze stmt' AS k, count(*)::text AS v FROM public.reconciliation_matches WHERE statement_id = '025f99b8-22f6-496f-898e-eaca64f48411'
UNION ALL SELECT '== M on canonical stmt', count(*)::text FROM public.reconciliation_matches WHERE statement_id = 'e6a2b535-afd2-4ed2-9302-3a857db3d044'
UNION ALL SELECT '== M on 4e8 stmt', count(*)::text FROM public.reconciliation_matches WHERE statement_id = '0033bf24-ba2b-4f5c-8ba5-5421a6bbeea7'
UNION ALL SELECT '== M on 011 smoke stmt', count(*)::text FROM public.reconciliation_matches WHERE statement_id = '9f3fc8f0-6bd4-4bcd-9d1f-25496e0c915a';
