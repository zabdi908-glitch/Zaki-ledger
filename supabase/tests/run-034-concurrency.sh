#!/usr/bin/env bash
set -euo pipefail

container_name="${ZAKI_LOCAL_DB_CONTAINER:-supabase_db_Zaki-ledger}"
source_database="postgres"
race_database="zaki_step9_race_validation"
task_temp_dir="$(mktemp -d)"
created_database=0

if [[ ! "${race_database}" =~ ^zaki_step9_race_validation$ ]]; then
  echo "unsafe disposable database name" >&2
  exit 1
fi

source_sql() {
  docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d "${source_database}" -Atc "$1"
}

race_sql() {
  docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d "${race_database}" -Atc "$1"
}

cleanup() {
  if [[ "${created_database}" == "1" ]]; then
    docker exec "${container_name}" psql -X -U postgres -d "${source_database}" -Atc \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${race_database}' AND pid <> pg_backend_pid();" >/dev/null || true
    docker exec "${container_name}" dropdb -U postgres --if-exists "${race_database}" >/dev/null || true
  fi
  rm -r -- "${task_temp_dir}"
}
trap cleanup EXIT

[[ "$(source_sql "SELECT count(*) FROM pg_database WHERE datname='${race_database}';")" == "0" ]]
docker exec "${container_name}" createdb -U postgres "${race_database}"
created_database=1

docker exec "${container_name}" pg_dump -U postgres -d "${source_database}" \
  --schema-only --no-owner --no-privileges \
  | docker exec -i "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d "${race_database}" >/dev/null
docker exec -i "${container_name}" psql -X -v ON_ERROR_STOP=1 -U postgres -d "${race_database}" \
  < supabase/migrations/034_step9_shadow_orchestration.sql >/dev/null

race_sql "
  INSERT INTO public.currency_definitions (code,default_minor_unit,status)
    VALUES ('GBP',2,'active');
  INSERT INTO auth.users (id,email,role,aud,created_at,updated_at) VALUES
    ('34000000-0000-4000-8000-000000000001','step9-race@example.test','authenticated','authenticated',now(),now());
  INSERT INTO public.practices (id,name,created_by_user_id) VALUES
    ('34000000-0000-4000-8000-000000000101','Step 9 Race A','34000000-0000-4000-8000-000000000001'),
    ('34000000-0000-4000-8000-000000000102','Step 9 Race B','34000000-0000-4000-8000-000000000001');
  INSERT INTO public.client_entities (id,practice_id,legal_name,display_name,base_currency) VALUES
    ('34000000-0000-4000-8000-000000000201','34000000-0000-4000-8000-000000000101','Race Client A','Race Client A','GBP'),
    ('34000000-0000-4000-8000-000000000202','34000000-0000-4000-8000-000000000102','Race Client B','Race Client B','GBP');
  INSERT INTO public.ledger_books (id,client_entity_id,book_kind,display_name,functional_currency) VALUES
    ('34000000-0000-4000-8000-000000000301','34000000-0000-4000-8000-000000000201','quickbooks','Race Book A','GBP'),
    ('34000000-0000-4000-8000-000000000302','34000000-0000-4000-8000-000000000202','xero','Race Book B','GBP');" >/dev/null

claim_run_sql="SELECT public.claim_shadow_orchestration_run_v1(
  '34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000301','race:identical','2026-09-07T02:00:00Z',
  'race-correlation',repeat('11',32),repeat('12',32),'SHADOW',false);"

pids=()
for index in $(seq 1 12); do
  race_sql "${claim_run_sql}" >"${task_temp_dir}/run-${index}.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "${pid}"; done

[[ "$(race_sql "SELECT count(*) FROM public.shadow_orchestration_runs WHERE run_key=decode(repeat('11',32),'hex');")" == "1" ]]
[[ "$(rg -o '"reused": false' "${task_temp_dir}"/run-*.log | wc -l | tr -d ' ')" == "1" ]]
[[ "$(rg -o '"reused": true' "${task_temp_dir}"/run-*.log | wc -l | tr -d ' ')" == "11" ]]
run_id="$(race_sql "SELECT id FROM public.shadow_orchestration_runs WHERE run_key=decode(repeat('11',32),'hex');")"

if race_sql "SELECT public.claim_shadow_orchestration_run_v1(
  '34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000301','race:identical','2026-09-07T02:00:00Z',
  'race-correlation',repeat('11',32),repeat('13',32),'SHADOW',false);" >/dev/null 2>&1; then
  echo "conflicting run content was accepted" >&2
  exit 1
