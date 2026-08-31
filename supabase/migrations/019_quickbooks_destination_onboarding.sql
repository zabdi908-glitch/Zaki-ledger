-- Step 5 pilot foundation: canonical QuickBooks destination onboarding only.
-- No financial-provider mutation is introduced here.
BEGIN;

CREATE TABLE public.provider_destination_onboarding_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid NOT NULL,
  client_entity_id uuid NOT NULL,
  ledger_book_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'quickbooks'),
  external_organisation_id text NOT NULL CHECK (btrim(external_organisation_id) <> ''),
  requested_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 500),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  provider_discovery_fingerprint bytea NOT NULL CHECK (octet_length(provider_discovery_fingerprint) = 32),
  provider_connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id,client_entity_id,ledger_book_id,provider,external_organisation_id,idempotency_key),
  UNIQUE (id,practice_id,client_entity_id,ledger_book_id,provider,external_organisation_id),
  FOREIGN KEY (client_entity_id,practice_id) REFERENCES public.client_entities(id,practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id,client_entity_id) REFERENCES public.ledger_books(id,client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id,client_entity_id,ledger_book_id,provider,external_organisation_id)
    REFERENCES public.provider_connections(id,client_entity_id,ledger_book_id,provider,external_organisation_id) ON DELETE RESTRICT
);

CREATE TABLE public.provider_destination_onboarding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_operation_id uuid NOT NULL REFERENCES public.provider_destination_onboarding_operations(id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('CLAIMED','DISCOVERED','BOUND','MAPPINGS_VERIFIED')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (onboarding_operation_id,event_sequence)
);

CREATE OR REPLACE FUNCTION public.provider_destination_onboarding_reject_mutation_v1()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'destination onboarding history is append-only';
END; $$;
CREATE TRIGGER provider_destination_onboarding_operations_append_only
  BEFORE UPDATE OR DELETE ON public.provider_destination_onboarding_operations
  FOR EACH ROW EXECUTE FUNCTION public.provider_destination_onboarding_reject_mutation_v1();
CREATE TRIGGER provider_destination_onboarding_events_append_only
  BEFORE UPDATE OR DELETE ON public.provider_destination_onboarding_events
  FOR EACH ROW EXECUTE FUNCTION public.provider_destination_onboarding_reject_mutation_v1();

CREATE OR REPLACE FUNCTION public.complete_quickbooks_destination_onboarding_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_actor_user_id uuid, p_realm_id text, p_idempotency_key text,
  p_request_fingerprint_hex text, p_discovery_fingerprint_hex text,
  p_account_mappings jsonb, p_tax_mappings jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing public.provider_destination_onboarding_operations%ROWTYPE;
  v_connection public.provider_connections%ROWTYPE;
  v_operation_id uuid := gen_random_uuid();
  v_account jsonb;
  v_tax jsonb;
