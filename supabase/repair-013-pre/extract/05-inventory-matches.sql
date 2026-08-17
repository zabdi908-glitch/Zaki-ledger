SET default_transaction_read_only = on;
WITH dup AS (
  SELECT qb_transaction_id
  FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
), mm AS (
  SELECT m.*, d.qb_transaction_id IS NOT NULL AS in_dup
  FROM public.reconciliation_matches m
  JOIN dup d ON d.qb_transaction_id = m.qb_transaction_id
  WHERE m.matched_by = 'auto'
)
SELECT jsonb_agg(
  jsonb_build_object(
    'match_id', m.id::text,
    'qb_id', m.qb_transaction_id::text,
    'user_id', m.user_id::text,
    'statement_id', m.statement_id::text,
    'bank_txn_id', m.bank_transaction_id::text,
    'confidence', m.confidence,
    'flagged_level', m.flagged_level,
    'matched_by', m.matched_by,
    'matched_at', m.matched_at,
    'approved_by', m.approved_by,
    'approved_at', m.approved_at,
    'match_reason', m.match_reason,
    'audit_memo', m.audit_memo,
    'client_entity_id', m.client_entity_id::text,
    'bank_date', b.transaction_date,
    'bank_posted_date', b.posted_date,
    'bank_amount', b.amount,
    'bank_currency', b.currency,
    'bank_merchant', b.merchant,
    'bank_description', b.description,
    'bank_source_provider', b.source_provider,
    'bank_client_entity_id', b.client_entity_id::text,
    'stmt_file_name', s.file_name,
    'stmt_format', s.file_format,
    'stmt_period_start', s.statement_period_start,
    'stmt_period_end', s.statement_period_end,
    'stmt_ledger_book_id', s.ledger_book_id::text,
    'stmt_client_entity_id', s.client_entity_id::text,
    'stmt_upload_date', s.upload_date
  )
) AS result
FROM mm m
JOIN public.bank_transactions b ON b.id = m.bank_transaction_id
JOIN public.bank_statements s ON s.id = m.statement_id;
