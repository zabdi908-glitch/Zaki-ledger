SELECT '== qb in N matches' AS k, count(*)::text AS v FROM public.reconciliation_matches WHERE qb_transaction_id = 'cd0a15ca-0aa5-408c-a943-59caf2ad8361'
UNION ALL SELECT '== bank in N matches', count(*)::text FROM public.reconciliation_matches WHERE statement_id = '025f99b8-22f6-496f-898e-eaca64f48411'
UNION ALL SELECT '== matched_at/by', COALESCE(matched_at::text,'null') || ' | ' || COALESCE(matched_by,'null') FROM public.reconciliation_matches WHERE id = '752a6e83-6742-47ea-8df9-2c1696c85b33'
UNION ALL SELECT '== confidence/reason', COALESCE(confidence::text,'null') || ' | ' || COALESCE(match_reason,'null') FROM public.reconciliation_matches WHERE id = '752a6e83-6742-47ea-8df9-2c1696c85b33'
UNION ALL SELECT '== approved?', COALESCE(approved_by,'null') FROM public.reconciliation_matches WHERE id = '752a6e83-6742-47ea-8df9-2c1696c85b33';
