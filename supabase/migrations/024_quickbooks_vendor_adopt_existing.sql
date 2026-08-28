-- Migration 024: read-only adoption of an existing QuickBooks Vendor for an authorized
-- ENSURE_VENDOR child. No provider CREATE acknowledgement is accepted here.
BEGIN;

CREATE OR REPLACE FUNCTION public.quickbooks_vendor_adoption_grant_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_external_vendor_id text
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
    WHERE id = p_attempt_id AND operation_id = p_operation_id AND attempt_kind = 'VERIFY';
  RETURN jsonb_build_object(
    'operation', jsonb_build_object(
      'id', v_operation.id, 'stateAtAdoption', 'AUTHORIZED',
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
      'kind', v_attempt.attempt_kind, 'providerIdempotencyToken', NULL
    ),
    'requestedObject', v_operation.requested_object,
    'expectedMaterialState', v_operation.expected_material_state,
    'externalVendorId', btrim(p_external_vendor_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_vendor_adoption_v1(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_external_vendor_id text,
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
  v_conflict public.provider_object_bindings%ROWTYPE;
  v_attempt_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_sequence bigint;
  v_reason text := NULL;
  v_external_vendor_id text := btrim(COALESCE(p_external_vendor_id, ''));
BEGIN
  IF v_external_vendor_id = '' OR length(v_external_vendor_id) > 100
     OR v_external_vendor_id ~ '[[:cntrl:]]'
     OR p_lease_seconds < 1 OR p_lease_seconds > 600
     OR btrim(COALESCE(p_adapter_name, '')) = ''
     OR btrim(COALESCE(p_adapter_version, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Vendor adoption input';
  END IF;

  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_operation.provider_connection_id::text || '|' ||
    v_operation.external_organisation_id || '|VENDOR|' || v_external_vendor_id, 0));

  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id AND external_object_type = 'VENDOR';
    IF v_binding.provider_connection_id = v_operation.provider_connection_id
       AND v_binding.external_organisation_id = v_operation.external_organisation_id
       AND v_binding.external_object_id = v_external_vendor_id THEN
      RETURN jsonb_build_object('kind', 'SUCCEEDED',
        'externalVendorId', v_binding.external_object_id);
    END IF;
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', 'SUCCEEDED',
      'reasonCode', 'EXISTING_VENDOR_BINDING_CONFLICT');
  END IF;

  IF v_operation.current_state <> 'AUTHORIZED' THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', CASE WHEN v_operation.current_state = 'VERIFYING'
        THEN 'VENDOR_ADOPTION_ALREADY_IN_PROGRESS' ELSE 'OPERATION_NOT_AUTHORIZED' END);
  END IF;

  IF v_operation.provider <> 'quickbooks'
     OR v_operation.operation_kind <> 'ENSURE_VENDOR'
     OR v_operation.external_object_type <> 'VENDOR'
     OR v_operation.action <> 'CREATE' THEN
    v_reason := 'UNSUPPORTED_QUICKBOOKS_VENDOR_ADOPTION';
  ELSIF NOT public.posting_actor_can_post_v1(
      p_actor_user_id, v_operation.practice_id, v_operation.client_entity_id) THEN
    v_reason := 'ADOPTION_ACTOR_UNAUTHORIZED';
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
    v_reason := 'ADOPTION_DESTINATION_INVALID';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.posting_human_authorizations auth_record
    WHERE auth_record.id = v_operation.human_authorization_id
      AND auth_record.authorized_request_fingerprint = v_operation.authorized_request_fingerprint
      AND auth_record.approved_at <= now()
      AND (auth_record.expires_at IS NULL OR auth_record.expires_at > now())
      AND public.posting_actor_can_post_v1(auth_record.approved_by_user_id,
        auth_record.practice_id, auth_record.client_entity_id)
  ) THEN
    v_reason := 'ADOPTION_APPROVAL_STALE';
  ELSIF public.posting_dispatch_evidence_status_v1(v_operation.id) <> 'OK' THEN
    v_reason := public.posting_dispatch_evidence_status_v1(v_operation.id);
  ELSIF btrim(COALESCE(v_operation.requested_object->>'displayName', '')) = ''
     OR btrim(COALESCE(v_operation.expected_material_state->>'displayName', ''))
        <> btrim(v_operation.requested_object->>'displayName') THEN
    v_reason := 'VENDOR_INTENT_INVALID';
  END IF;

  SELECT * INTO v_conflict FROM public.provider_object_bindings
    WHERE provider_connection_id = v_operation.provider_connection_id
      AND external_organisation_id = v_operation.external_organisation_id
      AND external_object_type = 'VENDOR'
      AND external_object_id = v_external_vendor_id
      AND originating_operation_id <> v_operation.id;
  IF FOUND THEN v_reason := 'EXISTING_VENDOR_BINDING_CONFLICT'; END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE public.posting_operations SET current_state = 'REVIEW', row_version = row_version + 1
      WHERE id = v_operation.id RETURNING * INTO v_operation;
    SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
      FROM public.posting_events WHERE operation_id = v_operation.id;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
      provider, external_organisation_id, event_sequence, event_type, prior_state, new_state,
      reason_code, actor_kind, actor_service, authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, v_sequence, 'TRANSITION', 'AUTHORIZED', 'REVIEW',
      v_reason, 'SERVICE', 'AuthoritativePostingService',
      v_operation.authorized_request_fingerprint,
      jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId', v_external_vendor_id,
        'providerWrite', false)
    );
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', 'REVIEW', 'reasonCode', v_reason);
  END IF;

  SELECT COALESCE(max(attempt_number), 0) + 1 INTO v_attempt_number
    FROM public.posting_attempts WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_attempts (
    id, operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
    provider, external_organisation_id, attempt_number, attempt_kind, execution_lease_id,
    adapter_name, adapter_version, authorized_request_fingerprint, provider_idempotency_token,
    lease_expires_at
  ) VALUES (
    v_attempt_id, v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, v_attempt_number, 'VERIFY', gen_random_uuid(),
    p_adapter_name, p_adapter_version, v_operation.authorized_request_fingerprint, NULL,
    now() + make_interval(secs => p_lease_seconds)
  );
  UPDATE public.posting_operations SET current_state = 'VERIFYING', row_version = row_version + 1
    WHERE id = v_operation.id RETURNING * INTO v_operation;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
    provider, external_organisation_id, attempt_id, event_sequence, event_type,
    prior_state, new_state, reason_code, actor_kind, actor_user_id, actor_service,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, v_attempt_id, v_sequence, 'MANUAL_INTERVENTION',
    NULL, NULL, 'QUICKBOOKS_VENDOR_ADOPT_EXISTING_REQUESTED', 'USER', p_actor_user_id, NULL,
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId', v_external_vendor_id,
      'readOnly', true, 'providerWrite', false)
  ), (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, v_attempt_id, v_sequence + 1, 'TRANSITION',
    'AUTHORIZED', 'VERIFYING', 'QUICKBOOKS_VENDOR_ADOPTION_VERIFICATION_STARTED',
    'SERVICE', NULL, 'AuthoritativePostingService', v_operation.authorized_request_fingerprint,
    jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId', v_external_vendor_id,
      'readOnly', true, 'providerWrite', false)
  );
  RETURN jsonb_build_object('kind', 'VERIFY', 'grant',
    public.quickbooks_vendor_adoption_grant_v1(
      v_operation.id, v_attempt_id, v_external_vendor_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_vendor_adoption_observation_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_external_vendor_id text,
  p_provider_version text,
  p_provider_state_fingerprint_hex text,
  p_normalized_provider_state jsonb,
  p_comparison_outcome text,
  p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_binding public.provider_object_bindings%ROWTYPE;
  v_conflict public.provider_object_bindings%ROWTYPE;
  v_requested_external_id text;
  v_fingerprint bytea;
  v_sequence bigint;
  v_outcome text := p_comparison_outcome;
  v_reason text := left(btrim(COALESCE(p_reason_code, '')), 120);
  v_target_state text;
BEGIN
  IF v_outcome NOT IN ('MATCH', 'MISMATCH', 'INCONCLUSIVE') OR v_reason = ''
     OR btrim(COALESCE(p_external_vendor_id, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Vendor adoption observation';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id AND external_object_type = 'VENDOR';
    IF v_binding.external_object_id = btrim(p_external_vendor_id) THEN
      RETURN jsonb_build_object('operationId', v_operation.id, 'state', 'SUCCEEDED',
        'externalVendorId', v_binding.external_object_id,
        'reasonCodes', jsonb_build_array('EXACT_RETRY_EXISTING_SUCCESS'),
        'resumed', true, 'recovered', false);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Vendor binding conflicts with adoption replay';
  END IF;
  SELECT details->>'externalVendorId' INTO STRICT v_requested_external_id
    FROM public.posting_events
    WHERE operation_id = v_operation.id AND attempt_id = p_attempt_id
      AND event_type = 'MANUAL_INTERVENTION'
      AND reason_code = 'QUICKBOOKS_VENDOR_ADOPT_EXISTING_REQUESTED'
      AND details->>'action' = 'ADOPT_EXISTING';
  PERFORM 1 FROM public.posting_attempts
    WHERE id = p_attempt_id AND operation_id = p_operation_id AND attempt_kind = 'VERIFY';
  IF NOT FOUND OR v_operation.current_state <> 'VERIFYING'
     OR v_operation.provider <> 'quickbooks'
     OR v_operation.operation_kind <> 'ENSURE_VENDOR'
     OR v_operation.external_object_type <> 'VENDOR'
     OR v_requested_external_id <> btrim(p_external_vendor_id) THEN
    RAISE EXCEPTION 'invalid QuickBooks Vendor adoption observation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_operation.provider_connection_id::text || '|' ||
    v_operation.external_organisation_id || '|VENDOR|' || v_requested_external_id, 0));

  IF v_outcome <> 'INCONCLUSIVE' THEN
    IF p_provider_state_fingerprint_hex !~ '^[0-9a-fA-F]{64}$'
       OR jsonb_typeof(p_normalized_provider_state) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Vendor provider observation';
    END IF;
    v_fingerprint := decode(lower(p_provider_state_fingerprint_hex), 'hex');
  END IF;
  IF v_outcome = 'MATCH' AND (
       p_normalized_provider_state->>'externalObjectType' <> 'VENDOR'
       OR p_normalized_provider_state->>'providerVendorId' <> v_requested_external_id
       OR p_normalized_provider_state->>'realmId' <> v_operation.external_organisation_id
       OR p_normalized_provider_state->>'displayName'
          IS DISTINCT FROM btrim(v_operation.requested_object->>'displayName')
       OR p_normalized_provider_state->>'active' <> 'true') THEN
    v_outcome := 'MISMATCH';
    v_reason := 'QUICKBOOKS_VENDOR_ADOPTION_MATERIAL_MISMATCH';
  END IF;
  SELECT * INTO v_conflict FROM public.provider_object_bindings
    WHERE provider_connection_id = v_operation.provider_connection_id
      AND external_organisation_id = v_operation.external_organisation_id
      AND external_object_type = 'VENDOR'
      AND external_object_id = v_requested_external_id
      AND originating_operation_id <> v_operation.id;
  IF FOUND THEN
    v_outcome := 'MISMATCH';
    v_reason := 'EXISTING_VENDOR_BINDING_CONFLICT';
  END IF;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  IF v_outcome = 'MATCH' THEN
    INSERT INTO public.provider_object_bindings (
      originating_operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id, external_object_type,
      external_object_id, binding_kind, verified_provider_state_fingerprint,
      provider_version, verified_at
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, 'VENDOR', v_requested_external_id, 'ADOPTED',
      v_fingerprint, NULLIF(btrim(p_provider_version), ''), now()
    ) ON CONFLICT (originating_operation_id) DO NOTHING;
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id;
    IF v_binding.binding_kind <> 'ADOPTED' OR v_binding.external_object_type <> 'VENDOR'
       OR v_binding.external_object_id <> v_requested_external_id
       OR v_binding.provider_connection_id <> v_operation.provider_connection_id
       OR v_binding.external_organisation_id <> v_operation.external_organisation_id
       OR v_binding.verified_provider_state_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Vendor adoption binding conflicts';
    END IF;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
      provider, external_organisation_id, attempt_id, provider_object_binding_id,
      event_sequence, event_type, reason_code, actor_kind, actor_service,
      authorized_request_fingerprint, provider_state_fingerprint,
      normalized_provider_state, comparison_outcome, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, p_attempt_id, v_binding.id, v_sequence,
      'PROVIDER_OBSERVATION', v_reason, 'SERVICE', 'QuickBooksVendorAdoptionAdapter',
      v_operation.authorized_request_fingerprint, v_fingerprint,
      p_normalized_provider_state, 'MATCH',
      jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId',
        v_requested_external_id, 'providerVersion', NULLIF(btrim(p_provider_version), ''),
        'providerWrite', false)
    );
    v_target_state := 'SUCCEEDED';
  ELSIF v_outcome = 'MISMATCH' THEN
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
      provider, external_organisation_id, attempt_id, event_sequence, event_type,
      reason_code, actor_kind, actor_service, authorized_request_fingerprint,
      provider_state_fingerprint, normalized_provider_state, comparison_outcome, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, p_attempt_id, v_sequence,
      'PROVIDER_OBSERVATION', v_reason, 'SERVICE', 'QuickBooksVendorAdoptionAdapter',
      v_operation.authorized_request_fingerprint, v_fingerprint,
      p_normalized_provider_state, 'MISMATCH',
      jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId',
        v_requested_external_id, 'providerWrite', false)
    );
    v_target_state := 'REVIEW';
  ELSE
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
      provider, external_organisation_id, attempt_id, event_sequence, event_type,
      reason_code, actor_kind, actor_service, authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, p_attempt_id, v_sequence, 'RECOVERY', v_reason,
      'SERVICE', 'QuickBooksVendorAdoptionAdapter', v_operation.authorized_request_fingerprint,
      jsonb_build_object('action', 'ADOPT_EXISTING', 'externalVendorId',
        v_requested_external_id, 'readOnly', true, 'providerWrite', false,
        'outcome', 'INCONCLUSIVE')
    );
    v_target_state := 'REVIEW';
  END IF;

  UPDATE public.posting_operations SET current_state = v_target_state, row_version = row_version + 1
    WHERE id = v_operation.id RETURNING * INTO v_operation;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
    provider, external_organisation_id, attempt_id, event_sequence, event_type,
    prior_state, new_state, reason_code, actor_kind, actor_service,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, p_attempt_id, v_sequence + 1, 'TRANSITION',
    'VERIFYING', v_target_state, v_reason, 'SERVICE', 'AuthoritativePostingService',
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('action', 'ADOPT_EXISTING', 'comparisonOutcome', v_outcome,
      'providerWrite', false)
  );
  RETURN jsonb_build_object('operationId', v_operation.id, 'state', v_target_state,
    'externalVendorId', CASE WHEN v_target_state = 'SUCCEEDED'
      THEN v_requested_external_id ELSE NULL END,
    'reasonCodes', jsonb_build_array(v_reason), 'resumed', false, 'recovered', false);
END;
$$;

REVOKE ALL ON FUNCTION public.quickbooks_vendor_adoption_grant_v1(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_vendor_adoption_v1(
  uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_vendor_adoption_observation_v1(
  uuid, uuid, text, text, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_vendor_adoption_v1(
  uuid, uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_vendor_adoption_observation_v1(
  uuid, uuid, text, text, text, jsonb, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
