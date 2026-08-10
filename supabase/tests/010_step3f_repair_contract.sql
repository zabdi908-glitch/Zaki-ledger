\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE(p_value,false) THEN
    RAISE EXCEPTION 'Step 3F assertion failed: %',p_message;
  END IF;
END $$;

INSERT INTO auth.users (id,email,role,aud,created_at,updated_at) VALUES
 ('f1000000-0000-0000-0000-000000000001','owner-a@step3f.test','authenticated','authenticated',now(),now()),
 ('f1000000-0000-0000-0000-000000000002','owner-b@step3f.test','authenticated','authenticated',now(),now()),
 ('f1000000-0000-0000-0000-000000000003','authorized-bookkeeper@step3f.test','authenticated','authenticated',now(),now()),
 ('f1000000-0000-0000-0000-000000000004','unauthorized-bookkeeper@step3f.test','authenticated','authenticated',now(),now()),
 ('f1000000-0000-0000-0000-000000000005','suspended-admin@step3f.test','authenticated','authenticated',now(),now()),
 ('f1000000-0000-0000-0000-000000000006','revoked-reviewer@step3f.test','authenticated','authenticated',now(),now());
INSERT INTO public.practices (id,name,created_by_user_id) VALUES
 ('f2000000-0000-0000-0000-000000000001','Step 3F Practice A','f1000000-0000-0000-0000-000000000001'),
 ('f2000000-0000-0000-0000-000000000002','Step 3F Practice B','f1000000-0000-0000-0000-000000000002');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role,status,valid_to) VALUES
 ('f3000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000001','owner','active',NULL),
 ('f3000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000002','f1000000-0000-0000-0000-000000000002','owner','active',NULL),
 ('f3000000-0000-0000-0000-000000000003','f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000003','bookkeeper','active',NULL),
 ('f3000000-0000-0000-0000-000000000004','f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000004','bookkeeper','active',NULL),
 ('f3000000-0000-0000-0000-000000000005','f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000005','admin','suspended',now()),
 ('f3000000-0000-0000-0000-000000000006','f2000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000006','reviewer','revoked',now());
INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency) VALUES
 ('f4000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001','Step 3F Client A Ltd','Step 3F Client A','GBP'),
 ('f4000000-0000-0000-0000-000000000002','f2000000-0000-0000-0000-000000000002','Step 3F Client B Ltd','Step 3F Client B','GBP');
INSERT INTO public.client_access
 (id,client_entity_id,practice_id,membership_id,user_id,role,status,valid_to)
VALUES
 ('f4100000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000003','f1000000-0000-0000-0000-000000000003','bookkeeper','active',NULL),
 ('f4100000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001','f3000000-0000-0000-0000-000000000004','f1000000-0000-0000-0000-000000000004','bookkeeper','revoked',now());

INSERT INTO public.ledger_books (id,client_entity_id,book_kind,display_name,functional_currency) VALUES
 ('f5000000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001','quickbooks','Realm A','GBP'),
 ('f5000000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-000000000001','quickbooks','Realm B','GBP'),
 ('f5000000-0000-0000-0000-000000000003','f4000000-0000-0000-0000-000000000002','quickbooks','Realm Other Client','GBP');
INSERT INTO public.provider_connections
 (id,client_entity_id,ledger_book_id,provider,external_organisation_id) VALUES
 ('f5100000-0000-0000-0000-000000000001','f4000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001','quickbooks','realm-a'),
 ('f5100000-0000-0000-0000-000000000002','f4000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000002','quickbooks','realm-b'),
 ('f5100000-0000-0000-0000-000000000003','f4000000-0000-0000-0000-000000000002','f5000000-0000-0000-0000-000000000003','quickbooks','realm-a');

-- Central actor authorization, including every role branch and service list.
DO $$
DECLARE v_before integer; v_after integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.financial_events;
  BEGIN
    PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"spoof"}','user','f1000000-0000-0000-0000-000000000002',NULL,'spoof');
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"unauthorized"}','user','f1000000-0000-0000-0000-000000000004',NULL,'unauthorized');
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"suspended"}','user','f1000000-0000-0000-0000-000000000005',NULL,'suspended');
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"revoked"}','user','f1000000-0000-0000-0000-000000000006',NULL,'revoked');
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"bad-service"}','service',NULL,'arbitrary-worker','bad-service');
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT count(*) INTO v_after FROM public.financial_events;
  PERFORM pg_temp.assert_true(v_after=v_before,'unauthorized actor or service created an event');
  PERFORM public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"authorized-bookkeeper"}','user','f1000000-0000-0000-0000-000000000003',NULL,'authorized');
  PERFORM pg_temp.assert_true((SELECT count(*)=v_before+1 FROM public.financial_events),'authorized bookkeeper was rejected');
