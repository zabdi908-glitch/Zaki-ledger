SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'statements', (SELECT jsonb_agg(x ORDER BY x->>'upload_date') FROM (SELECT jsonb_build_object('id',id::text,'file_name',file_name,'format',file_format,'period_start',statement_period_start,'period_end',statement_period_end,'upload_date',upload_date,'user_id',user_id::text,'txn_count',transaction_count) x FROM public.bank_statements) t),
  'smoke_matches_0814', (SELECT jsonb_agg(jsonb_build_object('match_id',m.id::text,'qb_id',m.qb_transaction_id::text,'bank_txn_id',m.bank_transaction_id::text,'stmt_id',m.statement_id::text,'conf',m.confidence,'approved',(m.approved_at IS NOT NULL),'matched_at',m.matched_at) ORDER BY m.matched_at) FROM public.reconciliation_matches m WHERE m.matched_at >= '2026-08-14')
) AS result;
