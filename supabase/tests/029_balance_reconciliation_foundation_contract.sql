\set ON_ERROR_STOP on

-- Migration 029 behavioral contract. All fixtures roll back.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '029 assertion failed: %', p_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_pattern text, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_failed boolean := false; v_error text;
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN v_failed := true; v_error := SQLERRM;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION '029 expected failure did not occur: %', p_message; END IF;
  IF v_error !~* p_pattern THEN
    RAISE EXCEPTION '029 wrong failure for %: %', p_message, v_error;
  END IF;
END;
$$;

INSERT INTO auth.users (id, email, role, aud, created_at, updated_at) VALUES
  ('28000000-0000-0000-0000-000000000001', 'balance-a@example.test', 'authenticated', 'authenticated', now(), now()),
  ('28000000-0000-0000-0000-000000000002', 'balance-b@example.test', 'authenticated', 'authenticated', now(), now());
INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('28100000-0000-0000-0000-000000000001', 'Balance Practice A', '28000000-0000-0000-0000-000000000001'),
  ('28100000-0000-0000-0000-000000000002', 'Balance Practice B', '28000000-0000-0000-0000-000000000002');
INSERT INTO public.practice_memberships (id, practice_id, user_id, role) VALUES
  ('28200000-0000-0000-0000-000000000001', '28100000-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001', 'owner'),
  ('28200000-0000-0000-0000-000000000002', '28100000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000002', 'owner');
INSERT INTO public.client_entities
  (id, practice_id, legal_name, display_name, base_currency) VALUES
  ('28300000-0000-0000-0000-000000000001', '28100000-0000-0000-0000-000000000001', 'Balance A Ltd', 'Balance A', 'GBP'),
  ('28300000-0000-0000-0000-000000000002', '28100000-0000-0000-0000-000000000002', 'Balance B Ltd', 'Balance B', 'GBP');
INSERT INTO public.ledger_books
  (id, client_entity_id, book_kind, display_name, functional_currency) VALUES
  ('28400000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', 'quickbooks', 'Balance Book A', 'GBP'),
  ('28400000-0000-0000-0000-000000000002', '28300000-0000-0000-0000-000000000002', 'quickbooks', 'Balance Book B', 'GBP');
INSERT INTO public.provider_connections
  (id, client_entity_id, ledger_book_id, provider, external_organisation_id) VALUES
  ('28500000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', '28400000-0000-0000-0000-000000000001', 'quickbooks', 'realm-balance-a'),
  ('28500000-0000-0000-0000-000000000002', '28300000-0000-0000-0000-000000000002', '28400000-0000-0000-0000-000000000002', 'quickbooks', 'realm-balance-b');
INSERT INTO public.financial_accounts
  (id, client_entity_id, ledger_book_id, account_kind, display_name, currency_code) VALUES
  ('28600000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', '28400000-0000-0000-0000-000000000001', 'bank', 'Current Account', 'GBP'),
  ('28600000-0000-0000-0000-000000000002', '28300000-0000-0000-0000-000000000002', '28400000-0000-0000-0000-000000000002', 'bank', 'Other Account', 'GBP');
INSERT INTO public.provider_posting_account_mappings
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   financial_account_id, provider, external_organisation_id, provider_account_id,
   posting_role, provider_account_type, mapping_status, is_postable,
   verified_at, eligibility_expires_at) VALUES
  ('28700000-0000-0000-0000-000000000001', '28100000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', '28400000-0000-0000-0000-000000000001', '28500000-0000-0000-0000-000000000001', '28600000-0000-0000-0000-000000000001', 'quickbooks', 'realm-balance-a', 'qb-bank-a', 'general_ledger', 'Bank', 'active', true, now() - interval '1 minute', now() + interval '1 day'),
  ('28700000-0000-0000-0000-000000000002', '28100000-0000-0000-0000-000000000002', '28300000-0000-0000-0000-000000000002', '28400000-0000-0000-0000-000000000002', '28500000-0000-0000-0000-000000000002', '28600000-0000-0000-0000-000000000002', 'quickbooks', 'realm-balance-b', 'qb-bank-b', 'general_ledger', 'Bank', 'active', true, now() - interval '1 minute', now() + interval '1 day');