BEGIN
  -- Serialize the exact onboarding namespace. This turns concurrent exact
  -- replays into RESUMED instead of a unique-index race.
  PERFORM pg_advisory_xact_lock(hashtext(concat_ws(':',p_practice_id::text,p_client_entity_id::text,p_ledger_book_id::text,p_realm_id,p_idempotency_key)));
  IF NOT public.posting_actor_can_post_v1(p_actor_user_id,p_practice_id,p_client_entity_id) THEN
    RETURN jsonb_build_object('outcome','DESTINATION_REJECTED');
  END IF;
  IF p_realm_id IS NULL OR btrim(p_realm_id) = '' OR p_request_fingerprint_hex !~ '^[0-9a-fA-F]{64}$'
     OR p_discovery_fingerprint_hex !~ '^[0-9a-fA-F]{64}$' OR jsonb_typeof(p_account_mappings) <> 'array'
     OR jsonb_typeof(p_tax_mappings) <> 'array' THEN RAISE EXCEPTION 'invalid QuickBooks onboarding input' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.client_entities WHERE id=p_client_entity_id AND practice_id=p_practice_id AND status='active';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  PERFORM 1 FROM public.ledger_books WHERE id=p_ledger_book_id AND client_entity_id=p_client_entity_id AND status='active';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  PERFORM 1 FROM public.oauth_connections WHERE user_id=p_actor_user_id AND provider='quickbooks'
    AND org_id=p_realm_id AND expires_at>now();
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','OAUTH_DESTINATION_REJECTED'); END IF;
  SELECT * INTO v_existing FROM public.provider_destination_onboarding_operations
   WHERE practice_id=p_practice_id AND client_entity_id=p_client_entity_id AND ledger_book_id=p_ledger_book_id
     AND provider='quickbooks' AND external_organisation_id=p_realm_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> decode(p_request_fingerprint_hex,'hex') THEN
      RETURN jsonb_build_object('outcome','IDEMPOTENCY_CONFLICT','operation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object('outcome','RESUMED','operation_id',v_existing.id,'provider_connection_id',v_existing.provider_connection_id);
  END IF;
  SELECT * INTO v_connection FROM public.provider_connections WHERE client_entity_id=p_client_entity_id
    AND ledger_book_id=p_ledger_book_id AND provider='quickbooks' AND external_organisation_id=p_realm_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.provider_connections WHERE provider='quickbooks' AND external_organisation_id=p_realm_id AND status='active') THEN
      RETURN jsonb_build_object('outcome','DESTINATION_REJECTED');
    END IF;
    INSERT INTO public.provider_connections(id,client_entity_id,ledger_book_id,provider,external_organisation_id,status,provider_metadata)
      VALUES (gen_random_uuid(),p_client_entity_id,p_ledger_book_id,'quickbooks',p_realm_id,'active',jsonb_build_object('onboarding','step5','discoveryFingerprint',p_discovery_fingerprint_hex)) RETURNING * INTO v_connection;
  END IF;
  INSERT INTO public.provider_destination_onboarding_operations(id,practice_id,client_entity_id,ledger_book_id,provider,external_organisation_id,requested_by_user_id,idempotency_key,request_fingerprint,provider_discovery_fingerprint,provider_connection_id)
    VALUES(v_operation_id,p_practice_id,p_client_entity_id,p_ledger_book_id,'quickbooks',p_realm_id,p_actor_user_id,p_idempotency_key,decode(p_request_fingerprint_hex,'hex'),decode(p_discovery_fingerprint_hex,'hex'),v_connection.id);
  INSERT INTO public.provider_destination_onboarding_events(onboarding_operation_id,event_sequence,event_type,actor_user_id,details) VALUES
    (v_operation_id,1,'CLAIMED',p_actor_user_id,jsonb_build_object('realmId',p_realm_id)),
    (v_operation_id,2,'DISCOVERED',p_actor_user_id,jsonb_build_object('discoveryFingerprint',p_discovery_fingerprint_hex)),
    (v_operation_id,3,'BOUND',p_actor_user_id,jsonb_build_object('providerConnectionId',v_connection.id));
  FOR v_account IN SELECT value FROM jsonb_array_elements(p_account_mappings) LOOP
    INSERT INTO public.provider_posting_account_mappings(practice_id,client_entity_id,ledger_book_id,provider_connection_id,financial_account_id,provider,external_organisation_id,provider_account_id,provider_account_code,provider_account_name,posting_role,provider_account_type,provider_account_subtype,mapping_status,is_postable,verified_at,eligibility_expires_at,provider_updated_at,provider_version)
    VALUES(p_practice_id,p_client_entity_id,p_ledger_book_id,v_connection.id,(v_account->>'financialAccountId')::uuid,'quickbooks',p_realm_id,v_account->>'providerAccountId',v_account->>'providerAccountCode',v_account->>'providerAccountName','general_ledger',v_account->>'providerAccountType',v_account->>'providerAccountSubtype','active',true,now(),(v_account->>'eligibilityExpiresAt')::timestamptz,now(),v_account->>'providerVersion');
  END LOOP;
  FOR v_tax IN SELECT value FROM jsonb_array_elements(p_tax_mappings) LOOP
    INSERT INTO public.provider_tax_treatment_mappings(practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,external_organisation_id,provider_tax_code,treatment_name,evidence_fingerprint,mapping_status,verified_at,eligibility_expires_at,provider_updated_at,provider_version)
    VALUES(p_practice_id,p_client_entity_id,p_ledger_book_id,v_connection.id,'quickbooks',p_realm_id,v_tax->>'providerTaxCode',v_tax->>'treatmentName',decode(v_tax->>'evidenceFingerprint','hex'),'active',now(),(v_tax->>'eligibilityExpiresAt')::timestamptz,now(),v_tax->>'providerVersion');
  END LOOP;
  INSERT INTO public.provider_destination_onboarding_events(onboarding_operation_id,event_sequence,event_type,actor_user_id,details) VALUES
    (v_operation_id,4,'MAPPINGS_VERIFIED',p_actor_user_id,jsonb_build_object('accountCount',jsonb_array_length(p_account_mappings),'taxCount',jsonb_array_length(p_tax_mappings)));
  RETURN jsonb_build_object('outcome','CREATED','operation_id',v_operation_id,'provider_connection_id',v_connection.id);
END; $$;
ALTER TABLE public.provider_destination_onboarding_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_destination_onboarding_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_destination_onboarding_operations,public.provider_destination_onboarding_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.complete_quickbooks_destination_onboarding_v1(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_quickbooks_destination_onboarding_v1(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
