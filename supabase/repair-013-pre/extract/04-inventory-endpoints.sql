SET default_transaction_read_only = on;
WITH dup AS (
  SELECT qb_transaction_id
  FROM public.reconciliation_matches
  WHERE matched_by='auto' AND qb_transaction_id IS NOT NULL
  GROUP BY qb_transaction_id HAVING count(*) > 1
), m AS (
  SELECT m.* FROM public.reconciliation_matches m JOIN dup d ON d.qb_transaction_id = m.qb_transaction_id
  WHERE m.matched_by = 'auto'
)
SELECT jsonb_agg(
  jsonb_build_object(
    'qb_id', e.qb_id::text,
    'user_id', e.user_id::text,
    'client_entity_id', e.client_entity_id::text,
    'client_display_name', ce.display_name,
    'client_legal_name', ce.legal_name,
    'practice_id', p.id::text,
    'practice_name', p.name,
    'qb_ledger_book_id', e.qb_ledger_book_id::text,
    'qb_book_kind', lb.book_kind,
    'qb_native_id', e.qb_native_id,
    'qb_date', e.qb_date,
    'qb_amount', e.qb_amount,
    'qb_currency', e.qb_currency,
    'qb_description', e.qb_description,
    'qb_account_name', e.qb_account_name,
    'qb_provider', e.qb_provider,
    'qb_org_id', e.qb_organisation_id,
    'qb_synced_at', e.qb_synced_at,
    'is_test_qb', e.is_test_qb,
    'n_matches', e.n_matches,
    'n_approved', e.n_approved,
    'n_unapproved', e.n_unapproved,
    'n_statements', e.n_statements,
    'n_bank_rows', e.n_bank_rows,
    'all_bank_same_client', e.all_bank_same_client,
    'any_approved_by_non_null', e.any_approved_by
  )
) AS result
FROM (
  SELECT
    m.qb_transaction_id AS qb_id,
    min(m.user_id::text)::uuid AS user_id,
    min(m.client_entity_id::text)::uuid AS client_entity_id,
    count(*) AS n_matches,
    count(*) FILTER (WHERE m.approved_at IS NOT NULL) AS n_approved,
    count(*) FILTER (WHERE m.approved_at IS NULL) AS n_unapproved,
    count(DISTINCT m.statement_id) AS n_statements,
    count(DISTINCT m.bank_transaction_id) AS n_bank_rows,
    bool_and(m.client_entity_id IS NOT DISTINCT FROM q.client_entity_id) AS all_bank_same_client,
    bool_or(m.approved_by IS NOT NULL) AS any_approved_by,
    q.qb_transaction_id AS qb_native_id,
    q.posted_date AS qb_date,
    q.amount AS qb_amount,
    q.currency AS qb_currency,
    q.description AS qb_description,
    q.account_name AS qb_account_name,
    q.provider AS qb_provider,
    q.organisation_id AS qb_organisation_id,
    q.synced_from_qb_at AS qb_synced_at,
    q.ledger_book_id AS qb_ledger_book_id,
    (q.description ILIKE '%4FB-CANONICAL-TEST%') AS is_test_qb
  FROM m
  JOIN public.qb_transactions q ON q.id = m.qb_transaction_id
  GROUP BY m.qb_transaction_id, q.qb_transaction_id, q.posted_date, q.amount, q.currency,
           q.description, q.account_name, q.provider, q.organisation_id,
           q.synced_from_qb_at, q.ledger_book_id
) e
LEFT JOIN public.client_entities ce ON ce.id = e.client_entity_id
LEFT JOIN public.ledger_books lb ON lb.id = e.qb_ledger_book_id
LEFT JOIN LATERAL (
  SELECT p.id, p.name FROM public.practices p
  JOIN public.practice_memberships pm ON pm.practice_id = p.id
  WHERE pm.user_id = e.user_id
  ORDER BY p.created_at LIMIT 1
) p ON true;