INSERT INTO public.balance_reconciliation_scopes
  (id, practice_id, client_entity_id, ledger_book_id, financial_account_id,
   ledger_provider_connection_id, ledger_provider, ledger_external_organisation_id,
   ledger_provider_account_id, source_provider, source_account_id, account_class,
   currency_code, minor_unit_exponent, account_timezone, source_date_basis,
   ledger_date_basis, source_balance_sign_multiplier, ledger_balance_sign_multiplier,
   contract_version)
VALUES
  ('28800000-0000-0000-0000-000000000001', '28100000-0000-0000-0000-000000000001',
   '28300000-0000-0000-0000-000000000001', '28400000-0000-0000-0000-000000000001',
   '28600000-0000-0000-0000-000000000001', '28500000-0000-0000-0000-000000000001',
   'quickbooks', 'realm-balance-a', 'qb-bank-a', 'ofx', 'ofx-account-a', 'asset',
   'GBP', 2, 'Europe/London', 'posted_date', 'accounting_date', 1, 1, 'step6-day4-v1');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.balance_reconciliation_scopes
    (practice_id, client_entity_id, ledger_book_id, financial_account_id,
     ledger_provider_connection_id, ledger_provider, ledger_external_organisation_id,
     ledger_provider_account_id, source_provider, source_account_id, account_class,
     currency_code, minor_unit_exponent, account_timezone, source_date_basis,
     ledger_date_basis, source_balance_sign_multiplier, ledger_balance_sign_multiplier,
     contract_version)
  VALUES
    ('28100000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001',
     '28400000-0000-0000-0000-000000000001', '28600000-0000-0000-0000-000000000001',
     '28500000-0000-0000-0000-000000000002', 'quickbooks', 'realm-balance-b',
     'qb-bank-b', 'ofx', 'cross-tenant', 'asset', 'GBP', 2, 'Europe/London',
     'posted_date', 'accounting_date', 1, 1, 'step6-day4-v1')
$sql$, 'foreign key|owned financial account|mapping', 'scope cannot cross tenant/account ownership');

-- Frozen sign orientation and exact bigint arithmetic.
SELECT pg_temp.assert_true(public.balance_normalize_legacy_movement_v1('asset', 100) = -100,
  'asset money-out decreases normalized position');
SELECT pg_temp.assert_true(public.balance_normalize_legacy_movement_v1('liability', 100) = 100,
  'liability money-out increases normalized position');
SELECT pg_temp.assert_true(public.balance_normalize_legacy_movement_v1('credit_card', 100) = 100,
  'credit-card spend increases normalized liability');
SELECT pg_temp.assert_true(public.balance_normalize_legacy_movement_v1('overdraft', 100) = 100,
  'overdraft drawdown increases normalized liability');
SELECT pg_temp.assert_true(public.balance_normalize_raw_balance_v1(-12345, -1) = 12345,
  'balance multiplier is exact');
SELECT pg_temp.assert_true(
  public.balance_checked_add_minor_v1(9007199254740993, 7) = 9007199254741000,
  'minor-unit addition remains exact beyond JavaScript safe integers');
SELECT pg_temp.expect_error(
  $$SELECT public.balance_checked_add_minor_v1(9223372036854775807, 1)$$,
  'overflow', 'minor-unit overflow fails closed');

-- Europe/London spring-forward day is 23 hours; autumn fallback is 25 hours.
SELECT pg_temp.assert_true(
  public.balance_period_end_exclusive_utc_v1('2026-03-29', 'Europe/London')
    - public.balance_period_start_utc_v1('2026-03-29', 'Europe/London') = interval '23 hours',
  'spring DST cutoff uses local calendar midnight');
SELECT pg_temp.assert_true(
  public.balance_period_end_exclusive_utc_v1('2026-10-25', 'Europe/London')
    - public.balance_period_start_utc_v1('2026-10-25', 'Europe/London') = interval '25 hours',
  'autumn DST cutoff uses local calendar midnight');
