-- Step 4E Phase 1: READ-ONLY production snapshot (preflight evidence).
-- All statements are SELECTs. No DML, no DDL, no bootstrap.
-- Run against the production candidate db.fqvekbzwghjurkcawpgg.
\set ON_ERROR_STOP on

SELECT '== A1 server' AS section, current_database() AS v, current_user AS extra, current_setting('server_version') AS extra2;

SELECT '== A2 ledger' AS section, version AS v, name AS extra, '' AS extra2
FROM supabase_migrations.schema_migrations ORDER BY version;

-- =========================================================================
-- B. Spine + registry counts
-- =========================================================================
SELECT '== B bank_statements' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.bank_statements;
SELECT '== B bank_statement_transaction_observations' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.bank_statement_transaction_observations;
SELECT '== B bank_transactions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.bank_transactions;
SELECT '== B qb_transactions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.qb_transactions;
SELECT '== B reconciliation_matches' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_matches;
SELECT '== B reconciliation_reports' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_reports;
SELECT '== B reconciliation_decisions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_decisions;
SELECT '== B reconciliation_audit_log' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_audit_log;
SELECT '== B invoices' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.invoices;
SELECT '== B invoice_matches' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.invoice_matches;
SELECT '== B confirmations' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.confirmations;
SELECT '== B practices' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.practices;
SELECT '== B practice_memberships' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.practice_memberships;
SELECT '== B client_entities' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.client_entities;
SELECT '== B ledger_books' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.ledger_books;
SELECT '== B default_tenant_identities' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.default_tenant_identities;
SELECT '== B canonical_audit_ledger' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM public.canonical_audit_ledger;

-- =========================================================================
-- C. Auth / classifier inputs (exact 011 predicate)
-- =========================================================================
SELECT '== C auth_users_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2 FROM auth.users;

SELECT '== C eligible_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users
WHERE confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false;

SELECT '== C eligible_registry_exists' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id);

SELECT '== C eligible_registry_missing' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users AS u
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND NOT EXISTS (SELECT 1 FROM public.default_tenant_identities AS reg WHERE reg.user_id = u.id);

SELECT '== C ineligible_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users
WHERE NOT (confirmed_at IS NOT NULL AND deleted_at IS NULL AND COALESCE(is_anonymous, false) = false);

SELECT '== C anonymous_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users WHERE COALESCE(is_anonymous, false) = true;

SELECT '== C deleted_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users WHERE deleted_at IS NOT NULL;

SELECT '== C confirmed_total' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM auth.users WHERE confirmed_at IS NOT NULL;

-- Registry rows with any core field NULL
SELECT '== C registry_incomplete' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.default_tenant_identities
WHERE practice_id IS NULL OR practice_membership_id IS NULL
   OR client_entity_id IS NULL OR internal_ledger_book_id IS NULL;

-- Registry rows whose user_id has no auth row
SELECT '== C registry_auth_user_missing' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.default_tenant_identities AS reg
LEFT JOIN auth.users AS u ON u.id = reg.user_id
WHERE u.id IS NULL;

-- Distinct spine users per table (audit resolved through match pointer)
SELECT '== C distinct_users_bank_statements' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.bank_statements;
SELECT '== C distinct_users_bank_transactions' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.bank_transactions;
SELECT '== C distinct_users_qb_transactions' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.qb_transactions;
SELECT '== C distinct_users_reconciliation_matches' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_matches;
SELECT '== C distinct_users_reconciliation_reports' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_reports;
SELECT '== C distinct_users_reconciliation_decisions' AS section, count(DISTINCT user_id)::text AS v, '' AS extra, '' AS extra2 FROM public.reconciliation_decisions;
SELECT '== C distinct_users_audit_via_match' AS section, count(DISTINCT rm.user_id)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_audit_log AS ral
JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id;

-- Users appearing in ALL seven spine sets (audit via match join)
SELECT '== C users_in_all_seven_spine' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM (
  SELECT user_id FROM public.bank_statements
  INTERSECT SELECT user_id FROM public.bank_transactions
  INTERSECT SELECT user_id FROM public.qb_transactions
  INTERSECT SELECT user_id FROM public.reconciliation_matches
  INTERSECT SELECT user_id FROM public.reconciliation_reports
  INTERSECT SELECT user_id FROM public.reconciliation_decisions
  INTERSECT SELECT rm.user_id FROM public.reconciliation_audit_log AS ral
            JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
) AS s;

-- Rows belonging to ineligible users per spine table (user_id present but not eligible)
SELECT '== C ineligible_rows_bank_statements' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.bank_statements AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

SELECT '== C ineligible_rows_bank_transactions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.bank_transactions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

SELECT '== C ineligible_rows_qb_transactions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.qb_transactions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

SELECT '== C ineligible_rows_reconciliation_matches' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

SELECT '== C ineligible_rows_reconciliation_reports' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_reports AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

SELECT '== C ineligible_rows_reconciliation_decisions' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_decisions AS t
JOIN auth.users AS u ON u.id = t.user_id
WHERE NOT (u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false);

