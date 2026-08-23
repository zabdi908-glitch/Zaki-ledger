-- Step 5 Day 4 Task 1: narrow QuickBooks CREATE BILL execution contract.
--
-- This migration defines only durable local state transitions and mappings.
-- It contains no credentials, HTTP implementation, deployment action, or
-- production application step.

BEGIN;

CREATE TABLE public.provider_tax_treatment_mappings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                uuid NOT NULL,
  client_entity_id           uuid NOT NULL,
  ledger_book_id             uuid NOT NULL,
  provider_connection_id     uuid NOT NULL,
  provider                   text NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
  external_organisation_id   text NOT NULL CHECK (btrim(external_organisation_id) <> ''),
  provider_tax_code          text NOT NULL CHECK (btrim(provider_tax_code) <> ''),
  treatment_name             text NOT NULL CHECK (btrim(treatment_name) <> ''),
  evidence_fingerprint       bytea NOT NULL CHECK (octet_length(evidence_fingerprint) = 32),
  mapping_status             text NOT NULL DEFAULT 'active'
                             CHECK (mapping_status IN ('active', 'inactive', 'archived', 'unknown')),
  effective_from             timestamptz NOT NULL DEFAULT now(),
  effective_to               timestamptz,
  verified_at                timestamptz NOT NULL,
  eligibility_expires_at     timestamptz NOT NULL,
  provider_updated_at        timestamptz,
  provider_version           text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  archived_at                timestamptz,
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id),
  UNIQUE (provider_connection_id, external_organisation_id, provider_tax_code),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id, ledger_book_id,
               provider, external_organisation_id)
    REFERENCES public.provider_connections
      (id, client_entity_id, ledger_book_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (eligibility_expires_at > verified_at),
  CHECK ((mapping_status = 'archived') = (archived_at IS NOT NULL))
);

CREATE VIEW public.eligible_provider_tax_treatments
WITH (security_invoker = true)
AS
SELECT mapping.*
FROM public.provider_tax_treatment_mappings AS mapping
JOIN public.client_entities AS client
  ON client.id = mapping.client_entity_id
 AND client.practice_id = mapping.practice_id
 AND client.status = 'active'
JOIN public.ledger_books AS book
  ON book.id = mapping.ledger_book_id
 AND book.client_entity_id = mapping.client_entity_id
 AND book.status = 'active'
JOIN public.provider_connections AS connection
  ON connection.id = mapping.provider_connection_id
 AND connection.client_entity_id = mapping.client_entity_id
 AND connection.ledger_book_id = mapping.ledger_book_id
 AND connection.provider = mapping.provider
 AND connection.external_organisation_id = mapping.external_organisation_id
 AND connection.status = 'active'
WHERE mapping.mapping_status = 'active'
  AND mapping.effective_from <= now()
  AND (mapping.effective_to IS NULL OR mapping.effective_to > now())
  AND mapping.verified_at <= now()
  AND mapping.eligibility_expires_at > now();

CREATE OR REPLACE FUNCTION public.posting_tax_mapping_protect_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
       NEW.id, NEW.practice_id, NEW.client_entity_id, NEW.ledger_book_id,
       NEW.provider_connection_id, NEW.provider, NEW.external_organisation_id,
       NEW.provider_tax_code, NEW.evidence_fingerprint, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.practice_id, OLD.client_entity_id, OLD.ledger_book_id,
       OLD.provider_connection_id, OLD.provider, OLD.external_organisation_id,
       OLD.provider_tax_code, OLD.evidence_fingerprint, OLD.created_at
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'provider tax-treatment mapping identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_tax_treatment_mapping_identity_immutable
  BEFORE UPDATE ON public.provider_tax_treatment_mappings
  FOR EACH ROW EXECUTE FUNCTION public.posting_tax_mapping_protect_identity_v1();

