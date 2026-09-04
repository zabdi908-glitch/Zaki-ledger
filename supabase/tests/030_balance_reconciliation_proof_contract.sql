\set ON_ERROR_STOP on

-- Migration 030 behavioral contract. All fixtures roll back.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '030 assertion failed: %', p_message;
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
  IF NOT v_failed THEN RAISE EXCEPTION '030 expected failure did not occur: %', p_message; END IF;
  IF v_error !~* p_pattern THEN
    RAISE EXCEPTION '030 wrong failure for %: %', p_message, v_error;
  END IF;
END;
$$;

INSERT INTO auth.users (id, email, role, aud, created_at, updated_at) VALUES
  ('30000000-0000-0000-0000-000000000001', 'proof@example.test', 'authenticated', 'authenticated', now(), now());
INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('30100000-0000-0000-0000-000000000001', 'Proof Practice', '30000000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id, practice_id, user_id, role) VALUES
  ('30200000-0000-0000-0000-000000000001', '30100000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'owner');
INSERT INTO public.client_entities (id, practice_id, legal_name, display_name, base_currency) VALUES
  ('30300000-0000-0000-0000-000000000001', '30100000-0000-0000-0000-000000000001', 'Proof Ltd', 'Proof', 'GBP');
INSERT INTO public.ledger_books (id, client_entity_id, book_kind, display_name, functional_currency) VALUES
  ('30400000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'quickbooks', 'Proof Book', 'GBP');
INSERT INTO public.provider_connections
  (id, client_entity_id, ledger_book_id, provider, external_organisation_id) VALUES
  ('30500000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001',
   '30400000-0000-0000-0000-000000000001', 'quickbooks', 'realm-proof');
INSERT INTO public.financial_accounts
  (id, client_entity_id, ledger_book_id, account_kind, display_name, currency_code) VALUES
  ('30600000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001',
   '30400000-0000-0000-0000-000000000001', 'bank', 'Proof Current Account', 'GBP');
INSERT INTO public.provider_posting_account_mappings
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   financial_account_id, provider, external_organisation_id, provider_account_id,
   posting_role, provider_account_type, mapping_status, is_postable,
   verified_at, eligibility_expires_at) VALUES
  ('30700000-0000-0000-0000-000000000001', '30100000-0000-0000-0000-000000000001',
   '30300000-0000-0000-0000-000000000001', '30400000-0000-0000-0000-000000000001',
   '30500000-0000-0000-0000-000000000001', '30600000-0000-0000-0000-000000000001',
   'quickbooks', 'realm-proof', 'qb-proof-bank', 'general_ledger', 'Bank', 'active', true,
   now() - interval '1 minute', now() + interval '1 day');
INSERT INTO public.balance_reconciliation_scopes
  (id, practice_id, client_entity_id, ledger_book_id, financial_account_id,
   ledger_provider_connection_id, ledger_provider, ledger_external_organisation_id,
   ledger_provider_account_id, source_provider, source_account_id, account_class,
   currency_code, minor_unit_exponent, account_timezone, source_date_basis,
   ledger_date_basis, source_balance_sign_multiplier, ledger_balance_sign_multiplier,
   contract_version) VALUES
  ('30800000-0000-0000-0000-000000000001', '30100000-0000-0000-0000-000000000001',
   '30300000-0000-0000-0000-000000000001', '30400000-0000-0000-0000-000000000001',
   '30600000-0000-0000-0000-000000000001', '30500000-0000-0000-0000-000000000001',
   'quickbooks', 'realm-proof', 'qb-proof-bank', 'ofx', 'ofx-proof-bank', 'asset',
   'GBP', 2, 'UTC', 'posted_date', 'accounting_date', 1, 1, 'step6-day5-v1');

-- B0=10000, ΔB=1000, B1=11000. L0=10500 and two valid ledger views:
-- carry-forward ΔL=1000/L1=11500; cleared ΔL=500/L1=11000.
INSERT INTO public.balance_snapshots
  (id, scope_id, client_entity_id, side, boundary, local_boundary_date,
   as_of_exclusive, raw_balance_text, raw_currency_text, raw_balance_minor,
   balance_sign_multiplier, balance_minor, currency_code, minor_unit_exponent,
   snapshot_origin, verification_state, retrieved_at, raw_payload_hash,
   evidence_fingerprint) VALUES
  ('30900000-0000-0000-0000-000000000001', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'source', 'opening', '2026-01-01', '2026-01-01 00:00+00', '100.00', 'GBP', 10000, 1, 10000, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('01',32),'hex'), decode(repeat('11',32),'hex')),
  ('30900000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'source', 'closing', '2026-02-01', '2026-02-01 00:00+00', '110.00', 'GBP', 11000, 1, 11000, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('02',32),'hex'), decode(repeat('12',32),'hex')),
  ('30900000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', 'opening', '2026-01-01', '2026-01-01 00:00+00', '105.00', 'GBP', 10500, 1, 10500, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('03',32),'hex'), decode(repeat('13',32),'hex')),
  ('30900000-0000-0000-0000-000000000004', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', 'closing', '2026-02-01', '2026-02-01 00:00+00', '115.00', 'GBP', 11500, 1, 11500, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('04',32),'hex'), decode(repeat('14',32),'hex')),
  ('30900000-0000-0000-0000-000000000005', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', 'closing', '2026-02-01', '2026-02-01 00:00+00', '110.00', 'GBP', 11000, 1, 11000, 'GBP', 2, 'provider_reported', 'verified', now(), decode(repeat('05',32),'hex'), decode(repeat('15',32),'hex'));

INSERT INTO public.balance_movement_sets
  (id, scope_id, client_entity_id, side, period_start, period_end,
   period_start_utc, period_end_exclusive_utc, date_basis,
   opening_snapshot_id, closing_snapshot_id, pagination_mode, page_count,
   pagination_complete, terminal_boundary_seen, coverage_complete, result_truncated,
   error_count, returned_count, accepted_count, rejected_count, duplicate_count,
   movement_total_minor, completeness_state, incompleteness_reason,
   request_fingerprint, response_fingerprint, set_fingerprint,
   retrieval_started_at, retrieval_completed_at) VALUES
  ('30a00000-0000-0000-0000-000000000001', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'source', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'posted_date', '30900000-0000-0000-0000-000000000001', '30900000-0000-0000-0000-000000000002', 'provider_cursor', 1, true, true, true, false, 0, 1, 1, 0, 0, 1000, 'complete', NULL, decode(repeat('21',32),'hex'), decode(repeat('22',32),'hex'), decode(repeat('23',32),'hex'), now()-interval '1 second', now()),
  ('30a00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'accounting_date', '30900000-0000-0000-0000-000000000003', '30900000-0000-0000-0000-000000000004', 'provider_cursor', 1, true, true, true, false, 0, 1, 1, 0, 0, 1000, 'complete', NULL, decode(repeat('24',32),'hex'), decode(repeat('25',32),'hex'), decode(repeat('26',32),'hex'), now()-interval '1 second', now()),
  ('30a00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'accounting_date', '30900000-0000-0000-0000-000000000003', '30900000-0000-0000-0000-000000000005', 'provider_cursor', 1, true, true, true, false, 0, 1, 1, 0, 0, 500, 'complete', NULL, decode(repeat('27',32),'hex'), decode(repeat('28',32),'hex'), decode(repeat('29',32),'hex'), now()-interval '1 second', now()),
  ('30a00000-0000-0000-0000-000000000004', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'source', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'posted_date', '30900000-0000-0000-0000-000000000001', '30900000-0000-0000-0000-000000000002', 'provider_cursor', 1, true, true, true, false, 0, 0, 0, 0, 0, 0, 'conflicted', 'rollforward differs', decode(repeat('31',32),'hex'), decode(repeat('32',32),'hex'), decode(repeat('33',32),'hex'), now()-interval '1 second', now()),
  ('30a00000-0000-0000-0000-000000000005', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'accounting_date', '30900000-0000-0000-0000-000000000003', '30900000-0000-0000-0000-000000000005', 'provider_cursor', 1, false, false, true, false, 0, 0, 0, 0, 0, 500, 'incomplete', 'next cursor not consumed', decode(repeat('34',32),'hex'), decode(repeat('35',32),'hex'), decode(repeat('36',32),'hex'), now()-interval '1 second', now());

INSERT INTO public.balance_movement_members
  (id, movement_set_id, scope_id, client_entity_id, movement_identity_canonical,
   date_precision, effective_on, raw_amount_minor, normalization_basis,
   movement_minor, currency_code, minor_unit_exponent, source_status, included,
   evidence_hash) VALUES
  ('30b00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000001', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'source-movement-1', 'date', '2026-01-10', 1000, 'normalized_account_effect', 1000, 'GBP', 2, 'posted', true, decode(repeat('41',32),'hex')),
  ('30b00000-0000-0000-0000-000000000002', '30a00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger-movement-carry', 'date', '2026-01-10', 1000, 'normalized_account_effect', 1000, 'GBP', 2, 'posted', true, decode(repeat('42',32),'hex')),
  ('30b00000-0000-0000-0000-000000000003', '30a00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 'ledger-movement-clear', 'date', '2026-01-15', 500, 'normalized_account_effect', 500, 'GBP', 2, 'posted', true, decode(repeat('43',32),'hex'));

-- Stable identity and the initial legitimate +500 source-to-ledger adjustment.
INSERT INTO public.reconciliation_outstanding_items
  (id, scope_id, client_entity_id, outstanding_identity_canonical,
   item_kind, original_adjustment_minor, currency_code, minor_unit_exponent,
   discovered_at) VALUES
  ('30c00000-0000-0000-0000-000000000001', '30800000-0000-0000-0000-000000000001',
   '30300000-0000-0000-0000-000000000001', 'outstanding|deposit|500',
   'deposit_in_transit', 500, 'GBP', 2, '2025-12-15 10:00+00');
INSERT INTO public.reconciliation_outstanding_item_revisions
  (id, outstanding_item_id, scope_id, client_entity_id, revision_no, state,
   effective_at, remaining_adjustment_minor, evidence_state, raw_payload_hash,
   evidence_fingerprint, authorized_by_user_id, authorized_at, created_at) VALUES
  ('30d00000-0000-0000-0000-000000000001', '30c00000-0000-0000-0000-000000000001',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001',
   1, 'open', '2025-12-15 10:00+00', 500, 'complete', decode(repeat('51',32),'hex'),
   decode(repeat('61',32),'hex'), '30000000-0000-0000-0000-000000000001',
   '2026-01-01 09:00+00', '2026-01-01 09:00+00');

-- Run identity helper rows.
INSERT INTO public.balance_reconciliation_runs
  (id, scope_id, client_entity_id, period_start, period_end, period_start_utc,
   period_end_exclusive_utc, run_identity_canonical) VALUES
  ('30e00000-0000-0000-0000-000000000001', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'carry-forward'),
  ('30e00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'exact-clearance'),
  ('30e00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'nonzero-residual'),
  ('30e00000-0000-0000-0000-000000000004', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'broken-rollforward'),
  ('30e00000-0000-0000-0000-000000000005', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'incomplete-evidence'),
  ('30e00000-0000-0000-0000-000000000006', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'stale-evidence'),
  ('30e00000-0000-0000-0000-000000000007', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', '2026-01-01 00:00+00', '2026-02-01 00:00+00', 'invalid-item');

-- Valid carry-forward uses the same still-current item revision at B0 and B1.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000001', '30e00000-0000-0000-0000-000000000001',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000002',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid], '2026-02-01 12:00+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'RECONCILED' AND o0_minor = 500 AND o1_minor = 500
     AND r0_minor = 0 AND r_minor = 0
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000001'),
  'valid outstanding item carries forward into an exact reconciliation');

-- A later evidence revision fully clears the item. Partial and invalid
-- transition behavior is exercised on a separate post-period item below.
INSERT INTO public.reconciliation_outstanding_item_revisions
  (id, outstanding_item_id, scope_id, client_entity_id, revision_no,
   previous_revision_id, state, effective_at, remaining_adjustment_minor,
   evidence_state, raw_payload_hash, evidence_fingerprint,
   authorized_by_user_id, authorized_at, created_at) VALUES
  ('30d00000-0000-0000-0000-000000000002', '30c00000-0000-0000-0000-000000000001',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 2,
   '30d00000-0000-0000-0000-000000000001', 'cleared', '2026-01-15 12:00+00', 0,
   'complete', decode(repeat('52',32),'hex'), decode(repeat('62',32),'hex'),
   '30000000-0000-0000-0000-000000000001', '2026-02-02 09:00+00', '2026-02-02 09:00+00');

-- Exact equations and zero-residual reconciliation after full clearance.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000002', '30e00000-0000-0000-0000-000000000002',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000003',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000002'::uuid], '2026-02-03 09:00+00');
SELECT pg_temp.assert_true(
  (SELECT b0_minor = 10000 AND delta_b_minor = 1000 AND b1_minor = 11000
      AND l0_minor = 10500 AND delta_l_minor = 500 AND l1_minor = 11000
      AND o0_minor = 500 AND o1_minor = 0
      AND a0_minor = 10500 AND a1_minor = 11000
      AND r0_minor = 0 AND r_minor = 0
      AND reconciliation_state = 'RECONCILED'
      AND primary_reason_code = 'RECONCILED_EXACT_ZERO_RESIDUAL'
      AND octet_length(frozen_input_fingerprint) = 32
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000002'),
  'B0/deltaB/B1/L0/deltaL/L1/O0/O1/A0/A1/R0/R are exact and zero residual reconciles');

-- Same complete evidence with a nonzero closing residual must be REVIEW.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000003', '30e00000-0000-0000-0000-000000000003',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000002',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000002'::uuid], '2026-02-03 09:01+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'REVIEW' AND r_minor = -500
      AND primary_reason_code = 'REVIEW_CLOSING_RESIDUAL_NONZERO'
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000003'),
  'nonzero unexplained residual requires review');

-- A broken source rollforward deterministically outranks residual review.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000004', '30e00000-0000-0000-0000-000000000004',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000004', '30a00000-0000-0000-0000-000000000003',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000002'::uuid], '2026-02-03 09:02+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'FAILED'
      AND primary_reason_code = 'FAILED_SOURCE_ROLLFORWARD_BROKEN'
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000004'),
  'broken rollforward fails before review reasons');

-- Zero residual can never reconcile incomplete retrieval evidence.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000005', '30e00000-0000-0000-0000-000000000005',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000005',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000002'::uuid], '2026-02-03 09:03+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'REVIEW' AND r0_minor = 0 AND r_minor = 0
      AND evidence_complete = false
      AND primary_reason_code = 'REVIEW_LEDGER_EVIDENCE_INCOMPLETE'
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000005'),
  'zero residual with incomplete evidence is REVIEW');

-- Selecting the superseded opening revision at closing is a frozen stale-input failure.
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000006', '30e00000-0000-0000-0000-000000000006',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000002',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid], '2026-02-03 09:04+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'FAILED'
      AND primary_reason_code = 'FAILED_OUTSTANDING_EVIDENCE_STALE'
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000006'),
  'stale outstanding evidence revision fails deterministically');
SELECT pg_temp.assert_true(
  (SELECT frozen_input_fingerprint FROM public.balance_reconciliation_revisions
   WHERE id = '30f00000-0000-0000-0000-000000000006') <>
  (SELECT frozen_input_fingerprint FROM public.balance_reconciliation_revisions
   WHERE id = '30f00000-0000-0000-0000-000000000001'),
  'late evidence changes the frozen evidence-universe fingerprint');

-- Duplicate stable identity is rejected before two logical items can exist.
SELECT pg_temp.expect_error($sql$
  INSERT INTO public.reconciliation_outstanding_items
    (scope_id, client_entity_id, outstanding_identity_canonical, item_kind,
     original_adjustment_minor, currency_code, minor_unit_exponent, discovered_at)
  VALUES ('30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001',
    'outstanding|deposit|500', 'deposit_in_transit', 500, 'GBP', 2, now())
$sql$, 'duplicate key', 'duplicate outstanding identity');

-- Partial clearance must reduce absolute magnitude; full clearance is terminal.
INSERT INTO public.reconciliation_outstanding_items
  (id, scope_id, client_entity_id, outstanding_identity_canonical, item_kind,
   original_adjustment_minor, currency_code, minor_unit_exponent, discovered_at) VALUES
  ('30c00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001',
   '30300000-0000-0000-0000-000000000001', 'future|payment|-1000', 'outstanding_payment',
   -1000, 'GBP', 2, '2026-03-01 00:00+00');
INSERT INTO public.reconciliation_outstanding_item_revisions
  (id, outstanding_item_id, scope_id, client_entity_id, revision_no, previous_revision_id,
   state, effective_at, remaining_adjustment_minor, evidence_state, raw_payload_hash,
   evidence_fingerprint, authorized_by_user_id, authorized_at) VALUES
  ('30d00000-0000-0000-0000-000000000003', '30c00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1, NULL, 'open', '2026-03-01 00:00+00', -1000, 'complete', decode(repeat('53',32),'hex'), decode(repeat('63',32),'hex'), '30000000-0000-0000-0000-000000000001', now()),
  ('30d00000-0000-0000-0000-000000000004', '30c00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 2, '30d00000-0000-0000-0000-000000000003', 'partially_cleared', '2026-03-15 00:00+00', -400, 'complete', decode(repeat('54',32),'hex'), decode(repeat('64',32),'hex'), '30000000-0000-0000-0000-000000000001', now()),
  ('30d00000-0000-0000-0000-000000000005', '30c00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 3, '30d00000-0000-0000-0000-000000000004', 'cleared', '2026-04-01 00:00+00', 0, 'complete', decode(repeat('55',32),'hex'), decode(repeat('65',32),'hex'), '30000000-0000-0000-0000-000000000001', now());
SELECT pg_temp.assert_true(
  (SELECT state = 'partially_cleared' AND remaining_adjustment_minor = -400
   FROM public.reconciliation_outstanding_item_revisions WHERE id = '30d00000-0000-0000-0000-000000000004')
  AND
  (SELECT state = 'cleared' AND remaining_adjustment_minor = 0
   FROM public.reconciliation_outstanding_item_revisions WHERE id = '30d00000-0000-0000-0000-000000000005'),
  'partial and full clearance transitions preserve sign and exact remainder');
SELECT pg_temp.expect_error($sql$
  INSERT INTO public.reconciliation_outstanding_item_revisions
    (outstanding_item_id, scope_id, client_entity_id, revision_no, previous_revision_id,
     state, effective_at, remaining_adjustment_minor, evidence_state, rationale,
     evidence_fingerprint)
  VALUES ('30c00000-0000-0000-0000-000000000002', '30800000-0000-0000-0000-000000000001',
    '30300000-0000-0000-0000-000000000001', 4, '30d00000-0000-0000-0000-000000000005',
    'partially_cleared', '2026-04-02 00:00+00', -100, 'incomplete', 'invalid after clear',
    decode(repeat('66',32),'hex'))
$sql$, 'terminal', 'invalid outstanding transition after full clearance');

-- An explicitly invalidated item cannot be supplied as legitimate proof input.
INSERT INTO public.reconciliation_outstanding_items
  (id, scope_id, client_entity_id, outstanding_identity_canonical, item_kind,
   original_adjustment_minor, currency_code, minor_unit_exponent, discovered_at) VALUES
  ('30c00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001',
   '30300000-0000-0000-0000-000000000001', 'invalid|item|300', 'other_supported',
   300, 'GBP', 2, '2025-12-20 00:00+00');
INSERT INTO public.reconciliation_outstanding_item_revisions
  (id, outstanding_item_id, scope_id, client_entity_id, revision_no, previous_revision_id,
   state, effective_at, remaining_adjustment_minor, evidence_state, raw_payload_hash,
   evidence_fingerprint, authorized_by_user_id, authorized_at, rationale, created_at) VALUES
  ('30d00000-0000-0000-0000-000000000006', '30c00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1, NULL, 'open', '2025-12-20 00:00+00', 300, 'complete', decode(repeat('56',32),'hex'), decode(repeat('67',32),'hex'), '30000000-0000-0000-0000-000000000001', '2026-02-04 09:00+00', NULL, '2026-02-04 09:00+00'),
  ('30d00000-0000-0000-0000-000000000007', '30c00000-0000-0000-0000-000000000003', '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 2, '30d00000-0000-0000-0000-000000000006', 'invalidated', '2026-01-10 00:00+00', 0, 'rejected', NULL, decode(repeat('68',32),'hex'), NULL, NULL, 'not legitimate', '2026-02-05 09:00+00');
INSERT INTO public.balance_reconciliation_revisions
  (id, reconciliation_run_id, scope_id, client_entity_id, revision_no,
   source_movement_set_id, ledger_movement_set_id,
   opening_outstanding_revision_ids, closing_outstanding_revision_ids, evaluated_at)
VALUES
  ('30f00000-0000-0000-0000-000000000007', '30e00000-0000-0000-0000-000000000007',
   '30800000-0000-0000-0000-000000000001', '30300000-0000-0000-0000-000000000001', 1,
   '30a00000-0000-0000-0000-000000000001', '30a00000-0000-0000-0000-000000000003',
   ARRAY['30d00000-0000-0000-0000-000000000001'::uuid, '30d00000-0000-0000-0000-000000000006'::uuid],
   ARRAY['30d00000-0000-0000-0000-000000000002'::uuid, '30d00000-0000-0000-0000-000000000007'::uuid],
   '2026-02-06 09:00+00');
SELECT pg_temp.assert_true(
  (SELECT reconciliation_state = 'FAILED'
      AND primary_reason_code = 'FAILED_OUTSTANDING_ITEM_INVALID'
   FROM public.balance_reconciliation_revisions WHERE id = '30f00000-0000-0000-0000-000000000007'),
  'invalid outstanding item fails before residual review');

SET CONSTRAINTS balance_movement_sets_complete_ck, balance_movement_members_complete_ck IMMEDIATE;

SELECT pg_temp.expect_error($sql$
  UPDATE public.balance_reconciliation_revisions SET r_minor = 0
  WHERE id = '30f00000-0000-0000-0000-000000000003'
$sql$, 'append-only', 'frozen reconciliation proof is immutable');

ROLLBACK;
SELECT '030_BALANCE_RECONCILIATION_PROOF_OK' AS result;