fi

claim_stage_sql="SELECT public.claim_shadow_stage_v1(
  '${run_id}','INGESTION',repeat('21',32),'worker-a',120);"
pids=()
for index in $(seq 1 12); do
  (race_sql "${claim_stage_sql}" >"${task_temp_dir}/stage-${index}.log" 2>&1) &
  pids+=("$!")
done
stage_success=0
stage_failure=0
for pid in "${pids[@]}"; do
  if wait "${pid}"; then stage_success=$((stage_success + 1)); else stage_failure=$((stage_failure + 1)); fi
done
if [[ "${stage_success}" != "1" || "${stage_failure}" != "11" ]]; then
  echo "unexpected concurrent stage claim outcomes: success=${stage_success} failure=${stage_failure}" >&2
  sed -n '1,8p' "${task_temp_dir}"/stage-*.log >&2
fi
[[ "${stage_success}" == "1" ]]
[[ "${stage_failure}" == "11" ]]
[[ "$(race_sql "SELECT count(*) FROM public.shadow_orchestration_stage_attempts WHERE run_id='${run_id}';")" == "1" ]]
[[ "$(race_sql "SELECT count(DISTINCT owner_id) FROM public.shadow_orchestration_leases WHERE client_entity_id='34000000-0000-4000-8000-000000000201' AND stage='INGESTION' AND lease_expires_at > clock_timestamp();")" == "1" ]]

stage_id="$(race_sql "SELECT id FROM public.shadow_orchestration_stages WHERE run_id='${run_id}' AND stage='INGESTION';")"
first_attempt_id="$(race_sql "SELECT id FROM public.shadow_orchestration_stage_attempts WHERE stage_id='${stage_id}' AND attempt_number=1;")"
first_fence="$(race_sql "SELECT fencing_token FROM public.shadow_orchestration_stage_attempts WHERE id='${first_attempt_id}';")"
resource_key="$(race_sql "SELECT encode(resource_key,'hex') FROM public.shadow_orchestration_leases WHERE client_entity_id='34000000-0000-4000-8000-000000000201' AND stage='INGESTION';")"
race_sql "UPDATE public.shadow_orchestration_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE resource_key=decode('${resource_key}','hex');" >/dev/null

takeover="$(race_sql "SELECT public.claim_shadow_stage_v1('${run_id}','INGESTION',repeat('21',32),'worker-b',120);")"
second_attempt_id="$(race_sql "SELECT id FROM public.shadow_orchestration_stage_attempts WHERE stage_id='${stage_id}' AND attempt_number=2;")"
second_fence="$(race_sql "SELECT fencing_token FROM public.shadow_orchestration_stage_attempts WHERE id='${second_attempt_id}';")"
[[ "${second_fence}" -gt "${first_fence}" ]]
[[ "$(race_sql "SELECT owner_id FROM public.shadow_orchestration_leases WHERE resource_key=decode('${resource_key}','hex');")" == "worker-b" ]]

if race_sql "SELECT public.renew_shadow_stage_lease_v1('${resource_key}','worker-a',${first_fence},120);" >/dev/null 2>&1; then
  echo "stale heartbeat was accepted" >&2
  exit 1
fi
if race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${run_id}','${stage_id}','${first_attempt_id}','worker-a',${first_fence},'SUCCEEDED',
  repeat('21',32),repeat('22',32),'{\"ok\":true}','[]',NULL);" >/dev/null 2>&1; then
  echo "stale worker finalized after takeover" >&2
  exit 1
fi

first_finalize="$(race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${run_id}','${stage_id}','${second_attempt_id}','worker-b',${second_fence},'SUCCEEDED',
  repeat('21',32),repeat('22',32),'{\"ok\":true}','[]',NULL);")"
second_finalize="$(race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${run_id}','${stage_id}','${second_attempt_id}','worker-b',${second_fence},'SUCCEEDED',
  repeat('21',32),repeat('22',32),'{\"ok\":true}','[]',NULL);")"
[[ "${first_finalize}" == *'"reused": false'* ]]
[[ "${second_finalize}" == *'"reused": true'* ]]

if race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${run_id}','${stage_id}','${second_attempt_id}','worker-b',${second_fence},'SUCCEEDED',
  repeat('21',32),repeat('23',32),'{\"ok\":false}','[]',NULL);" >/dev/null 2>&1; then
  echo "conflicting stage output was accepted" >&2
  exit 1
fi

