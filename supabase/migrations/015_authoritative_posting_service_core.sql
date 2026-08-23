-- Step 5 Day 3 Task 2: durable service-core write surface.
-- No provider adapter, dispatch primitive, approval route, or provider I/O is
-- introduced by this migration.

BEGIN;

CREATE TABLE public.posting_human_authorizations (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid NOT NULL,
  provider_connection_id          uuid NOT NULL,
  provider                        text NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
  external_organisation_id        text NOT NULL CHECK (btrim(external_organisation_id) <> ''),
  operation_kind                  text NOT NULL CHECK (btrim(operation_kind) <> ''),
  external_object_type            text NOT NULL CHECK (btrim(external_object_type) <> ''),
  action                          text NOT NULL
                                  CHECK (action IN ('CREATE', 'UPDATE', 'VOID', 'DELETE',
                                                    'PAYMENT', 'JOURNAL', 'TRANSFER')),
  authorized_request_fingerprint  bytea NOT NULL
                                  CHECK (octet_length(authorized_request_fingerprint) = 32),
  approved_by_user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at                     timestamptz NOT NULL DEFAULT now(),
  expires_at                      timestamptz,
  approval_context                jsonb NOT NULL DEFAULT '{}'::jsonb
                                  CHECK (jsonb_typeof(approval_context) = 'object'),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id,
          operation_kind, external_object_type, action,
          authorized_request_fingerprint),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id, ledger_book_id,
               provider, external_organisation_id)
    REFERENCES public.provider_connections
      (id, client_entity_id, ledger_book_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR expires_at > approved_at)
);

ALTER TABLE public.posting_operations
  ADD CONSTRAINT posting_operations_exact_human_authorization_fk
  FOREIGN KEY (human_authorization_id, practice_id, client_entity_id,
               ledger_book_id, provider_connection_id, provider,
               external_organisation_id, operation_kind,
               external_object_type, action,
               authorized_request_fingerprint)
  REFERENCES public.posting_human_authorizations
    (id, practice_id, client_entity_id, ledger_book_id,
     provider_connection_id, provider, external_organisation_id,
     operation_kind, external_object_type, action,
     authorized_request_fingerprint)
  ON DELETE RESTRICT;

