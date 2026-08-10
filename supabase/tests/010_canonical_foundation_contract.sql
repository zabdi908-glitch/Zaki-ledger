\set ON_ERROR_STOP on

-- Migration 010 isolated behavioral contract. The complete test runs in one
-- transaction and always rolls back its synthetic users and financial data.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(p_value, false) THEN
    RAISE EXCEPTION 'contract assertion failed: %', p_message;
  END IF;
END;
$$;

INSERT INTO auth.users (id, email, role, aud, created_at, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'canonical-owner-a@example.test', 'authenticated', 'authenticated', now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'canonical-owner-b@example.test', 'authenticated', 'authenticated', now(), now()),
  ('33333333-3333-3333-3333-333333333333', 'canonical-bookkeeper@example.test', 'authenticated', 'authenticated', now(), now());

INSERT INTO public.practices (id, name, created_by_user_id) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Practice A', '11111111-1111-1111-1111-111111111111'),
  ('a2000000-0000-0000-0000-000000000002', 'Practice B', '22222222-2222-2222-2222-222222222222');
INSERT INTO public.practice_memberships (id, practice_id, user_id, role) VALUES
  ('a1100000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('a2200000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner'),
  ('a1300000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'bookkeeper');
INSERT INTO public.client_entities (id, practice_id, legal_name, display_name, base_currency) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Client A Ltd', 'Client A', 'GBP'),
  ('c2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', 'Client B Ltd', 'Client B', 'GBP');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.client_entities) <> 1 THEN
    RAISE EXCEPTION 'owner RLS did not isolate its practice client';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.client_entities) <> 0 THEN
    RAISE EXCEPTION 'bookkeeper received client access without an explicit grant';
  END IF;
END $$;
RESET ROLE;
INSERT INTO public.client_access
  (client_entity_id, practice_id, membership_id, user_id, role)
VALUES
  ('c1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',
   'a1300000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','bookkeeper');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.client_entities) <> 1 THEN
    RAISE EXCEPTION 'explicit client grant was not honored';
  END IF;
END $$;
RESET ROLE;

SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.legacy_record_mappings), '010 creates no legacy mappings');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public.financial_event_aliases), '010 creates no aliases');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class child ON child.oid = c.conrelid
  JOIN pg_class parent ON parent.oid = c.confrelid
  JOIN pg_namespace n ON n.oid = child.relnamespace
  WHERE c.contype = 'f' AND n.nspname = 'public'
    AND child.relname IN (
      'practices','practice_memberships','client_entities','client_access','ledger_books',
      'provider_connections','financial_accounts','import_artifacts','import_runs',
      'financial_events','financial_event_revisions','financial_observations',
      'financial_observation_revisions','financial_observation_occurrences',
      'financial_event_observation_links','financial_event_fact_resolutions',
      'financial_identity_claims','financial_documents','financial_document_revisions',
      'financial_relationships','financial_relationship_endpoints','financial_allocations',
      'financial_merge_operations','financial_event_aliases','legacy_record_mappings',
      'canonical_audit_ledger')
    AND parent.relname IN ('bank_transactions','qb_transactions','bank_statements','invoices',
                           'reconciliation_matches','invoice_matches','oauth_connections')
), 'canonical schema has no legacy foreign keys');

CREATE TEMP TABLE test_ids (name text PRIMARY KEY, id uuid NOT NULL);

