SELECT '== V stmt' AS k, bs.id::text AS v FROM public.bank_statements bs WHERE bs.file_name = '4e8-valid-1'
UNION ALL SELECT '== V stmt stamp', client_entity_id::text || ' / ' || ledger_book_id::text FROM public.bank_statements WHERE file_name = '4e8-valid-1'
UNION ALL SELECT '== V qb', qt.id::text FROM public.qb_transactions qt WHERE qt.provider = '4e8'
UNION ALL SELECT '== V qb stamp', client_entity_id::text || ' / ' || ledger_book_id::text FROM public.qb_transactions WHERE provider = '4e8'
UNION ALL SELECT '== V bt', bt.id::text FROM public.bank_transactions bt JOIN public.bank_statements bs ON bs.id = bt.statement_id WHERE bs.file_name = '4e8-valid-1'
UNION ALL SELECT '== V bt stamp', bt.client_entity_id::text FROM public.bank_transactions bt JOIN public.bank_statements bs ON bs.id = bt.statement_id WHERE bs.file_name = '4e8-valid-1';
