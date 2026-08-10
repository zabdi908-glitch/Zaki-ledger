\set ON_ERROR_STOP on

-- Step 3E hostile probes. The transaction is rolled back so this suite leaves
-- the disposable validation database unchanged. A failed probe is reported as
-- data instead of aborting the run, allowing all independent attack surfaces
-- to be inspected in one pass.
BEGIN;

CREATE TEMP TABLE staging_probe_results (
  probe text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text NOT NULL
);

CREATE OR REPLACE FUNCTION pg_temp.probe(p_probe text, p_passed boolean, p_detail text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO staging_probe_results VALUES (p_probe, p_passed, p_detail);
$$;

INSERT INTO auth.users (id,email,role,aud,created_at,updated_at) VALUES
 ('e1000000-0000-0000-0000-000000000001','owner-a@canonical-test.test','authenticated','authenticated',now(),now()),
 ('e1000000-0000-0000-0000-000000000002','admin-a@canonical-test.test','authenticated','authenticated',now(),now()),
 ('e1000000-0000-0000-0000-000000000003','bookkeeper-a@canonical-test.test','authenticated','authenticated',now(),now()),
 ('e1000000-0000-0000-0000-000000000004','reviewer-a@canonical-test.test','authenticated','authenticated',now(),now()),
 ('e1000000-0000-0000-0000-000000000005','viewer-a@canonical-test.test','authenticated','authenticated',now(),now()),
 ('e1000000-0000-0000-0000-000000000006','owner-b@canonical-test.test','authenticated','authenticated',now(),now());

INSERT INTO public.practices (id,name,created_by_user_id) VALUES
 ('e2000000-0000-0000-0000-000000000001','Practice A','e1000000-0000-0000-0000-000000000001'),
 ('e2000000-0000-0000-0000-000000000002','Practice B','e1000000-0000-0000-0000-000000000006');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role) VALUES
 ('e3000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','owner'),
 ('e3000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','admin'),
 ('e3000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','bookkeeper'),
 ('e3000000-0000-0000-0000-000000000004','e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000004','reviewer'),
 ('e3000000-0000-0000-0000-000000000005','e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000005','viewer'),
 ('e3000000-0000-0000-0000-000000000006','e2000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000006','owner');
INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency) VALUES
 ('e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','Client A1 Ltd','Client A1','GBP'),
 ('e4000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000001','Client A2 Ltd','Client A2','GBP'),
 ('e4000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000002','Client B1 Ltd','Client B1','GBP');
INSERT INTO public.client_access (client_entity_id,practice_id,membership_id,user_id,role) VALUES
 ('e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000003','e1000000-0000-0000-0000-000000000003','bookkeeper'),
 ('e4000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000004','e1000000-0000-0000-0000-000000000004','reviewer'),
 ('e4000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000005','e1000000-0000-0000-0000-000000000005','viewer');

-- RLS role matrix: owner/admin are practice-wide; other roles require an
-- explicit per-client grant.
DO $$
DECLARE v_count integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000001',true);
  SELECT count(*) INTO v_count FROM public.client_entities;
  RESET ROLE;
  PERFORM pg_temp.probe('rls_owner_practice_scope',v_count=2,'visible clients='||v_count);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000002',true);
  SELECT count(*) INTO v_count FROM public.client_entities;
  RESET ROLE;
  PERFORM pg_temp.probe('rls_admin_practice_scope',v_count=2,'visible clients='||v_count);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000003',true);
  SELECT count(*) INTO v_count FROM public.client_entities;
  RESET ROLE;
  PERFORM pg_temp.probe('rls_bookkeeper_explicit_scope',v_count=1,'visible clients='||v_count);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000004',true);
  SELECT count(*) INTO v_count FROM public.client_entities;
  RESET ROLE;
  PERFORM pg_temp.probe('rls_reviewer_explicit_scope',v_count=1,'visible clients='||v_count);

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000005',true);
  SELECT count(*) INTO v_count FROM public.client_entities;
  RESET ROLE;
  PERFORM pg_temp.probe('rls_viewer_explicit_scope',v_count=1,'visible clients='||v_count);
END $$;

SELECT pg_temp.probe('acl_anon_no_select',NOT has_table_privilege('anon','public.financial_events','SELECT'),'catalog privilege check');
SELECT pg_temp.probe('acl_authenticated_no_dml',NOT has_table_privilege('authenticated','public.financial_events','INSERT,UPDATE,DELETE'),'catalog privilege check');
SELECT pg_temp.probe('acl_service_role_no_dml',NOT has_table_privilege('service_role','public.financial_events','INSERT,UPDATE,DELETE'),'catalog privilege check');

CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL);
WITH r AS (SELECT public.create_financial_event_v1('e4000000-0000-0000-0000-000000000001','manual','{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}','service',NULL,'canonical-test','event-a'))
INSERT INTO ids SELECT 'event_a',(create_financial_event_v1->>'event_id')::uuid FROM r;
WITH r AS (SELECT public.create_financial_event_v1('e4000000-0000-0000-0000-000000000001','manual','{"event_kind":"payment","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}','service',NULL,'canonical-test','event-b'))
INSERT INTO ids SELECT 'event_b',(create_financial_event_v1->>'event_id')::uuid FROM r;
WITH r AS (SELECT public.create_financial_observation_v1('e4000000-0000-0000-0000-000000000001','{"observation_kind":"bank_movement"}','{"source_status":"pending","raw_amount_text":"-10.00","raw_currency_text":"ZZZ","posted_on":"2026-08-10"}','service',NULL,'canonical-test','obs-a'))
INSERT INTO ids SELECT 'obs_a',(create_financial_observation_v1->>'observation_id')::uuid FROM r;
WITH r AS (SELECT public.create_financial_observation_v1('e4000000-0000-0000-0000-000000000001','{"observation_kind":"ledger_posting"}','{"source_status":"posted","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","direction":"outflow"}','service',NULL,'canonical-test','obs-b'))
INSERT INTO ids SELECT 'obs_b',(create_financial_observation_v1->>'observation_id')::uuid FROM r;
WITH r AS (SELECT public.create_financial_document_v1('e4000000-0000-0000-0000-000000000001','invoice',NULL,'{"obligation_status":"open","resolution_status":"resolved","amount_minor":"1000","currency_code":"GBP","minor_unit_exponent":"2","raw_amount_text":"10.00","raw_currency_text":"GBP"}','service',NULL,'canonical-test','doc-a'))
INSERT INTO ids SELECT 'doc_a',(create_financial_document_v1->>'document_id')::uuid FROM r;

SELECT pg_temp.probe('raw_unknown_currency_preserved',(
  SELECT amount_minor IS NULL AND currency_code IS NULL AND raw_currency_text='ZZZ' AND posted_on='2026-08-10'::date AND posted_at IS NULL
  FROM public.financial_observation_revisions WHERE observation_id=(SELECT id FROM ids WHERE name='obs_a')
),'no normalized facts invented');

-- RPC actor identity must be authorized for the client. This deliberately uses
-- Practice B's owner while mutating Client A1.
DO $$
DECLARE v_before integer; v_after integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.financial_events WHERE client_entity_id='e4000000-0000-0000-0000-000000000001';
  BEGIN
    PERFORM public.create_financial_event_v1('e4000000-0000-0000-0000-000000000001','manual','{"event_kind":"attack","resolution_status":"incomplete"}','user','e1000000-0000-0000-0000-000000000006',NULL,'cross-tenant-actor');
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
  SELECT count(*) INTO v_after FROM public.financial_events WHERE client_entity_id='e4000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.probe('rpc_cross_tenant_actor_rejected',v_after=v_before,format('before=%s after=%s',v_before,v_after));
END $$;

-- Strong namespaces are exact and client-scoped; fingerprints cannot be
-- promoted to authoritative strength.
SELECT public.create_financial_identity_claim_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_a'),jsonb_build_object('claim_kind','manual_adjudication','strength','strong','namespace_canonical','manual|realm-a|purchase','claim_key_canonical','42','namespace_hash_hex',repeat('11',32),'claim_key_hash_hex',repeat('22',32),'components','{}'::jsonb),'service',NULL,'canonical-test','qb-realm-a');
SELECT public.create_financial_identity_claim_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_b'),jsonb_build_object('claim_kind','manual_adjudication','strength','strong','namespace_canonical','manual|realm-b|purchase','claim_key_canonical','42','namespace_hash_hex',repeat('11',32),'claim_key_hash_hex',repeat('22',32),'components','{}'::jsonb),'service',NULL,'canonical-test','qb-realm-b');
SELECT pg_temp.probe('identity_exact_namespace_not_hash_only',(SELECT count(*)=2 FROM public.financial_identity_claims WHERE claim_key_canonical='42'),'same digest/different realm coexist');
DO $$ BEGIN
  BEGIN
    PERFORM public.create_financial_identity_claim_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_a'),jsonb_build_object('claim_kind','versioned_fingerprint','strength','authoritative','namespace_canonical','fingerprint|v1','claim_key_canonical','x','namespace_hash_hex',repeat('33',32),'claim_key_hash_hex',repeat('44',32),'components','{}'::jsonb),'service',NULL,'canonical-test','bad-promotion');
    PERFORM pg_temp.probe('fingerprint_promotion_rejected',false,'promotion succeeded');
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN
    PERFORM pg_temp.probe('fingerprint_promotion_rejected',true,'claim-kind FK rejected promotion');
  END;
END $$;

-- Provider strong identities cannot use the separate claim primitive; callers
-- must use the atomic resolve-or-create RPC.
DO $$
DECLARE v_before integer; v_after integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.financial_identity_claims;
  BEGIN
    PERFORM public.create_financial_identity_claim_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_a'),jsonb_build_object('claim_kind','quickbooks_object_id','strength','authoritative','namespace_canonical','quickbooks|realm-a|purchase','claim_key_canonical','provider-42','namespace_hash_hex',repeat('11',32),'claim_key_hash_hex',repeat('22',32),'components','{}'::jsonb),'service',NULL,'canonical-test','separate-provider-claim');
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO v_after FROM public.financial_identity_claims;
  PERFORM pg_temp.probe('provider_strong_claim_requires_atomic_ingest',v_after=v_before,format('before=%s after=%s',v_before,v_after));