SELECT pg_temp.assert_true(
  public.balance_timestamp_in_period_v1('2026-03-29 22:59:59+00', '2026-03-29', '2026-03-29', 'Europe/London')
  AND NOT public.balance_timestamp_in_period_v1('2026-03-29 23:00:00+00', '2026-03-29', '2026-03-29', 'Europe/London'),
  'timestamp cutoff is half-open');

INSERT INTO public.balance_snapshots
  (id, scope_id, client_entity_id, side, boundary, local_boundary_date,
   as_of_exclusive, raw_balance_text, raw_currency_text, raw_balance_minor,
   balance_sign_multiplier, balance_minor, currency_code, minor_unit_exponent,
   snapshot_origin, verification_state, retrieved_at, raw_payload_hash,
   evidence_fingerprint) VALUES
  ('28900000-0000-0000-0000-000000000001', '28800000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', 'source', 'opening', '2026-03-01', '2026-03-01 00:00:00+00', '100.00', 'GBP', 10000, 1, 10000, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('11',32),'hex'), decode(repeat('21',32),'hex')),
  ('28900000-0000-0000-0000-000000000002', '28800000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001', 'source', 'closing', '2026-04-01', '2026-03-31 23:00:00+00', '90.00', 'GBP', 9000, 1, 9000, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('12',32),'hex'), decode(repeat('22',32),'hex'));

INSERT INTO public.balance_movement_sets
  (id, scope_id, client_entity_id, side, period_start, period_end,
   period_start_utc, period_end_exclusive_utc, date_basis,
   opening_snapshot_id, closing_snapshot_id, pagination_mode, page_count,
   pagination_complete, terminal_boundary_seen, coverage_complete, result_truncated,
   error_count, returned_count, accepted_count, rejected_count, duplicate_count,
   movement_total_minor, completeness_state, request_fingerprint,
   response_fingerprint, set_fingerprint, retrieval_started_at, retrieval_completed_at)
VALUES
  ('28a00000-0000-0000-0000-000000000001', '28800000-0000-0000-0000-000000000001',
   '28300000-0000-0000-0000-000000000001', 'source', '2026-03-01', '2026-03-31',
   '2026-03-01 00:00:00+00', '2026-03-31 23:00:00+00', 'posted_date',
   '28900000-0000-0000-0000-000000000001', '28900000-0000-0000-0000-000000000002',
   'provider_cursor', 1, true, true, true, false, 0, 1, 1, 0, 0, -1000,
   'complete', decode(repeat('31',32),'hex'), decode(repeat('32',32),'hex'),
   decode(repeat('33',32),'hex'), now() - interval '1 second', now());

INSERT INTO public.balance_movement_members
  (id, movement_set_id, scope_id, client_entity_id, movement_identity_canonical,
   date_precision, effective_on, raw_amount_minor, normalization_basis,
   movement_minor, currency_code, minor_unit_exponent, source_status, included,
   evidence_hash)
VALUES
  ('28b00000-0000-0000-0000-000000000001', '28a00000-0000-0000-0000-000000000001',
   '28800000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001',
   'ofx|ofx-account-a|fitid-1', 'date', '2026-03-15', 1000,
   'legacy_positive_out', -1000, 'GBP', 2, 'posted', true, decode(repeat('41',32),'hex'));

SET CONSTRAINTS balance_movement_sets_complete_ck, balance_movement_members_complete_ck IMMEDIATE;
SELECT pg_temp.assert_true(
  public.balance_movement_set_validation_v1('28a00000-0000-0000-0000-000000000001') = 'OK',
  'complete movement manifest proves exact rollforward');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.balance_movement_members
    (movement_set_id, scope_id, client_entity_id, movement_identity_canonical,
     date_precision, effective_on, raw_amount_minor, normalization_basis,
     movement_minor, currency_code, minor_unit_exponent, source_status, included,
     evidence_hash)
  VALUES
    ('28a00000-0000-0000-0000-000000000001', '28800000-0000-0000-0000-000000000001',
     '28300000-0000-0000-0000-000000000001', 'ofx|ofx-account-a|fitid-1',
     'date', '2026-03-16', 1000, 'legacy_positive_out', -1000, 'GBP', 2,
     'posted', true, decode(repeat('42',32),'hex'))