race_sql "UPDATE public.shadow_orchestration_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE resource_key=decode('${resource_key}','hex');" >/dev/null
if race_sql "SELECT public.claim_shadow_stage_v1('${run_id}','INGESTION',repeat('21',32),'worker-c',120);" \
  >"${task_temp_dir}/terminal-reopen.log" 2>&1; then
  echo "terminal stage reopened" >&2
  exit 1
fi
rg -q 'TERMINAL_SHADOW_STAGE_CANNOT_REOPEN' "${task_temp_dir}/terminal-reopen.log"

if race_sql "UPDATE public.shadow_orchestration_stages SET state='RUNNING',terminal_at=NULL WHERE id='${stage_id}';" \
  >"${task_temp_dir}/illegal-transition.log" 2>&1; then
  echo "illegal transition was accepted" >&2
  exit 1
fi
rg -q 'ILLEGAL_SHADOW_TRANSITION' "${task_temp_dir}/illegal-transition.log"

publish_exception_sql="SELECT public.record_shadow_exception_v1(
  '${run_id}','34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000301','INGESTION',repeat('31',32),'artifact','artifact-1',
  'RACE_EXCEPTION',repeat('32',32),'{\"reasonCode\":\"RACE_EXCEPTION\"}',repeat('33',32),'race-correlation');"
pids=()
for index in $(seq 1 12); do
  race_sql "${publish_exception_sql}" >"${task_temp_dir}/exception-${index}.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "${pid}"; done
[[ "$(race_sql "SELECT count(*) FROM public.shadow_orchestration_exceptions WHERE exception_key=decode(repeat('31',32),'hex');")" == "1" ]]
[[ "$(race_sql "SELECT count(DISTINCT id) FROM public.shadow_orchestration_exceptions WHERE exception_key=decode(repeat('31',32),'hex');")" == "1" ]]

if race_sql "SELECT public.record_shadow_exception_v1(
  '${run_id}','34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000301','INGESTION',repeat('31',32),'artifact','artifact-1',
  'RACE_EXCEPTION',repeat('32',32),'{\"reasonCode\":\"CHANGED\"}',repeat('34',32),'race-correlation');" >/dev/null 2>&1; then
  echo "conflicting exception content was accepted" >&2
  exit 1
fi

if race_sql "SELECT public.claim_shadow_orchestration_run_v1(
  '34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000302','race:cross-book','2026-09-07T02:10:00Z',
  'race-cross',repeat('41',32),repeat('42',32),'SHADOW',false);" >/dev/null 2>&1; then
  echo "cross-client/book run write was accepted" >&2
  exit 1
fi
if race_sql "SELECT public.record_shadow_exception_v1(
  '${run_id}','34000000-0000-4000-8000-000000000102','34000000-0000-4000-8000-000000000202',
  '34000000-0000-4000-8000-000000000302','INGESTION',repeat('43',32),'artifact','cross-client',
  'CROSS_SCOPE',repeat('44',32),'{\"reasonCode\":\"CROSS_SCOPE\"}',repeat('45',32),'race-cross');" >/dev/null 2>&1; then
  echo "cross-client exception write was accepted" >&2
  exit 1
fi

race_sql "BEGIN;
  SELECT public.claim_shadow_orchestration_run_v1(
    '34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
    '34000000-0000-4000-8000-000000000301','race:rollback','2026-09-07T02:20:00Z',
    'race-rollback',repeat('51',32),repeat('52',32),'SHADOW',false);
  ROLLBACK;" >/dev/null
[[ "$(race_sql "SELECT count(*) FROM public.shadow_orchestration_runs WHERE run_key=decode(repeat('51',32),'hex');")" == "0" ]]

rollup_run="$(race_sql "SELECT public.claim_shadow_orchestration_run_v1(
  '34000000-0000-4000-8000-000000000101','34000000-0000-4000-8000-000000000201',
  '34000000-0000-4000-8000-000000000301','race:rollup','2026-09-07T02:30:00Z',
  'race-rollup',repeat('61',32),repeat('62',32),'SHADOW',false)->>'run_id';")"
ingestion_claim="$(race_sql "SELECT public.claim_shadow_stage_v1('${rollup_run}','INGESTION',repeat('63',32),'rollup-ingestion',120);")"
ingestion_stage="$(race_sql "SELECT id FROM public.shadow_orchestration_stages WHERE run_id='${rollup_run}' AND stage='INGESTION';")"
ingestion_attempt="$(race_sql "SELECT id FROM public.shadow_orchestration_stage_attempts WHERE stage_id='${ingestion_stage}';")"
ingestion_fence="$(race_sql "SELECT fencing_token FROM public.shadow_orchestration_stage_attempts WHERE id='${ingestion_attempt}';")"
race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${rollup_run}','${ingestion_stage}','${ingestion_attempt}','rollup-ingestion',${ingestion_fence},'SUCCEEDED',
  repeat('63',32),repeat('64',32),'{\"ok\":true}','[]',NULL);" >/dev/null

