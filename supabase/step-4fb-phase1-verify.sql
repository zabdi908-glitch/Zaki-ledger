-- Step 4F-B Phase 1 evidence: locate the smoke-upload rows (read-only).
SELECT 'statement' AS kind, id::text, (row_to_json(bs)::text) AS payload
FROM public.bank_statements bs
WHERE row_to_json(bs)::text ILIKE '%4FB-TEST-011%'
UNION ALL
SELECT 'bank_transaction', bt.id::text, (row_to_json(bt)::text)::text
FROM public.bank_transactions bt
WHERE row_to_json(bt)::text ILIKE '%4FB-TEST-011%'
UNION ALL
SELECT 'audit', al.id::text, (row_to_json(al)::text)::text
FROM public.reconciliation_audit_log al
WHERE row_to_json(al)::text ILIKE '%4FB-TEST-011%';
