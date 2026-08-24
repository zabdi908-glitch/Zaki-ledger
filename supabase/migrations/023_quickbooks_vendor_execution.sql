-- Safe ENSURE_VENDOR execution. This is deliberately separate from BILL
-- dispatch: a Bill may reference a Vendor child but never creates one itself.
BEGIN;

CREATE OR REPLACE FUNCTION public.quickbooks_vendor_execution_grant_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_state_key text,
  p_state_value text,
  p_known_external_vendor_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_attempt public.posting_attempts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id = p_operation_id;
  SELECT * INTO STRICT v_attempt FROM public.posting_attempts
    WHERE id = p_attempt_id AND operation_id = p_operation_id;
  RETURN jsonb_build_object(
    'operation', jsonb_build_object(
      'id', v_operation.id, p_state_key, p_state_value,
      'practiceId', v_operation.practice_id,
      'clientEntityId', v_operation.client_entity_id,
      'ledgerBookId', v_operation.ledger_book_id,
      'providerConnectionId', v_operation.provider_connection_id,
      'provider', v_operation.provider,
      'externalOrganisationId', v_operation.external_organisation_id,
      'externalObjectType', v_operation.external_object_type,
      'action', v_operation.action,
      'authorizedRequestFingerprint', encode(v_operation.authorized_request_fingerprint, 'hex')
    ),
    'attempt', jsonb_build_object(
      'id', v_attempt.id, 'number', v_attempt.attempt_number,
      'kind', v_attempt.attempt_kind,
      'providerIdempotencyToken', v_attempt.provider_idempotency_token
    ),
    'requestedObject', v_operation.requested_object,
    'expectedMaterialState', v_operation.expected_material_state,
    'knownExternalVendorId', p_known_external_vendor_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_vendor_submission_v1(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_adapter_name text,
  p_adapter_version text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_binding public.provider_object_bindings%ROWTYPE;
  v_attempt_id uuid := gen_random_uuid();
  v_lease_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_sequence bigint;
  v_reason text := NULL;
BEGIN
  IF p_lease_seconds < 1 OR p_lease_seconds > 600
     OR btrim(COALESCE(p_adapter_name, '')) = ''
     OR btrim(COALESCE(p_adapter_version, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Vendor dispatch preparation input';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id
        AND external_object_type = 'VENDOR';
    RETURN jsonb_build_object('kind', 'SUCCEEDED',
      'externalVendorId', v_binding.external_object_id);
  END IF;
  IF v_operation.current_state IN ('SUBMITTING', 'VERIFYING', 'UNCERTAIN') THEN
    RETURN jsonb_build_object('kind', 'RECOVERY_REQUIRED', 'state', v_operation.current_state);
  END IF;
  IF v_operation.current_state <> 'AUTHORIZED' THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', 'OPERATION_NOT_AUTHORIZED');
  END IF;
  IF v_operation.provider <> 'quickbooks'
     OR v_operation.operation_kind <> 'ENSURE_VENDOR'
     OR v_operation.external_object_type <> 'VENDOR'
     OR v_operation.action <> 'CREATE' THEN
    v_reason := 'UNSUPPORTED_QUICKBOOKS_VENDOR_OPERATION';
  ELSIF NOT public.posting_actor_can_post_v1(
      p_actor_user_id, v_operation.practice_id, v_operation.client_entity_id) THEN
    v_reason := 'DISPATCH_ACTOR_UNAUTHORIZED';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.client_entities client
    JOIN public.ledger_books book ON book.id = v_operation.ledger_book_id
      AND book.client_entity_id = client.id AND book.status = 'active'
    JOIN public.provider_connections connection ON connection.id = v_operation.provider_connection_id
      AND connection.client_entity_id = client.id AND connection.ledger_book_id = book.id
      AND connection.provider = 'quickbooks'
      AND connection.external_organisation_id = v_operation.external_organisation_id
      AND connection.status = 'active'
    WHERE client.id = v_operation.client_entity_id
      AND client.practice_id = v_operation.practice_id AND client.status = 'active'
  ) THEN
    v_reason := 'DISPATCH_DESTINATION_INVALID';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.posting_human_authorizations auth_record
    WHERE auth_record.id = v_operation.human_authorization_id
      AND auth_record.authorized_request_fingerprint = v_operation.authorized_request_fingerprint
      AND auth_record.approved_at <= now()
      AND (auth_record.expires_at IS NULL OR auth_record.expires_at > now())
      AND public.posting_actor_can_post_v1(auth_record.approved_by_user_id,
        auth_record.practice_id, auth_record.client_entity_id)
  ) THEN
    v_reason := 'DISPATCH_APPROVAL_STALE';
  ELSIF public.posting_dispatch_evidence_status_v1(v_operation.id) <> 'OK' THEN
    v_reason := public.posting_dispatch_evidence_status_v1(v_operation.id);
  ELSIF btrim(COALESCE(v_operation.requested_object->>'displayName', '')) = ''
     OR btrim(COALESCE(v_operation.expected_material_state->>'displayName', ''))
        <> btrim(v_operation.requested_object->>'displayName')
     OR jsonb_array_length(v_operation.account_treatment_snapshot) <> 1
     OR v_operation.account_treatment_snapshot->0->>'disposition' <> 'NOT_APPLICABLE'
     OR jsonb_array_length(v_operation.tax_treatment_snapshot) <> 1
     OR v_operation.tax_treatment_snapshot->0->>'disposition' <> 'NOT_APPLICABLE' THEN
    v_reason := 'VENDOR_INTENT_INVALID';
  END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE public.posting_operations SET current_state = 'DENIED', row_version = row_version + 1
      WHERE id = v_operation.id RETURNING * INTO v_operation;
    SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
      FROM public.posting_events WHERE operation_id = v_operation.id;
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
      provider,external_organisation_id,event_sequence,event_type,prior_state,new_state,
      reason_code,actor_kind,actor_service,authorized_request_fingerprint,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      v_sequence,'TRANSITION','AUTHORIZED','DENIED',v_reason,'SERVICE',
      'AuthoritativePostingService',v_operation.authorized_request_fingerprint,
      jsonb_build_object('phase','vendor-dispatch-revalidation')
    );
    RETURN jsonb_build_object('kind','DENIED','state','DENIED','reasonCode',v_reason);
  END IF;
  SELECT COALESCE(max(attempt_number), 0) + 1 INTO v_attempt_number
    FROM public.posting_attempts WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_attempts (
    id,operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
    provider,external_organisation_id,attempt_number,attempt_kind,execution_lease_id,
    adapter_name,adapter_version,authorized_request_fingerprint,provider_idempotency_token,
    lease_expires_at
  ) VALUES (
    v_attempt_id,v_operation.id,v_operation.practice_id,v_operation.client_entity_id,
    v_operation.ledger_book_id,v_operation.provider_connection_id,v_operation.provider,
    v_operation.external_organisation_id,v_attempt_number,'SUBMIT',v_lease_id,p_adapter_name,
    p_adapter_version,v_operation.authorized_request_fingerprint,
    'zaki-qb-vendor-' || v_operation.id::text || '-' || v_attempt_number::text,
    now() + make_interval(secs => p_lease_seconds)
  );
  UPDATE public.posting_operations SET current_state = 'SUBMITTING', row_version = row_version + 1
    WHERE id = v_operation.id RETURNING * INTO v_operation;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
    provider,external_organisation_id,attempt_id,event_sequence,event_type,prior_state,new_state,
    reason_code,actor_kind,actor_service,authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    v_attempt_id,v_sequence,'TRANSITION','AUTHORIZED','SUBMITTING',
    'QUICKBOOKS_VENDOR_DISPATCH_PREPARED','SERVICE','AuthoritativePostingService',
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('adapterName',p_adapter_name,'adapterVersion',p_adapter_version)
  ),(
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    v_attempt_id,v_sequence+1,'DISPATCH',NULL,NULL,'QUICKBOOKS_VENDOR_DISPATCH_COMMITTED',
    'SERVICE','AuthoritativePostingService',v_operation.authorized_request_fingerprint,
    jsonb_build_object('attemptNumber',v_attempt_number,'providerIdempotencyToken',
      'zaki-qb-vendor-' || v_operation.id::text || '-' || v_attempt_number::text)
  );
  RETURN jsonb_build_object('kind','DISPATCH','grant',
    public.quickbooks_vendor_execution_grant_v1(v_operation.id,v_attempt_id,
      'stateAtDispatch','AUTHORIZED',NULL));
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_quickbooks_vendor_recovery_v1(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_adapter_name text,
  p_adapter_version text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_binding public.provider_object_bindings%ROWTYPE;
  v_original_state text;
  v_attempt_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_sequence bigint;
  v_known_external_id text;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id AND external_object_type = 'VENDOR';
    RETURN jsonb_build_object('kind','SUCCEEDED','externalVendorId',v_binding.external_object_id);
  END IF;
  IF v_operation.current_state NOT IN ('SUBMITTING','VERIFYING','UNCERTAIN')
     OR v_operation.provider <> 'quickbooks' OR v_operation.operation_kind <> 'ENSURE_VENDOR'
     OR v_operation.external_object_type <> 'VENDOR' OR v_operation.action <> 'CREATE' THEN
    RETURN jsonb_build_object('kind','BLOCKED','state',v_operation.current_state,
      'reasonCode','RECOVERY_STATE_OR_OPERATION_NOT_ELIGIBLE');
  END IF;
  IF NOT public.posting_actor_can_post_v1(p_actor_user_id,v_operation.practice_id,
      v_operation.client_entity_id) THEN
    RETURN jsonb_build_object('kind','BLOCKED','state',v_operation.current_state,
      'reasonCode','DISPATCH_ACTOR_UNAUTHORIZED');
  END IF;
  v_original_state := v_operation.current_state;
  SELECT details->>'externalVendorId' INTO v_known_external_id FROM public.posting_events
    WHERE operation_id = v_operation.id AND event_type = 'PROVIDER_RESPONSE'
      AND details ? 'externalVendorId' ORDER BY event_sequence DESC LIMIT 1;
  SELECT COALESCE(max(attempt_number),0)+1 INTO v_attempt_number FROM public.posting_attempts
    WHERE operation_id=v_operation.id;
  INSERT INTO public.posting_attempts (
    id,operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_number,attempt_kind,execution_lease_id,adapter_name,
    adapter_version,authorized_request_fingerprint,provider_idempotency_token,lease_expires_at
  ) VALUES (
    v_attempt_id,v_operation.id,v_operation.practice_id,v_operation.client_entity_id,
    v_operation.ledger_book_id,v_operation.provider_connection_id,v_operation.provider,
    v_operation.external_organisation_id,v_attempt_number,'RECOVERY',gen_random_uuid(),
    p_adapter_name,p_adapter_version,v_operation.authorized_request_fingerprint,
    'zaki-qb-vendor-' || v_operation.id::text || '-recovery-' || v_attempt_number::text,
    now()+make_interval(secs=>p_lease_seconds)
  );
  SELECT COALESCE(max(event_sequence),0)+1 INTO v_sequence FROM public.posting_events
    WHERE operation_id=v_operation.id;
  IF v_operation.current_state <> 'VERIFYING' THEN
    UPDATE public.posting_operations SET current_state='VERIFYING',row_version=row_version+1
      WHERE id=v_operation.id RETURNING * INTO v_operation;
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
      external_organisation_id,attempt_id,event_sequence,event_type,prior_state,new_state,
      reason_code,actor_kind,actor_service,authorized_request_fingerprint,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      v_attempt_id,v_sequence,'TRANSITION',v_original_state,'VERIFYING',
      'QUICKBOOKS_VENDOR_RECOVERY_STARTED','SERVICE','AuthoritativePostingService',
      v_operation.authorized_request_fingerprint,jsonb_build_object('readOnly',true)
    );
    v_sequence:=v_sequence+1;
  END IF;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_id,event_sequence,event_type,reason_code,actor_kind,
    actor_service,authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    v_attempt_id,v_sequence,'RECOVERY','QUICKBOOKS_VENDOR_READ_ONLY_RECOVERY','SERVICE',
    'AuthoritativePostingService',v_operation.authorized_request_fingerprint,
    jsonb_build_object('knownExternalVendorId',v_known_external_id,'readOnly',true)
  );
  RETURN jsonb_build_object('kind','RECOVER','grant',
    public.quickbooks_vendor_execution_grant_v1(v_operation.id,v_attempt_id,
      'stateAtRecovery',v_original_state,v_known_external_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_vendor_acknowledged_v1(
  p_operation_id uuid,p_attempt_id uuid,p_external_vendor_id text,
  p_provider_request_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_operation public.posting_operations%ROWTYPE; v_prior_state text; v_sequence bigint;
BEGIN
  IF btrim(COALESCE(p_external_vendor_id,''))='' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='external Vendor ID is required';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id=p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts WHERE id=p_attempt_id AND operation_id=p_operation_id
    AND attempt_kind='SUBMIT';
  IF NOT FOUND OR v_operation.current_state NOT IN ('SUBMITTING','VERIFYING','UNCERTAIN') THEN
    RAISE EXCEPTION 'invalid QuickBooks Vendor acknowledgement';
  END IF;
  v_prior_state:=v_operation.current_state;
  SELECT COALESCE(max(event_sequence),0)+1 INTO v_sequence FROM public.posting_events
    WHERE operation_id=v_operation.id;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_id,event_sequence,event_type,reason_code,actor_kind,
    actor_service,authorized_request_fingerprint,provider_correlation_id,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    p_attempt_id,v_sequence,'PROVIDER_RESPONSE','QUICKBOOKS_VENDOR_CREATE_ACKNOWLEDGED',
    'SERVICE','QuickBooksVendorPostingAdapter',v_operation.authorized_request_fingerprint,
    NULLIF(btrim(p_provider_request_id),''),jsonb_build_object('result','CREATED',
      'externalVendorId',btrim(p_external_vendor_id))
  );
  IF v_prior_state <> 'VERIFYING' THEN
    UPDATE public.posting_operations SET current_state='VERIFYING',row_version=row_version+1
      WHERE id=v_operation.id RETURNING * INTO v_operation;
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
      external_organisation_id,attempt_id,event_sequence,event_type,prior_state,new_state,
      reason_code,actor_kind,actor_service,authorized_request_fingerprint,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      p_attempt_id,v_sequence+1,'TRANSITION',v_prior_state,'VERIFYING',
      'QUICKBOOKS_VENDOR_CREATE_ACKNOWLEDGED','SERVICE','AuthoritativePostingService',
      v_operation.authorized_request_fingerprint,jsonb_build_object('externalVendorId',
        btrim(p_external_vendor_id))
    );
  END IF;
  RETURN jsonb_build_object('state','VERIFYING');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_vendor_failure_v1(
  p_operation_id uuid,p_attempt_id uuid,p_target_state text,p_failure_classification text,
  p_failure_code text,p_sanitized_summary text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_operation public.posting_operations%ROWTYPE; v_prior_state text; v_sequence bigint;
BEGIN
  IF p_target_state NOT IN ('FAILED_SAFE','UNCERTAIN') OR
     (p_target_state='FAILED_SAFE' AND p_failure_classification NOT IN
       ('VALIDATION_REJECTION','BEFORE_DELIVERY')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='unsafe Vendor failure classification';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id=p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts WHERE id=p_attempt_id AND operation_id=p_operation_id;
  IF NOT FOUND OR v_operation.current_state NOT IN ('SUBMITTING','VERIFYING','UNCERTAIN') THEN
    RAISE EXCEPTION 'invalid QuickBooks Vendor failure';
  END IF;
  v_prior_state:=v_operation.current_state;
  SELECT COALESCE(max(event_sequence),0)+1 INTO v_sequence FROM public.posting_events
    WHERE operation_id=v_operation.id;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_id,event_sequence,event_type,reason_code,actor_kind,
    actor_service,authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    p_attempt_id,v_sequence,'PROVIDER_RESPONSE',left(p_failure_code,120),'SERVICE',
    'QuickBooksVendorPostingAdapter',v_operation.authorized_request_fingerprint,
    jsonb_build_object('classification',p_failure_classification,'code',left(p_failure_code,120),
      'summaryStored',false)
  );
  UPDATE public.posting_operations SET current_state=p_target_state,row_version=row_version+1
    WHERE id=v_operation.id RETURNING * INTO v_operation;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_id,event_sequence,event_type,prior_state,new_state,
    reason_code,actor_kind,actor_service,authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    p_attempt_id,v_sequence+1,'TRANSITION',v_prior_state,p_target_state,left(p_failure_code,120),
    'SERVICE','AuthoritativePostingService',v_operation.authorized_request_fingerprint,
    jsonb_build_object('classification',p_failure_classification)
  );
  RETURN jsonb_build_object('operationId',v_operation.id,'state',p_target_state,
    'externalVendorId',NULL,'reasonCodes',jsonb_build_array(left(p_failure_code,120)),
    'resumed',false,'recovered',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_vendor_observation_v1(
  p_operation_id uuid,p_attempt_id uuid,p_external_vendor_id text,p_provider_version text,
  p_provider_state_fingerprint_hex text,p_normalized_provider_state jsonb,
  p_comparison_outcome text,p_reason_code text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE; v_binding public.provider_object_bindings%ROWTYPE;
  v_fingerprint bytea; v_sequence bigint; v_target_state text;
BEGIN
  IF p_comparison_outcome NOT IN ('MATCH','MISMATCH','INCONCLUSIVE') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid Vendor comparison outcome';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id=p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts WHERE id=p_attempt_id AND operation_id=p_operation_id;
  IF NOT FOUND OR v_operation.current_state <> 'VERIFYING' OR
     v_operation.external_object_type <> 'VENDOR' THEN
    RAISE EXCEPTION 'invalid QuickBooks Vendor observation';
  END IF;
  IF p_comparison_outcome <> 'INCONCLUSIVE' THEN
    IF p_provider_state_fingerprint_hex !~ '^[0-9a-fA-F]{64}$'
       OR jsonb_typeof(p_normalized_provider_state) <> 'object'
       OR btrim(COALESCE(p_external_vendor_id,'')) = '' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid Vendor provider observation';
    END IF;
    v_fingerprint:=decode(lower(p_provider_state_fingerprint_hex),'hex');
  END IF;
  SELECT COALESCE(max(event_sequence),0)+1 INTO v_sequence FROM public.posting_events
    WHERE operation_id=v_operation.id;
  IF p_comparison_outcome='MATCH' THEN
    INSERT INTO public.provider_object_bindings (
      originating_operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,
      provider,external_organisation_id,external_object_type,external_object_id,binding_kind,
      verified_provider_state_fingerprint,provider_version,verified_at
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      'VENDOR',btrim(p_external_vendor_id),'CREATED',v_fingerprint,
      NULLIF(btrim(p_provider_version),''),now()
    ) ON CONFLICT (originating_operation_id) DO NOTHING;
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id=v_operation.id;
    IF v_binding.external_object_type <> 'VENDOR' OR
       v_binding.external_object_id <> btrim(p_external_vendor_id) OR
       v_binding.verified_provider_state_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Vendor binding conflicts with verified observation';
    END IF;
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
      external_organisation_id,attempt_id,provider_object_binding_id,event_sequence,event_type,
      reason_code,actor_kind,actor_service,authorized_request_fingerprint,provider_state_fingerprint,
      normalized_provider_state,comparison_outcome,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      p_attempt_id,v_binding.id,v_sequence,'PROVIDER_OBSERVATION',left(p_reason_code,120),
      'SERVICE','QuickBooksVendorPostingAdapter',v_operation.authorized_request_fingerprint,
      v_fingerprint,p_normalized_provider_state,'MATCH',jsonb_build_object('externalVendorId',
        btrim(p_external_vendor_id),'providerVersion',NULLIF(btrim(p_provider_version),''))
    );
    v_target_state:='SUCCEEDED';
  ELSIF p_comparison_outcome='MISMATCH' THEN
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
      external_organisation_id,attempt_id,event_sequence,event_type,reason_code,actor_kind,
      actor_service,authorized_request_fingerprint,provider_state_fingerprint,
      normalized_provider_state,comparison_outcome,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      p_attempt_id,v_sequence,'PROVIDER_OBSERVATION',left(p_reason_code,120),'SERVICE',
      'QuickBooksVendorPostingAdapter',v_operation.authorized_request_fingerprint,v_fingerprint,
      p_normalized_provider_state,'MISMATCH',jsonb_build_object('externalVendorId',
        btrim(p_external_vendor_id))
    );
    v_target_state:='UNCERTAIN';
  ELSE
    INSERT INTO public.posting_events (
      operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
      external_organisation_id,attempt_id,event_sequence,event_type,reason_code,actor_kind,
      actor_service,authorized_request_fingerprint,details
    ) VALUES (
      v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
      v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
      p_attempt_id,v_sequence,'RECOVERY',left(p_reason_code,120),'SERVICE',
      'QuickBooksVendorPostingAdapter',v_operation.authorized_request_fingerprint,
      jsonb_build_object('readOnly',true,'outcome','INCONCLUSIVE')
    );
    v_target_state:='UNCERTAIN';
  END IF;
  UPDATE public.posting_operations SET current_state=v_target_state,row_version=row_version+1
    WHERE id=v_operation.id RETURNING * INTO v_operation;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,provider_connection_id,provider,
    external_organisation_id,attempt_id,event_sequence,event_type,prior_state,new_state,reason_code,
    actor_kind,actor_service,authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,v_operation.ledger_book_id,
    v_operation.provider_connection_id,v_operation.provider,v_operation.external_organisation_id,
    p_attempt_id,v_sequence+1,'TRANSITION','VERIFYING',v_target_state,left(p_reason_code,120),
    'SERVICE','AuthoritativePostingService',v_operation.authorized_request_fingerprint,
    jsonb_build_object('comparisonOutcome',p_comparison_outcome)
  );
  RETURN jsonb_build_object('operationId',v_operation.id,'state',v_target_state,
    'externalVendorId',CASE WHEN p_comparison_outcome='MATCH' THEN btrim(p_external_vendor_id)
      ELSE NULL END,'reasonCodes',jsonb_build_array(left(p_reason_code,120)),
    'resumed',false,'recovered',false);
END;
$$;

REVOKE ALL ON FUNCTION public.quickbooks_vendor_execution_grant_v1(uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_vendor_submission_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_quickbooks_vendor_recovery_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_vendor_acknowledged_v1(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_vendor_failure_v1(uuid,uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_vendor_observation_v1(uuid,uuid,text,text,text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_vendor_submission_v1(uuid,uuid,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_quickbooks_vendor_recovery_v1(uuid,uuid,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_vendor_acknowledged_v1(uuid,uuid,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_vendor_failure_v1(uuid,uuid,text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_vendor_observation_v1(uuid,uuid,text,text,text,jsonb,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
