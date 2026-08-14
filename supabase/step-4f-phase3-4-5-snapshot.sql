-- Step 4F-A Phases 3+4+5: READ-ONLY production snapshot, integrity preflight,
-- and Migration 012 classifier dry run against production fqvekbzwghjurkcawpgg.
-- ONE UNION ALL SELECT. No DML, no DDL, no RPC calls, no bootstrap.
-- Run: npx supabase db query --linked -f supabase/step-4f-phase3-4-5-snapshot.sql

SELECT * FROM (

-- A. Server + migration ledger identity
SELECT '== A1 server' AS section, current_database() AS v, current_user AS extra, current_setting('server_version') AS extra2
UNION ALL
SELECT '== A2 ledger' , version::text, name::text, '' FROM supabase_migrations.schema_migrations
UNION ALL
SELECT '== A3 ledger_012_absent', count(*)::text, '', '' FROM supabase_migrations.schema_migrations WHERE version = '012'

-- B. Spine + registry counts
UNION ALL SELECT '== B bank_statements', count(*)::text, '', '' FROM public.bank_statements
UNION ALL SELECT '== B bank_statement_transaction_observations', count(*)::text, '', '' FROM public.bank_statement_transaction_observations
UNION ALL SELECT '== B bank_transactions', count(*)::text, '', '' FROM public.bank_transactions
UNION ALL SELECT '== B qb_transactions', count(*)::text, '', '' FROM public.qb_transactions
UNION ALL SELECT '== B reconciliation_matches', count(*)::text, '', '' FROM public.reconciliation_matches
UNION ALL SELECT '== B reconciliation_reports', count(*)::text, '', '' FROM public.reconciliation_reports
UNION ALL SELECT '== B reconciliation_decisions', count(*)::text, '', '' FROM public.reconciliation_decisions
UNION ALL SELECT '== B reconciliation_audit_log', count(*)::text, '', '' FROM public.reconciliation_audit_log
UNION ALL SELECT '== B invoices', count(*)::text, '', '' FROM public.invoices
UNION ALL SELECT '== B invoice_matches', count(*)::text, '', '' FROM public.invoice_matches
UNION ALL SELECT '== B confirmations', count(*)::text, '', '' FROM public.confirmations
UNION ALL SELECT '== B practices', count(*)::text, '', '' FROM public.practices
UNION ALL SELECT '== B practice_memberships', count(*)::text, '', '' FROM public.practice_memberships
UNION ALL SELECT '== B client_entities', count(*)::text, '', '' FROM public.client_entities
UNION ALL SELECT '== B ledger_books', count(*)::text, '', '' FROM public.ledger_books
UNION ALL SELECT '== B default_tenant_identities', count(*)::text, '', '' FROM public.default_tenant_identities
UNION ALL SELECT '== B canonical_audit_ledger', count(*)::text, '', '' FROM public.canonical_audit_ledger

-- C. Auth / classifier (exact 011 eligibility predicate)
UNION ALL SELECT '== C auth_users_total', count(*)::text, '', '' FROM auth.users
UNION ALL SELECT '== C eligible_total', count(*)::text, '', ''
FROM auth.users
WHERE confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false
UNION ALL SELECT '== C eligible_registry_exists', count(*)::text, '', ''
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id)
UNION ALL SELECT '== C eligible_registry_missing', count(*)::text, '', ''
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND NOT EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id)
UNION ALL SELECT '== C ineligible_total', count(*)::text, '', ''
FROM auth.users
WHERE NOT (confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false)
UNION ALL SELECT '== C anonymous_total', count(*)::text, '', '' FROM auth.users WHERE COALESCE(is_anonymous, false) = true
UNION ALL SELECT '== C deleted_total', count(*)::text, '', '' FROM auth.users WHERE deleted_at IS NOT NULL
UNION ALL SELECT '== C confirmed_total', count(*)::text, '', '' FROM auth.users WHERE confirmed_at IS NOT NULL
UNION ALL SELECT '== C registry_incomplete', count(*)::text, '', ''
FROM public.default_tenant_identities
WHERE practice_id IS NULL OR practice_membership_id IS NULL
   OR client_entity_id IS NULL OR internal_ledger_book_id IS NULL
