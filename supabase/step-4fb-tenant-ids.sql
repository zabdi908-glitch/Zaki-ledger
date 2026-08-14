(SELECT '== B statement' AS k, id::text AS v FROM public.bank_statements WHERE user_id = '0042d6e0-86f5-4c2e-970e-a0c7ac04106a' ORDER BY statement_period_start DESC NULLS LAST LIMIT 1)
UNION ALL
(SELECT '== B match', id::text FROM public.reconciliation_matches WHERE user_id = '0042d6e0-86f5-4c2e-970e-a0c7ac04106a' LIMIT 1);
