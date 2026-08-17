SET default_transaction_read_only = on;
SELECT jsonb_agg(jsonb_build_object(
  'id', id::text, 'user_id', user_id::text, 'posted_date', posted_date, 'amount', amount,
  'description', description, 'client_entity_id', client_entity_id::text, 'ledger_book_id', ledger_book_id::text
)) AS result
FROM public.qb_transactions;