UNION ALL SELECT '== C registry_auth_user_missing', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
LEFT JOIN auth.users AS u ON u.id = reg.user_id
WHERE u.id IS NULL
UNION ALL SELECT '== C distinct_users_bank_statements', count(DISTINCT user_id)::text, '', '' FROM public.bank_statements
UNION ALL SELECT '== C distinct_users_bank_transactions', count(DISTINCT user_id)::text, '', '' FROM public.bank_transactions
UNION ALL SELECT '== C distinct_users_qb_transactions', count(DISTINCT user_id)::text, '', '' FROM public.qb_transactions
UNION ALL SELECT '== C distinct_users_reconciliation_matches', count(DISTINCT user_id)::text, '', '' FROM public.reconciliation_matches
UNION ALL SELECT '== C distinct_users_reconciliation_reports', count(DISTINCT user_id)::text, '', '' FROM public.reconciliation_reports
UNION ALL SELECT '== C distinct_users_reconciliation_decisions', count(DISTINCT user_id)::text, '', '' FROM public.reconciliation_decisions
UNION ALL SELECT '== C distinct_users_audit_via_match', count(DISTINCT rm.user_id)::text, '', ''
FROM public.reconciliation_audit_log AS ral
JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
UNION ALL SELECT '== C users_in_all_seven_spine', count(*)::text, '', ''
FROM (
  SELECT user_id FROM public.bank_statements
  INTERSECT SELECT user_id FROM public.bank_transactions
  INTERSECT SELECT user_id FROM public.qb_transactions
  INTERSECT SELECT user_id FROM public.reconciliation_matches
  INTERSECT SELECT user_id FROM public.reconciliation_reports
  INTERSECT SELECT user_id FROM public.reconciliation_decisions
  INTERSECT SELECT rm.user_id FROM public.reconciliation_audit_log AS ral
            JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
) AS s
UNION ALL SELECT '== C ineligible_rows_bank_statements', count(*)::text, '', ''
FROM public.bank_statements AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C ineligible_rows_bank_transactions', count(*)::text, '', ''
FROM public.bank_transactions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C ineligible_rows_qb_transactions', count(*)::text, '', ''
FROM public.qb_transactions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C ineligible_rows_reconciliation_matches', count(*)::text, '', ''
FROM public.reconciliation_matches AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C ineligible_rows_reconciliation_reports', count(*)::text, '', ''
FROM public.reconciliation_reports AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C ineligible_rows_reconciliation_decisions', count(*)::text, '', ''
FROM public.reconciliation_decisions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C null_userid_rows_any_spine', count(*)::text, '', ''
FROM (
  SELECT user_id FROM public.bank_statements
  UNION ALL SELECT user_id FROM public.bank_transactions
  UNION ALL SELECT user_id FROM public.qb_transactions
  UNION ALL SELECT user_id FROM public.reconciliation_matches
  UNION ALL SELECT user_id FROM public.reconciliation_reports
  UNION ALL SELECT user_id FROM public.reconciliation_decisions
) AS s WHERE user_id IS NULL

-- Phase 5 classifier: exact per-class user IDs (no emails, no PII)
UNION ALL SELECT '== C5 class_eligible_registry_exists_ids', u.id::text, '', ''
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id)
UNION ALL SELECT '== C5 class_eligible_registry_missing_ids', u.id::text, '', ''
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND NOT EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id)
UNION ALL SELECT '== C5 class_ineligible_ids', u.id::text,
  CASE WHEN u.confirmed_at IS NULL THEN 'unconfirmed'
       WHEN u.deleted_at IS NOT NULL THEN 'deleted'
       WHEN COALESCE(u.is_anonymous,false) THEN 'anonymous'
       ELSE 'other' END, ''
FROM auth.users AS u
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false)
UNION ALL SELECT '== C5 class_auth_user_missing_ids', s.user_id::text, 'spine row without auth user', ''
FROM (
  SELECT user_id FROM public.bank_statements
  UNION SELECT user_id FROM public.bank_transactions
  UNION SELECT user_id FROM public.qb_transactions
  UNION SELECT user_id FROM public.reconciliation_matches
  UNION SELECT user_id FROM public.reconciliation_reports
  UNION SELECT user_id FROM public.reconciliation_decisions
) AS s
LEFT JOIN auth.users AS u ON u.id = s.user_id
WHERE s.user_id IS NOT NULL AND u.id IS NULL
UNION ALL SELECT '== C5 class_other_blocker_ids', reg.user_id::text, 'incomplete registry', ''
FROM public.default_tenant_identities AS reg
WHERE practice_id IS NULL OR practice_membership_id IS NULL
   OR client_entity_id IS NULL OR internal_ledger_book_id IS NULL

