\set ON_ERROR_STOP on

-- Migration 014 behavioral contract. All fixtures roll back.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '014 assertion failed: %', p_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(
  p_sql text,
  p_pattern text,
  p_message text
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_failed boolean := false;
  v_error text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION '014 expected failure did not occur: %', p_message;
  END IF;
  IF v_error !~* p_pattern THEN
    RAISE EXCEPTION '014 wrong failure for %: %', p_message, v_error;
  END IF;
END;
$$;

-- Two separate practices prove tenant/client isolation rather than merely
-- same-practice book alignment.
INSERT INTO auth.users (id, email, role, aud, created_at, updated_at) VALUES
  ('14000000-0000-0000-0000-000000000001', 'posting-owner-a@example.test', 'authenticated', 'authenticated', now(), now()),
  ('14000000-0000-0000-0000-000000000002', 'posting-owner-b@example.test', 'authenticated', 'authenticated', now(), now());

INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('14100000-0000-0000-0000-000000000001', 'Posting Practice A', '14000000-0000-0000-0000-000000000001'),
  ('14100000-0000-0000-0000-000000000002', 'Posting Practice B', '14000000-0000-0000-0000-000000000002');

INSERT INTO public.practice_memberships (id, practice_id, user_id, role) VALUES
  ('14200000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', 'owner'),
  ('14200000-0000-0000-0000-000000000002', '14100000-0000-0000-0000-000000000002', '14000000-0000-0000-0000-000000000002', 'owner');

INSERT INTO public.client_entities
  (id, practice_id, legal_name, display_name, base_currency)
VALUES
  ('14300000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', 'Posting Client A Ltd', 'Posting Client A', 'GBP'),
  ('14300000-0000-0000-0000-000000000002', '14100000-0000-0000-0000-000000000002', 'Posting Client B Ltd', 'Posting Client B', 'GBP');

INSERT INTO public.ledger_books
  (id, client_entity_id, book_kind, display_name, functional_currency)
VALUES
  ('14400000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', 'quickbooks', 'QB A', 'GBP'),
  ('14400000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000002', 'xero', 'Xero B', 'GBP');

INSERT INTO public.provider_connections
  (id, client_entity_id, ledger_book_id, provider, external_organisation_id)
VALUES
  ('14500000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a'),
  ('14500000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000002', '14400000-0000-0000-0000-000000000002', 'xero', 'tenant-b');

INSERT INTO public.financial_accounts
  (id, client_entity_id, ledger_book_id, provider_connection_id, account_kind, display_name)
VALUES
  ('14600000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'expense', 'Travel'),
  ('14600000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'expense', 'Meals'),
  ('14600000-0000-0000-0000-000000000003', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'expense', 'Software'),
  ('14600000-0000-0000-0000-000000000004', '14300000-0000-0000-0000-000000000002', '14400000-0000-0000-0000-000000000002', '14500000-0000-0000-0000-000000000002', 'expense', 'Xero Expense');

INSERT INTO public.provider_posting_account_mappings
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   financial_account_id, provider, external_organisation_id,
   provider_account_id, provider_account_code, provider_account_name,
   posting_role, provider_account_type, mapping_status, is_postable,
   verified_at, eligibility_expires_at)
VALUES
  ('14700000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', '14600000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', 'qb-account-1', '6100', 'Travel', 'general_ledger', 'Expense', 'active', true, now() - interval '1 minute', now() + interval '1 day'),
  ('14700000-0000-0000-0000-000000000002', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', '14600000-0000-0000-0000-000000000002', 'quickbooks', 'realm-a', 'qb-account-2', '6200', 'Meals', 'general_ledger', 'Expense', 'active', false, now() - interval '1 minute', now() + interval '1 day'),
  ('14700000-0000-0000-0000-000000000003', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', '14600000-0000-0000-0000-000000000003', 'quickbooks', 'realm-a', 'qb-account-3', '6300', 'Software', 'general_ledger', 'Expense', 'inactive', true, now() - interval '1 minute', now() + interval '1 day'),
  ('14700000-0000-0000-0000-000000000004', '14100000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000002', '14400000-0000-0000-0000-000000000002', '14500000-0000-0000-0000-000000000002', '14600000-0000-0000-0000-000000000004', 'xero', 'tenant-b', 'xero-account-1', '400', 'General Expenses', 'nominal', 'EXPENSE', 'active', true, now() - interval '1 minute', now() + interval '1 day');

SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.eligible_provider_posting_accounts),
  'only active, postable, fresh mappings qualify');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.eligible_provider_posting_accounts
              WHERE id IN ('14700000-0000-0000-0000-000000000002',
                           '14700000-0000-0000-0000-000000000003')),
  'inactive or non-postable mappings never qualify');

