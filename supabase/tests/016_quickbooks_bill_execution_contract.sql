\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_value boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    RAISE EXCEPTION '016 assertion failed: %', p_message;
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
  IF NOT v_failed THEN RAISE EXCEPTION '016 expected failure: %', p_message; END IF;
  IF v_error !~* p_pattern THEN
    RAISE EXCEPTION '016 wrong failure for %: %', p_message, v_error;
  END IF;
END;
$$;

INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
VALUES ('d4000000-0000-0000-0000-000000000001',
        'posting-day4-owner@example.test','authenticated','authenticated',now(),now());
INSERT INTO public.practices (id,name,created_by_user_id)
VALUES ('d4110000-0000-0000-0000-000000000001','Posting Day 4 Practice',
        'd4000000-0000-0000-0000-000000000001');
INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
VALUES ('d4010000-0000-0000-0000-000000000001',
        'd4110000-0000-0000-0000-000000000001',
        'd4000000-0000-0000-0000-000000000001','owner');
INSERT INTO public.client_entities
  (id,practice_id,legal_name,display_name,base_currency)
VALUES ('d4120000-0000-0000-0000-000000000001',
        'd4110000-0000-0000-0000-000000000001',
        'Posting Day 4 Ltd','Posting Day 4','GBP');
INSERT INTO public.ledger_books
  (id,client_entity_id,book_kind,display_name,functional_currency)
VALUES ('d4130000-0000-0000-0000-000000000001',
        'd4120000-0000-0000-0000-000000000001',
        'quickbooks','Posting Day 4 Realm','GBP');