WITH result AS (
  SELECT public.create_financial_event_v1(
    'c1000000-0000-0000-0000-000000000001', 'manual',
    '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
    'service', NULL, 'canonical-test', 'event-1') AS value
) INSERT INTO test_ids SELECT 'event_a', (value->>'event_id')::uuid FROM result;
WITH result AS (
  SELECT public.create_financial_event_v1(
    'c1000000-0000-0000-0000-000000000001', 'manual',
    '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
    'service', NULL, 'canonical-test', 'event-2') AS value
) INSERT INTO test_ids SELECT 'event_b', (value->>'event_id')::uuid FROM result;
WITH result AS (
  SELECT public.create_financial_observation_v1(
    'c1000000-0000-0000-0000-000000000001', '{"observation_kind":"bank_movement"}',
    '{"source_status":"posted","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow","raw_amount_text":"-10.00","raw_currency_text":"GBP","posted_on":"2026-08-10"}',
    'service', NULL, 'canonical-test', 'observation-1') AS value
) INSERT INTO test_ids SELECT 'observation_a', (value->>'observation_id')::uuid FROM result;
WITH result AS (
  SELECT public.create_financial_observation_v1(
    'c1000000-0000-0000-0000-000000000001', '{"observation_kind":"ledger_posting"}',
    '{"source_status":"posted","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
    'service', NULL, 'canonical-test', 'observation-2') AS value
) INSERT INTO test_ids SELECT 'observation_b', (value->>'observation_id')::uuid FROM result;
WITH result AS (
  SELECT public.create_financial_document_v1(
    'c1000000-0000-0000-0000-000000000001', 'invoice', NULL,
    '{"obligation_status":"open","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","raw_amount_text":"10.00","raw_currency_text":"GBP"}',
    'service', NULL, 'canonical-test', 'document-1') AS value
) INSERT INTO test_ids SELECT 'document_a', (value->>'document_id')::uuid FROM result;

-- Hard composite ownership rejects cross-client identity attachment.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.financial_identity_claims (
      client_entity_id, observation_id, claim_kind, strength,
      canonicalisation_version, namespace_canonical, claim_key_canonical,
      namespace_hash, claim_key_hash, components
    ) VALUES (
      'c2000000-0000-0000-0000-000000000002', (SELECT id FROM test_ids WHERE name='observation_a'),
      'ofx_fitid', 'strong', 1, 'ofx|account', 'fitid-cross-client',
      extensions.digest('ns','sha256'), extensions.digest('key','sha256'), '{}'
    );
    RAISE EXCEPTION 'cross-client claim unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END;
$$;

SELECT public.attach_financial_observation_v1(
  'c1000000-0000-0000-0000-000000000001',
  (SELECT id FROM test_ids WHERE name='event_a'),
  (SELECT id FROM test_ids WHERE name='observation_a'),
  'primary', 'contract', 'service', NULL, 'canonical-test', 'attach-1');
DO $$
BEGIN
  BEGIN
    PERFORM public.attach_financial_observation_v1(
      'c1000000-0000-0000-0000-000000000001',
      (SELECT id FROM test_ids WHERE name='event_b'),
      (SELECT id FROM test_ids WHERE name='observation_a'),
      'primary', 'contract', 'service', NULL, 'canonical-test', 'attach-2');
    RAISE EXCEPTION 'second active attachment unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- Exact strong identity is unique; probabilistic claims and digest collisions
-- with different exact values remain representable.
SELECT public.create_financial_identity_claim_v1(
  'c1000000-0000-0000-0000-000000000001',
  (SELECT id FROM test_ids WHERE name='observation_a'),
  jsonb_build_object('claim_kind','manual_adjudication','strength','strong',
    'namespace_canonical','ofx|account-a','claim_key_canonical','fitid-1',
    'namespace_hash_hex',encode(extensions.digest('same-ns','sha256'),'hex'),
    'claim_key_hash_hex',encode(extensions.digest('same-key','sha256'),'hex'),
    'components','{}'::jsonb),
  'service', NULL, 'canonical-test', 'claim-1');
SELECT public.create_financial_identity_claim_v1(
  'c1000000-0000-0000-0000-000000000001',
  (SELECT id FROM test_ids WHERE name='observation_b'),
  jsonb_build_object('claim_kind','manual_adjudication','strength','strong',
    'namespace_canonical','ofx|account-b','claim_key_canonical','fitid-2',
    'namespace_hash_hex',encode(extensions.digest('same-ns','sha256'),'hex'),
    'claim_key_hash_hex',encode(extensions.digest('same-key','sha256'),'hex'),
    'components','{}'::jsonb),
  'service', NULL, 'canonical-test', 'hash-collision');
