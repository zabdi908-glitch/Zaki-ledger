\set ON_ERROR_STOP on

-- Migration 031 behavioral contract. All fixtures roll back.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '031 assertion failed: %', p_message;
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
  IF NOT v_failed THEN RAISE EXCEPTION '031 expected failure did not occur: %', p_message; END IF;
  IF v_error !~* p_pattern THEN RAISE EXCEPTION '031 wrong failure for %: %', p_message, v_error; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sha(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION pg_temp.side_evidence(
  p_side text,
  p_tag text,
  p_complete boolean,
  p_open_artifact uuid DEFAULT NULL,
  p_close_artifact uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_request text := pg_temp.sha(p_tag || '-request');
  v_response text := pg_temp.sha(p_tag || '-response');
  v_origin text := CASE WHEN p_side = 'source' THEN 'artifact_reported' ELSE 'provider_reported' END;
  v_value jsonb;
BEGIN
  v_value := jsonb_build_object(
    'side', p_side,
    'provider', CASE WHEN p_side = 'source' THEN 'ofx' ELSE 'quickbooks' END,
    'organisationId', CASE WHEN p_side = 'source' THEN NULL ELSE 'realm-shadow-contract' END,
    'accountId', CASE WHEN p_side = 'source' THEN 'ofx-shadow-account' ELSE 'qb-shadow-account' END,
    'currencyCode', 'GBP', 'minorUnitExponent', 2,
    'providerRequestId', CASE WHEN p_side = 'ledger' THEN 'intuit-request-id' ELSE NULL END,
    'dateBasis', CASE WHEN p_side = 'source' THEN 'posted_date' ELSE 'accounting_date' END,
    'opening', jsonb_build_object(
      'localBoundaryDate', '2026-01-01', 'asOfExclusive', '2026-01-01T00:00:00Z',
      'rawBalanceText', '100.00', 'rawBalanceMinor', '10000', 'balanceMinor', '10000',
      'origin', v_origin, 'artifactId', p_open_artifact,
      'rawPayloadHash', pg_temp.sha(p_tag || '-opening-payload'),
      'evidenceFingerprint', pg_temp.sha(p_tag || '-opening-evidence')
    ),
    'closing', jsonb_build_object(
      'localBoundaryDate', '2026-02-01', 'asOfExclusive', '2026-02-01T00:00:00Z',
      'rawBalanceText', '100.00', 'rawBalanceMinor', '10000', 'balanceMinor', '10000',
      'origin', v_origin, 'artifactId', p_close_artifact,
      'rawPayloadHash', pg_temp.sha(p_tag || '-closing-payload'),
      'evidenceFingerprint', pg_temp.sha(p_tag || '-closing-evidence')
    ),
    'paginationMode', CASE WHEN p_side = 'source' THEN 'artifact_pages' ELSE 'not_applicable' END,
    'pageCount', 1,
    'paginationComplete', p_complete,
    'terminalBoundarySeen', p_complete,
    'coverageComplete', p_complete,
    'resultTruncated', false,
    'errorCount', 0, 'returnedCount', 0, 'acceptedCount', 0,
    'rejectedCount', 0, 'duplicateCount', 0, 'movementTotalMinor', '0',
    'completenessState', CASE WHEN p_complete THEN 'complete' ELSE 'incomplete' END,
    'incompletenessReason', CASE WHEN p_complete THEN NULL ELSE 'provider terminal boundary unproven' END,
    'requestFingerprint', v_request, 'responseFingerprint', v_response,
    'retrievalStartedAt', now() - interval '1 second', 'retrievalCompletedAt', now(),
    'members', '[]'::jsonb
  );
  RETURN v_value || jsonb_build_object(
    'setFingerprint', public.balance_shadow_set_fingerprint_v1(v_value)
  );
END;
$$;

INSERT INTO auth.users (id, email, role, aud, created_at, updated_at) VALUES
  ('31100000-0000-0000-0000-000000000001', 'shadow-owner@example.test', 'authenticated', 'authenticated', now(), now()),
  ('31100000-0000-0000-0000-000000000002', 'shadow-other@example.test', 'authenticated', 'authenticated', now(), now());
INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('31200000-0000-0000-0000-000000000001', 'Shadow Practice', '31100000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id, practice_id, user_id, role) VALUES
  ('31300000-0000-0000-0000-000000000001', '31200000-0000-0000-0000-000000000001', '31100000-0000-0000-0000-000000000001', 'owner');
INSERT INTO public.client_entities (id, practice_id, legal_name, display_name, base_currency) VALUES
  ('31400000-0000-0000-0000-000000000001', '31200000-0000-0000-0000-000000000001', 'Shadow Ltd', 'Shadow', 'GBP');
INSERT INTO public.ledger_books (id, client_entity_id, book_kind, display_name, functional_currency) VALUES
  ('31500000-0000-0000-0000-000000000001', '31400000-0000-0000-0000-000000000001', 'quickbooks', 'Shadow Book', 'GBP');
INSERT INTO public.provider_connections
  (id, client_entity_id, ledger_book_id, provider, external_organisation_id) VALUES
  ('31600000-0000-0000-0000-000000000001', '31400000-0000-0000-0000-000000000001',
   '31500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-shadow-contract');
INSERT INTO public.financial_accounts
  (id, client_entity_id, ledger_book_id, account_kind, display_name, currency_code) VALUES
  ('31700000-0000-0000-0000-000000000001', '31400000-0000-0000-0000-000000000001',
   '31500000-0000-0000-0000-000000000001', 'bank', 'Shadow Account', 'GBP');
INSERT INTO public.provider_posting_account_mappings
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   financial_account_id, provider, external_organisation_id, provider_account_id,
   posting_role, provider_account_type, mapping_status, is_postable,
   verified_at, eligibility_expires_at) VALUES
  ('31800000-0000-0000-0000-000000000001', '31200000-0000-0000-0000-000000000001',
   '31400000-0000-0000-0000-000000000001', '31500000-0000-0000-0000-000000000001',
   '31600000-0000-0000-0000-000000000001', '31700000-0000-0000-0000-000000000001',
   'quickbooks', 'realm-shadow-contract', 'qb-shadow-account', 'general_ledger', 'Bank',
   'active', true, now() - interval '1 minute', now() + interval '1 day');
INSERT INTO public.balance_reconciliation_scopes
  (id, practice_id, client_entity_id, ledger_book_id, financial_account_id,
   ledger_provider_connection_id, ledger_provider, ledger_external_organisation_id,
   ledger_provider_account_id, source_provider, source_account_id, account_class,
   currency_code, minor_unit_exponent, account_timezone, source_date_basis,
   ledger_date_basis, source_balance_sign_multiplier, ledger_balance_sign_multiplier,
   contract_version) VALUES
  ('31900000-0000-0000-0000-000000000001', '31200000-0000-0000-0000-000000000001',
   '31400000-0000-0000-0000-000000000001', '31500000-0000-0000-0000-000000000001',
   '31700000-0000-0000-0000-000000000001', '31600000-0000-0000-0000-000000000001',
   'quickbooks', 'realm-shadow-contract', 'qb-shadow-account', 'ofx', 'ofx-shadow-account',
   'asset', 'GBP', 2, 'UTC', 'posted_date', 'accounting_date', 1, 1, 'step6-day6-v1');
INSERT INTO public.import_artifacts
  (id, client_entity_id, artifact_kind, content_sha256, content_length, source_filename, mime_type) VALUES
  ('31a00000-0000-0000-0000-000000000001', '31400000-0000-0000-0000-000000000001',
   'ofx_statement', extensions.digest(convert_to('source-complete-opening-payload','UTF8'),'sha256'), 100, 'opening.ofx', 'application/x-ofx'),
  ('31a00000-0000-0000-0000-000000000002', '31400000-0000-0000-0000-000000000001',
   'ofx_statement', extensions.digest(convert_to('source-complete-closing-payload','UTF8'),'sha256'), 100, 'closing.ofx', 'application/x-ofx');

SELECT pg_temp.assert_true(
  public.prepare_balance_reconciliation_shadow_scope_v1(
    '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001'
  )->>'outcome' = 'READY',
  'owning active practice member can prepare the exact scope');
SELECT pg_temp.assert_true(
  public.prepare_balance_reconciliation_shadow_scope_v1(
    '31100000-0000-0000-0000-000000000002', '31900000-0000-0000-0000-000000000001'
  )->>'reason_code' = 'BALANCE_SHADOW_SCOPE_OWNERSHIP_UNPROVEN',
  'cross-tenant actor cannot prepare the scope');

CREATE TEMP TABLE shadow_contract_inputs AS
SELECT
  pg_temp.side_evidence('source', 'source-complete', true,
    '31a00000-0000-0000-0000-000000000001', '31a00000-0000-0000-0000-000000000002') AS source_complete,
  pg_temp.side_evidence('ledger', 'ledger-complete', true) AS ledger_complete,
  pg_temp.side_evidence('ledger', 'ledger-incomplete', false) AS ledger_incomplete;

CREATE TEMP TABLE shadow_contract_results (name text PRIMARY KEY, result jsonb);
INSERT INTO shadow_contract_results
SELECT 'complete', public.record_balance_reconciliation_shadow_v1(
  '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001',
  '2026-01-01', '2026-01-31',
  encode(extensions.digest(convert_to(concat_ws('|', 'balance-shadow-v1',
    '31900000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31',
    source_complete->>'setFingerprint', ledger_complete->>'setFingerprint'), 'UTF8'), 'sha256'), 'hex'),
  source_complete, ledger_complete)
FROM shadow_contract_inputs;

SELECT pg_temp.assert_true(
  (SELECT result->>'mode' = 'SHADOW' AND result->>'state' = 'RECONCILED'
     AND result->>'reasonCode' = 'RECONCILED_EXACT_ZERO_RESIDUAL'
     AND result->>'sourceCompleteness' = 'OK' AND result->>'ledgerCompleteness' = 'OK'
     AND result->>'residualMinor' = '0' FROM shadow_contract_results WHERE name = 'complete'),
  'complete source and ledger evidence produces only an exact SHADOW reconciliation');
SELECT pg_temp.assert_true(
  (SELECT execution_mode = 'SHADOW' AND octet_length(shadow_request_fingerprint) = 32
   FROM public.balance_reconciliation_runs LIMIT 1)
  AND (SELECT count(*) = 4 FROM public.balance_snapshots)
  AND (SELECT count(*) = 2 FROM public.balance_movement_sets),
  'shadow run retains four immutable balance snapshots and two manifests');

-- Exact retry returns the frozen run without duplicating evidence.
INSERT INTO shadow_contract_results
SELECT 'retry', public.record_balance_reconciliation_shadow_v1(
  '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001',
  '2026-01-01', '2026-01-31',
  encode(extensions.digest(convert_to(concat_ws('|', 'balance-shadow-v1',
    '31900000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31',
    source_complete->>'setFingerprint', ledger_complete->>'setFingerprint'), 'UTF8'), 'sha256'), 'hex'),
  source_complete, ledger_complete)
FROM shadow_contract_inputs;
SELECT pg_temp.assert_true(
  (SELECT result->>'reused' = 'true' FROM shadow_contract_results WHERE name = 'retry')
  AND (SELECT count(*) = 4 FROM public.balance_snapshots)
  AND (SELECT count(*) = 2 FROM public.balance_movement_sets),
  'idempotent retry reuses immutable evidence');

-- Same immutable source evidence may feed a new ledger retrieval whose terminal
-- coverage is not proven. The proof engine must retain it and return REVIEW.
INSERT INTO shadow_contract_results
SELECT 'incomplete', public.record_balance_reconciliation_shadow_v1(
  '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001',
  '2026-01-01', '2026-01-31',
  encode(extensions.digest(convert_to(concat_ws('|', 'balance-shadow-v1',
    '31900000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31',
    source_complete->>'setFingerprint', ledger_incomplete->>'setFingerprint'), 'UTF8'), 'sha256'), 'hex'),
  source_complete, ledger_incomplete)
FROM shadow_contract_inputs;
SELECT pg_temp.assert_true(
  (SELECT result->>'mode' = 'SHADOW' AND result->>'state' = 'REVIEW'
     AND result->>'reasonCode' = 'REVIEW_LEDGER_EVIDENCE_INCOMPLETE'
   FROM shadow_contract_results WHERE name = 'incomplete'),
  'unproven provider completeness deterministically returns REVIEW');

SELECT pg_temp.expect_error($sql$
  SELECT public.record_balance_reconciliation_shadow_v1(
    '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001',
    '2026-01-01', '2026-01-31', repeat('0',64),
    source_complete || jsonb_build_object('accountId','wrong-source-account'), ledger_complete)
  FROM shadow_contract_inputs
$sql$, 'source evidence.*frozen shadow contract', 'exact source account ownership');

SELECT pg_temp.expect_error($sql$
  SELECT public.record_balance_reconciliation_shadow_v1(
    '31100000-0000-0000-0000-000000000001', '31900000-0000-0000-0000-000000000001',
    '2026-01-01', '2026-01-31', repeat('0',64),
    jsonb_set(source_complete, '{opening,asOfExclusive}', '"2026-01-01T01:00:00Z"'), ledger_complete)
  FROM shadow_contract_inputs
$sql$, 'source evidence.*frozen shadow contract', 'exact cutoff enforcement');

SELECT pg_temp.expect_error($sql$
  UPDATE public.balance_snapshots SET raw_balance_text = 'rewritten'
$sql$, 'append-only', 'persisted balance evidence remains immutable');

ROLLBACK;
SELECT '031_BALANCE_RECONCILIATION_SHADOW_READ_OK' AS result;
