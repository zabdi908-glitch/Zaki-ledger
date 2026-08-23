#!/usr/bin/env bash
set -euo pipefail

container_name="${ZAKI_LOCAL_DB_CONTAINER:-supabase_db_Zaki-ledger}"

run_sql() {
  docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "$1"
}

cleanup() {
  run_sql "
    BEGIN;
    ALTER TABLE public.posting_operations DISABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.posting_operations
      WHERE client_entity_id = '14c30000-0000-0000-0000-000000000001';
    ALTER TABLE public.posting_operations ENABLE TRIGGER posting_operations_no_delete;
    DELETE FROM public.provider_connections
      WHERE id = '14c50000-0000-0000-0000-000000000001';
    DELETE FROM public.ledger_books
      WHERE id = '14c40000-0000-0000-0000-000000000001';
    DELETE FROM public.client_entities
      WHERE id = '14c30000-0000-0000-0000-000000000001';
    DELETE FROM public.practice_memberships
      WHERE id = '14c20000-0000-0000-0000-000000000001';
    DELETE FROM public.practices
      WHERE id = '14c10000-0000-0000-0000-000000000001';
    DELETE FROM auth.users
      WHERE id = '14c00000-0000-0000-0000-000000000001';
    COMMIT;" >/dev/null
}

trap cleanup EXIT
cleanup

run_sql "
  INSERT INTO auth.users (id,email,role,aud,created_at,updated_at)
  VALUES ('14c00000-0000-0000-0000-000000000001',
          'posting-concurrency@example.test','authenticated','authenticated',now(),now());
  INSERT INTO public.practices (id,name,created_by_user_id)
  VALUES ('14c10000-0000-0000-0000-000000000001','Posting Concurrency',
          '14c00000-0000-0000-0000-000000000001');
  INSERT INTO public.practice_memberships (id,practice_id,user_id,role)
  VALUES ('14c20000-0000-0000-0000-000000000001',
          '14c10000-0000-0000-0000-000000000001',
          '14c00000-0000-0000-0000-000000000001','owner');
  INSERT INTO public.client_entities
    (id,practice_id,legal_name,display_name,base_currency)
  VALUES ('14c30000-0000-0000-0000-000000000001',
          '14c10000-0000-0000-0000-000000000001',
          'Posting Concurrency Ltd','Posting Concurrency','GBP');
  INSERT INTO public.ledger_books
    (id,client_entity_id,book_kind,display_name,functional_currency)
  VALUES ('14c40000-0000-0000-0000-000000000001',
          '14c30000-0000-0000-0000-000000000001',
          'quickbooks','Concurrency Realm','GBP');
  INSERT INTO public.provider_connections
    (id,client_entity_id,ledger_book_id,provider,external_organisation_id)
  VALUES ('14c50000-0000-0000-0000-000000000001',
          '14c30000-0000-0000-0000-000000000001',
          '14c40000-0000-0000-0000-000000000001',
          'quickbooks','concurrency-realm');" >/dev/null

operation_sql() {
  local idempotency_key="$1"
  local source_byte="$2"
  local request_byte="$3"
  local hold_seconds="$4"
  printf '%s' "
    BEGIN;
    INSERT INTO public.posting_operations
      (practice_id,client_entity_id,ledger_book_id,provider_connection_id,
       provider,external_organisation_id,operation_kind,external_object_type,
       action,idempotency_key,source_action_claim_fingerprint,
       authorized_request_fingerprint,intent_schema_version,
       canonicalization_version,validation_rule_set_version,
       requested_object,expected_material_state)
    VALUES
      ('14c10000-0000-0000-0000-000000000001',
       '14c30000-0000-0000-0000-000000000001',
       '14c40000-0000-0000-0000-000000000001',
       '14c50000-0000-0000-0000-000000000001',
       'quickbooks','concurrency-realm','POST_OBJECT','BILL','CREATE',
       '${idempotency_key}',decode(repeat('${source_byte}',32),'hex'),
       decode(repeat('${request_byte}',32),'hex'),'1','1','step5-day3-v1',
       jsonb_build_object('request_byte','${request_byte}'),'{}'::jsonb);
    SELECT pg_sleep(${hold_seconds});
    COMMIT;"
}

run_race() {
  local sql_a="$1"
  local sql_b="$2"
  local log_a log_b
  log_a="$(mktemp)"
  log_b="$(mktemp)"

  set +e
  run_sql "${sql_a}" >"${log_a}" 2>&1 &
  local pid_a=$!
  run_sql "${sql_b}" >"${log_b}" 2>&1 &
  local pid_b=$!
  wait "${pid_a}"
  local status_a=$?
  wait "${pid_b}"
  local status_b=$?
  set -e

  if [[ $((status_a == 0 ? 1 : 0)) -ne $((status_b == 0 ? 0 : 1)) ]]; then
    printf 'race did not produce exactly one winner\nA(%s): %s\nB(%s): %s\n' \
      "${status_a}" "$(<"${log_a}")" "${status_b}" "$(<"${log_b}")" >&2
    rm -f "${log_a}" "${log_b}"
    return 1
  fi

  if ! { grep -qi 'duplicate key' "${log_a}" || grep -qi 'duplicate key' "${log_b}"; }; then
    printf 'losing race was not rejected by uniqueness\nA: %s\nB: %s\n' \
      "$(<"${log_a}")" "$(<"${log_b}")" >&2
    rm -f "${log_a}" "${log_b}"
    return 1
  fi

  rm -f "${log_a}" "${log_b}"
}

# Same namespace/key, different source and semantic intent: one row wins.
run_race \
  "$(operation_sql 'concurrent-idempotency' '51' '61' '1')" \
  "$(operation_sql 'concurrent-idempotency' '52' '62' '0')"

idempotency_count="$(run_sql "
  SELECT count(*) FROM public.posting_operations
  WHERE client_entity_id='14c30000-0000-0000-0000-000000000001'
    AND idempotency_key='concurrent-idempotency';")"
[[ "${idempotency_count}" == "1" ]]

# Different caller keys, same source/action business effect: one row wins.
run_race \
  "$(operation_sql 'concurrent-source-a' '71' '81' '1')" \
  "$(operation_sql 'concurrent-source-b' '71' '82' '0')"

source_claim_count="$(run_sql "
  SELECT count(*) FROM public.posting_operations
  WHERE client_entity_id='14c30000-0000-0000-0000-000000000001'
    AND source_action_claim_fingerprint=decode(repeat('71',32),'hex');")"
[[ "${source_claim_count}" == "1" ]]

echo "014_POSTING_CONCURRENCY_OK idempotency_rows=${idempotency_count} source_claim_rows=${source_claim_count}"
