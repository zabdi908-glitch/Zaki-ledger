-- Migration 027: order the bounded Sandbox pilot so expired authorization can
-- be refreshed only after immutable scope/evidence, live OAuth, and exact
-- current mappings have been independently re-proved.
BEGIN;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_sandbox_pilot_eligibility_v2(
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
  v_reason text;
  v_stop_state text;
  v_existing_bill_id text;
  v_existing_vendor_id text;
BEGIN
  IF p_vendor_operation_id IS NULL OR p_bill_operation_id IS NULL
     OR p_vendor_operation_id = p_bill_operation_id OR p_actor_user_id IS NULL
     OR btrim(COALESCE(p_external_vendor_id, '')) = ''
     OR octet_length(p_external_vendor_id) > 100
     OR p_external_vendor_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Sandbox pilot eligibility input';
  END IF;

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
  ELSIF public.posting_dispatch_evidence_status_v1(v_vendor.id) <> 'OK'
     OR public.posting_dispatch_evidence_status_v1(v_bill.id) <> 'OK' THEN
    v_reason := 'PILOT_EVIDENCE_NOT_CURRENT'; v_stop_state := 'REVIEW';
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
      'SANDBOX_PILOT_ELIGIBILITY_STOPPED', p_actor_user_id,
      jsonb_build_object('reasonCode', v_reason, 'stopState', v_stop_state,
        'vendorOperationId', v_vendor.id, 'externalVendorId', btrim(p_external_vendor_id),
        'providerWrite', false));
    RETURN jsonb_build_object('kind', 'STOP', 'state', v_stop_state,
      'reasonCode', v_reason);
  END IF;

  PERFORM public.posting_pilot_append_event_v1(v_bill.id,
    'SANDBOX_PILOT_ELIGIBILITY_VERIFIED', p_actor_user_id,
    jsonb_build_object('vendorOperationId', v_vendor.id,
      'externalVendorId', btrim(p_external_vendor_id),
      'immutableScopeVerified', true, 'evidenceVerified', true,
      'providerWrite', false));
  RETURN jsonb_build_object('kind', 'READY', 'scope', jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'providerConnectionId', v_bill.provider_connection_id,
    'realmId', v_bill.external_organisation_id,
    'vendorState', v_vendor.current_state,
    'billState', v_bill.current_state,
    'existingBillId', v_existing_bill_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.quickbooks_sandbox_pilot_mapping_status_v1(
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_item jsonb;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id;
  IF jsonb_typeof(v_operation.account_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_operation.account_treatment_snapshot) = 0 THEN
    RETURN 'PILOT_ACCOUNT_MAPPING_NOT_CURRENT';
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
        RETURN 'PILOT_ACCOUNT_MAPPING_NOT_CURRENT';
      END;
      IF NOT FOUND THEN RETURN 'PILOT_ACCOUNT_MAPPING_NOT_CURRENT'; END IF;
    ELSIF v_operation.external_object_type <> 'BILL'
          AND v_item->>'disposition' = 'NOT_APPLICABLE' THEN
      NULL;
    ELSE
      RETURN 'PILOT_ACCOUNT_MAPPING_NOT_CURRENT';
    END IF;
  END LOOP;

  IF jsonb_typeof(v_operation.tax_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_operation.tax_treatment_snapshot) = 0 THEN
    RETURN 'PILOT_TAX_MAPPING_NOT_CURRENT';
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
        RETURN 'PILOT_TAX_MAPPING_NOT_CURRENT';
      END;
      IF NOT FOUND THEN RETURN 'PILOT_TAX_MAPPING_NOT_CURRENT'; END IF;
    ELSIF v_operation.external_object_type <> 'BILL'
          AND v_item->>'disposition' = 'NOT_APPLICABLE' THEN
      NULL;
    ELSE
      RETURN 'PILOT_TAX_MAPPING_NOT_CURRENT';
    END IF;
  END LOOP;
  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.reverify_quickbooks_sandbox_pilot_mappings_v1(
  p_vendor_operation_id uuid,
  p_bill_operation_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vendor public.posting_operations%ROWTYPE;
  v_bill public.posting_operations%ROWTYPE;
  v_status text;
BEGIN
  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id = p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id = p_bill_operation_id;
  IF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id
     OR NOT public.posting_actor_can_post_v1(
       p_actor_user_id, v_bill.practice_id, v_bill.client_entity_id) THEN
    RETURN jsonb_build_object('kind', 'STOP', 'state', 'DENIED',
      'reasonCode', 'PILOT_OPERATION_PAIR_SCOPE_MISMATCH');
  END IF;

  v_status := public.quickbooks_sandbox_pilot_mapping_status_v1(v_vendor.id);
  IF v_status = 'OK' THEN
    v_status := public.quickbooks_sandbox_pilot_mapping_status_v1(v_bill.id);
  END IF;
  IF v_status <> 'OK' THEN
    PERFORM public.posting_pilot_append_event_v1(v_bill.id,
      'SANDBOX_PILOT_MAPPING_REVIEW', p_actor_user_id,
      jsonb_build_object('reasonCode', v_status, 'vendorOperationId', v_vendor.id,
        'accountTaxMappingsReverified', false, 'providerWrite', false));
    RETURN jsonb_build_object('kind', 'STOP', 'state', 'REVIEW',
      'reasonCode', v_status);
  END IF;

  PERFORM public.posting_pilot_append_event_v1(v_bill.id,
    'SANDBOX_PILOT_MAPPINGS_VERIFIED', p_actor_user_id,
    jsonb_build_object('vendorOperationId', v_vendor.id,
      'accountTaxMappingsReverified', true, 'providerWrite', false));
  RETURN jsonb_build_object('kind', 'READY');
END;
$$;

-- Preserve the 026 audit surface and add only the two authorization-ordering
-- events emitted by the authenticated coordinator.
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
    'SANDBOX_PILOT_AUTHORIZATION_REVIEW', 'SANDBOX_PILOT_AUTHORIZATION_REFRESHED',
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

REVOKE ALL ON FUNCTION public.prepare_quickbooks_sandbox_pilot_eligibility_v2(
  uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.quickbooks_sandbox_pilot_mapping_status_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reverify_quickbooks_sandbox_pilot_mappings_v1(
  uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_sandbox_pilot_eligibility_v2(
  uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverify_quickbooks_sandbox_pilot_mappings_v1(
  uuid,uuid,uuid) TO service_role;

COMMENT ON FUNCTION public.prepare_quickbooks_sandbox_pilot_eligibility_v2(
  uuid,uuid,uuid,text) IS
  'Immutable operation, evidence, actor, destination, and binding eligibility before OAuth; does not require fresh authorization or mappings.';
COMMENT ON FUNCTION public.reverify_quickbooks_sandbox_pilot_mappings_v1(
  uuid,uuid,uuid) IS
  'Read-only exact account/tax mapping revalidation for the bounded Sandbox pilot.';

NOTIFY pgrst, 'reload schema';
COMMIT;