UPDATE public.provider_connections SET status = 'expired'
WHERE id = '14500000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.eligible_provider_posting_accounts
              WHERE id = '14700000-0000-0000-0000-000000000001'),
  'inactive provider connection disqualifies an otherwise valid mapping');
UPDATE public.provider_connections SET status = 'active'
WHERE id = '14500000-0000-0000-0000-000000000001';

UPDATE public.financial_accounts SET status = 'closed'
WHERE id = '14600000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.eligible_provider_posting_accounts
              WHERE id = '14700000-0000-0000-0000-000000000001'),
  'inactive canonical account disqualifies its posting mapping');
UPDATE public.financial_accounts SET status = 'active'
WHERE id = '14600000-0000-0000-0000-000000000001';

UPDATE public.ledger_books SET status = 'disconnected'
WHERE id = '14400000-0000-0000-0000-000000000001';
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.eligible_provider_posting_accounts
              WHERE id = '14700000-0000-0000-0000-000000000001'),
  'inactive ledger book disqualifies its posting mapping');
UPDATE public.ledger_books SET status = 'active'
WHERE id = '14400000-0000-0000-0000-000000000001';

SELECT pg_temp.expect_error($sql$
  UPDATE public.provider_posting_account_mappings
  SET provider_account_id = 'moved-account'
  WHERE id = '14700000-0000-0000-0000-000000000001'
$sql$, 'immutable', 'mapping destination identity cannot be rewritten');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.provider_posting_account_mappings
    (practice_id, client_entity_id, ledger_book_id, provider_connection_id,
     financial_account_id, provider, external_organisation_id,
     provider_account_id, posting_role, provider_account_type,
     mapping_status, is_postable, verified_at, eligibility_expires_at)
  VALUES
    ('14100000-0000-0000-0000-000000000001',
     '14300000-0000-0000-0000-000000000001',
     '14400000-0000-0000-0000-000000000001',
     '14500000-0000-0000-0000-000000000002',
     '14600000-0000-0000-0000-000000000001',
     'xero', 'tenant-b', 'cross-tenant-account', 'nominal', 'EXPENSE',
     'active', true, now(), now() + interval '1 day')
$sql$, 'foreign key', 'posting account cannot cross client/book/connection');

-- Base parent operation plus a separately claimed child Vendor operation.
INSERT INTO public.posting_operations
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   provider, external_organisation_id, parent_operation_id, operation_kind, external_object_type,
   action, idempotency_key, source_action_claim_fingerprint,
   authorized_request_fingerprint, intent_schema_version,
   canonicalization_version, validation_rule_set_version, requested_object,
   evidence_snapshot, account_treatment_snapshot, tax_treatment_snapshot,
   expected_material_state)
