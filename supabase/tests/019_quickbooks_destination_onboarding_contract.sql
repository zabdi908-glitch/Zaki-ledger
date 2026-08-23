BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.assert_true(v boolean, m text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF NOT v THEN RAISE EXCEPTION '%',m; END IF; END $$;
DO $$
DECLARE p uuid := 'ef481ade-eec4-4db0-b08f-304c9f845024'; c uuid := '5cdc1964-e39b-4269-9628-1efcd58a7ca1'; b uuid := '5eea194a-9f76-422a-8703-8c599f0d8e33'; u uuid := '343ea659-28cc-4248-a901-3d0dc81ad086'; r jsonb; op uuid; conn uuid := '19000000-0000-0000-0000-000000000101'; a uuid := '19000000-0000-0000-0000-000000000102';
BEGIN
  INSERT INTO public.oauth_connections(user_id,provider,access_token,refresh_token,expires_at,org_id) VALUES(u,'quickbooks','local','local',now()+interval '1 day','realm-019') ON CONFLICT (user_id,provider) DO UPDATE SET expires_at=excluded.expires_at,org_id=excluded.org_id;
  INSERT INTO public.provider_connections(id,client_entity_id,ledger_book_id,provider,external_organisation_id,status,provider_metadata) VALUES(conn,c,b,'quickbooks','realm-019','active','{}');
  INSERT INTO public.financial_accounts(id,client_entity_id,ledger_book_id,provider_connection_id,account_kind,status) VALUES(a,c,b,conn,'expense','active');
  r:=public.complete_quickbooks_destination_onboarding_v1(p,c,b,gen_random_uuid(),'realm-019','cross',repeat('a',64),repeat('b',64),'[]','[]');
  PERFORM pg_temp.assert_true(r->>'outcome'='DESTINATION_REJECTED','cross-tenant actor was accepted');
  UPDATE public.ledger_books SET status='archived',archived_at=now() WHERE id=b;
  r:=public.complete_quickbooks_destination_onboarding_v1(p,c,b,u,'realm-019','stale',repeat('a',64),repeat('b',64),'[]','[]');
  PERFORM pg_temp.assert_true(r->>'outcome'='DESTINATION_REJECTED','inactive book was accepted');
  UPDATE public.ledger_books SET status='active',archived_at=NULL WHERE id=b;
  r:=public.complete_quickbooks_destination_onboarding_v1(p,c,b,u,'realm-019','replay',repeat('c',64),repeat('d',64),jsonb_build_array(jsonb_build_object('financialAccountId',a,'providerAccountId','6000','providerAccountType','Expense','eligibilityExpiresAt','2030-01-01T00:00:00Z')),jsonb_build_array(jsonb_build_object('providerTaxCode','S20','treatmentName','Standard','evidenceFingerprint',repeat('e',64),'eligibilityExpiresAt','2030-01-01T00:00:00Z')));
  PERFORM pg_temp.assert_true(r->>'outcome'='CREATED','initial onboarding failed'); op:=(r->>'operation_id')::uuid;
  r:=public.complete_quickbooks_destination_onboarding_v1(p,c,b,u,'realm-019','replay',repeat('c',64),repeat('d',64),'[]','[]');
  PERFORM pg_temp.assert_true(r->>'outcome'='RESUMED' AND (r->>'operation_id')::uuid=op,'exact replay was not resumed');
  r:=public.complete_quickbooks_destination_onboarding_v1(p,c,b,u,'realm-019','replay',repeat('f',64),repeat('d',64),'[]','[]');
  PERFORM pg_temp.assert_true(r->>'outcome'='IDEMPOTENCY_CONFLICT','changed intent was accepted');
  BEGIN UPDATE public.provider_destination_onboarding_events SET event_type='BOUND' WHERE onboarding_operation_id=op; RAISE EXCEPTION 'audit update unexpectedly succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $$;
ROLLBACK;
\echo 019_QUICKBOOKS_DESTINATION_ONBOARDING_CONTRACT_OK
