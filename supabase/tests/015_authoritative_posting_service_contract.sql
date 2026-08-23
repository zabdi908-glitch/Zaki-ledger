\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '015 assertion failed: %', p_message;
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
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN v_failed := true; v_error := SQLERRM;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION '015 expected failure did not occur: %', p_message;
  END IF;
  IF v_error !~* p_pattern THEN
    RAISE EXCEPTION '015 wrong failure for %: %', p_message, v_error;
  END IF;
END;
$$;

INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
VALUES ('15000000-0000-0000-0000-000000000001',
        'posting-service-owner@example.test','authenticated','authenticated',now(),now());
INSERT INTO public.practices (id,name,created_by_user_id)
VALUES ('15100000-0000-0000-0000-000000000001','Posting Service Practice',
        '15000000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
VALUES ('15200000-0000-0000-0000-000000000001',
        '15100000-0000-0000-0000-000000000001',
        '15000000-0000-0000-0000-000000000001','owner');
INSERT INTO public.client_entities
  (id,practice_id,legal_name,display_name,base_currency)
VALUES ('15300000-0000-0000-0000-000000000001',
        '15100000-0000-0000-0000-000000000001',
        'Posting Service Ltd','Posting Service','GBP');
INSERT INTO public.ledger_books
  (id,client_entity_id,book_kind,display_name,functional_currency)
VALUES ('15400000-0000-0000-0000-000000000001',
        '15300000-0000-0000-0000-000000000001',
        'quickbooks','Posting Service Realm','GBP');
INSERT INTO public.provider_connections
  (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
VALUES ('15500000-0000-0000-0000-000000000001',
        '15300000-0000-0000-0000-000000000001',
        '15400000-0000-0000-0000-000000000001',
        'quickbooks','service-realm');

CREATE OR REPLACE FUNCTION pg_temp.claim(
  p_key text,
  p_source_hex text,
  p_request_hex text,
  p_requested jsonb DEFAULT '{"displayName":"Supplier"}'::jsonb
)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.claim_posting_operation_v1(
    '15100000-0000-0000-0000-000000000001',
    '15300000-0000-0000-0000-000000000001',
    '15400000-0000-0000-0000-000000000001',
    '15500000-0000-0000-0000-000000000001',
    'quickbooks', 'service-realm', NULL, 'ENSURE_VENDOR', 'VENDOR',
    'CREATE', p_key, p_source_hex, p_request_hex, '1', '1',
    'step5-day3-v1', p_requested,
    '[{"kind":"IMPORT_ARTIFACT","evidenceId":"artifact-1","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
    '[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]'::jsonb,
    '[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]'::jsonb,
    '{"displayName":"Supplier"}'::jsonb,
    '15000000-0000-0000-0000-000000000001'
  );
$$;

SELECT pg_temp.claim('service-key-1', repeat('11',32), repeat('21',32)) AS claim_result \gset
SELECT pg_temp.assert_true(
  (:'claim_result'::jsonb->>'outcome') = 'CREATED',
  'first exact claim creates a PROPOSED operation');
SELECT (:'claim_result'::jsonb#>>'{operation,id}')::uuid AS operation_id \gset

SELECT pg_temp.assert_true(
  (pg_temp.claim('service-key-1', repeat('11',32), repeat('21',32))->>'outcome') = 'RESUMED',
  'same key and exact intent resumes');
SELECT pg_temp.assert_true(
  (pg_temp.claim('service-key-1', repeat('12',32), repeat('22',32),
                 '{"displayName":"Changed"}'::jsonb)->>'outcome') = 'IDEMPOTENCY_CONFLICT',
  'same key with changed intent conflicts');
SELECT pg_temp.assert_true(
  (pg_temp.claim('service-key-2', repeat('11',32), repeat('23',32))->>'outcome') = 'DUPLICATE_CREATE_CLAIM',
  'different key cannot duplicate source/action CREATE claim');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM public.posting_operations
   WHERE client_entity_id='15300000-0000-0000-0000-000000000001'),
  'conflicts created no second operation');

SELECT public.record_posting_decision_v1(
  :'operation_id', '15000000-0000-0000-0000-000000000001',
  'CORE_SAFETY_ALLOW', '{"gate":"CorePostingSafetyGate","decision":"ALLOW"}'
);

SELECT pg_temp.expect_error(
  format($sql$SELECT public.transition_posting_operation_v1(
    %L::uuid,'PROPOSED','AUTHORIZED',
    '15000000-0000-0000-0000-000000000001','PERMISSION_ALLOW',NULL,NULL,'{}')$sql$,
    :'operation_id'),
  'not permitted|requires', 'PROPOSED cannot skip VALIDATED');

SELECT public.transition_posting_operation_v1(
  :'operation_id', 'PROPOSED', 'VALIDATED',
  '15000000-0000-0000-0000-000000000001', 'CORE_SAFETY_ALLOW',
  NULL, NULL, '{"gate":"CorePostingSafetyGate"}'
);

INSERT INTO public.posting_human_authorizations (
  id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
  provider,external_organisation_id,operation_kind,external_object_type,
  action,authorized_request_fingerprint,approved_by_user_id,expires_at
) VALUES (
  '15600000-0000-0000-0000-000000000001',
  '15100000-0000-0000-0000-000000000001',
  '15300000-0000-0000-0000-000000000001',
  '15400000-0000-0000-0000-000000000001',
  '15500000-0000-0000-0000-000000000001',
  'quickbooks','service-realm','ENSURE_VENDOR','VENDOR','CREATE',
  decode(repeat('21',32),'hex'),
  '15000000-0000-0000-0000-000000000001',now()+interval '1 day'
);

SELECT public.record_posting_decision_v1(
  :'operation_id', '15000000-0000-0000-0000-000000000001',
  'PERMISSION_ALLOW',
  '{"gate":"Step5DeterministicPermissionGate","decision":"ALLOW"}'
);
SELECT public.transition_posting_operation_v1(
  :'operation_id', 'VALIDATED', 'AUTHORIZED',
  '15000000-0000-0000-0000-000000000001', 'PERMISSION_ALLOW',
  '15600000-0000-0000-0000-000000000001',
  '15700000-0000-0000-0000-000000000001',
  '{"service":"AuthoritativePostingService.submit"}'
);

SELECT pg_temp.assert_true(
  (SELECT current_state='AUTHORIZED'
          AND human_authorization_id='15600000-0000-0000-0000-000000000001'
          AND permission_decision_id='15700000-0000-0000-0000-000000000001'
   FROM public.posting_operations WHERE id=:'operation_id'),
  'exact authorization and permission bind the AUTHORIZED state');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 5 AND max(event_sequence) = 5
   FROM public.posting_events WHERE operation_id=:'operation_id'),
  'claim, gate decisions, and transitions are append-only sequential events');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.posting_events
              WHERE operation_id=:'operation_id' AND new_state='SUBMITTING'),
  'service-core contract never enters SUBMITTING');

SELECT pg_temp.expect_error(
  'UPDATE public.posting_human_authorizations SET expires_at=now()+interval ''2 days'' WHERE id=''15600000-0000-0000-0000-000000000001''',
  'append-only', 'human authorization cannot be rewritten');

SELECT pg_temp.assert_true(NOT has_function_privilege(
  'authenticated',
  'public.record_posting_decision_v1(uuid,uuid,text,jsonb)', 'EXECUTE'),
  'authenticated cannot invoke decision write RPC');
SELECT pg_temp.assert_true(NOT has_function_privilege(
  'authenticated',
  'public.transition_posting_operation_v1(uuid,text,text,uuid,text,uuid,uuid,jsonb)',
  'EXECUTE'), 'authenticated cannot invoke transition RPC');
SELECT pg_temp.assert_true(has_function_privilege(
  'service_role',
  'public.transition_posting_operation_v1(uuid,text,text,uuid,text,uuid,uuid,jsonb)',
  'EXECUTE'), 'service role can invoke transition RPC');

ROLLBACK;
\echo 015_AUTHORITATIVE_POSTING_SERVICE_CONTRACT_OK
