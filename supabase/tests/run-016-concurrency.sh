#!/usr/bin/env bash
set -euo pipefail

container_name="${ZAKI_LOCAL_DB_CONTAINER:-supabase_db_Zaki-ledger}"
task_temp_dir="$(mktemp -d)"

run_sql() {
  docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "$1"
}

cleanup() {
  run_sql "
    BEGIN;
    ALTER TABLE public.posting_events DISABLE TRIGGER posting_events_append_only;
    DELETE FROM public.posting_events WHERE client_entity_id='d4c20000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_events ENABLE TRIGGER posting_events_append_only;
    ALTER TABLE public.provider_object_bindings DISABLE TRIGGER provider_object_bindings_append_only;
    DELETE FROM public.provider_object_bindings WHERE client_entity_id='d4c20000-0000-0000-0000-000000000001';
    ALTER TABLE public.provider_object_bindings ENABLE TRIGGER provider_object_bindings_append_only;
    ALTER TABLE public.posting_attempts DISABLE TRIGGER posting_attempts_append_only;
    DELETE FROM public.posting_attempts WHERE client_entity_id='d4c20000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_attempts ENABLE TRIGGER posting_attempts_append_only;
    ALTER TABLE public.posting_operations DISABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.posting_operations WHERE id='d4c70000-0000-0000-0000-000000000001';
    DELETE FROM public.posting_operations WHERE id='d4c00000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_operations ENABLE TRIGGER posting_operations_no_delete;
    ALTER TABLE public.posting_human_authorizations DISABLE TRIGGER posting_human_authorizations_append_only;
    DELETE FROM public.posting_human_authorizations WHERE id='d4c80000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_human_authorizations ENABLE TRIGGER posting_human_authorizations_append_only;
    ALTER TABLE public.provider_tax_treatment_mappings DISABLE TRIGGER provider_tax_treatment_mapping_no_delete;
    DELETE FROM public.provider_tax_treatment_mappings WHERE id='d4c60000-0000-0000-0000-000000000001';
    ALTER TABLE public.provider_tax_treatment_mappings ENABLE TRIGGER provider_tax_treatment_mapping_no_delete;
    ALTER TABLE public.provider_posting_account_mappings DISABLE TRIGGER provider_posting_account_mapping_no_delete;
    DELETE FROM public.provider_posting_account_mappings WHERE id='d4c50000-0000-0000-0000-000000000001';
    ALTER TABLE public.provider_posting_account_mappings ENABLE TRIGGER provider_posting_account_mapping_no_delete;
    DELETE FROM public.financial_accounts WHERE id='d4c51000-0000-0000-0000-000000000001';
    DELETE FROM public.import_artifacts WHERE id='d4c90000-0000-0000-0000-000000000001';
    DELETE FROM public.provider_connections WHERE id='d4c40000-0000-0000-0000-000000000001';
    DELETE FROM public.ledger_books WHERE id='d4c30000-0000-0000-0000-000000000001';
    DELETE FROM public.client_entities WHERE id='d4c20000-0000-0000-0000-000000000001';
    DELETE FROM public.practice_memberships WHERE id='d4c11000-0000-0000-0000-000000000001';
    DELETE FROM public.practices WHERE id='d4c10000-0000-0000-0000-000000000001';
    DELETE FROM auth.users WHERE id='d4c00000-0000-0000-0000-000000000099';
    COMMIT;" >/dev/null
  rm -r -- "${task_temp_dir}"
}
trap cleanup EXIT

cleanup
mkdir -p -- "${task_temp_dir}"
trap cleanup EXIT