END $$;

-- Relationship topology must reject a relationship from an event to itself.
DO $$
DECLARE v_rel uuid;
BEGIN
  BEGIN
    v_rel := (public.create_financial_relationship_v1('e4000000-0000-0000-0000-000000000001','{"relationship_type":"reverses","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"self attack"}',jsonb_build_array(jsonb_build_object('endpoint_kind','event','entity_id',(SELECT id FROM ids WHERE name='event_a'),'endpoint_role','original','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',(SELECT id FROM ids WHERE name='event_a'),'endpoint_role','reversal','ordinal',1)),'service',NULL,'canonical-test','self-reversal')->>'relationship_id')::uuid;
  EXCEPTION WHEN check_violation OR unique_violation THEN NULL;
  END;
  PERFORM pg_temp.probe('relationship_self_subject_rejected',v_rel IS NULL,COALESCE('created relationship='||v_rel,'rejected'));
END $$;

-- Invalid multi-row relationship creation must roll back both the relationship
-- and its first endpoint.
DO $$
DECLARE v_before_rel integer; v_before_ep integer; v_after_rel integer; v_after_ep integer;
BEGIN
  SELECT count(*) INTO v_before_rel FROM public.financial_relationships;
  SELECT count(*) INTO v_before_ep FROM public.financial_relationship_endpoints;
  BEGIN
    PERFORM public.create_financial_relationship_v1('e4000000-0000-0000-0000-000000000001','{"relationship_type":"reconciles_with","status":"confirmed","evidence_strength":"strong","source_kind":"manual","reason":"invalid endpoint"}',jsonb_build_array(jsonb_build_object('endpoint_kind','observation','entity_id',(SELECT id FROM ids WHERE name='obs_a'),'endpoint_role','bank','ordinal',0),jsonb_build_object('endpoint_kind','event','entity_id',(SELECT id FROM ids WHERE name='event_a'),'endpoint_role','ledger','ordinal',1)),'service',NULL,'canonical-test','invalid-rel');
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT count(*) INTO v_after_rel FROM public.financial_relationships;
  SELECT count(*) INTO v_after_ep FROM public.financial_relationship_endpoints;
  PERFORM pg_temp.probe('relationship_failure_atomic',v_before_rel=v_after_rel AND v_before_ep=v_after_ep,format('relationships %s/%s endpoints %s/%s',v_before_rel,v_after_rel,v_before_ep,v_after_ep));
END $$;

-- Artifact/run and occurrence replay are all idempotent.
DO $$
DECLARE v_art uuid; v_run uuid; v_first uuid; v_second uuid;
BEGIN
  v_art := (public.ingest_import_artifact_v1('e4000000-0000-0000-0000-000000000001','csv',repeat('aa',32),10,'{}','service',NULL,'canonical-test','artifact')->>'artifact_id')::uuid;
  v_run := (public.start_import_run_v1('e4000000-0000-0000-0000-000000000001',v_art,NULL,'replay-key',repeat('bb',32),'csv','1','service',NULL,'canonical-test','run')->>'run_id')::uuid;
  v_first := (public.record_financial_observation_occurrence_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_a'),v_run,v_art,'{"source_locator":"row:1","source_row_number":"1"}','service',NULL,'canonical-test','occ-1')->>'occurrence_id')::uuid;
  BEGIN
    v_second := (public.record_financial_observation_occurrence_v1('e4000000-0000-0000-0000-000000000001',(SELECT id FROM ids WHERE name='obs_a'),v_run,v_art,'{"source_locator":"row:1","source_row_number":"1"}','service',NULL,'canonical-test','occ-2')->>'occurrence_id')::uuid;
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  PERFORM pg_temp.probe('occurrence_replay_idempotent',COALESCE(v_second=v_first,false),format('first=%s second=%s',v_first,v_second));
END $$;

-- Audit projection rejects arbitrary metadata keys and stores no supplied raw
-- payloads/tokens in the metadata column.
SELECT pg_temp.probe('audit_metadata_allowlist',(SELECT bool_and(public.canonical_audit_metadata_allowed_v1(metadata_redacted)) FROM public.canonical_audit_ledger),'all rows satisfy allowlist');
SELECT pg_temp.probe('audit_secret_scan_zero',NOT EXISTS (SELECT 1 FROM public.canonical_audit_ledger WHERE metadata_redacted::text ~* '(access[_ ]?token|refresh[_ ]?token|secret[_ ]?key|raw[_ ]?(payload|invoice))'),'metadata secret scan');
SELECT pg_temp.probe('security_definer_fixed_path',NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef AND p.proname LIKE '%_v1'
    AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,ARRAY[]::text[])) c WHERE c LIKE 'search_path=%')
),'all versioned SECURITY DEFINER functions fix search_path');

TABLE staging_probe_results ORDER BY passed, probe;
SELECT count(*) FILTER (WHERE passed) AS passed, count(*) FILTER (WHERE NOT passed) AS failed FROM staging_probe_results;
ROLLBACK;
