-- Audited refresh of human authorization for existing immutable posting operations.
-- This migration creates no posting operation and has no provider I/O capability.
BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_posting_human_authorizations_v1(
  p_operation_ids uuid[],
  p_actor_user_id uuid,
  p_refresh_request_id uuid,
  p_ttl_seconds integer DEFAULT 3600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_prior_authorization public.posting_human_authorizations%ROWTYPE;
  v_new_authorization_id uuid;
  v_expires_at timestamptz;
  v_sequence bigint;
  v_locked_count integer;
  v_evidence_status text;
  v_item jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF p_actor_user_id IS NULL OR p_refresh_request_id IS NULL
     OR p_operation_ids IS NULL OR cardinality(p_operation_ids) < 1
     OR cardinality(p_operation_ids) > 10 OR p_ttl_seconds < 300
     OR p_ttl_seconds > 86400 OR EXISTS (
       SELECT 1 FROM unnest(p_operation_ids) AS operation_id WHERE operation_id IS NULL
     ) OR cardinality(p_operation_ids) <> (
       SELECT count(DISTINCT operation_id) FROM unnest(p_operation_ids) AS operation_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid posting authorization refresh input';
  END IF;

  -- Every caller locks the same batch in UUID order. Concurrent exact replays
  -- therefore serialize and observe the first transaction's fresh approval.
  PERFORM 1 FROM public.posting_operations
    WHERE id = ANY(p_operation_ids) ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS v_locked_count = ROW_COUNT;
  IF v_locked_count <> cardinality(p_operation_ids) THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'reasonCode', 'OPERATION_NOT_FOUND');
  END IF;

  -- Validate the complete batch before writing anything. A failure leaves all
  -- operations and authorization records unchanged.
  FOR v_operation IN
    SELECT * FROM public.posting_operations
      WHERE id = ANY(p_operation_ids) ORDER BY id
  LOOP
    IF v_operation.current_state <> 'AUTHORIZED' THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'OPERATION_NOT_AUTHORIZED');
    END IF;
    IF NOT public.posting_actor_can_post_v1(
        p_actor_user_id, v_operation.practice_id, v_operation.client_entity_id) THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'ACTOR_UNAUTHORIZED');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.client_entities client
      JOIN public.ledger_books book ON book.id = v_operation.ledger_book_id
        AND book.client_entity_id = client.id AND book.status = 'active'
      JOIN public.provider_connections connection
        ON connection.id = v_operation.provider_connection_id
        AND connection.client_entity_id = client.id
        AND connection.ledger_book_id = book.id
        AND connection.provider = v_operation.provider
        AND connection.external_organisation_id = v_operation.external_organisation_id
        AND connection.status = 'active'
      WHERE client.id = v_operation.client_entity_id
        AND client.practice_id = v_operation.practice_id AND client.status = 'active'
    ) THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'DESTINATION_NOT_CURRENT');
    END IF;
    SELECT * INTO v_prior_authorization FROM public.posting_human_authorizations
      WHERE id = v_operation.human_authorization_id
        AND practice_id = v_operation.practice_id
        AND client_entity_id = v_operation.client_entity_id
        AND ledger_book_id = v_operation.ledger_book_id
        AND provider_connection_id = v_operation.provider_connection_id
        AND provider = v_operation.provider
        AND external_organisation_id = v_operation.external_organisation_id
        AND operation_kind = v_operation.operation_kind
        AND external_object_type = v_operation.external_object_type
        AND action = v_operation.action
        AND authorized_request_fingerprint = v_operation.authorized_request_fingerprint;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'PRIOR_AUTHORIZATION_SCOPE_MISMATCH');
    END IF;

    v_evidence_status := public.posting_dispatch_evidence_status_v1(v_operation.id);
    IF v_evidence_status <> 'OK' THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', v_evidence_status);
    END IF;

    IF jsonb_array_length(v_operation.account_treatment_snapshot) = 0 THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'CURRENT_ACCOUNT_MAPPING_INVALID');
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_operation.account_treatment_snapshot)
    LOOP
      IF v_operation.external_object_type = 'BILL' AND v_item->>'disposition' = 'MAPPED' THEN
        BEGIN
          PERFORM 1 FROM public.eligible_provider_posting_accounts mapping
            WHERE mapping.id = (v_item->>'mappingId')::uuid
              AND mapping.practice_id = v_operation.practice_id
              AND mapping.client_entity_id = v_operation.client_entity_id
              AND mapping.ledger_book_id = v_operation.ledger_book_id
              AND mapping.provider_connection_id = v_operation.provider_connection_id
              AND mapping.provider = v_operation.provider
              AND mapping.external_organisation_id = v_operation.external_organisation_id;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
            'reasonCode', 'CURRENT_ACCOUNT_MAPPING_INVALID');
        END;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
            'reasonCode', 'CURRENT_ACCOUNT_MAPPING_INVALID');
        END IF;
      ELSIF v_operation.external_object_type <> 'BILL'
            AND v_item->>'disposition' = 'NOT_APPLICABLE' THEN
        NULL;
      ELSE
        RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
          'reasonCode', 'CURRENT_ACCOUNT_MAPPING_INVALID');
      END IF;
    END LOOP;

    IF jsonb_array_length(v_operation.tax_treatment_snapshot) = 0 THEN
      RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
        'reasonCode', 'CURRENT_TAX_MAPPING_INVALID');
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_operation.tax_treatment_snapshot)
    LOOP
      IF v_operation.external_object_type = 'BILL' AND v_item->>'disposition' = 'MAPPED' THEN
        BEGIN
          PERFORM 1 FROM public.eligible_provider_tax_treatments mapping
            WHERE mapping.id = (v_item->>'treatmentId')::uuid
              AND mapping.practice_id = v_operation.practice_id
              AND mapping.client_entity_id = v_operation.client_entity_id
              AND mapping.ledger_book_id = v_operation.ledger_book_id
              AND mapping.provider_connection_id = v_operation.provider_connection_id
              AND mapping.provider = v_operation.provider
              AND mapping.external_organisation_id = v_operation.external_organisation_id
              AND mapping.provider_tax_code = v_item->>'providerTaxCode'
              AND encode(mapping.evidence_fingerprint, 'hex') =
                lower(v_item->>'evidenceFingerprint');
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
            'reasonCode', 'CURRENT_TAX_MAPPING_INVALID');
        END;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
            'reasonCode', 'CURRENT_TAX_MAPPING_INVALID');
        END IF;
      ELSIF v_operation.external_object_type <> 'BILL'
            AND v_item->>'disposition' = 'NOT_APPLICABLE' THEN
        NULL;
      ELSE
        RETURN jsonb_build_object('kind', 'BLOCKED', 'operationId', v_operation.id,
          'reasonCode', 'CURRENT_TAX_MAPPING_INVALID');
      END IF;
    END LOOP;
  END LOOP;

  v_expires_at := now() + make_interval(secs => p_ttl_seconds);
  FOR v_operation IN
    SELECT * FROM public.posting_operations
      WHERE id = ANY(p_operation_ids) ORDER BY id
  LOOP
    SELECT * INTO STRICT v_prior_authorization
      FROM public.posting_human_authorizations
      WHERE id = v_operation.human_authorization_id;
    IF v_prior_authorization.approved_by_user_id = p_actor_user_id
       AND v_prior_authorization.approval_context->>'refreshRequestId' =
         p_refresh_request_id::text
       AND v_prior_authorization.expires_at > now() THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'operationId', v_operation.id,
        'authorizationId', v_prior_authorization.id,
        'expiresAt', v_prior_authorization.expires_at,
        'refreshed', false
      ));
      CONTINUE;
    END IF;

    v_new_authorization_id := gen_random_uuid();
    INSERT INTO public.posting_human_authorizations (
      id, practice_id, client_entity_id, ledger_book_id, provider_connection_id,
      provider, external_organisation_id, operation_kind, external_object_type,
      action, authorized_request_fingerprint, approved_by_user_id, approved_at,
      expires_at, approval_context
    ) VALUES (
      v_new_authorization_id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id, v_operation.provider,
      v_operation.external_organisation_id, v_operation.operation_kind,
      v_operation.external_object_type, v_operation.action,
      v_operation.authorized_request_fingerprint, p_actor_user_id, now(), v_expires_at,
      jsonb_build_object(
        'kind', 'REFRESH_EXISTING_POSTING_AUTHORIZATION',
        'refreshRequestId', p_refresh_request_id,
        'operationId', v_operation.id,
        'priorAuthorizationId', v_prior_authorization.id,
        'immutableIntentFingerprint',
          encode(v_operation.authorized_request_fingerprint, 'hex')
      )
    );
    UPDATE public.posting_operations
      SET human_authorization_id = v_new_authorization_id,
          row_version = row_version + 1
      WHERE id = v_operation.id;
    SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
      FROM public.posting_events WHERE operation_id = v_operation.id;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id, event_sequence,
      event_type, reason_code, actor_kind, actor_user_id,
      authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id, v_sequence,
      'MANUAL_INTERVENTION', 'POSTING_HUMAN_AUTHORIZATION_REFRESHED',
      'USER', p_actor_user_id, v_operation.authorized_request_fingerprint,
      jsonb_build_object(
        'refreshRequestId', p_refresh_request_id,
        'priorAuthorizationId', v_prior_authorization.id,
        'newAuthorizationId', v_new_authorization_id,
        'expiresAt', v_expires_at,
        'immutableIntentFingerprint',
          encode(v_operation.authorized_request_fingerprint, 'hex'),
        'providerWrite', false
      )
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'operationId', v_operation.id,
      'authorizationId', v_new_authorization_id,
      'expiresAt', v_expires_at,
      'refreshed', true
    ));
  END LOOP;

  RETURN jsonb_build_object('kind', 'REFRESHED', 'authorizations', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_posting_human_authorizations_v1(
  uuid[], uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_posting_human_authorizations_v1(
  uuid[], uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
