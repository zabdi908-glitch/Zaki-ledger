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
    DELETE FROM public.posting_events
      WHERE client_entity_id='15c30000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_events ENABLE TRIGGER posting_events_append_only;
    ALTER TABLE public.posting_operations DISABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.posting_operations
      WHERE client_entity_id='15c30000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_operations ENABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.provider_connections WHERE id='15c50000-0000-0000-0000-000000000001';
    DELETE FROM public.ledger_books WHERE id='15c40000-0000-0000-0000-000000000001';
    DELETE FROM public.client_entities WHERE id='15c30000-0000-0000-0000-000000000001';
    DELETE FROM public.practice_memberships WHERE id='15c20000-0000-0000-0000-000000000001';
    DELETE FROM public.practices WHERE id='15c10000-0000-0000-0000-000000000001';
    DELETE FROM auth.users WHERE id='15c00000-0000-0000-0000-000000000001';
    COMMIT;" >/dev/null
  rm -r -- "${task_temp_dir}"
}
trap cleanup EXIT

cleanup_initial() {
  run_sql "
    BEGIN;
    ALTER TABLE public.posting_events DISABLE TRIGGER posting_events_append_only;
    DELETE FROM public.posting_events
      WHERE client_entity_id='15c30000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_events ENABLE TRIGGER posting_events_append_only;
    ALTER TABLE public.posting_operations DISABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.posting_operations
      WHERE client_entity_id='15c30000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_operations ENABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.provider_connections WHERE id='15c50000-0000-0000-0000-000000000001';
    DELETE FROM public.ledger_books WHERE id='15c40000-0000-0000-0000-000000000001';
    DELETE FROM public.client_entities WHERE id='15c30000-0000-0000-0000-000000000001';
    DELETE FROM public.practice_memberships WHERE id='15c20000-0000-0000-0000-000000000001';
    DELETE FROM public.practices WHERE id='15c10000-0000-0000-0000-000000000001';
    DELETE FROM auth.users WHERE id='15c00000-0000-0000-0000-000000000001';
    COMMIT;" >/dev/null
}

cleanup_initial
run_sql "
  INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
  VALUES ('15c00000-0000-0000-0000-000000000001','posting-service-concurrency@example.test',
          'authenticated','authenticated',now(),now());
  INSERT INTO public.practices (id,name,created_by_user_id)
  VALUES ('15c10000-0000-0000-0000-000000000001','Posting Service Concurrency',
          '15c00000-0000-0000-0000-000000000001');
  INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
  VALUES ('15c20000-0000-0000-0000-000000000001',
          '15c10000-0000-0000-0000-000000000001',
          '15c00000-0000-0000-0000-000000000001','owner');
  INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency)
  VALUES ('15c30000-0000-0000-0000-000000000001',
          '15c10000-0000-0000-0000-000000000001',
          'Posting Service Concurrency Ltd','Posting Service Concurrency','GBP');
  INSERT INTO public.ledger_books (id,client_entity_id,book_kind,display_name,functional_currency)
  VALUES ('15c40000-0000-0000-0000-000000000001',
          '15c30000-0000-0000-0000-000000000001',
          'quickbooks','Posting Service Concurrency Realm','GBP');
  INSERT INTO public.provider_connections
    (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
  VALUES ('15c50000-0000-0000-0000-000000000001',
          '15c30000-0000-0000-0000-000000000001',
          '15c40000-0000-0000-0000-000000000001',
          'quickbooks','service-concurrency-realm');" >/dev/null

claim_sql="SELECT public.claim_posting_operation_v1(
  '15c10000-0000-0000-0000-000000000001',
  '15c30000-0000-0000-0000-000000000001',
  '15c40000-0000-0000-0000-000000000001',
  '15c50000-0000-0000-0000-000000000001',
  'quickbooks','service-concurrency-realm',NULL,'ENSURE_VENDOR','VENDOR','CREATE',
  'same-concurrent-key',repeat('91',32),repeat('92',32),'1','1','step5-day3-v1',
  '{\"displayName\":\"Concurrent Supplier\"}'::jsonb,
  '[]'::jsonb,
  '[{\"disposition\":\"NOT_APPLICABLE\",\"reason\":\"Vendor\"}]'::jsonb,
  '[{\"disposition\":\"NOT_APPLICABLE\",\"reason\":\"Vendor\"}]'::jsonb,
  '{\"displayName\":\"Concurrent Supplier\"}'::jsonb,
  '15c00000-0000-0000-0000-000000000001');"

pids=()
for index in $(seq 1 12); do
  run_sql "${claim_sql}" >"${task_temp_dir}/${index}.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "${pid}"
done

created_count="$(grep -h -o '"outcome": "CREATED"' "${task_temp_dir}"/*.log | wc -l | tr -d ' ')"
resumed_count="$(grep -h -o '"outcome": "RESUMED"' "${task_temp_dir}"/*.log | wc -l | tr -d ' ')"
operation_count="$(run_sql "SELECT count(*) FROM public.posting_operations WHERE client_entity_id='15c30000-0000-0000-0000-000000000001';")"
claim_event_count="$(run_sql "SELECT count(*) FROM public.posting_events WHERE client_entity_id='15c30000-0000-0000-0000-000000000001' AND reason_code='OPERATION_CLAIMED';")"

[[ "${created_count}" == "1" ]]
[[ "${resumed_count}" == "11" ]]
[[ "${operation_count}" == "1" ]]
[[ "${claim_event_count}" == "1" ]]

echo "015_POSTING_SERVICE_CONCURRENCY_OK created=${created_count} resumed=${resumed_count} operations=${operation_count} claim_events=${claim_event_count}"
