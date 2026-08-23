BEGIN;

-- Claiming is itself a durable mutation. The actor must be authorized for the
-- requested tenant/client before the legacy claim implementation can insert an
-- operation or its append-only claim event.
ALTER FUNCTION public.claim_posting_operation_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) RENAME TO claim_posting_operation_unchecked_v1;

CREATE FUNCTION public.claim_posting_operation_v1(
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
BEGIN
  IF NOT public.posting_actor_can_post_v1(
    p_actor_user_id, p_practice_id, p_client_entity_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'DESTINATION_REJECTED');
  END IF;

  RETURN public.claim_posting_operation_unchecked_v1(
    p_practice_id, p_client_entity_id, p_ledger_book_id,
    p_provider_connection_id, p_provider, p_external_organisation_id,
    p_parent_operation_id, p_operation_kind, p_external_object_type,
    p_action, p_idempotency_key, p_source_action_claim_fingerprint_hex,
    p_authorized_request_fingerprint_hex, p_intent_schema_version,
    p_canonicalization_version, p_validation_rule_set_version,
    p_requested_object, p_evidence_snapshot, p_account_treatment_snapshot,
    p_tax_treatment_snapshot, p_expected_material_state, p_actor_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_posting_operation_unchecked_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_posting_operation_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_posting_operation_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text,
  text, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