VALUES
  ('14800000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', NULL, 'POST_OBJECT', 'BILL', 'CREATE', 'bill-key-1', decode(repeat('11',32),'hex'), decode(repeat('21',32),'hex'), '1', '1', 'step5-day3-v1', '{"amount":"100.00","currency":"GBP"}', '[]', '[{"mapping_id":"14700000-0000-0000-0000-000000000001"}]', '[]', '{"amount":"100.00","currency":"GBP"}'),
  ('14800000-0000-0000-0000-000000000002', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', '14800000-0000-0000-0000-000000000001', 'ENSURE_VENDOR', 'VENDOR', 'CREATE', 'vendor-key-1', decode(repeat('12',32),'hex'), decode(repeat('22',32),'hex'), '1', '1', 'step5-day3-v1', '{"supplier_id":"supplier-1"}', '[]', '[]', '[]', '{"display_name":"Supplier One"}');

SELECT pg_temp.assert_true(
  (SELECT parent_operation_id = '14800000-0000-0000-0000-000000000001'
   FROM public.posting_operations
   WHERE id = '14800000-0000-0000-0000-000000000002'),
  'same-destination parent/child operation is supported');

-- Scope uniqueness plus immutable fingerprint means a key can never represent
-- a second or rewritten semantic intent.
SELECT pg_temp.expect_error($sql$
  INSERT INTO public.posting_operations
    (practice_id, client_entity_id, ledger_book_id, provider_connection_id,
     provider, external_organisation_id, operation_kind, external_object_type,
     action, idempotency_key, source_action_claim_fingerprint,
     authorized_request_fingerprint, intent_schema_version,
     canonicalization_version, validation_rule_set_version, requested_object,
     expected_material_state)
  VALUES
    ('14100000-0000-0000-0000-000000000001',
     '14300000-0000-0000-0000-000000000001',
     '14400000-0000-0000-0000-000000000001',
     '14500000-0000-0000-0000-000000000001',
     'quickbooks', 'realm-a', 'POST_OBJECT', 'BILL', 'CREATE', 'bill-key-1',
     decode(repeat('13',32),'hex'), decode(repeat('23',32),'hex'),
     '1', '1', 'step5-day3-v1', '{"amount":"999.00"}', '{}')
$sql$, 'posting_operations_scoped_idempotency_idx|duplicate key',
  'same scoped key cannot create different intent');

SELECT pg_temp.expect_error($sql$
  UPDATE public.posting_operations
  SET authorized_request_fingerprint = decode(repeat('ff',32),'hex'),
      row_version = 2
  WHERE id = '14800000-0000-0000-0000-000000000001'
$sql$, 'immutable', 'existing idempotent intent fingerprint cannot change');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.posting_operations
    (practice_id, client_entity_id, ledger_book_id, provider_connection_id,
     provider, external_organisation_id, operation_kind, external_object_type,
     action, idempotency_key, source_action_claim_fingerprint,
     authorized_request_fingerprint, intent_schema_version,
     canonicalization_version, validation_rule_set_version, requested_object,
     expected_material_state)
  VALUES
    ('14100000-0000-0000-0000-000000000001',
     '14300000-0000-0000-0000-000000000001',
     '14400000-0000-0000-0000-000000000001',
     '14500000-0000-0000-0000-000000000001',
     'quickbooks', 'realm-a', 'POST_OBJECT', 'BILL', 'CREATE', 'bill-key-2',
     decode(repeat('11',32),'hex'), decode(repeat('24',32),'hex'),
     '1', '1', 'step5-day3-v1', '{"amount":"100.00"}', '{}')
$sql$, 'posting_operations_create_claim_idx|duplicate key',
  'different key cannot duplicate a CREATE business-effect claim');

-- Cross-tenant parentage is rejected by the full destination FK.
INSERT INTO public.posting_operations
  (id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
   provider, external_organisation_id, operation_kind, external_object_type,
   action, idempotency_key, source_action_claim_fingerprint,
   authorized_request_fingerprint, intent_schema_version,
   canonicalization_version, validation_rule_set_version, requested_object,
   expected_material_state)