-- D. Relationship-integrity preflight (exact Step 4E D1-D16)
UNION ALL SELECT '== D1 child_txn_user_mismatch', count(*)::text, '', ''
FROM public.bank_transactions AS bt
JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
WHERE bt.user_id IS DISTINCT FROM bs.user_id
UNION ALL SELECT '== D2 cross_statement_matches', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.statement_id IS DISTINCT FROM bt.statement_id
UNION ALL SELECT '== D3 match_statement_user_mismatch', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
WHERE rm.user_id IS DISTINCT FROM bs.user_id
UNION ALL SELECT '== D4 match_txn_user_mismatch', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.user_id IS DISTINCT FROM bt.user_id
UNION ALL SELECT '== D5 match_qb_user_mismatch', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
JOIN public.qb_transactions AS qt ON qt.id = rm.qb_transaction_id
WHERE rm.user_id IS DISTINCT FROM qt.user_id
UNION ALL SELECT '== D6 report_statement_user_mismatch', count(*)::text, '', ''
FROM public.reconciliation_reports AS rr
JOIN public.bank_statements AS bs ON bs.id = rr.statement_id
WHERE rr.user_id IS DISTINCT FROM bs.user_id
UNION ALL SELECT '== D7 decision_statement_user_mismatch', count(*)::text, '', ''
FROM public.reconciliation_decisions AS rd
JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
WHERE rd.user_id IS DISTINCT FROM bs.user_id
UNION ALL SELECT '== D8a decisions_null_statement', count(*)::text, '', ''
FROM public.reconciliation_decisions WHERE statement_id IS NULL
UNION ALL SELECT '== D8b decisions_missing_statement', count(*)::text, '', ''
FROM public.reconciliation_decisions AS rd
LEFT JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
WHERE rd.statement_id IS NOT NULL AND bs.id IS NULL
UNION ALL SELECT '== D9a audit_null_match', count(*)::text, '', ''
FROM public.reconciliation_audit_log WHERE reconciliation_match_id IS NULL
UNION ALL SELECT '== D9b audit_missing_match', count(*)::text, '', ''
FROM public.reconciliation_audit_log AS ral
LEFT JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
WHERE ral.reconciliation_match_id IS NOT NULL AND rm.id IS NULL
UNION ALL SELECT '== D10 txn_missing_statement', count(*)::text, '', ''
FROM public.bank_transactions AS bt
LEFT JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
WHERE bt.statement_id IS NOT NULL AND bs.id IS NULL
UNION ALL SELECT '== D11 match_missing_txn', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
LEFT JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.bank_transaction_id IS NOT NULL AND bt.id IS NULL
UNION ALL SELECT '== D12 match_missing_statement', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
LEFT JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
WHERE rm.statement_id IS NOT NULL AND bs.id IS NULL
UNION ALL SELECT '== D13 canonical_cols_present', count(*)::text, '', ''
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'bank_statements' AND column_name IN ('client_entity_id','ledger_book_id'))
    OR (table_name IN ('bank_transactions','qb_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions') AND column_name = 'client_entity_id')
    OR (table_name = 'reconciliation_audit_log' AND column_name IN ('client_entity_id','user_id')))
UNION ALL SELECT '== D14 shape', table_name::text, column_name::text, is_nullable || '|' || data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'reconciliation_audit_log' AND column_name = 'reconciliation_match_id')
    OR (table_name = 'reconciliation_decisions' AND column_name = 'statement_id')
    OR (table_name = 'reconciliation_matches' AND column_name IN ('qb_transaction_id','bank_transaction_id')))
UNION ALL SELECT '== D15 matches_with_eligible_statement_user', count(*)::text, '', ''
FROM public.reconciliation_matches AS rm
JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
JOIN auth.users AS u ON u.id = bs.user_id
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
UNION ALL SELECT '== D16 eligible_registry_null_client_or_book', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN auth.users AS u ON u.id = reg.user_id
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND (reg.client_entity_id IS NULL OR reg.internal_ledger_book_id IS NULL)

-- E. Registry graph ownership (Phase 4 item 13)
UNION ALL SELECT '== E1 practice_owner_mismatch', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN public.practices AS p ON p.id = reg.practice_id
WHERE p.created_by_user_id IS DISTINCT FROM reg.user_id
UNION ALL SELECT '== E2 membership_user_mismatch', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN public.practice_memberships AS pm ON pm.id = reg.practice_membership_id
WHERE pm.user_id IS DISTINCT FROM reg.user_id
UNION ALL SELECT '== E3 membership_practice_mismatch', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN public.practice_memberships AS pm ON pm.id = reg.practice_membership_id
WHERE pm.practice_id IS DISTINCT FROM reg.practice_id
UNION ALL SELECT '== E4 client_entity_practice_mismatch', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN public.client_entities AS ce ON ce.id = reg.client_entity_id
WHERE ce.practice_id IS DISTINCT FROM reg.practice_id
UNION ALL SELECT '== E5 ledger_book_client_mismatch', count(*)::text, '', ''
FROM public.default_tenant_identities AS reg
JOIN public.ledger_books AS lb ON lb.id = reg.internal_ledger_book_id
WHERE lb.client_entity_id IS DISTINCT FROM reg.client_entity_id

-- F. Accounting parity anchors
UNION ALL SELECT '== F bank_txn_sum_amount', COALESCE(sum(amount),0)::text, '', '' FROM public.bank_transactions
UNION ALL SELECT '== F qb_txn_sum_amount', COALESCE(sum(amount),0)::text, '', '' FROM public.qb_transactions
UNION ALL SELECT '== F statement_opening_sum', COALESCE(sum(opening_balance),0)::text, '', '' FROM public.bank_statements
UNION ALL SELECT '== F statement_closing_sum', COALESCE(sum(closing_balance),0)::text, '', '' FROM public.bank_statements

) AS preflight_rows
ORDER BY section, v, extra;
