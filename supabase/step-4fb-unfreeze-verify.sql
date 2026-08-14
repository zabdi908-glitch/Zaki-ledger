SELECT '== U stmt' AS k, id::text AS v FROM public.bank_statements WHERE file_name = '4fb-unfreeze-test.csv'
UNION ALL SELECT '== U stmt stamp', client_entity_id::text || ' | ' || ledger_book_id::text FROM public.bank_statements WHERE file_name = '4fb-unfreeze-test.csv'
UNION ALL SELECT '== U bt stamp', min(client_entity_id::text) FROM public.bank_transactions WHERE statement_id = (SELECT id FROM public.bank_statements WHERE file_name = '4fb-unfreeze-test.csv');