VALUES
  ('14800000-0000-0000-0000-000000000003', '14100000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000002', '14400000-0000-0000-0000-000000000002', '14500000-0000-0000-0000-000000000002', 'xero', 'tenant-b', 'POST_OBJECT', 'BILL', 'CREATE', 'xero-bill-key', decode(repeat('31',32),'hex'), decode(repeat('32',32),'hex'), '1', '1', 'step5-day3-v1', '{"amount":"20.00"}', '{}');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.posting_operations
    (practice_id, client_entity_id, ledger_book_id, provider_connection_id,
     provider, external_organisation_id, parent_operation_id, operation_kind,
     external_object_type, action, idempotency_key,
     source_action_claim_fingerprint, authorized_request_fingerprint,
     intent_schema_version, canonicalization_version,
     validation_rule_set_version, requested_object, expected_material_state)
  VALUES
    ('14100000-0000-0000-0000-000000000002',
     '14300000-0000-0000-0000-000000000002',
     '14400000-0000-0000-0000-000000000002',
     '14500000-0000-0000-0000-000000000002',
     'xero', 'tenant-b', '14800000-0000-0000-0000-000000000001',
     'ENSURE_VENDOR', 'VENDOR', 'CREATE', 'cross-parent-key',
     decode(repeat('33',32),'hex'), decode(repeat('34',32),'hex'),
     '1', '1', 'step5-day3-v1', '{"supplier_id":"supplier-2"}', '{}')
$sql$, 'foreign key', 'parent operation cannot cross tenant/destination');

-- Day 5 adversarial probe: an owner of practice A attempts to post into the
-- independent practice-B client/book/connection. The claim must stop before
-- an operation or any downstream posting record exists.
SELECT public.claim_posting_operation_v1(
  '14100000-0000-0000-0000-000000000002',
  '14300000-0000-0000-0000-000000000002',
  '14400000-0000-0000-0000-000000000002',
  '14500000-0000-0000-0000-000000000002',
  'xero', 'tenant-b', NULL, 'POST_OBJECT', 'BILL', 'CREATE',
  'day5-cross-tenant-claim', repeat('51',32), repeat('52',32),
  '1', '1', 'step5-day5-v1', '{"amount":"20.00","currency":"GBP"}',
  '[]', '[]', '[]', '{"amount":"20.00","currency":"GBP"}',
  '14000000-0000-0000-0000-000000000001'
) AS cross_tenant_claim \gset
SELECT pg_temp.assert_true(
  (:'cross_tenant_claim'::jsonb->>'outcome')='DESTINATION_REJECTED',
  'cross-tenant actor cannot claim a posting operation');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.posting_operations
  WHERE idempotency_key='day5-cross-tenant-claim'
), 'cross-tenant claim creates no operation');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.posting_attempts
  WHERE client_entity_id='14300000-0000-0000-0000-000000000002'
), 'cross-tenant claim creates no dispatch attempt');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.posting_events
  WHERE client_entity_id='14300000-0000-0000-0000-000000000002'
    AND event_type='PROVIDER_OBSERVATION'
), 'cross-tenant claim creates no verification event');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.provider_object_bindings
  WHERE client_entity_id='14300000-0000-0000-0000-000000000002'
), 'cross-tenant claim creates no provider binding');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.posting_attempts
    (operation_id,practice_id,client_entity_id,ledger_book_id,
     provider_connection_id,provider,external_organisation_id,attempt_number,
     attempt_kind,execution_lease_id,adapter_name,adapter_version,
     authorized_request_fingerprint,lease_expires_at)
  VALUES
    ('14800000-0000-0000-0000-000000000001',
     '14100000-0000-0000-0000-000000000002',
     '14300000-0000-0000-0000-000000000002',
     '14400000-0000-0000-0000-000000000002',
     '14500000-0000-0000-0000-000000000002',
     'xero','tenant-b',1,'SUBMIT',
     '14920000-0000-0000-0000-000000000001','attacker','1',
     decode(repeat('21',32),'hex'),now()+interval '1 minute')
$sql$, 'foreign key', 'cross-tenant operation cannot receive a dispatch attempt');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.provider_object_bindings
    (originating_operation_id,practice_id,client_entity_id,ledger_book_id,
     provider_connection_id,provider,external_organisation_id,
     external_object_type,external_object_id,binding_kind,
     verified_provider_state_fingerprint,verified_at)
  VALUES
    ('14800000-0000-0000-0000-000000000001',
     '14100000-0000-0000-0000-000000000002',
     '14300000-0000-0000-0000-000000000002',
     '14400000-0000-0000-0000-000000000002',
     '14500000-0000-0000-0000-000000000002',
     'xero','tenant-b','BILL','attacker-bill','CREATED',
     decode(repeat('53',32),'hex'),now())
