\set ON_ERROR_STOP on
\timing on
BEGIN;

INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
VALUES ('fa000000-0000-0000-0000-000000000001','scale-owner@step3e.test','authenticated','authenticated',now(),now());
INSERT INTO public.practices (id,name,created_by_user_id)
VALUES ('fa100000-0000-0000-0000-000000000001','Scale Practice','fa000000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
VALUES ('fa200000-0000-0000-0000-000000000001','fa100000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-000000000001','owner');
INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency)
SELECT md5('scale-client-'||g)::uuid,'fa100000-0000-0000-0000-000000000001','Scale Client '||g,'Scale Client '||g,'GBP'
FROM generate_series(1,1000) g;

CREATE TEMP TABLE scale_constants AS
SELECT md5('scale-client-1')::uuid AS client_id,
       md5('scale-artifact')::uuid AS artifact_id,
       md5('scale-run')::uuid AS run_id;

INSERT INTO public.import_artifacts
  (id,client_entity_id,artifact_kind,content_sha256,content_length,metadata)
SELECT artifact_id,client_id,'synthetic-scale',extensions.digest('scale-artifact','sha256'),50000000,'{}'
FROM scale_constants;
INSERT INTO public.import_runs
  (id,client_entity_id,artifact_id,idempotency_key,request_hash,parser_name,parser_version,requested_by_kind,requested_by_service)
SELECT run_id,client_id,artifact_id,'scale-run',extensions.digest('scale-run','sha256'),'scale','1','system','step3e-scale'
FROM scale_constants;

-- 20,000 events (above the 10,000 minimum) and current revisions.
INSERT INTO public.financial_events (id,client_entity_id,created_by_kind)
SELECT md5('scale-event-'||g)::uuid,c.client_id,'backfill'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_event_revisions
  (id,client_entity_id,event_id,revision_number,event_kind,resolution_status,amount_minor,currency_code,minor_unit_exponent,direction,change_reason,created_by_kind,created_by_service)
SELECT md5('scale-event-revision-'||g)::uuid,c.client_id,md5('scale-event-'||g)::uuid,1,'payment','resolved',1000,'GBP',2,'outflow','scale fixture','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
UPDATE public.financial_events e SET current_revision_id=md5('scale-event-revision-'||g)::uuid
FROM generate_series(1,20000) g
WHERE e.id=md5('scale-event-'||g)::uuid;

-- 20,000 observations, links, 50,000 delivery occurrences and 20,000 exact claims.
INSERT INTO public.financial_observations (id,client_entity_id,observation_kind)
SELECT md5('scale-observation-'||g)::uuid,c.client_id,'bank_movement'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_observation_revisions
  (id,client_entity_id,observation_id,revision_number,source_status,amount_minor,currency_code,minor_unit_exponent,direction,posted_on,change_reason,created_by_kind,created_by_service)
SELECT md5('scale-observation-revision-'||g)::uuid,c.client_id,md5('scale-observation-'||g)::uuid,1,'posted',1000,'GBP',2,'outflow','2026-08-10','scale fixture','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
UPDATE public.financial_observations o SET current_revision_id=md5('scale-observation-revision-'||g)::uuid
FROM generate_series(1,20000) g
WHERE o.id=md5('scale-observation-'||g)::uuid;
INSERT INTO public.financial_event_observation_links
  (id,client_entity_id,event_id,observation_id,role,attachment_basis,attached_by_kind,attached_by_service)
SELECT md5('scale-link-'||g)::uuid,c.client_id,md5('scale-event-'||g)::uuid,md5('scale-observation-'||g)::uuid,'primary','scale fixture','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_observation_occurrences
  (id,client_entity_id,observation_id,import_run_id,artifact_id,source_locator,source_row_number,source_reference_hash,raw_payload_hash)