INSERT INTO public.financial_identity_claims (
  client_entity_id, observation_id, claim_kind, strength, canonicalisation_version,
  namespace_canonical, claim_key_canonical, namespace_hash, claim_key_hash, components
)
SELECT 'c1000000-0000-0000-0000-000000000001', id,
       'versioned_fingerprint', 'probabilistic', 1, 'fingerprint|v1', 'duplicate',
       extensions.digest('fpns','sha256'), extensions.digest('fp','sha256'), '{}'
FROM test_ids WHERE name IN ('observation_a','observation_b');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public.financial_identity_claims
  WHERE claim_kind='versioned_fingerprint'), 'probabilistic duplicate claims are allowed');

-- Revision append is monotonic, raw date-only facts remain date-only, and
-- immutable history rejects UPDATE/DELETE.
SELECT public.append_financial_event_revision_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='event_a'),
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service', NULL, 'canonical-test', 'event-rev-2');
SELECT pg_temp.assert_true((SELECT max(revision_number)=2 FROM public.financial_event_revisions
  WHERE event_id=(SELECT id FROM test_ids WHERE name='event_a')), 'event revisions are monotonic');
SELECT pg_temp.assert_true((SELECT posted_on='2026-08-10'::date AND posted_at IS NULL
  FROM public.financial_observation_revisions WHERE observation_id=(SELECT id FROM test_ids WHERE name='observation_a')),
  'date-only source facts do not invent timestamps');
DO $$
BEGIN
  BEGIN
    UPDATE public.financial_event_revisions SET display_label='forbidden'
    WHERE event_id=(SELECT id FROM test_ids WHERE name='event_a');
    RAISE EXCEPTION 'revision update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

-- A confirmed Â£600 allocation is valid; a second Â£600 against the same Â£1000
-- payment/invoice is rejected by the defensive capacity trigger.
WITH result AS (
  SELECT public.create_financial_relationship_v1(
    'c1000000-0000-0000-0000-000000000001',
    '{"relationship_type":"settles","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"contract"}',
    jsonb_build_array(
      jsonb_build_object('endpoint_kind','event','entity_id',(SELECT id FROM test_ids WHERE name='event_a'),'endpoint_role','payment','ordinal',0),
      jsonb_build_object('endpoint_kind','document','entity_id',(SELECT id FROM test_ids WHERE name='document_a'),'endpoint_role','obligation','ordinal',1)),
    'service', NULL, 'canonical-test', 'relationship-1') AS value
) INSERT INTO test_ids SELECT 'relationship_a', (value->>'relationship_id')::uuid FROM result;
SELECT public.allocate_financial_relationship_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='relationship_a'),
  (SELECT id FROM public.financial_relationship_endpoints WHERE relationship_id=(SELECT id FROM test_ids WHERE name='relationship_a') AND endpoint_role='payment'),
  (SELECT id FROM public.financial_relationship_endpoints WHERE relationship_id=(SELECT id FROM test_ids WHERE name='relationship_a') AND endpoint_role='obligation'),
  '{"source_amount_minor":"600","source_currency_code":"GBP","source_minor_unit_exponent":"2","target_amount_minor":"600","target_currency_code":"GBP","target_minor_unit_exponent":"2","status":"confirmed"}',
  'service', NULL, 'canonical-test', 'allocation-1');
DO $$
BEGIN
  BEGIN
    PERFORM public.allocate_financial_relationship_v1(
      'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='relationship_a'),
      (SELECT id FROM public.financial_relationship_endpoints WHERE relationship_id=(SELECT id FROM test_ids WHERE name='relationship_a') AND endpoint_role='payment'),
      (SELECT id FROM public.financial_relationship_endpoints WHERE relationship_id=(SELECT id FROM test_ids WHERE name='relationship_a') AND endpoint_role='obligation'),
      '{"source_amount_minor":"600","source_currency_code":"GBP","source_minor_unit_exponent":"2","target_amount_minor":"600","target_currency_code":"GBP","target_minor_unit_exponent":"2","status":"confirmed"}',
      'service', NULL, 'canonical-test', 'allocation-2');
    RAISE EXCEPTION 'oversubscription unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true((public.append_financial_event_revision_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='event_a'),
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"500","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service', NULL, 'canonical-test', 'event-correction')->>'resolution_status')='conflicted',
  'amount correction below confirmed allocation becomes conflicted');