run_sql "
  INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
  VALUES ('d4c00000-0000-0000-0000-000000000099','day4-concurrency@example.test',
          'authenticated','authenticated',now(),now());
  INSERT INTO public.practices (id,name,created_by_user_id)
  VALUES ('d4c10000-0000-0000-0000-000000000001','Day 4 Concurrency',
          'd4c00000-0000-0000-0000-000000000099');
  INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
  VALUES ('d4c11000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'd4c00000-0000-0000-0000-000000000099','owner');
  INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency)
  VALUES ('d4c20000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'Day 4 Concurrency Ltd','Day 4 Concurrency','GBP');
  INSERT INTO public.ledger_books (id,client_entity_id,book_kind,display_name,functional_currency)
  VALUES ('d4c30000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'quickbooks','Day 4 Concurrency Realm','GBP');
  INSERT INTO public.provider_connections
    (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
  VALUES ('d4c40000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'quickbooks','fake-realm-day4-concurrency');
  INSERT INTO public.import_artifacts
    (id,client_entity_id,artifact_kind,content_sha256,content_length,storage_state)
  VALUES ('d4c90000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001','invoice_pdf',
          decode(repeat('f2',32),'hex'),10,'retained');
  INSERT INTO public.financial_accounts
    (id,client_entity_id,ledger_book_id,provider_connection_id,account_kind,display_name)
  VALUES ('d4c51000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'd4c40000-0000-0000-0000-000000000001','expense','Purchases');
  INSERT INTO public.provider_posting_account_mappings
    (id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
     financial_account_id,provider,external_organisation_id,provider_account_id,
     posting_role,provider_account_type,mapping_status,is_postable,verified_at,
     eligibility_expires_at)
  VALUES ('d4c50000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'd4c40000-0000-0000-0000-000000000001',
          'd4c51000-0000-0000-0000-000000000001','quickbooks',
          'fake-realm-day4-concurrency','qb-expense-concurrent','general_ledger',
          'Expense','active',true,now()-interval '1 minute',now()+interval '1 day');
  INSERT INTO public.provider_tax_treatment_mappings
    (id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
     provider,external_organisation_id,provider_tax_code,treatment_name,
     evidence_fingerprint,mapping_status,verified_at,eligibility_expires_at)
  VALUES ('d4c60000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'd4c40000-0000-0000-0000-000000000001','quickbooks',
          'fake-realm-day4-concurrency','20.0% S','Standard',decode(repeat('b2',32),'hex'),
          'active',now()-interval '1 minute',now()+interval '1 day');
  INSERT INTO public.posting_human_authorizations
    (id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
     provider,external_organisation_id,operation_kind,external_object_type,
     action,authorized_request_fingerprint,approved_by_user_id,expires_at)
  VALUES ('d4c80000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'd4c40000-0000-0000-0000-000000000001','quickbooks',
          'fake-realm-day4-concurrency','ACCOUNTS_PAYABLE_BILL','BILL','CREATE',
          decode(repeat('a4',32),'hex'),'d4c00000-0000-0000-0000-000000000099',
          now()+interval '1 day');
  INSERT INTO public.posting_operations
    (id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
     provider,external_organisation_id,parent_operation_id,operation_kind,
     external_object_type,action,idempotency_key,source_action_claim_fingerprint,
     authorized_request_fingerprint,intent_schema_version,canonicalization_version,
     validation_rule_set_version,requested_object,evidence_snapshot,
     account_treatment_snapshot,tax_treatment_snapshot,expected_material_state,
     current_state,human_authorization_id,permission_decision_id)
  VALUES
    ('d4c00000-0000-0000-0000-000000000001',
     'd4c10000-0000-0000-0000-000000000001','d4c20000-0000-0000-0000-000000000001',
     'd4c30000-0000-0000-0000-000000000001','d4c40000-0000-0000-0000-000000000001',
     'quickbooks','fake-realm-day4-concurrency',NULL,'ACCOUNTS_PAYABLE_BILL','BILL',
     'CREATE','day4-concurrent-bill',decode(repeat('c4',32),'hex'),decode(repeat('a4',32),'hex'),
     'step5.v1','step5.v1','step5-day4-v1',
     jsonb_build_object('amount','10.00','currency','GBP','description','Concurrent Bill',
       'vendorChild',jsonb_build_object('operationId','d4c70000-0000-0000-0000-000000000001',
         'idempotencyKey','day4-concurrent-vendor','authorizedRequestFingerprint',repeat('a5',32))),
     jsonb_build_array(jsonb_build_object('kind','IMPORT_ARTIFACT',
       'evidenceId','d4c90000-0000-0000-0000-000000000001',
       'fingerprint',repeat('f2',32))),
     '[{\"disposition\":\"MAPPED\",\"mappingId\":\"d4c50000-0000-0000-0000-000000000001\"}]',
     jsonb_build_array(jsonb_build_object('disposition','MAPPED',
       'treatmentId','d4c60000-0000-0000-0000-000000000001',
       'providerTaxCode','20.0% S','evidenceFingerprint',repeat('b2',32))),
     '{\"status\":\"OPEN\",\"amount\":\"10.00\",\"currency\":\"GBP\"}',
     'AUTHORIZED','d4c80000-0000-0000-0000-000000000001',gen_random_uuid()),
    ('d4c70000-0000-0000-0000-000000000001',
     'd4c10000-0000-0000-0000-000000000001','d4c20000-0000-0000-0000-000000000001',
     'd4c30000-0000-0000-0000-000000000001','d4c40000-0000-0000-0000-000000000001',
     'quickbooks','fake-realm-day4-concurrency','d4c00000-0000-0000-0000-000000000001',
     'ENSURE_VENDOR','VENDOR','CREATE','day4-concurrent-vendor',decode(repeat('c5',32),'hex'),
     decode(repeat('a5',32),'hex'),'step5.v1','step5.v1','step5-day4-v1',
     '{\"displayName\":\"Concurrent Vendor\"}','[]','[]','[]',
     '{\"displayName\":\"Concurrent Vendor\"}','SUCCEEDED',NULL,NULL);
  INSERT INTO public.provider_object_bindings
    (originating_operation_id,practice_id,client_entity_id,ledger_book_id,
     provider_connection_id,provider,external_organisation_id,external_object_type,
     external_object_id,binding_kind,verified_provider_state_fingerprint,verified_at)
  VALUES ('d4c70000-0000-0000-0000-000000000001',
          'd4c10000-0000-0000-0000-000000000001',
          'd4c20000-0000-0000-0000-000000000001',
          'd4c30000-0000-0000-0000-000000000001',
          'd4c40000-0000-0000-0000-000000000001','quickbooks',
          'fake-realm-day4-concurrency','VENDOR','qb-vendor-concurrent','CREATED',
          decode(repeat('d4',32),'hex'),now());" >/dev/null

prepare_sql="SELECT public.prepare_quickbooks_bill_submission_v1(
  'd4c00000-0000-0000-0000-000000000001',
  'd4c00000-0000-0000-0000-000000000099',
  'QuickBooksPostingAdapter','step5-day4-v1',120);"

pids=()
for index in $(seq 1 12); do
  run_sql "${prepare_sql}" >"${task_temp_dir}/${index}.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "${pid}"; done

dispatch_count="$(grep -h -o '"kind": "DISPATCH"' "${task_temp_dir}"/*.log | wc -l | tr -d ' ')"
recovery_count="$(grep -h -o '"kind": "RECOVERY_REQUIRED"' "${task_temp_dir}"/*.log | wc -l | tr -d ' ')"
submit_attempts="$(run_sql "SELECT count(*) FROM public.posting_attempts WHERE operation_id='d4c00000-0000-0000-0000-000000000001' AND attempt_kind='SUBMIT';")"
dispatch_events="$(run_sql "SELECT count(*) FROM public.posting_events WHERE operation_id='d4c00000-0000-0000-0000-000000000001' AND event_type='DISPATCH';")"
state="$(run_sql "SELECT current_state FROM public.posting_operations WHERE id='d4c00000-0000-0000-0000-000000000001';")"

[[ "${dispatch_count}" == "1" ]]
[[ "${recovery_count}" == "11" ]]
[[ "${submit_attempts}" == "1" ]]
[[ "${dispatch_events}" == "1" ]]
[[ "${state}" == "SUBMITTING" ]]

echo "016_QUICKBOOKS_EXECUTION_CONCURRENCY_OK dispatch=${dispatch_count} recovery=${recovery_count} submit_attempts=${submit_attempts} dispatch_events=${dispatch_events} state=${state}"