INSERT INTO public.provider_connections
  (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
VALUES ('d4140000-0000-0000-0000-000000000001',
        'd4120000-0000-0000-0000-000000000001',
        'd4130000-0000-0000-0000-000000000001',
        'quickbooks','fake-realm-day4');
INSERT INTO public.import_artifacts
  (id,client_entity_id,artifact_kind,content_sha256,content_length,storage_state)
VALUES ('d4210000-0000-0000-0000-000000000001',
        'd4120000-0000-0000-0000-000000000001','invoice_pdf',
        decode(repeat('f1',32),'hex'),120,'retained');
INSERT INTO public.financial_accounts
  (id,client_entity_id,ledger_book_id,provider_connection_id,account_kind,display_name)
VALUES ('d4151000-0000-0000-0000-000000000001',
        'd4120000-0000-0000-0000-000000000001',
        'd4130000-0000-0000-0000-000000000001',
        'd4140000-0000-0000-0000-000000000001','expense','Purchases');
INSERT INTO public.provider_posting_account_mappings (
  id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
  financial_account_id,provider,external_organisation_id,provider_account_id,
  provider_account_name,posting_role,provider_account_type,mapping_status,
  is_postable,verified_at,eligibility_expires_at
) VALUES (
  'd4150000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'd4151000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','qb-expense-6100','Purchases',
  'general_ledger','Expense','active',true,now()-interval '1 minute',now()+interval '1 day'
);
INSERT INTO public.provider_tax_treatment_mappings (
  id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
  provider,external_organisation_id,provider_tax_code,treatment_name,
  evidence_fingerprint,mapping_status,verified_at,eligibility_expires_at
) VALUES (
  'd4160000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','20.0% S','UK standard-rated purchase',
  decode(repeat('b1',32),'hex'),'active',now()-interval '1 minute',now()+interval '1 day'
);

INSERT INTO public.posting_human_authorizations (
  id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
  provider,external_organisation_id,operation_kind,external_object_type,
  action,authorized_request_fingerprint,approved_by_user_id,expires_at
) VALUES (
  'd4180000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','ACCOUNTS_PAYABLE_BILL','BILL','CREATE',
  decode(repeat('a1',32),'hex'),'d4000000-0000-0000-0000-000000000001',now()+interval '1 day'
);

INSERT INTO public.posting_operations (
  id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
  provider,external_organisation_id,parent_operation_id,operation_kind,
  external_object_type,action,idempotency_key,source_action_claim_fingerprint,
  authorized_request_fingerprint,intent_schema_version,canonicalization_version,
  validation_rule_set_version,requested_object,evidence_snapshot,
  account_treatment_snapshot,tax_treatment_snapshot,expected_material_state,
  current_state,human_authorization_id,permission_decision_id
) VALUES (
  'd4100000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4',NULL,'ACCOUNTS_PAYABLE_BILL','BILL','CREATE',
  'day4-bill-key',decode(repeat('c1',32),'hex'),decode(repeat('a1',32),'hex'),
  'step5.v1','step5.v1','step5-day4-v1',
  jsonb_build_object(
    'amount','120.00','currency','GBP','invoiceDate','2026-08-22',
    'invoiceNumber','INV-DAY4-1','description','Invoice INV-DAY4-1',
    'vendorChild',jsonb_build_object(
      'operationId','d4170000-0000-0000-0000-000000000001',
      'idempotencyKey','day4-vendor-key',
      'authorizedRequestFingerprint',repeat('a2',32))),
  jsonb_build_array(jsonb_build_object(
    'kind','IMPORT_ARTIFACT','evidenceId','d4210000-0000-0000-0000-000000000001',
    'fingerprint',repeat('f1',32))),
  '[{"disposition":"MAPPED","mappingId":"d4150000-0000-0000-0000-000000000001"}]',
  jsonb_build_array(jsonb_build_object(
    'disposition','MAPPED','treatmentId','d4160000-0000-0000-0000-000000000001',
    'providerTaxCode','20.0% S','evidenceFingerprint',repeat('b1',32))),
  '{"externalObjectType":"BILL","status":"OPEN","amount":"120.00","currency":"GBP"}',
  'AUTHORIZED','d4180000-0000-0000-0000-000000000001',
  'd4190000-0000-0000-0000-000000000001'
),(
  'd4170000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','d4100000-0000-0000-0000-000000000001',
  'ENSURE_VENDOR','VENDOR','CREATE','day4-vendor-key',
  decode(repeat('c2',32),'hex'),decode(repeat('a2',32),'hex'),
  'step5.v1','step5.v1','step5-day4-v1','{"displayName":"Day 4 Supplier"}',
  '[]','[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]',
  '[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]',
  '{"displayName":"Day 4 Supplier"}','SUCCEEDED',NULL,NULL
);

INSERT INTO public.provider_object_bindings (
  id,originating_operation_id,practice_id,client_entity_id,ledger_book_id,
  provider_connection_id,provider,external_organisation_id,
  external_object_type,external_object_id,binding_kind,
  verified_provider_state_fingerprint,provider_version,verified_at
) VALUES (
  'd4200000-0000-0000-0000-000000000001',
  'd4170000-0000-0000-0000-000000000001',
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','VENDOR','qb-vendor-91','CREATED',
  decode(repeat('d1',32),'hex'),'1',now()
);

SAVEPOINT stale_evidence_probe;
UPDATE public.import_artifacts SET storage_state='unavailable'
WHERE id='d4210000-0000-0000-0000-000000000001';
SELECT public.prepare_quickbooks_bill_submission_v1(
  'd4100000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001',
  'QuickBooksPostingAdapter','step5-day4-v1',120
) AS stale_evidence \gset
SELECT pg_temp.assert_true((:'stale_evidence'::jsonb->>'kind')='BLOCKED'
  AND (:'stale_evidence'::jsonb->>'state')='REVIEW'
  AND (:'stale_evidence'::jsonb->>'reasonCode')='DISPATCH_EVIDENCE_STALE',
  'stale evidence blocks dispatch before provider work');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.posting_attempts
  WHERE operation_id='d4100000-0000-0000-0000-000000000001'
), 'stale evidence creates no dispatch attempt');
ROLLBACK TO SAVEPOINT stale_evidence_probe;

SAVEPOINT expired_connection_probe;
UPDATE public.provider_connections SET status='expired'
WHERE id='d4140000-0000-0000-0000-000000000001';
SELECT public.prepare_quickbooks_bill_submission_v1(
  'd4100000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001',
  'QuickBooksPostingAdapter','step5-day4-v1',120
) AS expired_connection \gset
SELECT pg_temp.assert_true((:'expired_connection'::jsonb->>'kind')='DENIED'
  AND (:'expired_connection'::jsonb->>'state')='DENIED'
  AND (:'expired_connection'::jsonb->>'reasonCode')='DISPATCH_DESTINATION_INVALID',
  'expired provider connection denies dispatch before provider work');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM public.posting_attempts
  WHERE operation_id='d4100000-0000-0000-0000-000000000001'
), 'expired provider connection creates no dispatch attempt');
ROLLBACK TO SAVEPOINT expired_connection_probe;