SELECT md5('scale-occurrence-'||g)::uuid,c.client_id,md5('scale-observation-'||(((g-1)%20000)+1))::uuid,c.run_id,c.artifact_id,'row:'||g,g,extensions.digest('reference-'||g,'sha256'),extensions.digest('payload-'||g,'sha256')
FROM generate_series(1,50000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_identity_claims
  (id,client_entity_id,observation_id,claim_kind,strength,canonicalisation_version,namespace_canonical,claim_key_canonical,namespace_hash,claim_key_hash,components)
SELECT md5('scale-claim-'||g)::uuid,c.client_id,md5('scale-observation-'||g)::uuid,'ofx_fitid','strong',1,'ofx|scale-account','FIT-'||g,extensions.digest('ofx|scale-account','sha256'),extensions.digest('FIT-'||g,'sha256'),jsonb_build_object('fitid','FIT-'||g)
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;

-- 20,000 documents, relationships, endpoint pairs and confirmed allocations.
INSERT INTO public.financial_documents (id,client_entity_id,document_kind)
SELECT md5('scale-document-'||g)::uuid,c.client_id,'invoice'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_document_revisions
  (id,client_entity_id,document_id,revision_number,obligation_status,resolution_status,amount_minor,currency_code,minor_unit_exponent,change_reason,created_by_kind,created_by_service)
SELECT md5('scale-document-revision-'||g)::uuid,c.client_id,md5('scale-document-'||g)::uuid,1,'open','resolved',1000,'GBP',2,'scale fixture','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
UPDATE public.financial_documents d SET current_revision_id=md5('scale-document-revision-'||g)::uuid
FROM generate_series(1,20000) g
WHERE d.id=md5('scale-document-'||g)::uuid;
INSERT INTO public.financial_relationships
  (id,client_entity_id,relationship_type,status,evidence_strength,source_kind,reason,created_by_kind,created_by_service)
SELECT md5('scale-relationship-'||g)::uuid,c.client_id,'settles','confirmed','strong','system','scale fixture','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_relationship_endpoints
  (id,client_entity_id,relationship_id,endpoint_role,ordinal,event_id)
SELECT md5('scale-endpoint-payment-'||g)::uuid,c.client_id,md5('scale-relationship-'||g)::uuid,'payment',0,md5('scale-event-'||g)::uuid
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_relationship_endpoints
  (id,client_entity_id,relationship_id,endpoint_role,ordinal,document_id)
SELECT md5('scale-endpoint-obligation-'||g)::uuid,c.client_id,md5('scale-relationship-'||g)::uuid,'obligation',1,md5('scale-document-'||g)::uuid
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;
INSERT INTO public.financial_allocations
  (id,client_entity_id,relationship_id,from_endpoint_id,to_endpoint_id,source_amount_minor,source_currency_code,source_minor_unit_exponent,target_amount_minor,target_currency_code,target_minor_unit_exponent,status,created_by_kind,created_by_service)
SELECT md5('scale-allocation-'||g)::uuid,c.client_id,md5('scale-relationship-'||g)::uuid,md5('scale-endpoint-payment-'||g)::uuid,md5('scale-endpoint-obligation-'||g)::uuid,1000,'GBP',2,1000,'GBP',2,'proposed','system','step3e-scale'
FROM generate_series(1,20000) g CROSS JOIN scale_constants c;

-- Confirm the full allocation population. The guard locks only the two affected
-- subjects and uses targeted balance indexes, so this is also the bulk-path test.
UPDATE public.financial_allocations AS allocation
SET status='confirmed'
FROM generate_series(1,20000) g
WHERE allocation.id=md5('scale-allocation-'||g)::uuid;

SET CONSTRAINTS ALL IMMEDIATE;
ANALYZE public.financial_events;
ANALYZE public.financial_event_revisions;
ANALYZE public.financial_observations;
ANALYZE public.financial_event_observation_links;
ANALYZE public.financial_identity_claims;
ANALYZE public.financial_relationships;
ANALYZE public.financial_relationship_endpoints;
ANALYZE public.financial_allocations;

SELECT 'scale_counts' AS result,
  (SELECT count(*) FROM public.financial_events) AS events,
  (SELECT count(*) FROM public.financial_observations) AS observations,
  (SELECT count(*) FROM public.financial_observation_occurrences) AS occurrences,
  (SELECT count(*) FROM public.financial_identity_claims) AS claims,
  (SELECT count(*) FROM public.financial_relationships) AS relationships,
  (SELECT count(*) FROM public.financial_allocations) AS allocations;

EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT public.resolve_canonical_event_root_v1((SELECT client_id FROM scale_constants),md5('scale-event-20000')::uuid);
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT id FROM public.financial_identity_claims WHERE client_entity_id=(SELECT client_id FROM scale_constants) AND claim_kind='ofx_fitid' AND namespace_canonical='ofx|scale-account' AND claim_key_canonical='FIT-19999' AND status='active';
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT event_id FROM public.financial_event_observation_links WHERE observation_id=md5('scale-observation-19999')::uuid AND valid_to IS NULL;
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT e.id,r.amount_minor,r.currency_code FROM public.financial_events e JOIN public.financial_event_revisions r ON (r.id,r.event_id,r.client_entity_id)=(e.current_revision_id,e.id,e.client_entity_id) WHERE e.id=md5('scale-event-19999')::uuid;
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT id FROM public.financial_relationships WHERE client_entity_id=(SELECT client_id FROM scale_constants) AND status='confirmed' ORDER BY created_at DESC LIMIT 50;
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT COALESCE(sum(a.source_amount_minor),0) FROM public.financial_allocations a JOIN public.financial_relationship_endpoints ep ON ep.id=a.from_endpoint_id WHERE a.client_entity_id=(SELECT client_id FROM scale_constants) AND a.status='confirmed' AND ep.event_id=md5('scale-event-19999')::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-000000000001',true);
EXPLAIN (ANALYZE,BUFFERS,TIMING,FORMAT TEXT)
SELECT id,display_name FROM public.client_entities ORDER BY display_name LIMIT 100;
RESET ROLE;

ROLLBACK;