CREATE TRIGGER posting_human_authorizations_append_only
  BEFORE UPDATE OR DELETE ON public.posting_human_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.claim_posting_operation_v1(
  p_practice_id uuid,
  p_client_entity_id uuid,
  p_ledger_book_id uuid,
  p_provider_connection_id uuid,
  p_provider text,
  p_external_organisation_id text,
  p_parent_operation_id uuid,
  p_operation_kind text,
  p_external_object_type text,
  p_action text,
  p_idempotency_key text,
  p_source_action_claim_fingerprint_hex text,
  p_authorized_request_fingerprint_hex text,
  p_intent_schema_version text,
  p_canonicalization_version text,
  p_validation_rule_set_version text,
  p_requested_object jsonb,
  p_evidence_snapshot jsonb,
  p_account_treatment_snapshot jsonb,
  p_tax_treatment_snapshot jsonb,
  p_expected_material_state jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request_fingerprint bytea;
  v_source_fingerprint bytea;
  v_operation public.posting_operations%ROWTYPE;
  v_inserted_id uuid;
  v_exact boolean;
BEGIN
  IF p_authorized_request_fingerprint_hex !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid authorized request fingerprint';
  END IF;
  v_request_fingerprint := decode(lower(p_authorized_request_fingerprint_hex), 'hex');
  IF p_source_action_claim_fingerprint_hex IS NOT NULL THEN
    IF p_source_action_claim_fingerprint_hex !~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid source/action claim fingerprint';
    END IF;
    v_source_fingerprint := decode(lower(p_source_action_claim_fingerprint_hex), 'hex');
  END IF;

  SELECT * INTO v_operation
  FROM public.posting_operations
  WHERE client_entity_id = p_client_entity_id
    AND ledger_book_id = p_ledger_book_id
    AND provider_connection_id = p_provider_connection_id
    AND external_object_type = p_external_object_type
    AND action = p_action
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    v_exact :=
      v_operation.practice_id = p_practice_id
      AND v_operation.provider = p_provider
      AND v_operation.external_organisation_id = p_external_organisation_id
      AND v_operation.parent_operation_id IS NOT DISTINCT FROM p_parent_operation_id
      AND v_operation.operation_kind = p_operation_kind
      AND v_operation.source_action_claim_fingerprint IS NOT DISTINCT FROM v_source_fingerprint
      AND v_operation.authorized_request_fingerprint = v_request_fingerprint
      AND v_operation.intent_schema_version = p_intent_schema_version
      AND v_operation.canonicalization_version = p_canonicalization_version
      AND v_operation.validation_rule_set_version = p_validation_rule_set_version
      AND v_operation.requested_object = p_requested_object
      AND v_operation.evidence_snapshot = p_evidence_snapshot
      AND v_operation.account_treatment_snapshot = p_account_treatment_snapshot
      AND v_operation.tax_treatment_snapshot = p_tax_treatment_snapshot
      AND v_operation.expected_material_state = p_expected_material_state;
    IF v_exact THEN
      RETURN jsonb_build_object('outcome', 'RESUMED', 'operation', to_jsonb(v_operation));
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'IDEMPOTENCY_CONFLICT',
      'conflicting_operation_id', v_operation.id
    );
  END IF;

  IF p_action = 'CREATE' THEN
    SELECT * INTO v_operation
    FROM public.posting_operations
    WHERE client_entity_id = p_client_entity_id
      AND ledger_book_id = p_ledger_book_id
      AND provider_connection_id = p_provider_connection_id
      AND external_object_type = p_external_object_type
      AND action = 'CREATE'
      AND source_action_claim_fingerprint = v_source_fingerprint
    FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'DUPLICATE_CREATE_CLAIM',
        'conflicting_operation_id', v_operation.id
      );
    END IF;
  END IF;

  INSERT INTO public.posting_operations (
    practice_id, client_entity_id, ledger_book_id, provider_connection_id,
    provider, external_organisation_id, parent_operation_id, operation_kind,
    external_object_type, action, idempotency_key,
    source_action_claim_fingerprint, authorized_request_fingerprint,
    intent_schema_version, canonicalization_version,
    validation_rule_set_version, requested_object, evidence_snapshot,
    account_treatment_snapshot, tax_treatment_snapshot,
    expected_material_state, current_state
  ) VALUES (
    p_practice_id, p_client_entity_id, p_ledger_book_id,
    p_provider_connection_id, p_provider, p_external_organisation_id,
    p_parent_operation_id, p_operation_kind, p_external_object_type, p_action,
    p_idempotency_key, v_source_fingerprint, v_request_fingerprint,
    p_intent_schema_version, p_canonicalization_version,
    p_validation_rule_set_version, p_requested_object, p_evidence_snapshot,
    p_account_treatment_snapshot, p_tax_treatment_snapshot,
    p_expected_material_state, 'PROPOSED'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    -- A concurrent transaction won either unique claim. Re-enter the exact
    -- lookup logic after the unique-index wait has completed.
    SELECT * INTO v_operation
    FROM public.posting_operations
    WHERE client_entity_id = p_client_entity_id
      AND ledger_book_id = p_ledger_book_id
      AND provider_connection_id = p_provider_connection_id
      AND external_object_type = p_external_object_type
      AND action = p_action
      AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
      v_exact :=
        v_operation.practice_id = p_practice_id
        AND v_operation.provider = p_provider
        AND v_operation.external_organisation_id = p_external_organisation_id
        AND v_operation.parent_operation_id IS NOT DISTINCT FROM p_parent_operation_id
        AND v_operation.operation_kind = p_operation_kind
        AND v_operation.source_action_claim_fingerprint IS NOT DISTINCT FROM v_source_fingerprint
        AND v_operation.authorized_request_fingerprint = v_request_fingerprint
        AND v_operation.intent_schema_version = p_intent_schema_version
        AND v_operation.canonicalization_version = p_canonicalization_version
        AND v_operation.validation_rule_set_version = p_validation_rule_set_version
        AND v_operation.requested_object = p_requested_object
        AND v_operation.evidence_snapshot = p_evidence_snapshot
        AND v_operation.account_treatment_snapshot = p_account_treatment_snapshot
        AND v_operation.tax_treatment_snapshot = p_tax_treatment_snapshot
        AND v_operation.expected_material_state = p_expected_material_state;
      IF v_exact THEN
        RETURN jsonb_build_object('outcome', 'RESUMED', 'operation', to_jsonb(v_operation));
      END IF;
      RETURN jsonb_build_object(
        'outcome', 'IDEMPOTENCY_CONFLICT',
        'conflicting_operation_id', v_operation.id
      );
    END IF;

    SELECT * INTO v_operation
    FROM public.posting_operations
    WHERE client_entity_id = p_client_entity_id
      AND ledger_book_id = p_ledger_book_id
      AND provider_connection_id = p_provider_connection_id
      AND external_object_type = p_external_object_type
      AND action = 'CREATE'
      AND source_action_claim_fingerprint = v_source_fingerprint
    FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'DUPLICATE_CREATE_CLAIM',
        'conflicting_operation_id', v_operation.id
      );
    END IF;
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'posting operation claim lost without a visible winner';
  END IF;

  SELECT * INTO STRICT v_operation
  FROM public.posting_operations
  WHERE id = v_inserted_id;

  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    event_sequence, event_type, reason_code, actor_kind, actor_user_id,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    1, 'DECISION', 'OPERATION_CLAIMED', 'USER', p_actor_user_id,
    v_operation.authorized_request_fingerprint,
    jsonb_build_object('claim_version', '015-v1')
  );

  RETURN jsonb_build_object('outcome', 'CREATED', 'operation', to_jsonb(v_operation));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_posting_decision_v1(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_reason_code text,
  p_details jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_event_id uuid;
  v_sequence bigint;
BEGIN
  IF btrim(COALESCE(p_reason_code, '')) = '' OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid posting decision';
  END IF;
  SELECT * INTO STRICT v_operation
  FROM public.posting_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
  FROM public.posting_events
  WHERE operation_id = p_operation_id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    event_sequence, event_type, reason_code, actor_kind, actor_user_id,
    authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    v_sequence, 'DECISION', p_reason_code, 'USER', p_actor_user_id,
    v_operation.authorized_request_fingerprint, p_details
  ) RETURNING id INTO v_event_id;
  RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_posting_operation_v1(
  p_operation_id uuid,
  p_expected_state text,
  p_to_state text,
  p_actor_user_id uuid,
  p_reason_code text,
  p_human_authorization_id uuid DEFAULT NULL,
  p_permission_decision_id uuid DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_sequence bigint;
  v_permitted boolean := false;
BEGIN
  IF btrim(COALESCE(p_reason_code, '')) = '' OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid posting transition';
  END IF;
  SELECT * INTO STRICT v_operation
  FROM public.posting_operations
  WHERE id = p_operation_id
  FOR UPDATE;

  IF v_operation.current_state = p_to_state THEN
    RETURN jsonb_build_object('outcome', 'UNCHANGED', 'operation', to_jsonb(v_operation));
  END IF;
  IF v_operation.current_state <> p_expected_state THEN
    RETURN jsonb_build_object('outcome', 'STALE', 'operation', to_jsonb(v_operation));
  END IF;

  v_permitted := CASE v_operation.current_state
    WHEN 'PROPOSED' THEN p_to_state IN ('VALIDATED', 'REVIEW', 'DENIED')
    WHEN 'REVIEW' THEN p_to_state IN ('VALIDATED', 'DENIED')
    WHEN 'VALIDATED' THEN p_to_state IN ('AUTHORIZED', 'REVIEW', 'DENIED')
    WHEN 'AUTHORIZED' THEN p_to_state IN ('SUBMITTING', 'REVIEW', 'DENIED')
    WHEN 'SUBMITTING' THEN p_to_state IN ('VERIFYING', 'FAILED_SAFE', 'UNCERTAIN')
    WHEN 'VERIFYING' THEN p_to_state IN ('SUCCEEDED', 'FAILED_SAFE', 'UNCERTAIN')
    WHEN 'UNCERTAIN' THEN p_to_state = 'VERIFYING'
    WHEN 'FAILED_SAFE' THEN p_to_state = 'VALIDATED'
    ELSE false
  END;
  IF NOT v_permitted THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('posting transition %s -> %s is not permitted',
                       v_operation.current_state, p_to_state);
  END IF;

  IF p_to_state = 'AUTHORIZED'
     AND (p_human_authorization_id IS NULL OR p_permission_decision_id IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'AUTHORIZED requires exact human authorization and permission decision';
  END IF;

  UPDATE public.posting_operations
  SET current_state = p_to_state,
      human_authorization_id = CASE
        WHEN p_to_state = 'AUTHORIZED' THEN p_human_authorization_id
        ELSE human_authorization_id
      END,
      permission_decision_id = CASE
        WHEN p_to_state = 'AUTHORIZED' THEN p_permission_decision_id
        ELSE permission_decision_id
      END,
      row_version = row_version + 1
  WHERE id = p_operation_id
  RETURNING * INTO v_operation;

  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
  FROM public.posting_events
  WHERE operation_id = p_operation_id;
  INSERT INTO public.posting_events (
    operation_id, practice_id, client_entity_id, ledger_book_id,
    provider_connection_id, provider, external_organisation_id,
    event_sequence, event_type, prior_state, new_state, reason_code,
    actor_kind, actor_user_id, authorized_request_fingerprint, details
  ) VALUES (
    v_operation.id, v_operation.practice_id, v_operation.client_entity_id,
    v_operation.ledger_book_id, v_operation.provider_connection_id,
    v_operation.provider, v_operation.external_organisation_id,
    v_sequence, 'TRANSITION', p_expected_state, p_to_state, p_reason_code,
    'USER', p_actor_user_id, v_operation.authorized_request_fingerprint,
    p_details || jsonb_build_object(
      'human_authorization_id', p_human_authorization_id,
      'permission_decision_id', p_permission_decision_id
    )
  );

  RETURN jsonb_build_object('outcome', 'TRANSITIONED', 'operation', to_jsonb(v_operation));
END;
$$;

ALTER TABLE public.posting_human_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY posting_human_authorizations_authenticated_select
  ON public.posting_human_authorizations FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

REVOKE ALL PRIVILEGES ON TABLE public.posting_human_authorizations
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.posting_human_authorizations
TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_posting_operation_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_posting_decision_v1(uuid, uuid, text, jsonb)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_posting_operation_v1(
  uuid, text, text, uuid, text, uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.claim_posting_operation_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_posting_decision_v1(uuid, uuid, text, jsonb)
TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_posting_operation_v1(
  uuid, text, text, uuid, text, uuid, uuid, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
