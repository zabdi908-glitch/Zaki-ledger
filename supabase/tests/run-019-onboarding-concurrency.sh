#!/usr/bin/env bash
set -euo pipefail

container_name="${ZAKI_LOCAL_DB_CONTAINER:-supabase_db_Zaki-ledger}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
work_dir="$(mktemp -d)"

run_sql() { docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$1"; }

cleanup() {
  run_sql "BEGIN;
    ALTER TABLE public.provider_destination_onboarding_events DISABLE TRIGGER provider_destination_onboarding_events_append_only;
    DELETE FROM public.provider_destination_onboarding_events WHERE onboarding_operation_id IN (SELECT id FROM public.provider_destination_onboarding_operations WHERE client_entity_id='19010000-0000-0000-0000-000000000001');
    ALTER TABLE public.provider_destination_onboarding_events ENABLE TRIGGER provider_destination_onboarding_events_append_only;
    ALTER TABLE public.provider_destination_onboarding_operations DISABLE TRIGGER provider_destination_onboarding_operations_append_only;
    DELETE FROM public.provider_destination_onboarding_operations WHERE client_entity_id='19010000-0000-0000-0000-000000000001';
    ALTER TABLE public.provider_destination_onboarding_operations ENABLE TRIGGER provider_destination_onboarding_operations_append_only;
    ALTER TABLE public.provider_posting_account_mappings DISABLE TRIGGER provider_posting_account_mapping_no_delete;
    DELETE FROM public.provider_posting_account_mappings WHERE client_entity_id='19010000-0000-0000-0000-000000000001';
    ALTER TABLE public.provider_posting_account_mappings ENABLE TRIGGER provider_posting_account_mapping_no_delete;
    DELETE FROM public.financial_accounts WHERE id='19040000-0000-0000-0000-000000000001';
    DELETE FROM public.provider_connections WHERE client_entity_id='19010000-0000-0000-0000-000000000001';
    DELETE FROM public.oauth_connections WHERE user_id='19000000-0000-0000-0000-000000000001' AND provider='quickbooks';
    DELETE FROM public.ledger_books WHERE id='19020000-0000-0000-0000-000000000001';
    DELETE FROM public.client_entities WHERE id='19010000-0000-0000-0000-000000000001';
    DELETE FROM public.practice_memberships WHERE id='19001000-0000-0000-0000-000000000001';
    DELETE FROM public.practices WHERE id='19000100-0000-0000-0000-000000000001';
    DELETE FROM auth.users WHERE id='19000000-0000-0000-0000-000000000001'; COMMIT;" >/dev/null
  rm -rf "${work_dir}"
}
trap cleanup EXIT
cleanup
mkdir -p "${work_dir}"

# Apply precisely the replacement RPC from migration 020 to the local DB.
sed -n '/^CREATE OR REPLACE FUNCTION public.complete_quickbooks_destination_onboarding_v1(/,/^END; \$\$;/p' "${repo_root}/supabase/migrations/020_provider_independent_financial_account_mappings.sql" | docker exec -i "${container_name}" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres >/dev/null

run_sql "
  INSERT INTO auth.users(id,email,role,aud,created_at,updated_at) VALUES ('19000000-0000-0000-0000-000000000001','onboarding-race@example.test','authenticated','authenticated',now(),now());
  INSERT INTO public.practices(id,name,created_by_user_id) VALUES ('19000100-0000-0000-0000-000000000001','Onboarding race','19000000-0000-0000-0000-000000000001');
  INSERT INTO public.practice_memberships(id,practice_id,user_id,role) VALUES ('19001000-0000-0000-0000-000000000001','19000100-0000-0000-0000-000000000001','19000000-0000-0000-0000-000000000001','owner');
  INSERT INTO public.client_entities(id,practice_id,legal_name,display_name,base_currency) VALUES ('19010000-0000-0000-0000-000000000001','19000100-0000-0000-0000-000000000001','Onboarding race Ltd','Onboarding race','GBP');
  INSERT INTO public.ledger_books(id,client_entity_id,book_kind,display_name,functional_currency) VALUES ('19020000-0000-0000-0000-000000000001','19010000-0000-0000-0000-000000000001','quickbooks','Onboarding race book','GBP');
  INSERT INTO public.oauth_connections(user_id,provider,access_token,refresh_token,expires_at,org_id) VALUES ('19000000-0000-0000-0000-000000000001','quickbooks','local','local',now()+interval '1 day','realm-019-race');
  INSERT INTO public.financial_accounts(id,client_entity_id,ledger_book_id,account_kind,display_name,status) VALUES ('19040000-0000-0000-0000-000000000001','19010000-0000-0000-0000-000000000001','19020000-0000-0000-0000-000000000001','expense','Unbound race account','active');" >/dev/null

call_sql="SELECT public.complete_quickbooks_destination_onboarding_v1('19000100-0000-0000-0000-000000000001','19010000-0000-0000-0000-000000000001','19020000-0000-0000-0000-000000000001','19000000-0000-0000-0000-000000000001','realm-019-race','same-race-key',repeat('a',64),repeat('b',64),jsonb_build_array(jsonb_build_object('financialAccountId','19040000-0000-0000-0000-000000000001','providerAccountId','6000','providerAccountType','Expense','eligibilityExpiresAt','2030-01-01T00:00:00Z')),'[]');"
for i in 1 2; do docker exec "${container_name}" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "${call_sql}" >"${work_dir}/${i}" & done
wait

created="$(grep -h -c CREATED "${work_dir}"/* | awk '{s+=$1} END {print s}')"
resumed="$(grep -h -c RESUMED "${work_dir}"/* | awk '{s+=$1} END {print s}')"
[[ "${created}" == 1 && "${resumed}" == 1 ]]
[[ "$(run_sql "SELECT count(*) FROM public.provider_destination_onboarding_operations WHERE idempotency_key='same-race-key';")" == 1 ]]
[[ "$(run_sql "SELECT count(*) FROM public.provider_connections WHERE external_organisation_id='realm-019-race';")" == 1 ]]
[[ "$(run_sql "SELECT count(*) FROM public.provider_posting_account_mappings WHERE financial_account_id='19040000-0000-0000-0000-000000000001';")" == 1 ]]
[[ "$(run_sql "SELECT count(*) FROM public.provider_destination_onboarding_events e JOIN public.provider_destination_onboarding_operations o ON o.id=e.onboarding_operation_id WHERE o.idempotency_key='same-race-key';")" == 4 ]]
[[ "$(run_sql "SELECT provider_connection_id IS NULL FROM public.financial_accounts WHERE id='19040000-0000-0000-0000-000000000001';")" == t ]]

echo "019_ONBOARDING_CONCURRENCY_OK created=${created} resumed=${resumed} operations=1 connections=1 mappings=1 events=4"