CREATE TRIGGER provider_tax_treatment_mapping_no_delete
  BEFORE DELETE ON public.provider_tax_treatment_mappings
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.posting_actor_can_post_v1(
  p_user_id uuid,
  p_practice_id uuid,
  p_client_entity_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.practice_memberships membership
    WHERE membership.practice_id = p_practice_id
      AND membership.user_id = p_user_id
      AND membership.status = 'active'
      AND membership.valid_from <= now()
      AND (membership.valid_to IS NULL OR membership.valid_to > now())
      AND (
        membership.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1
          FROM public.client_access access_grant
          WHERE access_grant.membership_id = membership.id
            AND access_grant.user_id = p_user_id
            AND access_grant.client_entity_id = p_client_entity_id
            AND access_grant.role IN ('admin', 'bookkeeper')
            AND access_grant.status = 'active'
            AND access_grant.valid_from <= now()
            AND (access_grant.valid_to IS NULL OR access_grant.valid_to > now())
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.quickbooks_bill_execution_grant_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_state_key text,
  p_state_value text,
  p_known_external_bill_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_attempt public.posting_attempts%ROWTYPE;
  v_account public.provider_posting_account_mappings%ROWTYPE;
  v_tax public.provider_tax_treatment_mappings%ROWTYPE;
  v_child public.posting_operations%ROWTYPE;
  v_vendor_binding public.provider_object_bindings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations WHERE id = p_operation_id;
  SELECT * INTO STRICT v_attempt FROM public.posting_attempts WHERE id = p_attempt_id
    AND operation_id = p_operation_id;
  SELECT * INTO STRICT v_account FROM public.provider_posting_account_mappings
    WHERE id = (v_operation.account_treatment_snapshot->0->>'mappingId')::uuid;
  SELECT * INTO STRICT v_tax FROM public.provider_tax_treatment_mappings
    WHERE id = (v_operation.tax_treatment_snapshot->0->>'treatmentId')::uuid;
  SELECT * INTO STRICT v_child FROM public.posting_operations
    WHERE id = (v_operation.requested_object#>>'{vendorChild,operationId}')::uuid;
  SELECT * INTO STRICT v_vendor_binding FROM public.provider_object_bindings
    WHERE originating_operation_id = v_child.id;

  RETURN jsonb_build_object(
    'operation', jsonb_build_object(
      'id', v_operation.id,
      p_state_key, p_state_value,
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
      'id', v_attempt.id,
      'number', v_attempt.attempt_number,
      'kind', v_attempt.attempt_kind,
      'providerIdempotencyToken', v_attempt.provider_idempotency_token
    ),
    'accountMapping', jsonb_build_object(
      'id', v_account.id,
      'providerAccountId', v_account.provider_account_id,
      'providerAccountType', v_account.provider_account_type,
      'eligible', true,
      'scope', jsonb_build_object(
        'practiceId', v_account.practice_id,
        'clientEntityId', v_account.client_entity_id,
        'ledgerBookId', v_account.ledger_book_id,
        'providerConnectionId', v_account.provider_connection_id,
        'externalOrganisationId', v_account.external_organisation_id
      )
    ),
    'taxMapping', jsonb_build_object(
      'id', v_tax.id,
      'providerTaxCode', v_tax.provider_tax_code,
      'evidenceFingerprint', encode(v_tax.evidence_fingerprint, 'hex'),
      'eligible', true,
      'scope', jsonb_build_object(
        'practiceId', v_tax.practice_id,
        'clientEntityId', v_tax.client_entity_id,
        'ledgerBookId', v_tax.ledger_book_id,
        'providerConnectionId', v_tax.provider_connection_id,
        'externalOrganisationId', v_tax.external_organisation_id
      )
    ),
    'vendorChild', jsonb_build_object(
      'operationId', v_child.id,
      'state', v_child.current_state,
      'externalVendorId', v_vendor_binding.external_object_id,
      'verifiedProviderStateFingerprint',
        encode(v_vendor_binding.verified_provider_state_fingerprint, 'hex')
    ),
    'requestedObject', v_operation.requested_object,
    'expectedMaterialState', v_operation.expected_material_state,
    'knownExternalBillId', p_known_external_bill_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_bill_submission_v1(
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
  v_account public.provider_posting_account_mappings%ROWTYPE;
  v_tax public.provider_tax_treatment_mappings%ROWTYPE;
  v_child public.posting_operations%ROWTYPE;
  v_vendor_binding public.provider_object_bindings%ROWTYPE;
  v_binding public.provider_object_bindings%ROWTYPE;
  v_attempt_id uuid := gen_random_uuid();
  v_lease_id uuid := gen_random_uuid();
  v_attempt_number integer;
  v_sequence bigint;
  v_reason text;
  v_child_id_text text;
BEGIN
  IF p_lease_seconds < 1 OR p_lease_seconds > 600
     OR btrim(COALESCE(p_adapter_name, '')) = ''
     OR btrim(COALESCE(p_adapter_version, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid dispatch preparation input';
  END IF;

  SELECT * INTO STRICT v_operation FROM public.posting_operations
  WHERE id = p_operation_id FOR UPDATE;

  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id;
    RETURN jsonb_build_object('kind', 'SUCCEEDED',
      'externalBillId', v_binding.external_object_id);
  END IF;
  IF v_operation.current_state IN ('SUBMITTING', 'VERIFYING', 'UNCERTAIN') THEN
    RETURN jsonb_build_object('kind', 'RECOVERY_REQUIRED',
      'state', v_operation.current_state);
  END IF;
  IF v_operation.current_state <> 'AUTHORIZED' THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', 'OPERATION_NOT_AUTHORIZED');
  END IF;

  v_reason := NULL;
  IF v_operation.provider <> 'quickbooks'
     OR v_operation.external_object_type <> 'BILL'
     OR v_operation.action <> 'CREATE'
     OR v_operation.operation_kind <> 'ACCOUNTS_PAYABLE_BILL' THEN
    v_reason := 'UNSUPPORTED_QUICKBOOKS_OPERATION';
  ELSIF NOT public.posting_actor_can_post_v1(
      p_actor_user_id, v_operation.practice_id, v_operation.client_entity_id) THEN
    v_reason := 'DISPATCH_ACTOR_UNAUTHORIZED';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.client_entities client
    JOIN public.ledger_books book
      ON book.id = v_operation.ledger_book_id
     AND book.client_entity_id = client.id AND book.status = 'active'
    JOIN public.provider_connections connection
      ON connection.id = v_operation.provider_connection_id
     AND connection.client_entity_id = client.id
     AND connection.ledger_book_id = book.id
     AND connection.provider = 'quickbooks'
     AND connection.external_organisation_id = v_operation.external_organisation_id
     AND connection.status = 'active'
    WHERE client.id = v_operation.client_entity_id
      AND client.practice_id = v_operation.practice_id
      AND client.status = 'active'
  ) THEN
    v_reason := 'DISPATCH_DESTINATION_INVALID';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.posting_human_authorizations auth_record
    WHERE auth_record.id = v_operation.human_authorization_id
      AND auth_record.authorized_request_fingerprint = v_operation.authorized_request_fingerprint
      AND auth_record.approved_at <= now()
      AND (auth_record.expires_at IS NULL OR auth_record.expires_at > now())
      AND public.posting_actor_can_post_v1(
        auth_record.approved_by_user_id,
        auth_record.practice_id,
        auth_record.client_entity_id)
  ) THEN
    v_reason := 'DISPATCH_APPROVAL_STALE';
  END IF;

  IF v_reason IS NULL THEN
    IF jsonb_array_length(v_operation.account_treatment_snapshot) <> 1
       OR v_operation.account_treatment_snapshot->0->>'disposition' <> 'MAPPED' THEN
      v_reason := 'DISPATCH_ACCOUNT_MAPPING_INVALID';
    ELSE
      BEGIN
        SELECT * INTO STRICT v_account FROM public.eligible_provider_posting_accounts
        WHERE id = (v_operation.account_treatment_snapshot->0->>'mappingId')::uuid
          AND practice_id = v_operation.practice_id
          AND client_entity_id = v_operation.client_entity_id
          AND ledger_book_id = v_operation.ledger_book_id
          AND provider_connection_id = v_operation.provider_connection_id
          AND provider = 'quickbooks'
          AND external_organisation_id = v_operation.external_organisation_id;
      EXCEPTION WHEN OTHERS THEN
        v_reason := 'DISPATCH_ACCOUNT_MAPPING_INVALID';
      END;
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    IF jsonb_array_length(v_operation.tax_treatment_snapshot) <> 1
       OR v_operation.tax_treatment_snapshot->0->>'disposition' <> 'MAPPED' THEN
      v_reason := 'DISPATCH_TAX_MAPPING_INVALID';
    ELSE
      BEGIN
        SELECT * INTO STRICT v_tax FROM public.eligible_provider_tax_treatments
        WHERE id = (v_operation.tax_treatment_snapshot->0->>'treatmentId')::uuid
          AND practice_id = v_operation.practice_id
          AND client_entity_id = v_operation.client_entity_id
          AND ledger_book_id = v_operation.ledger_book_id
          AND provider_connection_id = v_operation.provider_connection_id
          AND provider = 'quickbooks'
          AND external_organisation_id = v_operation.external_organisation_id
          AND provider_tax_code = v_operation.tax_treatment_snapshot->0->>'providerTaxCode'
          AND encode(evidence_fingerprint, 'hex') =
              lower(v_operation.tax_treatment_snapshot->0->>'evidenceFingerprint');
      EXCEPTION WHEN OTHERS THEN
        v_reason := 'DISPATCH_TAX_MAPPING_INVALID';
      END;
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    v_child_id_text := v_operation.requested_object#>>'{vendorChild,operationId}';
    BEGIN
      SELECT * INTO STRICT v_child FROM public.posting_operations
      WHERE id = v_child_id_text::uuid
        AND parent_operation_id = v_operation.id
        AND practice_id = v_operation.practice_id
        AND client_entity_id = v_operation.client_entity_id
        AND ledger_book_id = v_operation.ledger_book_id
        AND provider_connection_id = v_operation.provider_connection_id
        AND provider = 'quickbooks'
        AND external_organisation_id = v_operation.external_organisation_id
        AND operation_kind = 'ENSURE_VENDOR'
        AND external_object_type = 'VENDOR'
        AND action = 'CREATE'
        AND idempotency_key = v_operation.requested_object#>>'{vendorChild,idempotencyKey}'
        AND encode(authorized_request_fingerprint, 'hex') =
            lower(v_operation.requested_object#>>'{vendorChild,authorizedRequestFingerprint}');
    EXCEPTION WHEN OTHERS THEN
      v_reason := 'VENDOR_CHILD_INVALID';
    END;
  END IF;

  IF v_reason IS NULL AND v_child.current_state <> 'SUCCEEDED' THEN
    SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
      FROM public.posting_events WHERE operation_id = v_operation.id;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      event_sequence, event_type, reason_code, actor_kind, actor_service,
      authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      v_sequence, 'DECISION', 'VENDOR_CHILD_UNRESOLVED', 'SERVICE',
      'AuthoritativePostingService', v_operation.authorized_request_fingerprint,
      jsonb_build_object('vendorChildOperationId', v_child.id,
                         'vendorChildState', v_child.current_state)
    );
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', 'VENDOR_CHILD_UNRESOLVED');
  END IF;

  IF v_reason IS NULL THEN
    BEGIN
      SELECT * INTO STRICT v_vendor_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_child.id
        AND provider_connection_id = v_operation.provider_connection_id
        AND external_organisation_id = v_operation.external_organisation_id
        AND external_object_type = 'VENDOR';
    EXCEPTION WHEN OTHERS THEN
      v_reason := 'VENDOR_CHILD_BINDING_MISSING';
    END;
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE public.posting_operations
      SET current_state = 'DENIED', row_version = row_version + 1
      WHERE id = v_operation.id RETURNING * INTO v_operation;
    SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
      FROM public.posting_events WHERE operation_id = v_operation.id;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      event_sequence, event_type, prior_state, new_state, reason_code,
      actor_kind, actor_service, authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      v_sequence, 'TRANSITION', 'AUTHORIZED', 'DENIED', v_reason,
      'SERVICE', 'AuthoritativePostingService',
      v_operation.authorized_request_fingerprint,
      jsonb_build_object('phase', 'dispatch-revalidation')
    );
    RETURN jsonb_build_object('kind', 'DENIED', 'state', 'DENIED',
      'reasonCode', v_reason);
  END IF;

  SELECT COALESCE(max(attempt_number), 0) + 1 INTO v_attempt_number
    FROM public.posting_attempts WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_attempts (
    id, operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_number, attempt_kind, execution_lease_id, adapter_name,
    adapter_version, authorized_request_fingerprint,
    provider_idempotency_token, lease_expires_at
  ) VALUES (
    v_attempt_id, v_operation.id, v_operation.practice_id,
    v_operation.client_entity_id, v_operation.ledger_book_id,
    v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, v_attempt_number, 'SUBMIT',
    v_lease_id, p_adapter_name, p_adapter_version,
    v_operation.authorized_request_fingerprint,
    'zaki-qb-' || v_operation.id::text || '-' || v_attempt_number::text,
    now() + make_interval(secs => p_lease_seconds)
  );

  UPDATE public.posting_operations
    SET current_state = 'SUBMITTING', row_version = row_version + 1
    WHERE id = v_operation.id RETURNING * INTO v_operation;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, prior_state, new_state,
    reason_code, actor_kind, actor_service,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    v_attempt_id, v_sequence, 'TRANSITION', 'AUTHORIZED', 'SUBMITTING',
    'QUICKBOOKS_BILL_DISPATCH_PREPARED', 'SERVICE',
    'AuthoritativePostingService', v_operation.authorized_request_fingerprint,
    jsonb_build_object('adapterName', p_adapter_name, 'adapterVersion', p_adapter_version)
  );
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, reason_code, actor_kind,
    actor_service, authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    v_attempt_id, v_sequence + 1, 'DISPATCH', 'QUICKBOOKS_BILL_DISPATCH_COMMITTED',
    'SERVICE', 'AuthoritativePostingService',
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('attemptNumber', v_attempt_number,
                       'providerIdempotencyToken',
                       'zaki-qb-' || v_operation.id::text || '-' || v_attempt_number::text)
  );

  RETURN jsonb_build_object('kind', 'DISPATCH', 'grant',
    public.quickbooks_bill_execution_grant_v1(
      v_operation.id, v_attempt_id, 'stateAtDispatch', 'AUTHORIZED', NULL));
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_quickbooks_bill_recovery_v1(
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
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.current_state = 'SUCCEEDED' THEN
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id;
    RETURN jsonb_build_object('kind', 'SUCCEEDED',
      'externalBillId', v_binding.external_object_id);
  END IF;
  IF v_operation.current_state NOT IN ('SUBMITTING', 'VERIFYING', 'UNCERTAIN') THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', 'RECOVERY_STATE_NOT_ELIGIBLE');
  END IF;
  IF v_operation.provider <> 'quickbooks' OR v_operation.external_object_type <> 'BILL'
     OR v_operation.action <> 'CREATE' THEN
    RETURN jsonb_build_object('kind', 'BLOCKED', 'state', v_operation.current_state,
      'reasonCode', 'UNSUPPORTED_QUICKBOOKS_OPERATION');
  END IF;

  v_original_state := v_operation.current_state;
  SELECT details->>'externalBillId' INTO v_known_external_id
  FROM public.posting_events
  WHERE operation_id = v_operation.id
    AND event_type = 'PROVIDER_RESPONSE'
    AND details ? 'externalBillId'
  ORDER BY event_sequence DESC LIMIT 1;

  SELECT COALESCE(max(attempt_number), 0) + 1 INTO v_attempt_number
    FROM public.posting_attempts WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_attempts (
    id, operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_number, attempt_kind, execution_lease_id, adapter_name,
    adapter_version, authorized_request_fingerprint,
    provider_idempotency_token, lease_expires_at
  ) VALUES (
    v_attempt_id, v_operation.id, v_operation.practice_id,
    v_operation.client_entity_id, v_operation.ledger_book_id,
    v_operation.provider_connection_id, v_operation.provider,
    v_operation.external_organisation_id, v_attempt_number, 'RECOVERY',
    gen_random_uuid(), p_adapter_name, p_adapter_version,
    v_operation.authorized_request_fingerprint,
    'zaki-qb-' || v_operation.id::text || '-recovery-' || v_attempt_number::text,
    now() + make_interval(secs => p_lease_seconds)
  );

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  IF v_operation.current_state <> 'VERIFYING' THEN
    UPDATE public.posting_operations
      SET current_state = 'VERIFYING', row_version = row_version + 1
      WHERE id = v_operation.id RETURNING * INTO v_operation;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, event_sequence, event_type, prior_state, new_state,
      reason_code, actor_kind, actor_service,
      authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      v_attempt_id, v_sequence, 'TRANSITION', v_original_state, 'VERIFYING',
      'QUICKBOOKS_BILL_RECOVERY_STARTED', 'SERVICE',
      'AuthoritativePostingService', v_operation.authorized_request_fingerprint,
      jsonb_build_object('readOnly', true)
    );
    v_sequence := v_sequence + 1;
  END IF;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, reason_code, actor_kind,
    actor_service, authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    v_attempt_id, v_sequence, 'RECOVERY', 'QUICKBOOKS_BILL_READ_ONLY_RECOVERY',
    'SERVICE', 'AuthoritativePostingService',
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('knownExternalBillId', v_known_external_id, 'readOnly', true)
  );

  RETURN jsonb_build_object('kind', 'RECOVER', 'grant',
    public.quickbooks_bill_execution_grant_v1(
      v_operation.id, v_attempt_id, 'stateAtRecovery', v_original_state,
      v_known_external_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_bill_acknowledged_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_external_bill_id text,
  p_provider_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_prior_state text;
  v_sequence bigint;
BEGIN
  IF btrim(COALESCE(p_external_bill_id, '')) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'external Bill ID is required';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts
    WHERE id = p_attempt_id AND operation_id = p_operation_id AND attempt_kind = 'SUBMIT';
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid QuickBooks submit attempt'; END IF;
  IF v_operation.current_state NOT IN ('SUBMITTING', 'VERIFYING', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'cannot acknowledge Bill from state %', v_operation.current_state;
  END IF;
  v_prior_state := v_operation.current_state;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, reason_code, actor_kind,
    actor_service, authorized_request_fingerprint, provider_correlation_id, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    p_attempt_id, v_sequence, 'PROVIDER_RESPONSE', 'QUICKBOOKS_BILL_CREATE_ACKNOWLEDGED',
    'SERVICE', 'QuickBooksPostingAdapter', v_operation.authorized_request_fingerprint,
    NULLIF(btrim(p_provider_request_id), ''),
    jsonb_build_object('result', 'CREATED', 'externalBillId', btrim(p_external_bill_id))
  );
  IF v_prior_state <> 'VERIFYING' THEN
    UPDATE public.posting_operations SET current_state = 'VERIFYING',
      row_version = row_version + 1 WHERE id = v_operation.id RETURNING * INTO v_operation;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, event_sequence, event_type, prior_state, new_state,
      reason_code, actor_kind, actor_service,
      authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      p_attempt_id, v_sequence + 1, 'TRANSITION', v_prior_state, 'VERIFYING',
      'QUICKBOOKS_BILL_CREATE_ACKNOWLEDGED', 'SERVICE',
      'AuthoritativePostingService', v_operation.authorized_request_fingerprint,
      jsonb_build_object('externalBillId', btrim(p_external_bill_id))
    );
  END IF;
  RETURN jsonb_build_object('state', 'VERIFYING');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_bill_failure_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_target_state text,
  p_failure_classification text,
  p_failure_code text,
  p_sanitized_summary text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_prior_state text;
  v_sequence bigint;
BEGIN
  IF p_target_state NOT IN ('FAILED_SAFE', 'UNCERTAIN') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid failure target state';
  END IF;
  IF p_target_state = 'FAILED_SAFE'
     AND p_failure_classification NOT IN ('VALIDATION_REJECTION', 'BEFORE_DELIVERY') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'FAILED_SAFE requires proof of rejection or no delivery';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts
    WHERE id = p_attempt_id AND operation_id = p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid QuickBooks attempt'; END IF;
  IF v_operation.current_state NOT IN ('SUBMITTING', 'VERIFYING', 'UNCERTAIN') THEN
    RAISE EXCEPTION 'cannot record provider failure from state %', v_operation.current_state;
  END IF;
  v_prior_state := v_operation.current_state;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, reason_code, actor_kind,
    actor_service, authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    p_attempt_id, v_sequence, 'PROVIDER_RESPONSE', left(p_failure_code, 120),
    'SERVICE', 'QuickBooksPostingAdapter', v_operation.authorized_request_fingerprint,
    jsonb_build_object('classification', p_failure_classification,
                       'code', left(p_failure_code, 120),
                       'summaryStored', false)
  );
  IF v_prior_state <> p_target_state THEN
    UPDATE public.posting_operations SET current_state = p_target_state,
      row_version = row_version + 1 WHERE id = v_operation.id RETURNING * INTO v_operation;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, event_sequence, event_type, prior_state, new_state,
      reason_code, actor_kind, actor_service,
      authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      p_attempt_id, v_sequence + 1, 'TRANSITION', v_prior_state, p_target_state,
      left(p_failure_code, 120), 'SERVICE', 'AuthoritativePostingService',
      v_operation.authorized_request_fingerprint,
      jsonb_build_object('classification', p_failure_classification)
    );
  END IF;
  RETURN jsonb_build_object(
    'operationId', v_operation.id, 'state', p_target_state,
    'externalBillId', NULL, 'reasonCodes', jsonb_build_array(left(p_failure_code, 120)),
    'resumed', false, 'recovered', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_quickbooks_bill_observation_v1(
  p_operation_id uuid,
  p_attempt_id uuid,
  p_external_bill_id text,
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
  v_fingerprint bytea;
  v_binding public.provider_object_bindings%ROWTYPE;
  v_sequence bigint;
  v_target_state text;
BEGIN
  IF p_comparison_outcome NOT IN ('MATCH', 'MISMATCH', 'INCONCLUSIVE') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid comparison outcome';
  END IF;
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  PERFORM 1 FROM public.posting_attempts
    WHERE id = p_attempt_id AND operation_id = p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid QuickBooks observation attempt'; END IF;
  IF v_operation.current_state <> 'VERIFYING' THEN
    RAISE EXCEPTION 'provider observation requires VERIFYING, found %', v_operation.current_state;
  END IF;

  IF p_comparison_outcome <> 'INCONCLUSIVE' THEN
    IF p_provider_state_fingerprint_hex !~ '^[0-9a-fA-F]{64}$'
       OR jsonb_typeof(p_normalized_provider_state) <> 'object'
       OR btrim(COALESCE(p_external_bill_id, '')) = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid provider observation';
    END IF;
    v_fingerprint := decode(lower(p_provider_state_fingerprint_hex), 'hex');
  END IF;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = v_operation.id;

  IF p_comparison_outcome = 'MATCH' THEN
    INSERT INTO public.provider_object_bindings (
      originating_operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      external_object_type, external_object_id, binding_kind,
      verified_provider_state_fingerprint, provider_version, verified_at
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      'BILL', btrim(p_external_bill_id), 'CREATED', v_fingerprint,
      NULLIF(btrim(p_provider_version), ''), now()
    )
    ON CONFLICT (originating_operation_id) DO NOTHING;
    SELECT * INTO STRICT v_binding FROM public.provider_object_bindings
      WHERE originating_operation_id = v_operation.id;
    IF v_binding.external_object_id <> btrim(p_external_bill_id)
       OR v_binding.verified_provider_state_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'provider object binding conflicts with verified observation';
    END IF;
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, provider_object_binding_id, event_sequence, event_type,
      reason_code, actor_kind, actor_service, authorized_request_fingerprint,
      provider_state_fingerprint, normalized_provider_state,
      comparison_outcome, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      p_attempt_id, v_binding.id, v_sequence, 'PROVIDER_OBSERVATION',
      left(p_reason_code, 120), 'SERVICE', 'QuickBooksPostingAdapter',
      v_operation.authorized_request_fingerprint, v_fingerprint,
      p_normalized_provider_state, 'MATCH',
      jsonb_build_object('externalBillId', btrim(p_external_bill_id),
                         'providerVersion', NULLIF(btrim(p_provider_version), ''))
    );
    v_target_state := 'SUCCEEDED';
  ELSIF p_comparison_outcome = 'MISMATCH' THEN
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, event_sequence, event_type, reason_code, actor_kind,
      actor_service, authorized_request_fingerprint,
      provider_state_fingerprint, normalized_provider_state,
      comparison_outcome, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      p_attempt_id, v_sequence, 'PROVIDER_OBSERVATION', left(p_reason_code, 120),
      'SERVICE', 'QuickBooksPostingAdapter', v_operation.authorized_request_fingerprint,
      v_fingerprint, p_normalized_provider_state, 'MISMATCH',
      jsonb_build_object('externalBillId', btrim(p_external_bill_id),
                         'providerVersion', NULLIF(btrim(p_provider_version), ''))
    );
    v_target_state := 'UNCERTAIN';
  ELSE
    INSERT INTO public.posting_events (
      operation_id, practice_id, client_entity_id, ledger_book_id,
      provider_connection_id, provider, external_organisation_id,
      attempt_id, event_sequence, event_type, reason_code, actor_kind,
      actor_service, authorized_request_fingerprint, details
    ) VALUES (
      v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
      v_operation.ledger_book_id, v_operation.provider_connection_id,
      v_operation.provider, v_operation.external_organisation_id,
      p_attempt_id, v_sequence, 'RECOVERY', left(p_reason_code, 120),
      'SERVICE', 'QuickBooksPostingAdapter', v_operation.authorized_request_fingerprint,
      jsonb_build_object('readOnly', true, 'outcome', 'INCONCLUSIVE')
    );
    v_target_state := 'UNCERTAIN';
  END IF;

  UPDATE public.posting_operations SET current_state = v_target_state,
    row_version = row_version + 1 WHERE id = v_operation.id RETURNING * INTO v_operation;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    attempt_id, event_sequence, event_type, prior_state, new_state,
    reason_code, actor_kind, actor_service,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    p_attempt_id, v_sequence + 1, 'TRANSITION', 'VERIFYING', v_target_state,
    left(p_reason_code, 120), 'SERVICE', 'AuthoritativePostingService',
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('comparisonOutcome', p_comparison_outcome)
  );
  RETURN jsonb_build_object(
    'operationId', v_operation.id, 'state', v_target_state,
    'externalBillId', CASE WHEN p_comparison_outcome = 'MATCH'
      THEN btrim(p_external_bill_id) ELSE NULL END,
    'reasonCodes', jsonb_build_array(left(p_reason_code, 120)),
    'resumed', false, 'recovered', false);
END;
$$;

ALTER TABLE public.provider_tax_treatment_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_tax_treatment_mappings_authenticated_select
  ON public.provider_tax_treatment_mappings FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

REVOKE ALL PRIVILEGES ON TABLE public.provider_tax_treatment_mappings,
  public.eligible_provider_tax_treatments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.provider_tax_treatment_mappings,
  public.eligible_provider_tax_treatments TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.posting_tax_mapping_protect_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.posting_actor_can_post_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.quickbooks_bill_execution_grant_v1(uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_quickbooks_bill_recovery_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_bill_acknowledged_v1(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_bill_failure_v1(uuid,uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_quickbooks_bill_observation_v1(
  uuid,uuid,text,text,text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_quickbooks_bill_recovery_v1(uuid,uuid,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_bill_acknowledged_v1(uuid,uuid,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_bill_failure_v1(uuid,uuid,text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_quickbooks_bill_observation_v1(
  uuid,uuid,text,text,text,jsonb,text,text)
  TO service_role;

COMMENT ON VIEW public.eligible_provider_tax_treatments IS
  'Destination-bound, active and current provider tax treatments eligible for posting.';

NOTIFY pgrst, 'reload schema';

COMMIT;
