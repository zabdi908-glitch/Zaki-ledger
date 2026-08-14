SELECT * FROM (
SELECT '== G bank_txn_sum_amount' AS k, COALESCE(sum(amount),0)::text AS v FROM public.bank_transactions
UNION ALL SELECT '== G bank_txn_count_currency' AS k, COALESCE(currency,'<null>') || '=' || count(*) AS v FROM public.bank_transactions GROUP BY currency
UNION ALL SELECT '== G qb_txn_sum_amount' AS k, COALESCE(sum(amount),0)::text AS v FROM public.qb_transactions
UNION ALL SELECT '== G qb_txn_count_currency' AS k, COALESCE(currency,'<null>') || '=' || count(*) AS v FROM public.qb_transactions GROUP BY currency
UNION ALL SELECT '== G statement_opening_sum' AS k, COALESCE(sum(opening_balance),0)::text AS v FROM public.bank_statements
UNION ALL SELECT '== G statement_closing_sum' AS k, COALESCE(sum(closing_balance),0)::text AS v FROM public.bank_statements
UNION ALL SELECT '== G statement_rows_detail' AS k, id::text || '|' || COALESCE(opening_balance::text,'<null>') || '|' || COALESCE(closing_balance::text,'<null>') || '|' || COALESCE(currency,'<null>') AS v FROM public.bank_statements
UNION ALL SELECT '== G reports_sum_bank_open' AS k, COALESCE(sum(bank_opening_balance),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_bank_close' AS k, COALESCE(sum(bank_closing_balance),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_qb_open' AS k, COALESCE(sum(qb_opening_balance),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_qb_close' AS k, COALESCE(sum(qb_closing_balance),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_variance' AS k, COALESCE(sum(variance),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_matched' AS k, COALESCE(sum(total_matched),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_unmatched_bank' AS k, COALESCE(sum(total_unmatched_bank),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G reports_sum_unmatched_qb' AS k, COALESCE(sum(total_unmatched_qb),0)::text AS v FROM public.reconciliation_reports
UNION ALL SELECT '== G decisions_count_by_type' AS k, COALESCE(decision_type,'<null>') || '=' || count(*) AS v FROM public.reconciliation_decisions GROUP BY decision_type
UNION ALL SELECT '== G matches_confidence_sum' AS k, COALESCE(sum(confidence),0)::text AS v FROM public.reconciliation_matches
UNION ALL SELECT '== G matches_flagged_count' AS k, COALESCE(flagged_level,'<null>') || '=' || count(*) AS v FROM public.reconciliation_matches GROUP BY flagged_level
UNION ALL SELECT '== G invoices_sum_total' AS k, COALESCE(sum(total),0)::text AS v FROM public.invoices
UNION ALL SELECT '== G confirmations_confidence_sum' AS k, COALESCE(sum(confidence),0)::text AS v FROM public.confirmations
UNION ALL SELECT '== G observations_count' AS k, count(*)::text AS v FROM public.bank_statement_transaction_observations
UNION ALL SELECT '== G audit_actions' AS k, COALESCE(action,'<null>') || '=' || count(*) AS v FROM public.reconciliation_audit_log GROUP BY action
UNION ALL SELECT '== G audit_confidence_delta_sum' AS k, COALESCE(sum(COALESCE(new_confidence,0) - COALESCE(old_confidence,0)),0)::text AS v FROM public.reconciliation_audit_log
) AS agg_rows ORDER BY k, v;
