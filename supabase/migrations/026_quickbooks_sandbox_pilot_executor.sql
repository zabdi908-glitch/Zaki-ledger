-- Migration 026: one authenticated, explicit-operation QuickBooks Sandbox pilot coordinator.
-- This migration adds no posting semantics and grants no provider capability.

BEGIN;

CREATE OR REPLACE FUNCTION public.posting_pilot_append_event_v1(
  p_operation_id uuid,
  p_reason_code text,
  p_actor_user_id uuid,
  p_details jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_sequence bigint;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = p_operation_id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id, event_sequence,
    event_type, reason_code, actor_kind, actor_user_id,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id, v_sequence,
    'DECISION', p_reason_code, 'USER', p_actor_user_id,
    v_operation.authorized_request_fingerprint, p_details
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_sandbox_pilot_v1(
  p_vendor_operation_id uuid,
  p_bill_operation_id uuid,
  p_actor_user_id uuid,
  p_external_vendor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vendor public.posting_operations%ROWTYPE;
  v_bill public.posting_operations%ROWTYPE;
  v_account_count integer;
  v_tax_count integer;
  v_reason text;
  v_stop_state text;
  v_existing_bill_id text;
  v_existing_vendor_id text;
BEGIN
  IF p_vendor_operation_id IS NULL OR p_bill_operation_id IS NULL
     OR p_vendor_operation_id = p_bill_operation_id
     OR p_actor_user_id IS NULL
     OR btrim(COALESCE(p_external_vendor_id, '')) = ''
     OR octet_length(p_external_vendor_id) > 100
     OR p_external_vendor_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Sandbox pilot input';
  END IF;

  -- Stable lock order prevents two callers from interleaving this pair check.
  PERFORM 1 FROM public.posting_operations
    WHERE id IN (p_vendor_operation_id, p_bill_operation_id)
    ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id = p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id = p_bill_operation_id;

  IF v_bill.current_state IN ('REVIEW', 'DENIED', 'UNCERTAIN') THEN
    v_reason := 'PILOT_BILL_TERMINAL_STOP'; v_stop_state := v_bill.current_state;
  ELSIF v_vendor.current_state IN ('REVIEW', 'DENIED', 'UNCERTAIN') THEN
    v_reason := 'PILOT_VENDOR_TERMINAL_STOP'; v_stop_state := v_vendor.current_state;
  ELSIF v_bill.current_state NOT IN ('AUTHORIZED', 'SUCCEEDED') THEN
    v_reason := 'PILOT_BILL_NOT_DISPATCHABLE'; v_stop_state := v_bill.current_state;
  ELSIF v_vendor.current_state NOT IN ('AUTHORIZED', 'SUCCEEDED') THEN
    v_reason := 'PILOT_VENDOR_NOT_ADOPTABLE'; v_stop_state := v_vendor.current_state;
  ELSIF v_bill.provider <> 'quickbooks'
     OR v_bill.operation_kind <> 'ACCOUNTS_PAYABLE_BILL'
     OR v_bill.external_object_type <> 'BILL' OR v_bill.action <> 'CREATE'
     OR v_vendor.provider <> 'quickbooks'
     OR v_vendor.operation_kind <> 'ENSURE_VENDOR'
     OR v_vendor.external_object_type <> 'VENDOR' OR v_vendor.action <> 'CREATE' THEN
    v_reason := 'PILOT_OPERATION_PAIR_UNSUPPORTED'; v_stop_state := 'DENIED';
  ELSIF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.practice_id <> v_bill.practice_id
     OR v_vendor.client_entity_id <> v_bill.client_entity_id
     OR v_vendor.ledger_book_id <> v_bill.ledger_book_id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id THEN
    v_reason := 'PILOT_OPERATION_PAIR_SCOPE_MISMATCH'; v_stop_state := 'DENIED';
  ELSIF v_bill.requested_object#>>'{vendorChild,operationId}' <> v_vendor.id::text
     OR v_bill.requested_object#>>'{vendorChild,idempotencyKey}' <> v_vendor.idempotency_key
     OR lower(v_bill.requested_object#>>'{vendorChild,authorizedRequestFingerprint}')
        <> encode(v_vendor.authorized_request_fingerprint, 'hex') THEN
    v_reason := 'PILOT_VENDOR_CHILD_IDENTITY_MISMATCH'; v_stop_state := 'DENIED';
  ELSIF NOT public.posting_actor_can_post_v1(
      p_actor_user_id, v_bill.practice_id, v_bill.client_entity_id) THEN
    v_reason := 'PILOT_ACTOR_UNAUTHORIZED'; v_stop_state := 'DENIED';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.client_entities client
    JOIN public.ledger_books book ON book.id = v_bill.ledger_book_id
      AND book.client_entity_id = client.id AND book.status = 'active'
    JOIN public.provider_connections connection ON connection.id = v_bill.provider_connection_id
      AND connection.client_entity_id = client.id
      AND connection.ledger_book_id = book.id
      AND connection.provider = 'quickbooks'
      AND connection.external_organisation_id = v_bill.external_organisation_id
      AND connection.status = 'active'
    WHERE client.id = v_bill.client_entity_id
      AND client.practice_id = v_bill.practice_id AND client.status = 'active'
  ) THEN
    v_reason := 'PILOT_DESTINATION_INVALID'; v_stop_state := 'DENIED';
  END IF;

  -- Refresh means re-prove the exact immutable authorizations at this instant;
  -- it never replaces or edits an authorization attached to an operation.
  IF v_reason IS NULL AND (
    NOT EXISTS (
      SELECT 1 FROM public.posting_human_authorizations auth_record
      WHERE auth_record.id = v_vendor.human_authorization_id
        AND auth_record.authorized_request_fingerprint = v_vendor.authorized_request_fingerprint
        AND auth_record.approved_at <= now()
        AND (auth_record.expires_at IS NULL OR auth_record.expires_at > now())
        AND public.posting_actor_can_post_v1(auth_record.approved_by_user_id,
          auth_record.practice_id, auth_record.client_entity_id))
    OR
    NOT EXISTS (
      SELECT 1 FROM public.posting_human_authorizations auth_record
      WHERE auth_record.id = v_bill.human_authorization_id
        AND auth_record.authorized_request_fingerprint = v_bill.authorized_request_fingerprint
        AND auth_record.approved_at <= now()
        AND (auth_record.expires_at IS NULL OR auth_record.expires_at > now())
        AND public.posting_actor_can_post_v1(auth_record.approved_by_user_id,
          auth_record.practice_id, auth_record.client_entity_id))
  ) THEN
    v_reason := 'PILOT_EXACT_AUTHORIZATION_STALE'; v_stop_state := 'REVIEW';
  END IF;

  IF v_reason IS NULL AND (
    public.posting_dispatch_evidence_status_v1(v_vendor.id) <> 'OK'
    OR public.posting_dispatch_evidence_status_v1(v_bill.id) <> 'OK'
  ) THEN
    v_reason := 'PILOT_EVIDENCE_NOT_CURRENT'; v_stop_state := 'REVIEW';
  END IF;

  IF v_reason IS NULL THEN
    SELECT count(*) INTO v_account_count
    FROM public.eligible_provider_posting_accounts mapping
    WHERE jsonb_array_length(v_bill.account_treatment_snapshot) = 1
      AND v_bill.account_treatment_snapshot->0->>'disposition' = 'MAPPED'
      AND mapping.id = CASE
        WHEN v_bill.account_treatment_snapshot->0->>'mappingId' ~*
          '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN (v_bill.account_treatment_snapshot->0->>'mappingId')::uuid ELSE NULL END
      AND mapping.practice_id = v_bill.practice_id
      AND mapping.client_entity_id = v_bill.client_entity_id
      AND mapping.ledger_book_id = v_bill.ledger_book_id
      AND mapping.provider_connection_id = v_bill.provider_connection_id
      AND mapping.provider = 'quickbooks'
      AND mapping.external_organisation_id = v_bill.external_organisation_id;
    IF v_account_count <> 1 THEN
      v_reason := 'PILOT_ACCOUNT_MAPPING_NOT_CURRENT'; v_stop_state := 'REVIEW';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT count(*) INTO v_tax_count
    FROM public.eligible_provider_tax_treatments mapping
    WHERE jsonb_array_length(v_bill.tax_treatment_snapshot) = 1
      AND v_bill.tax_treatment_snapshot->0->>'disposition' = 'MAPPED'
      AND mapping.id = CASE
        WHEN v_bill.tax_treatment_snapshot->0->>'treatmentId' ~*
          '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        THEN (v_bill.tax_treatment_snapshot->0->>'treatmentId')::uuid ELSE NULL END
      AND mapping.practice_id = v_bill.practice_id
      AND mapping.client_entity_id = v_bill.client_entity_id
      AND mapping.ledger_book_id = v_bill.ledger_book_id
      AND mapping.provider_connection_id = v_bill.provider_connection_id
      AND mapping.provider = 'quickbooks'
      AND mapping.external_organisation_id = v_bill.external_organisation_id
      AND mapping.provider_tax_code = v_bill.tax_treatment_snapshot->0->>'providerTaxCode'
      AND encode(mapping.evidence_fingerprint, 'hex') =
          lower(v_bill.tax_treatment_snapshot->0->>'evidenceFingerprint');
    IF v_tax_count <> 1 THEN
      v_reason := 'PILOT_TAX_MAPPING_NOT_CURRENT'; v_stop_state := 'REVIEW';
    END IF;
  END IF;

  IF v_reason IS NULL AND v_vendor.current_state = 'SUCCEEDED' THEN
    SELECT external_object_id INTO v_existing_vendor_id
      FROM public.provider_object_bindings
      WHERE originating_operation_id = v_vendor.id AND external_object_type = 'VENDOR';
    IF v_existing_vendor_id IS DISTINCT FROM btrim(p_external_vendor_id) THEN
      v_reason := 'PILOT_VENDOR_BINDING_MISMATCH'; v_stop_state := 'DENIED';
    END IF;
  END IF;
  IF v_reason IS NULL AND v_bill.current_state = 'SUCCEEDED' THEN
    SELECT external_object_id INTO v_existing_bill_id
      FROM public.provider_object_bindings
      WHERE originating_operation_id = v_bill.id AND external_object_type = 'BILL';
    IF v_existing_bill_id IS NULL THEN
      v_reason := 'PILOT_BILL_BINDING_MISSING'; v_stop_state := 'UNCERTAIN';
    END IF;
  END IF;
  IF v_reason IS NULL AND v_bill.current_state = 'AUTHORIZED' AND EXISTS (
    SELECT 1 FROM public.provider_object_bindings
    WHERE originating_operation_id = v_bill.id
  ) THEN
    v_reason := 'PILOT_UNEXPECTED_BILL_BINDING'; v_stop_state := 'UNCERTAIN';
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.posting_pilot_append_event_v1(v_bill.id,
      'SANDBOX_PILOT_PREFLIGHT_STOPPED', p_actor_user_id,
      jsonb_build_object('reasonCode', v_reason, 'stopState', v_stop_state,
        'vendorOperationId', v_vendor.id, 'externalVendorId', btrim(p_external_vendor_id),
        'providerWrite', false));
    RETURN jsonb_build_object('kind', 'STOP', 'state', v_stop_state,
      'reasonCode', v_reason);
  END IF;

  PERFORM public.posting_pilot_append_event_v1(v_bill.id,
    'SANDBOX_PILOT_PREFLIGHT_ALLOWED', p_actor_user_id,
    jsonb_build_object('vendorOperationId', v_vendor.id,
      'externalVendorId', btrim(p_external_vendor_id),
      'vendorState', v_vendor.current_state, 'billState', v_bill.current_state,
      'accountMappingReverified', true, 'taxMappingReverified', true,
      'exactAuthorizationsReverified', true, 'providerWrite', false));
  RETURN jsonb_build_object('kind', 'READY', 'scope', jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'providerConnectionId', v_bill.provider_connection_id,
    'realmId', v_bill.external_organisation_id,
    'vendorState', v_vendor.current_state,
    'billState', v_bill.current_state,
    'existingBillId', v_existing_bill_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_sandbox_pilot_event_v1(
  p_vendor_operation_id uuid,
  p_bill_operation_id uuid,
  p_actor_user_id uuid,
  p_reason_code text,
  p_details jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vendor public.posting_operations%ROWTYPE;
  v_bill public.posting_operations%ROWTYPE;
  v_allowed constant text[] := ARRAY[
    'SANDBOX_PILOT_OAUTH_REVIEW', 'SANDBOX_PILOT_OAUTH_VERIFIED',
    'SANDBOX_PILOT_VENDOR_SUCCEEDED', 'SANDBOX_PILOT_STOPPED_AFTER_VENDOR',
    'SANDBOX_PILOT_STOPPED_AFTER_BILL', 'SANDBOX_PILOT_EXISTING_SUCCESS',
    'SANDBOX_PILOT_SUCCEEDED'
  ];
BEGIN
  IF NOT (p_reason_code = ANY(v_allowed)) OR p_details IS NULL
     OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Sandbox pilot audit event';
  END IF;
  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id = p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id = p_bill_operation_id FOR UPDATE;
  IF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id
     OR NOT public.posting_actor_can_post_v1(
       p_actor_user_id, v_bill.practice_id, v_bill.client_entity_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sandbox pilot audit scope denied';
  END IF;
  PERFORM public.posting_pilot_append_event_v1(v_bill.id, p_reason_code,
    p_actor_user_id, p_details || jsonb_build_object(
      'environment', 'sandbox', 'vendorOperationId', v_vendor.id));
END;
$$;

REVOKE ALL ON FUNCTION public.posting_pilot_append_event_v1(uuid,text,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_sandbox_pilot_v1(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_sandbox_pilot_event_v1(uuid,uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_sandbox_pilot_v1(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_sandbox_pilot_event_v1(uuid,uuid,uuid,text,jsonb)
  TO service_role;

COMMENT ON FUNCTION public.prepare_quickbooks_sandbox_pilot_v1(uuid,uuid,uuid,text) IS
  'Read-only Step-5 operation-pair revalidation plus append-only preflight audit; grants no provider capability.';

NOTIFY pgrst, 'reload schema';
COMMIT;
