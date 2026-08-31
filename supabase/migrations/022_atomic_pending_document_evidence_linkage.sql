-- Make legacy queue linkage part of the canonical evidence transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.ingest_document_evidence_with_pending_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid, p_actor_user_id uuid,
  p_pending_document_id uuid, p_content_sha256_hex text, p_content_length bigint,
  p_storage_locator text, p_source_filename text, p_mime_type text,
  p_extraction_fingerprint_hex text, p_extraction_payload jsonb,
  p_extractor_name text, p_extractor_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result jsonb; v_pending jsonb; v_existing jsonb;
  v_default_practice_id uuid; v_default_client_entity_id uuid; v_default_ledger_book_id uuid;
BEGIN
  SELECT extraction INTO v_pending FROM public.pending_documents
  WHERE id=p_pending_document_id AND user_id=p_actor_user_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pending document is absent, resolved, or outside actor scope' USING ERRCODE='23503'; END IF;
  SELECT practice_id,client_entity_id,internal_ledger_book_id
    INTO v_default_practice_id,v_default_client_entity_id,v_default_ledger_book_id
  FROM public.default_tenant_identities WHERE user_id=p_actor_user_id;
  IF NOT FOUND OR p_practice_id IS DISTINCT FROM v_default_practice_id
     OR p_client_entity_id IS DISTINCT FROM v_default_client_entity_id
     OR p_ledger_book_id IS DISTINCT FROM v_default_ledger_book_id THEN
    RAISE EXCEPTION 'pending document linkage tenant does not match actor canonical tenant' USING ERRCODE='23514';
  END IF;
  v_existing:=v_pending->'__zakiCanonicalEvidence';
  IF v_existing IS NOT NULL AND (v_existing->>'artifactId' IS NULL OR v_existing->>'extractionId' IS NULL) THEN
    RAISE EXCEPTION 'pending document has malformed canonical evidence linkage' USING ERRCODE='23514';
  END IF;
  v_result:=public.ingest_document_evidence_v1(p_practice_id,p_client_entity_id,p_ledger_book_id,p_actor_user_id,p_content_sha256_hex,p_content_length,p_storage_locator,p_source_filename,p_mime_type,p_extraction_fingerprint_hex,p_extraction_payload,p_extractor_name,p_extractor_version);
  IF v_result->>'outcome' <> 'CREATED' THEN RETURN v_result; END IF;
  IF v_existing IS NOT NULL AND (v_existing->>'artifactId' <> v_result->>'artifact_id' OR v_existing->>'extractionId' <> v_result->>'extraction_id') THEN
    RAISE EXCEPTION 'pending document is linked to different canonical evidence' USING ERRCODE='23505';
  END IF;
  UPDATE public.pending_documents
  SET extraction=jsonb_set(extraction,'{__zakiCanonicalEvidence}',jsonb_build_object(
    'artifactId',v_result->>'artifact_id','extractionId',v_result->>'extraction_id',
    'documentId',COALESCE(v_existing->'documentId','null'::jsonb),
    'revisionId',COALESCE(v_existing->'revisionId','null'::jsonb)
  ),true)
  WHERE id=p_pending_document_id AND user_id=p_actor_user_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'pending document linkage lost during evidence retention' USING ERRCODE='40001'; END IF;
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_document_evidence_with_pending_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid, p_actor_user_id uuid,
  p_pending_document_id uuid, p_extraction_id uuid, p_idempotency_key text,
  p_confirmed_fingerprint_hex text, p_document_kind text, p_confirmed_revision jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_result jsonb; v_pending jsonb; v_existing jsonb;
  v_default_practice_id uuid; v_default_client_entity_id uuid; v_default_ledger_book_id uuid;
BEGIN
  SELECT extraction INTO v_pending FROM public.pending_documents WHERE id=p_pending_document_id AND user_id=p_actor_user_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pending document is absent, resolved, or outside actor scope' USING ERRCODE='23503'; END IF;
  SELECT practice_id,client_entity_id,internal_ledger_book_id
    INTO v_default_practice_id,v_default_client_entity_id,v_default_ledger_book_id
  FROM public.default_tenant_identities WHERE user_id=p_actor_user_id;
  IF NOT FOUND OR p_practice_id IS DISTINCT FROM v_default_practice_id
     OR p_client_entity_id IS DISTINCT FROM v_default_client_entity_id
     OR p_ledger_book_id IS DISTINCT FROM v_default_ledger_book_id THEN
    RAISE EXCEPTION 'pending document linkage tenant does not match actor canonical tenant' USING ERRCODE='23514';
  END IF;
  v_existing:=v_pending->'__zakiCanonicalEvidence';
  IF v_existing IS NULL OR v_existing->>'artifactId' IS NULL OR v_existing->>'extractionId' IS NULL
     OR v_existing->>'extractionId' IS DISTINCT FROM p_extraction_id::text THEN
    RAISE EXCEPTION 'pending document is not linked to the supplied canonical extraction' USING ERRCODE='23514';
  END IF;
  v_result:=public.confirm_document_evidence_v1(p_practice_id,p_client_entity_id,p_ledger_book_id,p_actor_user_id,p_extraction_id,p_idempotency_key,p_confirmed_fingerprint_hex,p_document_kind,p_confirmed_revision);
  IF v_result->>'outcome' NOT IN ('CREATED','RESUMED') THEN RETURN v_result; END IF;
  UPDATE public.pending_documents SET extraction=jsonb_set(jsonb_set(extraction,'{__zakiCanonicalEvidence,documentId}',to_jsonb(v_result->>'document_id'),true),'{__zakiCanonicalEvidence,revisionId}',to_jsonb(v_result->>'revision_id'),true)
  WHERE id=p_pending_document_id AND user_id=p_actor_user_id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'pending document linkage lost during confirmation' USING ERRCODE='40001'; END IF;
  RETURN v_result;
END; $$;

REVOKE ALL ON FUNCTION public.ingest_document_evidence_with_pending_v1(uuid,uuid,uuid,uuid,uuid,text,bigint,text,text,text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.confirm_document_evidence_with_pending_v1(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ingest_document_evidence_with_pending_v1(uuid,uuid,uuid,uuid,uuid,text,bigint,text,text,text,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_document_evidence_with_pending_v1(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