$sql$, 'foreign key', 'cross-tenant operation cannot bind a provider object');

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.posting_events
    (operation_id,practice_id,client_entity_id,ledger_book_id,
     provider_connection_id,provider,external_organisation_id,event_sequence,
     event_type,reason_code,actor_kind,actor_service,
     authorized_request_fingerprint,provider_state_fingerprint,
     normalized_provider_state,comparison_outcome,details)
  VALUES
    ('14800000-0000-0000-0000-000000000001',
     '14100000-0000-0000-0000-000000000002',
     '14300000-0000-0000-0000-000000000002',
     '14400000-0000-0000-0000-000000000002',
     '14500000-0000-0000-0000-000000000002',
     'xero','tenant-b',1,'PROVIDER_OBSERVATION','ATTACKER_VERIFY',
     'SERVICE','attacker',decode(repeat('21',32),'hex'),
     decode(repeat('54',32),'hex'),'{}','MATCH','{}')
$sql$, 'foreign key', 'cross-tenant operation cannot persist a verification event');

-- Every approved contract state is a durable value in the state constraint.
DO $$
DECLARE
  v_state text;
  v_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_definition
  FROM pg_constraint
  WHERE conrelid = 'public.posting_operations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%current_state%';
  FOREACH v_state IN ARRAY ARRAY[
    'PROPOSED','REVIEW','VALIDATED','AUTHORIZED','SUBMITTING','VERIFYING',
    'FAILED_SAFE','UNCERTAIN','DENIED','SUCCEEDED'
  ] LOOP
    IF position(quote_literal(v_state) IN v_definition) = 0 THEN
      RAISE EXCEPTION '014 state missing from constraint: %', v_state;
    END IF;
  END LOOP;
END;
$$;

INSERT INTO public.posting_attempts
  (id, operation_id, practice_id, client_entity_id, ledger_book_id,
   provider_connection_id, provider, external_organisation_id, attempt_number,
   attempt_kind, execution_lease_id, adapter_name, adapter_version,
   authorized_request_fingerprint, lease_expires_at)
VALUES
  ('14900000-0000-0000-0000-000000000001', '14800000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', 1, 'SUBMIT', '14910000-0000-0000-0000-000000000001', 'quickbooks-posting-adapter', '1', decode(repeat('21',32),'hex'), now() + interval '5 minutes');

SELECT pg_temp.expect_error(
  'UPDATE public.posting_attempts SET adapter_version = ''2'' WHERE id = ''14900000-0000-0000-0000-000000000001''',
  'append-only', 'attempt update is forbidden');
SELECT pg_temp.expect_error(
  'DELETE FROM public.posting_attempts WHERE id = ''14900000-0000-0000-0000-000000000001''',
  'append-only', 'attempt delete is forbidden');

INSERT INTO public.provider_object_bindings
  (id, originating_operation_id, practice_id, client_entity_id, ledger_book_id,
   provider_connection_id, provider, external_organisation_id,
   external_object_type, external_object_id, binding_kind,
   verified_provider_state_fingerprint, verified_at)
VALUES
  ('14a00000-0000-0000-0000-000000000001', '14800000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', 'BILL', 'qb-bill-100', 'CREATED', decode(repeat('41',32),'hex'), now());

-- The same provider-local object token may exist in another external
-- organisation; the binding identity is organisation/connection scoped.
INSERT INTO public.provider_object_bindings
  (id, originating_operation_id, practice_id, client_entity_id, ledger_book_id,
   provider_connection_id, provider, external_organisation_id,
   external_object_type, external_object_id, binding_kind,
   verified_provider_state_fingerprint, verified_at)
VALUES
  ('14a00000-0000-0000-0000-000000000002', '14800000-0000-0000-0000-000000000003', '14100000-0000-0000-0000-000000000002', '14300000-0000-0000-0000-000000000002', '14400000-0000-0000-0000-000000000002', '14500000-0000-0000-0000-000000000002', 'xero', 'tenant-b', 'BILL', 'qb-bill-100', 'CREATED', decode(repeat('43',32),'hex'), now());