-- Merge is alias-only, root-resolvable, reversible, and leaves observation links unmoved.
WITH result AS (
  SELECT public.merge_financial_events_v1(
    'c1000000-0000-0000-0000-000000000001',
    (SELECT id FROM test_ids WHERE name='event_a'), (SELECT id FROM test_ids WHERE name='event_b'),
    'contract merge', '{}', 'service', NULL, 'canonical-test', 'merge-1') AS value
) INSERT INTO test_ids SELECT 'merge_a', (value->>'merge_operation_id')::uuid FROM result;
SELECT pg_temp.assert_true(public.resolve_canonical_event_root_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='event_b')) =
  (SELECT id FROM test_ids WHERE name='event_a'), 'alias resolves to survivor');
SELECT public.reverse_financial_merge_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='merge_a'),
  'contract reversal', 'service', NULL, 'canonical-test', 'reverse-1');
SELECT pg_temp.assert_true(public.resolve_canonical_event_root_v1(
  'c1000000-0000-0000-0000-000000000001', (SELECT id FROM test_ids WHERE name='event_b')) =
  (SELECT id FROM test_ids WHERE name='event_b'), 'merge reversal restores independent root');

-- Idempotent imports return one artifact/run; conflicting request reuse fails.
SELECT public.ingest_import_artifact_v1(
  'c1000000-0000-0000-0000-000000000001','csv',repeat('ab',32),100,'{}',
  'service',NULL,'canonical-test','artifact-1') AS artifact_result \gset
SELECT public.start_import_run_v1(
  'c1000000-0000-0000-0000-000000000001',
  (:'artifact_result'::jsonb->>'artifact_id')::uuid,NULL,'idem-1',repeat('cd',32),
  'csv','1','service',NULL,'canonical-test','run-1') AS first_run \gset
SELECT pg_temp.assert_true((public.start_import_run_v1(
  'c1000000-0000-0000-0000-000000000001',
  (:'artifact_result'::jsonb->>'artifact_id')::uuid,NULL,'idem-1',repeat('cd',32),
  'csv','1','service',NULL,'canonical-test','run-2')->>'reused')::boolean,
  'same idempotency key and request hash is reused');
DO $$
BEGIN
  BEGIN
    PERFORM public.start_import_run_v1(
      'c1000000-0000-0000-0000-000000000001',
      (SELECT id FROM public.import_artifacts WHERE client_entity_id='c1000000-0000-0000-0000-000000000001'),
      NULL, 'idem-1', repeat('ef',32), 'csv','1','service',NULL,'canonical-test','run-conflict');
    RAISE EXCEPTION 'idempotency hash conflict unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- ACL and SECURITY DEFINER catalog contracts.
SELECT pg_temp.assert_true(NOT has_table_privilege('anon','public.financial_events','SELECT'), 'anon has no table access');
SELECT pg_temp.assert_true(has_table_privilege('authenticated','public.financial_events','SELECT'), 'authenticated has SELECT');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated','public.financial_events','INSERT'), 'authenticated has no DML');
SELECT pg_temp.assert_true(NOT has_table_privilege('service_role','public.financial_events','INSERT'), 'service role has no direct DML');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE '%financial%_v1'
    AND p.prosecdef AND NOT ('search_path=public, pg_temp'=ANY(p.proconfig))
), 'security definer canonical functions have a fixed search path');

SELECT pg_temp.assert_true((SELECT count(*) >= 12 FROM public.canonical_audit_ledger), 'mutation RPCs write audit rows');
DO $$
BEGIN
  BEGIN
    DELETE FROM public.canonical_audit_ledger;
    RAISE EXCEPTION 'audit delete unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

ROLLBACK;