-- Rows with NULL user_id (would break join-through-match classification)
SELECT '== C null_userid_rows_any_spine' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM (
  SELECT user_id FROM public.bank_statements
  UNION ALL SELECT user_id FROM public.bank_transactions
  UNION ALL SELECT user_id FROM public.qb_transactions
  UNION ALL SELECT user_id FROM public.reconciliation_matches
  UNION ALL SELECT user_id FROM public.reconciliation_reports
  UNION ALL SELECT user_id FROM public.reconciliation_decisions
) AS s WHERE user_id IS NULL;

-- =========================================================================
-- D. Relationship-integrity preflight (read-only)
-- =========================================================================

-- D1: child bank_transactions user_id != parent statement user_id
SELECT '== D1 child_txn_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.bank_transactions AS bt
JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
WHERE bt.user_id IS DISTINCT FROM bs.user_id;

-- D2: cross-statement bank transaction matches (BLOCKER for Z5 FK)
SELECT '== D2 cross_statement_matches' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.statement_id IS DISTINCT FROM bt.statement_id;

-- D3: match vs parent statement user mismatch
SELECT '== D3 match_statement_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
WHERE rm.user_id IS DISTINCT FROM bs.user_id;

-- D4: match vs bank transaction user mismatch
SELECT '== D4 match_txn_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.user_id IS DISTINCT FROM bt.user_id;

-- D5: match vs QB transaction user mismatch
SELECT '== D5 match_qb_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
JOIN public.qb_transactions AS qt ON qt.id = rm.qb_transaction_id
WHERE rm.user_id IS DISTINCT FROM qt.user_id;

-- D6: report vs statement user mismatch
SELECT '== D6 report_statement_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_reports AS rr
JOIN public.bank_statements AS bs ON bs.id = rr.statement_id
WHERE rr.user_id IS DISTINCT FROM bs.user_id;

-- D7: decision vs statement user mismatch
SELECT '== D7 decision_statement_user_mismatch' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_decisions AS rd
JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
WHERE rd.user_id IS DISTINCT FROM bs.user_id;

-- D8: orphan decisions (statement NULL or missing parent)
SELECT '== D8a decisions_null_statement' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_decisions WHERE statement_id IS NULL;
SELECT '== D8b decisions_missing_statement' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_decisions AS rd
LEFT JOIN public.bank_statements AS bs ON bs.id = rd.statement_id
WHERE rd.statement_id IS NOT NULL AND bs.id IS NULL;

-- D9: orphan audit rows (BLOCKER: Z3g NO-GO if match unresolvable)
SELECT '== D9a audit_null_match' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_audit_log WHERE reconciliation_match_id IS NULL;
SELECT '== D9b audit_missing_match' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_audit_log AS ral
LEFT JOIN public.reconciliation_matches AS rm ON rm.id = ral.reconciliation_match_id
WHERE ral.reconciliation_match_id IS NOT NULL AND rm.id IS NULL;

-- D10: bank transactions missing parent statement
SELECT '== D10 txn_missing_statement' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.bank_transactions AS bt
LEFT JOIN public.bank_statements AS bs ON bs.id = bt.statement_id
WHERE bt.statement_id IS NOT NULL AND bs.id IS NULL;

-- D11: matches missing parent bank transaction
SELECT '== D11 match_missing_txn' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
LEFT JOIN public.bank_transactions AS bt ON bt.id = rm.bank_transaction_id
WHERE rm.bank_transaction_id IS NOT NULL AND bt.id IS NULL;

-- D12: matches missing parent statement
SELECT '== D12 match_missing_statement' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
LEFT JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
WHERE rm.statement_id IS NOT NULL AND bs.id IS NULL;

-- D13: canonical stamp columns present? (should be absent pre-012)
SELECT '== D13 canonical_cols_present' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'bank_statements' AND column_name IN ('client_entity_id','ledger_book_id'))
    OR (table_name IN ('bank_transactions','qb_transactions','reconciliation_matches','reconciliation_reports','reconciliation_decisions') AND column_name = 'client_entity_id')
    OR (table_name = 'reconciliation_audit_log' AND column_name IN ('client_entity_id','user_id')));

-- D14: nullable/type of audit pointer + decisions statement (shape check)
SELECT '== D14 shape' AS section, table_name AS v, column_name AS extra, is_nullable || '|' || data_type AS extra2
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'reconciliation_audit_log' AND column_name = 'reconciliation_match_id')
    OR (table_name = 'reconciliation_decisions' AND column_name = 'statement_id')
    OR (table_name = 'reconciliation_matches' AND column_name IN ('qb_transaction_id','bank_transaction_id')));

-- D15: matches whose parent statement user is ELIGIBLE (backfill will stamp from registry)
SELECT '== D15 matches_with_eligible_statement_user' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.reconciliation_matches AS rm
JOIN public.bank_statements AS bs ON bs.id = rm.statement_id
JOIN auth.users AS u ON u.id = bs.user_id
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false;

-- D16: eligible registry rows with NULL client or book (would leave stamps NULL after backfill)
SELECT '== D16 eligible_registry_null_client_or_book' AS section, count(*)::text AS v, '' AS extra, '' AS extra2
FROM public.default_tenant_identities AS reg
JOIN auth.users AS u ON u.id = reg.user_id
WHERE u.confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.is_anonymous, false) = false
  AND (reg.client_entity_id IS NULL OR reg.internal_ledger_book_id IS NULL);