SELECT public.prepare_quickbooks_bill_submission_v1(
  'd4100000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001',
  'QuickBooksPostingAdapter','step5-day4-v1',120
) AS prepared \gset
SELECT pg_temp.assert_true((:'prepared'::jsonb->>'kind')='DISPATCH',
  'AUTHORIZED operation receives one dispatch grant');
SELECT pg_temp.assert_true((:'prepared'::jsonb#>>'{grant,operation,stateAtDispatch}')='AUTHORIZED',
  'adapter grant is explicitly bound to the AUTHORIZED pre-transition state');
SELECT pg_temp.assert_true((:'prepared'::jsonb#>>'{grant,accountMapping,providerAccountId}')='qb-expense-6100',
  'grant uses the exact eligible mapped account rather than an account query');
SELECT pg_temp.assert_true((:'prepared'::jsonb#>>'{grant,taxMapping,providerTaxCode}')='20.0% S',
  'grant includes exact validated tax code');
SELECT (:'prepared'::jsonb#>>'{grant,attempt,id}')::uuid AS submit_attempt_id \gset

SELECT pg_temp.assert_true(
  (SELECT current_state='SUBMITTING' FROM public.posting_operations
   WHERE id='d4100000-0000-0000-0000-000000000001')
  AND (SELECT count(*)=1 FROM public.posting_attempts
       WHERE operation_id='d4100000-0000-0000-0000-000000000001'
         AND attempt_kind='SUBMIT'),
  'attempt and AUTHORIZED to SUBMITTING transition commit together');
SELECT pg_temp.assert_true(
  (public.prepare_quickbooks_bill_submission_v1(
    'd4100000-0000-0000-0000-000000000001',
    'd4000000-0000-0000-0000-000000000001',
    'QuickBooksPostingAdapter','step5-day4-v1',120)->>'kind')='RECOVERY_REQUIRED',
  'SUBMITTING retry cannot receive a second CREATE grant');
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM public.posting_attempts
   WHERE operation_id='d4100000-0000-0000-0000-000000000001'
     AND attempt_kind='SUBMIT'),
  'exact retry creates no second submit attempt');

SAVEPOINT deterministic_failure_probe;
SELECT public.record_quickbooks_bill_failure_v1(
  'd4100000-0000-0000-0000-000000000001', :'submit_attempt_id',
  'FAILED_SAFE','VALIDATION_REJECTION','QBO_VALIDATION_REJECTED',
  'Bearer secret-token access_token=do-not-store'
) AS failed_safe_probe \gset
SELECT pg_temp.assert_true((:'failed_safe_probe'::jsonb->>'state')='FAILED_SAFE',
  'deterministic provider rejection before creation reaches FAILED_SAFE');
SELECT pg_temp.assert_true(
  (SELECT details->>'summaryStored'='false'
     AND details::text !~* 'secret-token|do-not-store'
   FROM public.posting_events
   WHERE operation_id='d4100000-0000-0000-0000-000000000001'
     AND event_type='PROVIDER_RESPONSE' ORDER BY event_sequence DESC LIMIT 1),
  'provider error persistence excludes raw or secret-bearing summaries');
ROLLBACK TO SAVEPOINT deterministic_failure_probe;

SAVEPOINT uncertain_failure_probe;
SELECT public.record_quickbooks_bill_failure_v1(
  'd4100000-0000-0000-0000-000000000001', :'submit_attempt_id',
  'UNCERTAIN','UNCERTAIN_DELIVERY','RESPONSE_TIMEOUT_AFTER_POSSIBLE_CREATE',
  'network timeout'
) AS uncertain_probe \gset
SELECT pg_temp.assert_true((:'uncertain_probe'::jsonb->>'state')='UNCERTAIN',
  'ambiguous post-dispatch timeout reaches UNCERTAIN');
ROLLBACK TO SAVEPOINT uncertain_failure_probe;

SELECT public.begin_quickbooks_bill_recovery_v1(
  'd4100000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001',
  'QuickBooksPostingAdapter','step5-day4-v1',120
) AS recovery \gset
SELECT pg_temp.assert_true((:'recovery'::jsonb->>'kind')='RECOVER'
  AND (:'recovery'::jsonb#>>'{grant,operation,stateAtRecovery}')='SUBMITTING',
  'SUBMITTING recovery is read-only and retains original state');
SELECT (:'recovery'::jsonb#>>'{grant,attempt,id}')::uuid AS recovery_attempt_id \gset

SELECT public.record_quickbooks_bill_acknowledged_v1(
  'd4100000-0000-0000-0000-000000000001', :'submit_attempt_id',
  'qb-bill-day4-1','fake-request-1');
SELECT pg_temp.assert_true(
  (SELECT details->>'externalBillId'='qb-bill-day4-1'
     AND details->>'result'='CREATED'
     AND NOT details ? 'rawResponse'
   FROM public.posting_events
   WHERE operation_id='d4100000-0000-0000-0000-000000000001'
     AND event_type='PROVIDER_RESPONSE' ORDER BY event_sequence DESC LIMIT 1),
  'external Bill ID is durable and response storage is sanitized');

SELECT public.record_quickbooks_bill_observation_v1(
  'd4100000-0000-0000-0000-000000000001', :'recovery_attempt_id',
  'qb-bill-day4-1','1',repeat('e1',32),
  '{"externalObjectType":"BILL","status":"OPEN","vendorId":"qb-vendor-91","transactionDate":"2026-08-22","documentNumber":"INV-DAY4-1","currency":"GBP","amount":"120.00","lines":[{"amount":"120.00","description":"Invoice INV-DAY4-1","providerAccountId":"qb-expense-6100","providerTaxCode":"20.0% S"}]}'::jsonb,
  'MATCH','QUICKBOOKS_BILL_RECOVERED_AND_VERIFIED'
) AS observed \gset
SELECT pg_temp.assert_true((:'observed'::jsonb->>'state')='SUCCEEDED',
  'matching provider read-back reaches SUCCEEDED');
SELECT pg_temp.assert_true(
  (SELECT external_object_id='qb-bill-day4-1'
   FROM public.provider_object_bindings
   WHERE originating_operation_id='d4100000-0000-0000-0000-000000000001'),
  'verified external Bill ID is bound to the exact operation and destination');
SELECT pg_temp.assert_true(
  (public.prepare_quickbooks_bill_submission_v1(
    'd4100000-0000-0000-0000-000000000001',
    'd4000000-0000-0000-0000-000000000001',
    'QuickBooksPostingAdapter','step5-day4-v1',120)#>>'{externalBillId}')='qb-bill-day4-1',
  'exact retry of SUCCEEDED returns existing result without dispatch');

SELECT pg_temp.expect_error(
  format('UPDATE public.posting_attempts SET adapter_version=''changed'' WHERE id=%L',
         :'submit_attempt_id'),
  'append-only','posting attempts remain append-only');
SELECT pg_temp.expect_error(
  format('UPDATE public.posting_events SET reason_code=''changed'' WHERE operation_id=%L',
         'd4100000-0000-0000-0000-000000000001'),
  'append-only','posting execution events remain append-only');
SELECT pg_temp.assert_true(NOT has_function_privilege(
  'authenticated',
  'public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)',
  'EXECUTE'), 'authenticated callers cannot invoke dispatch RPC');
SELECT pg_temp.assert_true(has_function_privilege(
  'service_role',
  'public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)',
  'EXECUTE'), 'only service role receives dispatch capability');

SELECT public.claim_posting_operation_v1(
  'd4110000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001',
  'd4130000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000001',
  'quickbooks','fake-realm-day4','d4100000-0000-0000-0000-000000000001',
  'ENSURE_VENDOR','VENDOR','CREATE','preallocated-child-key',
  repeat('c3',32),repeat('a3',32),'step5.v1','step5.v1','step5-day4-v1',
  jsonb_build_object('displayName','Preallocated Vendor',
                     '__zakiRequestedOperationId','d4220000-0000-0000-0000-000000000001'),
  '[]','[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]',
  '[{"disposition":"NOT_APPLICABLE","reason":"Vendor"}]',
  '{"displayName":"Preallocated Vendor"}',
  'd4000000-0000-0000-0000-000000000001'
) AS preallocated_child \gset
SELECT pg_temp.assert_true(
  (:'preallocated_child'::jsonb#>>'{operation,id}')='d4220000-0000-0000-0000-000000000001',
  'claim honors the exact precommitted ENSURE_VENDOR child operation ID');

ROLLBACK;
\echo 016_QUICKBOOKS_BILL_EXECUTION_CONTRACT_OK