$sql$, 'duplicate key', 'duplicate movement identity is rejected');

-- Incomplete pagination remains evidence, but can never claim COMPLETE.
INSERT INTO public.balance_movement_sets
  (id, scope_id, client_entity_id, side, period_start, period_end,
   period_start_utc, period_end_exclusive_utc, date_basis,
   opening_snapshot_id, closing_snapshot_id, pagination_mode, page_count,
   pagination_complete, terminal_boundary_seen, coverage_complete, result_truncated,
   error_count, returned_count, accepted_count, rejected_count, duplicate_count,
   movement_total_minor, completeness_state, incompleteness_reason,
   request_fingerprint, response_fingerprint, set_fingerprint,
   retrieval_started_at, retrieval_completed_at)
VALUES
  ('28a00000-0000-0000-0000-000000000002', '28800000-0000-0000-0000-000000000001',
   '28300000-0000-0000-0000-000000000001', 'source', '2026-03-01', '2026-03-31',
   '2026-03-01 00:00:00+00', '2026-03-31 23:00:00+00', 'posted_date',
   '28900000-0000-0000-0000-000000000001', '28900000-0000-0000-0000-000000000002',
   'provider_cursor', 20, false, false, true, true, 0, 0, 0, 0, 0, 0,
   'incomplete', 'provider page cap reached', decode(repeat('51',32),'hex'),
   decode(repeat('52',32),'hex'), decode(repeat('53',32),'hex'),
   now() - interval '1 second', now());
SELECT pg_temp.assert_true(
  public.balance_movement_set_validation_v1('28a00000-0000-0000-0000-000000000002') = 'PAGINATION_INCOMPLETE',
  'incomplete pagination is deterministic');
SELECT pg_temp.expect_error($sql$
  INSERT INTO public.balance_movement_sets
    (scope_id, client_entity_id, side, period_start, period_end,
     period_start_utc, period_end_exclusive_utc, date_basis,
     opening_snapshot_id, closing_snapshot_id, pagination_mode, page_count,
     pagination_complete, terminal_boundary_seen, coverage_complete, result_truncated,
     error_count, returned_count, accepted_count, rejected_count, duplicate_count,
     movement_total_minor, completeness_state, request_fingerprint,
     response_fingerprint, set_fingerprint, retrieval_started_at, retrieval_completed_at)
  VALUES
    ('28800000-0000-0000-0000-000000000001', '28300000-0000-0000-0000-000000000001',
     'source', '2026-03-01', '2026-03-31', '2026-03-01 00:00:00+00',
     '2026-03-31 23:00:00+00', 'posted_date',
     '28900000-0000-0000-0000-000000000001', '28900000-0000-0000-0000-000000000002',
     'provider_cursor', 20, false, false, true, true, 0, 0, 0, 0, 0, 0,
     'complete', decode(repeat('61',32),'hex'), decode(repeat('62',32),'hex'),
     decode(repeat('63',32),'hex'), now() - interval '1 second', now())
$sql$, 'incomplete retrieval evidence', 'incomplete provider pagination cannot claim complete');

SELECT pg_temp.expect_error($sql$
  UPDATE public.balance_snapshots SET provider_version = 'rewritten'
  WHERE id = '28900000-0000-0000-0000-000000000001'
$sql$, 'append-only', 'snapshot is immutable');
SELECT pg_temp.expect_error($sql$
  UPDATE public.balance_movement_sets SET set_fingerprint = decode(repeat('ff',32),'hex')
  WHERE id = '28a00000-0000-0000-0000-000000000001'
$sql$, 'append-only', 'movement manifest is immutable');
SELECT pg_temp.expect_error($sql$
  DELETE FROM public.balance_movement_members
  WHERE id = '28b00000-0000-0000-0000-000000000001'
$sql$, 'append-only', 'movement member is immutable');

ROLLBACK;
SELECT '029_BALANCE_RECONCILIATION_FOUNDATION_OK' AS result;