SELECT pg_temp.expect_error($sql$
  INSERT INTO public.provider_object_bindings
    (originating_operation_id, practice_id, client_entity_id, ledger_book_id,
     provider_connection_id, provider, external_organisation_id,
     external_object_type, external_object_id, binding_kind,
     verified_provider_state_fingerprint, verified_at)
  VALUES
    ('14800000-0000-0000-0000-000000000002',
     '14100000-0000-0000-0000-000000000001',
     '14300000-0000-0000-0000-000000000001',
     '14400000-0000-0000-0000-000000000001',
     '14500000-0000-0000-0000-000000000001',
     'quickbooks', 'wrong-realm', 'VENDOR', 'qb-vendor-1', 'CREATED',
     decode(repeat('42',32),'hex'), now())
$sql$, 'foreign key', 'provider object binding cannot cross organisation');

INSERT INTO public.posting_events
  (id, operation_id, practice_id, client_entity_id, ledger_book_id,
   provider_connection_id, provider, external_organisation_id, attempt_id,
   event_sequence, event_type, prior_state, new_state, reason_code,
   actor_kind, actor_service, authorized_request_fingerprint, details)
VALUES
  ('14b00000-0000-0000-0000-000000000001', '14800000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', '14900000-0000-0000-0000-000000000001', 1, 'TRANSITION', 'AUTHORIZED', 'SUBMITTING', 'DISPATCH_READY', 'SERVICE', 'posting-test', decode(repeat('21',32),'hex'), '{}');

INSERT INTO public.posting_events
  (id, operation_id, practice_id, client_entity_id, ledger_book_id,
   provider_connection_id, provider, external_organisation_id, attempt_id,
   provider_object_binding_id, event_sequence, event_type, reason_code,
   actor_kind, actor_service, authorized_request_fingerprint,
   provider_state_fingerprint, normalized_provider_state,
   comparison_outcome, details)
VALUES
  ('14b00000-0000-0000-0000-000000000002', '14800000-0000-0000-0000-000000000001', '14100000-0000-0000-0000-000000000001', '14300000-0000-0000-0000-000000000001', '14400000-0000-0000-0000-000000000001', '14500000-0000-0000-0000-000000000001', 'quickbooks', 'realm-a', '14900000-0000-0000-0000-000000000001', '14a00000-0000-0000-0000-000000000001', 2, 'PROVIDER_OBSERVATION', 'READ_BACK_MATCH', 'SERVICE', 'posting-test', decode(repeat('21',32),'hex'), decode(repeat('41',32),'hex'), '{"Id":"qb-bill-100","TotalAmt":"100.00"}', 'MATCH', '{}');

SELECT pg_temp.expect_error(
  'UPDATE public.posting_events SET reason_code = ''REWRITTEN'' WHERE id = ''14b00000-0000-0000-0000-000000000001''',
  'append-only', 'posting event update is forbidden');
SELECT pg_temp.expect_error(
  'DELETE FROM public.posting_events WHERE id = ''14b00000-0000-0000-0000-000000000001''',
  'append-only', 'posting event delete is forbidden');

-- RLS and ACL: owner A reads A, never B; no application role receives DML.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '14000000-0000-0000-0000-000000000001', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM public.posting_operations),
  'owner A sees only A posting operations through RLS');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM public.posting_operations
   WHERE client_entity_id = '14300000-0000-0000-0000-000000000002'),
  'owner A cannot read tenant B posting operations');
RESET ROLE;

SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('provider_posting_account_mappings','posting_operations',
                       'posting_attempts','provider_object_bindings','posting_events')
    AND grantee IN ('anon','authenticated','service_role')
    AND privilege_type IN ('INSERT','UPDATE','DELETE')
), 'application roles have no direct posting-table DML');

SELECT pg_temp.assert_true((
  SELECT count(*) = 5 FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('provider_posting_account_mappings','posting_operations',
                      'posting_attempts','provider_object_bindings','posting_events')
    AND c.relrowsecurity
), 'all posting foundation tables enforce RLS');

ROLLBACK;
\echo 014_POSTING_DURABILITY_CONTRACT_OK
