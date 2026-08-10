\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
VALUES ('91000000-0000-0000-0000-000000000001','canonical-concurrency@example.test','authenticated','authenticated',now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.practices (id,name,created_by_user_id)
VALUES ('92000000-0000-0000-0000-000000000001','Concurrency Practice','91000000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
VALUES ('93000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','owner');
INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency)
VALUES ('94000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001','Concurrency Client Ltd','Concurrency Client','GBP');

INSERT INTO public.ledger_books (id,client_entity_id,book_kind,display_name,functional_currency)
VALUES ('94100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','quickbooks','Concurrency Realm','GBP');
INSERT INTO public.provider_connections
  (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
VALUES ('94200000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94100000-0000-0000-0000-000000000001','quickbooks','concurrency-realm');
INSERT INTO public.import_artifacts
  (id,client_entity_id,artifact_kind,content_sha256,content_length,metadata)
VALUES ('94300000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','csv',decode(repeat('aa',32),'hex'),10,'{}');
INSERT INTO public.import_runs
  (id,client_entity_id,artifact_id,idempotency_key,request_hash,parser_name,parser_version,requested_by_kind,requested_by_service)
VALUES ('94400000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','94300000-0000-0000-0000-000000000001','concurrent-run',decode(repeat('bb',32),'hex'),'csv','1','service','canonical-test');

INSERT INTO public.financial_events (id,client_entity_id,created_by_kind)
VALUES ('95000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','manual');
INSERT INTO public.financial_events (id,client_entity_id,created_by_kind) VALUES
 ('99000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','manual'),
 ('99000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','manual');
INSERT INTO public.financial_event_revisions
  (id,client_entity_id,event_id,revision_number,event_kind,lifecycle_status,resolution_status,
   amount_minor,currency_code,minor_unit_exponent,direction,change_reason,provenance,
   created_by_kind,created_by_service)
VALUES ('95100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
  '95000000-0000-0000-0000-000000000001',1,'payment','active','resolved',1000,'GBP',2,'outflow',
  'setup','{}','service','canonical-test');
UPDATE public.financial_events SET current_revision_id='95100000-0000-0000-0000-000000000001'
WHERE id='95000000-0000-0000-0000-000000000001';
INSERT INTO public.financial_event_revisions
  (id,client_entity_id,event_id,revision_number,event_kind,lifecycle_status,resolution_status,
   amount_minor,currency_code,minor_unit_exponent,direction,change_reason,provenance,
   created_by_kind,created_by_service)
VALUES
 ('99100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000001',1,'payment','active','resolved',1000,'GBP',2,'outflow','setup','{}','service','canonical-test'),
 ('99100000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000002',1,'payment','active','resolved',1000,'GBP',2,'outflow','setup','{}','service','canonical-test');
UPDATE public.financial_events SET current_revision_id=
 CASE id WHEN '99000000-0000-0000-0000-000000000001'::uuid THEN '99100000-0000-0000-0000-000000000001'::uuid
         ELSE '99100000-0000-0000-0000-000000000002'::uuid END
WHERE id IN ('99000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000002');

INSERT INTO public.financial_documents (id,client_entity_id,document_kind)
VALUES ('96000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','invoice');
INSERT INTO public.financial_document_revisions
  (id,client_entity_id,document_id,revision_number,obligation_status,resolution_status,
   amount_minor,currency_code,minor_unit_exponent,change_reason,provenance,created_by_kind,created_by_service)
VALUES ('96100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000001',1,'open','resolved',1000,'GBP',2,'setup','{}','service','canonical-test');
UPDATE public.financial_documents SET current_revision_id='96100000-0000-0000-0000-000000000001'
WHERE id='96000000-0000-0000-0000-000000000001';

INSERT INTO public.financial_observations (id,client_entity_id,observation_kind) VALUES
 ('97000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','bank_movement'),
 ('97000000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','bank_movement');
INSERT INTO public.financial_observation_revisions
  (id,client_entity_id,observation_id,revision_number,source_status,amount_minor,currency_code,
   minor_unit_exponent,direction,change_reason,created_by_kind,created_by_service)
VALUES
 ('97100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001',1,'posted',1000,'GBP',2,'outflow','setup','service','canonical-test'),
 ('97100000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000002',1,'posted',1000,'GBP',2,'outflow','setup','service','canonical-test');
UPDATE public.financial_observations SET current_revision_id=
  CASE id WHEN '97000000-0000-0000-0000-000000000001'::uuid THEN '97100000-0000-0000-0000-000000000001'::uuid
          ELSE '97100000-0000-0000-0000-000000000002'::uuid END
WHERE id IN ('97000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000002');

INSERT INTO public.financial_relationships
  (id,client_entity_id,relationship_type,status,evidence_strength,source_kind,reason,created_by_kind,created_by_service)
VALUES ('98000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',
  'settles','confirmed','strong','manual','concurrency setup','service','canonical-test');
INSERT INTO public.financial_relationship_endpoints
  (id,client_entity_id,relationship_id,endpoint_role,ordinal,event_id,document_id)
VALUES
 ('98100000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001','98000000-0000-0000-0000-000000000001','payment',0,'95000000-0000-0000-0000-000000000001',NULL),
 ('98100000-0000-0000-0000-000000000002','94000000-0000-0000-0000-000000000001','98000000-0000-0000-0000-000000000001','obligation',1,NULL,'96000000-0000-0000-0000-000000000001');
COMMIT;