race_sql "SELECT public.claim_shadow_stage_v1('${rollup_run}','EXTRACTION',repeat('65',32),'rollup-extraction',120);" >/dev/null
race_sql "SELECT public.claim_shadow_stage_v1('${rollup_run}','EXCEPTION_OUTPUT',repeat('66',32),'rollup-exception',120);" >/dev/null
extraction_stage="$(race_sql "SELECT id FROM public.shadow_orchestration_stages WHERE run_id='${rollup_run}' AND stage='EXTRACTION';")"
extraction_attempt="$(race_sql "SELECT id FROM public.shadow_orchestration_stage_attempts WHERE stage_id='${extraction_stage}';")"
extraction_fence="$(race_sql "SELECT fencing_token FROM public.shadow_orchestration_stage_attempts WHERE id='${extraction_attempt}';")"
exception_stage="$(race_sql "SELECT id FROM public.shadow_orchestration_stages WHERE run_id='${rollup_run}' AND stage='EXCEPTION_OUTPUT';")"
exception_attempt="$(race_sql "SELECT id FROM public.shadow_orchestration_stage_attempts WHERE stage_id='${exception_stage}';")"
exception_fence="$(race_sql "SELECT fencing_token FROM public.shadow_orchestration_stage_attempts WHERE id='${exception_attempt}';")"

(race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${rollup_run}','${exception_stage}','${exception_attempt}','rollup-exception',${exception_fence},'SUCCEEDED',
  repeat('66',32),repeat('67',32),'{\"published\":true}','[]',NULL);" \
  >"${task_temp_dir}/rollup-exception.log" 2>&1) &
exception_pid=$!
(race_sql "SELECT pg_sleep(0.2); SELECT public.finalize_shadow_stage_attempt_v1(
  '${rollup_run}','${extraction_stage}','${extraction_attempt}','rollup-extraction',${extraction_fence},'UNCERTAIN',
  repeat('65',32),repeat('68',32),'{\"uncertain\":true}','[]','RACE_UNCERTAIN');" \
  >"${task_temp_dir}/rollup-extraction.log" 2>&1) &
extraction_pid=$!

exception_status=0
wait "${exception_pid}" || exception_status=$?
wait "${extraction_pid}"
if [[ "${exception_status}" == "0" ]]; then
  echo "exception output finalized while another stage was active" >&2
  exit 1
fi
rg -q 'SHADOW_RUN_HAS_ACTIVE_STAGE' "${task_temp_dir}/rollup-exception.log"
race_sql "SELECT public.finalize_shadow_stage_attempt_v1(
  '${rollup_run}','${exception_stage}','${exception_attempt}','rollup-exception',${exception_fence},'UNCERTAIN',
  repeat('66',32),repeat('67',32),'{\"published\":true}','[]','RACE_UNCERTAIN');" >/dev/null
[[ "$(race_sql "SELECT state FROM public.shadow_orchestration_runs WHERE id='${rollup_run}';")" == "UNCERTAIN" ]]

[[ "$(race_sql "SELECT public.step9_shadow_run_rollup_v1(ARRAY['SUCCEEDED','FAILED_SAFE']);")" == "FAILED_SAFE" ]]
[[ "$(race_sql "SELECT public.step9_shadow_run_rollup_v1(ARRAY['FAILED_SAFE','RETRYABLE']);")" == "RETRYABLE" ]]
[[ "$(race_sql "SELECT public.step9_shadow_run_rollup_v1(ARRAY['RETRYABLE','REVIEW_REQUIRED']);")" == "REVIEW_REQUIRED" ]]
[[ "$(race_sql "SELECT public.step9_shadow_run_rollup_v1(ARRAY['REVIEW_REQUIRED','BLOCKED']);")" == "BLOCKED" ]]
[[ "$(race_sql "SELECT public.step9_shadow_run_rollup_v1(ARRAY['BLOCKED','UNCERTAIN']);")" == "UNCERTAIN" ]]

echo "034_STEP9_POSTGRES_RACE_OK runs=12 stage_claims=12 exceptions=12 rollback=clean rollup=UNCERTAIN"
