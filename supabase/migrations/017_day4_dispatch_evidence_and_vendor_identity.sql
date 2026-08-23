-- Day 4 blocker remediation: dispatch-time evidence freshness and exact
-- preallocated parent/child operation identity. Local validation only.

BEGIN;

CREATE OR REPLACE FUNCTION public.posting_operation_preallocated_id_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_requested_id text;
BEGIN
  v_requested_id := NEW.requested_object->>'__zakiRequestedOperationId';
  IF v_requested_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    NEW.id := v_requested_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'requested posting operation ID must be a UUID';
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER posting_operations_preallocated_id
  BEFORE INSERT ON public.posting_operations
  FOR EACH ROW EXECUTE FUNCTION public.posting_operation_preallocated_id_v1();

CREATE OR REPLACE FUNCTION public.posting_dispatch_evidence_status_v1(
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public.posting_operations%ROWTYPE;
  v_reference jsonb;
  v_artifact public.import_artifacts%ROWTYPE;
  v_revision public.financial_document_revisions%ROWTYPE;
  v_document public.financial_documents%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  IF jsonb_array_length(v_operation.evidence_snapshot) = 0 THEN
    RETURN 'DISPATCH_EVIDENCE_MISSING';
  END IF;
  FOR v_reference IN SELECT value FROM jsonb_array_elements(v_operation.evidence_snapshot)
  LOOP
    IF v_reference->>'kind' = 'IMPORT_ARTIFACT' THEN
      BEGIN
        SELECT * INTO STRICT v_artifact FROM public.import_artifacts
          WHERE id = (v_reference->>'evidenceId')::uuid FOR KEY SHARE;
      EXCEPTION WHEN OTHERS THEN RETURN 'DISPATCH_EVIDENCE_MISSING'; END;
      IF v_artifact.client_entity_id <> v_operation.client_entity_id THEN
        RETURN 'DISPATCH_EVIDENCE_SCOPE_MISMATCH';
      END IF;
      IF v_artifact.storage_state <> 'retained' OR v_artifact.archived_at IS NOT NULL THEN
        RETURN 'DISPATCH_EVIDENCE_STALE';
      END IF;
      IF encode(v_artifact.content_sha256, 'hex') <> lower(v_reference->>'fingerprint') THEN
        RETURN 'DISPATCH_EVIDENCE_FINGERPRINT_MISMATCH';
      END IF;
    ELSIF v_reference->>'kind' = 'FINANCIAL_DOCUMENT_REVISION' THEN
      BEGIN
        SELECT * INTO STRICT v_revision FROM public.financial_document_revisions
          WHERE id = (v_reference->>'revisionId')::uuid FOR KEY SHARE;
        SELECT * INTO STRICT v_document FROM public.financial_documents
          WHERE id = (v_reference->>'evidenceId')::uuid FOR KEY SHARE;
      EXCEPTION WHEN OTHERS THEN RETURN 'DISPATCH_EVIDENCE_MISSING'; END;
      IF v_revision.client_entity_id <> v_operation.client_entity_id
         OR v_revision.document_id <> v_document.id
         OR v_document.client_entity_id <> v_operation.client_entity_id THEN
        RETURN 'DISPATCH_EVIDENCE_SCOPE_MISMATCH';
      END IF;
      IF v_document.archived_at IS NOT NULL
         OR v_document.current_revision_id <> v_revision.id THEN
        RETURN 'DISPATCH_EVIDENCE_STALE';
      END IF;
    ELSE
      RETURN 'DISPATCH_EVIDENCE_MISSING';
    END IF;
  END LOOP;
  RETURN 'OK';
END;
$$;

ALTER FUNCTION public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)
  RENAME TO prepare_quickbooks_bill_submission_unchecked_v1;

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
  v_evidence_status text;
  v_target_state text;
  v_sequence bigint;
BEGIN
  SELECT * INTO STRICT v_operation FROM public.posting_operations
    WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.current_state <> 'AUTHORIZED' THEN
    RETURN public.prepare_quickbooks_bill_submission_unchecked_v1(
      p_operation_id,p_actor_user_id,p_adapter_name,p_adapter_version,p_lease_seconds);
  END IF;

  v_evidence_status := public.posting_dispatch_evidence_status_v1(p_operation_id);
  IF v_evidence_status = 'OK' THEN
    RETURN public.prepare_quickbooks_bill_submission_unchecked_v1(
      p_operation_id,p_actor_user_id,p_adapter_name,p_adapter_version,p_lease_seconds);
  END IF;

  v_target_state := CASE
    WHEN v_evidence_status IN ('DISPATCH_EVIDENCE_SCOPE_MISMATCH',
                               'DISPATCH_EVIDENCE_FINGERPRINT_MISMATCH') THEN 'DENIED'
    ELSE 'REVIEW'
  END;
  UPDATE public.posting_operations SET current_state = v_target_state,
    row_version = row_version + 1 WHERE id = p_operation_id RETURNING * INTO v_operation;
  SELECT COALESCE(max(event_sequence), 0) + 1 INTO v_sequence
    FROM public.posting_events WHERE operation_id = p_operation_id;
  INSERT INTO public.posting_events (
    operation_id,practice_id,client_entity_id,ledger_book_id,
    provider_connection_id,provider,external_organisation_id,event_sequence,
    event_type,prior_state,new_state,reason_code,actor_kind,actor_service,
    authorized_request_fingerprint,details
  ) VALUES (
    v_operation.id,v_operation.practice_id,v_operation.client_entity_id,
    v_operation.ledger_book_id,v_operation.provider_connection_id,
    v_operation.provider,v_operation.external_organisation_id,v_sequence,
    'TRANSITION','AUTHORIZED',v_target_state,v_evidence_status,
    'SERVICE','AuthoritativePostingService',v_operation.authorized_request_fingerprint,
    jsonb_build_object('phase','dispatch-evidence-revalidation')
  );
  RETURN jsonb_build_object('kind','BLOCKED','state',v_target_state,
    'reasonCode',v_evidence_status);
END;
$$;

REVOKE ALL ON FUNCTION public.posting_operation_preallocated_id_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.posting_dispatch_evidence_status_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_bill_submission_unchecked_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_bill_submission_v1(uuid,uuid,text,text,integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