END $$;

-- Every canonical mutation RPC must reject the cross-practice actor before
-- validating its operation-specific payload. This proves each entry point is
-- wired to the central authorization helper, not merely that the helper works.
DO $$
DECLARE
  v_client uuid := 'f4000000-0000-0000-0000-000000000001';
  v_spoof uuid := 'f1000000-0000-0000-0000-000000000002';
  v_nil uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  BEGIN PERFORM public.create_financial_event_v1(v_client,'manual','{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'create event accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.append_financial_event_revision_v1(v_client,v_nil,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'append event accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.create_financial_observation_v1(v_client,'{}','{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'create observation accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.append_financial_observation_revision_v1(v_client,v_nil,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'append observation accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.create_financial_document_v1(v_client,'invoice',NULL,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'create document accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.append_financial_document_revision_v1(v_client,v_nil,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'append document accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.ingest_import_artifact_v1(v_client,'csv',repeat('00',32),0,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'artifact ingestion accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.start_import_run_v1(v_client,v_nil,NULL,'spoof',repeat('00',32),'csv','1','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'import run accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.record_financial_observation_occurrence_v1(v_client,v_nil,v_nil,NULL,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'occurrence accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.attach_financial_observation_v1(v_client,v_nil,v_nil,'primary','spoof','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'attachment accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.create_financial_identity_claim_v1(v_client,v_nil,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'identity claim accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.ingest_financial_observation_v1(v_client,'{}','{}','[]','{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'atomic ingestion accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.create_financial_relationship_v1(v_client,'{}','[]','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'relationship accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.allocate_financial_relationship_v1(v_client,v_nil,v_nil,v_nil,'{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'allocation accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.merge_financial_events_v1(v_client,v_nil,v_nil,'spoof','{}','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'merge accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.reverse_financial_merge_v1(v_client,v_nil,'spoof','user',v_spoof,NULL,'actor-matrix'); RAISE EXCEPTION 'merge reversal accepted spoof'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.create_financial_event_v1(v_client,'manual','{}','user',v_spoof,'canonical-api','actor-shape'); RAISE EXCEPTION 'mixed user actor shape accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.create_financial_event_v1(v_client,'manual','{}','service',v_spoof,'canonical-api','actor-shape'); RAISE EXCEPTION 'mixed service actor shape accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.create_financial_event_v1(v_client,'manual','{}','user',NULL,NULL,'actor-shape'); RAISE EXCEPTION 'null user actor accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.create_financial_event_v1(v_client,'manual','{}','service',NULL,NULL,'actor-shape'); RAISE EXCEPTION 'unnamed service actor accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'create_financial_event_v1','append_financial_event_revision_v1',
    'create_financial_observation_v1','append_financial_observation_revision_v1',
    'create_financial_document_v1','append_financial_document_revision_v1',
    'ingest_import_artifact_v1','start_import_run_v1',
    'record_financial_observation_occurrence_v1','attach_financial_observation_v1',
    'create_financial_identity_claim_v1','ingest_financial_observation_v1',
    'create_financial_relationship_v1','allocate_financial_relationship_v1',
    'merge_financial_events_v1','reverse_financial_merge_v1'
  ) AND position('canonical_assert_mutation_context_v1' IN pg_get_functiondef(p.oid))=0
),'every mutation RPC uses central actor authorization');

CREATE TEMP TABLE ids(name text PRIMARY KEY,id uuid NOT NULL);

-- Atomic new/replay/update for one authoritative QuickBooks identity.
WITH r AS (
 SELECT public.ingest_financial_observation_v1(
  'f4000000-0000-0000-0000-000000000001',
  '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000001","ledger_book_id":"f5000000-0000-0000-0000-000000000001"}',
  '{"source_status":"pending","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow","description":"Supplier payment","raw_payload_hash_hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
  '[{"claim_kind":"quickbooks_object_id","strength":"authoritative","namespace_canonical":"quickbooks|realm-a|purchase","claim_key_canonical":"QB-42","components":{"provider":"quickbooks","realm":"realm-a","object_type":"purchase"}}]',
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service',NULL,'canonical-test','atomic-new') value
) INSERT INTO ids SELECT 'atomic_observation',(value->>'observation_id')::uuid FROM r;

SELECT pg_temp.assert_true((public.ingest_financial_observation_v1(
  'f4000000-0000-0000-0000-000000000001',
  '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000001","ledger_book_id":"f5000000-0000-0000-0000-000000000001"}',
  '{"source_status":"pending","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow","description":"Supplier payment","raw_payload_hash_hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
  '[{"claim_kind":"quickbooks_object_id","strength":"authoritative","namespace_canonical":"quickbooks|realm-a|purchase","claim_key_canonical":"QB-42","components":{"provider":"quickbooks","realm":"realm-a","object_type":"purchase"}}]',
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service',NULL,'canonical-test','atomic-replay')->>'reused')::boolean,'exact atomic replay did not reuse');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.financial_observation_revisions WHERE observation_id=(SELECT id FROM ids WHERE name='atomic_observation')),'exact replay appended a revision');

SELECT pg_temp.assert_true((public.ingest_financial_observation_v1(
  'f4000000-0000-0000-0000-000000000001',
  '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000001","ledger_book_id":"f5000000-0000-0000-0000-000000000001"}',
  '{"source_status":"settled","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow","description":"Supplier payment","raw_payload_hash_hex":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","provider_updated_at":"2026-08-10T10:00:00Z"}',
  '[{"claim_kind":"quickbooks_object_id","strength":"authoritative","namespace_canonical":"quickbooks|realm-a|purchase","claim_key_canonical":"QB-42","components":{"provider":"quickbooks","realm":"realm-a","object_type":"purchase"}}]',
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service',NULL,'canonical-test','atomic-update')->>'revision_appended')::boolean,'provider update did not append revision');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM public.financial_observation_revisions WHERE observation_id=(SELECT id FROM ids WHERE name='atomic_observation')),'provider update revision count is not two');

-- Same external ID in another realm is distinct.
SELECT public.ingest_financial_observation_v1(
  'f4000000-0000-0000-0000-000000000001',
  '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000002","ledger_book_id":"f5000000-0000-0000-0000-000000000002"}',
  '{"source_status":"posted","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  '[{"claim_kind":"quickbooks_object_id","strength":"authoritative","namespace_canonical":"quickbooks|realm-b|purchase","claim_key_canonical":"QB-42","components":{"provider":"quickbooks","realm":"realm-b","object_type":"purchase"}}]',
  '{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
  'service',NULL,'canonical-test','other-realm');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM public.financial_identity_claims WHERE claim_key_canonical='QB-42'),'realm namespace collapsed identities');

-- A valid identity from realm A cannot be replayed with realm B root facts,
-- even though both provider connections belong to the same client.
DO $$
DECLARE v_obs integer; v_events integer;
BEGIN
  SELECT count(*) INTO v_obs FROM public.financial_observations;
  SELECT count(*) INTO v_events FROM public.financial_events;
  BEGIN
    PERFORM public.ingest_financial_observation_v1(
      'f4000000-0000-0000-0000-000000000001',
      '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000002","ledger_book_id":"f5000000-0000-0000-0000-000000000002"}',
      '{"source_status":"posted","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}',
      '[{"claim_kind":"quickbooks_object_id","strength":"authoritative","namespace_canonical":"quickbooks|realm-a|purchase","claim_key_canonical":"QB-42","components":{"provider":"quickbooks","realm":"realm-a","object_type":"purchase"}}]',
      '{"event_kind":"payment"}','service',NULL,'canonical-test','namespace-conflict');
    RAISE EXCEPTION 'cross-provider namespace replay succeeded';
  EXCEPTION WHEN check_violation OR unique_violation THEN NULL; END;
  PERFORM pg_temp.assert_true(
    (SELECT count(*)=v_obs FROM public.financial_observations)
    AND (SELECT count(*)=v_events FROM public.financial_events),
    'cross-provider namespace conflict leaked roots');
END $$;

-- Conflicting exact claims resolve before root creation and leave no orphans.
SELECT public.create_financial_identity_claim_v1(
  'f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='atomic_observation'),
  jsonb_build_object('claim_kind','manual_adjudication','strength','strong',
    'namespace_canonical','manual|step3f-conflict','claim_key_canonical','left',
    'namespace_hash_hex',repeat('31',32),'claim_key_hash_hex',repeat('32',32),
    'components','{}'::jsonb),'service',NULL,'canonical-test','conflict-left');
SELECT public.create_financial_identity_claim_v1(
  'f4000000-0000-0000-0000-000000000001',
  (SELECT observation_id FROM public.financial_identity_claims
   WHERE namespace_canonical='quickbooks|realm-b|purchase' AND claim_key_canonical='QB-42'),
  jsonb_build_object('claim_kind','manual_adjudication','strength','strong',
    'namespace_canonical','manual|step3f-conflict','claim_key_canonical','right',
    'namespace_hash_hex',repeat('31',32),'claim_key_hash_hex',repeat('33',32),
    'components','{}'::jsonb),'service',NULL,'canonical-test','conflict-right');
DO $$
DECLARE v_obs integer;v_events integer;v_links integer;
BEGIN
 SELECT count(*) INTO v_obs FROM public.financial_observations;
 SELECT count(*) INTO v_events FROM public.financial_events;
 SELECT count(*) INTO v_links FROM public.financial_event_observation_links;
 BEGIN
  PERFORM public.ingest_financial_observation_v1(
   'f4000000-0000-0000-0000-000000000001',
   '{"observation_kind":"ledger_posting","provider_connection_id":"f5100000-0000-0000-0000-000000000001"}',
   '{"source_status":"posted"}',
   '[{"claim_kind":"manual_adjudication","strength":"strong","namespace_canonical":"manual|step3f-conflict","claim_key_canonical":"left","components":{}},{"claim_kind":"manual_adjudication","strength":"strong","namespace_canonical":"manual|step3f-conflict","claim_key_canonical":"right","components":{}}]',
   '{"event_kind":"payment"}','service',NULL,'canonical-test','conflict');
 EXCEPTION WHEN unique_violation THEN NULL; END;
 PERFORM pg_temp.assert_true((SELECT count(*)=v_obs FROM public.financial_observations) AND (SELECT count(*)=v_events FROM public.financial_events) AND (SELECT count(*)=v_links FROM public.financial_event_observation_links),'identity conflict leaked roots');
END $$;

-- Probabilistic duplicates remain separate and cannot use automatic resolution.
WITH r AS (SELECT public.create_financial_observation_v1('f4000000-0000-0000-0000-000000000001','{"observation_kind":"bank_movement"}','{"source_status":"posted"}','service',NULL,'canonical-test','prob-a')) INSERT INTO ids SELECT 'prob_a',(create_financial_observation_v1->>'observation_id')::uuid FROM r;
WITH r AS (SELECT public.create_financial_observation_v1('f4000000-0000-0000-0000-000000000001','{"observation_kind":"bank_movement"}','{"source_status":"posted"}','service',NULL,'canonical-test','prob-b')) INSERT INTO ids SELECT 'prob_b',(create_financial_observation_v1->>'observation_id')::uuid FROM r;
SELECT public.create_financial_identity_claim_v1('f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='prob_a'),jsonb_build_object('claim_kind','versioned_fingerprint','strength','probabilistic','namespace_canonical','fingerprint|v1','claim_key_canonical','same','namespace_hash_hex',repeat('11',32),'claim_key_hash_hex',repeat('22',32),'components','{}'::jsonb),'service',NULL,'canonical-test','prob-claim-a');
SELECT public.create_financial_identity_claim_v1('f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='prob_b'),jsonb_build_object('claim_kind','versioned_fingerprint','strength','probabilistic','namespace_canonical','fingerprint|v1','claim_key_canonical','same','namespace_hash_hex',repeat('11',32),'claim_key_hash_hex',repeat('22',32),'components','{}'::jsonb),'service',NULL,'canonical-test','prob-claim-b');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM public.financial_identity_claims WHERE claim_kind='versioned_fingerprint' AND claim_key_canonical='same'),'probabilistic identities merged');

-- Idempotent occurrence replay and explicit conflict.
SELECT public.ingest_import_artifact_v1('f4000000-0000-0000-0000-000000000001','csv',repeat('cc',32),10,'{}','service',NULL,'canonical-test','artifact') artifact \gset
SELECT public.start_import_run_v1('f4000000-0000-0000-0000-000000000001',(:'artifact'::jsonb->>'artifact_id')::uuid,NULL,'run-key',repeat('dd',32),'csv','1','service',NULL,'canonical-test','run') run_result \gset
SELECT public.record_financial_observation_occurrence_v1('f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='atomic_observation'),(:'run_result'::jsonb->>'run_id')::uuid,(:'artifact'::jsonb->>'artifact_id')::uuid,'{"source_locator":"row:1","source_row_number":"1","raw_payload_hash_hex":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","observed_at":"2026-08-10T12:00:00Z"}','service',NULL,'canonical-test','occ-new') occurrence \gset
SELECT pg_temp.assert_true((public.record_financial_observation_occurrence_v1('f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='atomic_observation'),(:'run_result'::jsonb->>'run_id')::uuid,(:'artifact'::jsonb->>'artifact_id')::uuid,'{"source_locator":"row:1","source_row_number":"1","raw_payload_hash_hex":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","observed_at":"2026-08-10T12:00:00Z"}','service',NULL,'canonical-test','occ-replay')->>'reused')::boolean,'occurrence replay was not reused');
DO $$ BEGIN
 BEGIN
  PERFORM public.record_financial_observation_occurrence_v1('f4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='prob_a'),(SELECT id FROM public.import_runs WHERE idempotency_key='run-key'),(SELECT id FROM public.import_artifacts WHERE content_sha256=decode(repeat('cc',32),'hex')),'{"source_locator":"row:1","source_row_number":"1","raw_payload_hash_hex":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}','service',NULL,'canonical-test','occ-conflict');
  RAISE EXCEPTION 'occurrence conflict succeeded';
 EXCEPTION WHEN unique_violation THEN
  IF SQLERRM <> 'observation occurrence idempotency conflict' THEN RAISE; END IF;
 END;
END $$;

-- Every seeded relationship type explicitly forbids duplicate physical subjects.
SELECT pg_temp.assert_true((SELECT bool_and(NOT allows_same_subject) FROM public.financial_relationship_types),'relationship self-subject policy is not explicit');
DO $$
DECLARE v_event uuid:=(SELECT id FROM ids WHERE name='atomic_observation'); v_event_id uuid; v_event_2 uuid; v_obs uuid:=(SELECT id FROM ids WHERE name='atomic_observation'); v_result jsonb;
BEGIN
 SELECT event_id INTO v_event_id FROM public.financial_event_observation_links WHERE observation_id=v_obs AND valid_to IS NULL;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"reverses","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','original','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','reversal','ordinal',1)),'service',NULL,'canonical-test','self-reverse'); RAISE EXCEPTION 'self reversal succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"refunds","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','original','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','refund','ordinal',1)),'service',NULL,'canonical-test','self-refund'); RAISE EXCEPTION 'self refund succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"transfers_to","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','source','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','target','ordinal',1)),'service',NULL,'canonical-test','self-transfer'); RAISE EXCEPTION 'self transfer succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"supersedes","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','observation','entity_id',v_obs,'endpoint_role','old','ordinal',0),jsonb_build_object('endpoint_kind','observation','entity_id',v_obs,'endpoint_role','new','ordinal',1)),'service',NULL,'canonical-test','self-supersede'); RAISE EXCEPTION 'self supersession succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"reconciles_with","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','observation','entity_id',v_obs,'endpoint_role','bank','ordinal',0),jsonb_build_object('endpoint_kind','observation','entity_id',v_obs,'endpoint_role','ledger','ordinal',1)),'service',NULL,'canonical-test','self-reconcile'); RAISE EXCEPTION 'self reconciliation succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"batch_contains","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','parent','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','child','ordinal',1)),'service',NULL,'canonical-test','self-batch'); RAISE EXCEPTION 'self batch succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"split_into","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','parent','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','child','ordinal',1)),'service',NULL,'canonical-test','self-split'); RAISE EXCEPTION 'self split succeeded'; EXCEPTION WHEN check_violation THEN NULL; END;
 v_result := public.create_financial_event_v1('f4000000-0000-0000-0000-000000000001','manual','{"event_kind":"reversal","resolution_status":"resolved"}','service',NULL,'canonical-test','distinct-event');
 v_event_2 := (v_result->>'event_id')::uuid;
 PERFORM public.create_financial_relationship_v1('f4000000-0000-0000-0000-000000000001','{"relationship_type":"reverses","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"valid distinct subjects"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',v_event_id,'endpoint_role','original','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',v_event_2,'endpoint_role','reversal','ordinal',1)),'service',NULL,'canonical-test','distinct-reverse');
END $$;

SELECT pg_temp.assert_true((SELECT count(*)>0 FROM public.canonical_audit_ledger WHERE entity_kind='atomic_financial_observation_ingest'),'atomic ingestion missing audit');

ROLLBACK;
