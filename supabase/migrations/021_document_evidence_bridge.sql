-- Eyes -> Memory: durable, revisioned document evidence.
BEGIN;

INSERT INTO storage.buckets (id, name, public) VALUES ('document-evidence','document-evidence',false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.document_evidence_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid NOT NULL REFERENCES public.practices(id) ON DELETE RESTRICT,
  client_entity_id uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  ledger_book_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  extraction_fingerprint bytea NOT NULL CHECK (octet_length(extraction_fingerprint)=32),
  extraction_payload jsonb NOT NULL CHECK (jsonb_typeof(extraction_payload)='object'),
  extractor_name text NOT NULL CHECK (btrim(extractor_name)<>''),
  extractor_version text NOT NULL CHECK (btrim(extractor_version)<>''),
  created_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  UNIQUE (client_entity_id, artifact_id, extraction_fingerprint),
  FOREIGN KEY (ledger_book_id, client_entity_id) REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, client_entity_id) REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (practice_id) REFERENCES public.practices(id) ON DELETE RESTRICT
);

CREATE TABLE public.document_evidence_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid NOT NULL REFERENCES public.practices(id) ON DELETE RESTRICT,
  client_entity_id uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  ledger_book_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key)<>''),
  confirmed_fingerprint bytea NOT NULL CHECK (octet_length(confirmed_fingerprint)=32),
  confirmed_fields jsonb NOT NULL CHECK (jsonb_typeof(confirmed_fields)='object'),
  financial_document_id uuid NOT NULL,
  financial_document_revision_id uuid NOT NULL,
  confirmed_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  UNIQUE (client_entity_id, extraction_id, idempotency_key),
  UNIQUE (client_entity_id, extraction_id, confirmed_fingerprint),
  FOREIGN KEY (ledger_book_id, client_entity_id) REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_id, client_entity_id) REFERENCES public.document_evidence_extractions(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (financial_document_id, client_entity_id) REFERENCES public.financial_documents(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (financial_document_revision_id, financial_document_id, client_entity_id) REFERENCES public.financial_document_revisions(id, document_id, client_entity_id) ON DELETE RESTRICT
);

CREATE TRIGGER document_evidence_extractions_append_only BEFORE UPDATE OR DELETE ON public.document_evidence_extractions FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER document_evidence_confirmations_append_only BEFORE UPDATE OR DELETE ON public.document_evidence_confirmations FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.ingest_document_evidence_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid, p_actor_user_id uuid,
  p_content_sha256_hex text, p_content_length bigint, p_storage_locator text, p_source_filename text,
  p_mime_type text, p_extraction_fingerprint_hex text, p_extraction_payload jsonb,
  p_extractor_name text, p_extractor_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.import_artifacts%ROWTYPE; e public.document_evidence_extractions%ROWTYPE;
BEGIN
  IF NOT public.posting_actor_can_post_v1(p_actor_user_id,p_practice_id,p_client_entity_id) THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  IF p_content_sha256_hex !~ '^[0-9a-fA-F]{64}$' OR p_extraction_fingerprint_hex !~ '^[0-9a-fA-F]{64}$' OR p_content_length < 0 OR NULLIF(btrim(p_storage_locator),'') IS NULL OR jsonb_typeof(p_extraction_payload)<>'object' THEN RAISE EXCEPTION 'invalid document evidence ingestion input' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.ledger_books WHERE id=p_ledger_book_id AND client_entity_id=p_client_entity_id AND status='active'; IF NOT FOUND THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  INSERT INTO public.import_artifacts(client_entity_id,artifact_kind,content_sha256,content_length,storage_locator,storage_state,source_filename,mime_type,metadata)
  VALUES(p_client_entity_id,'uploaded_document',decode(p_content_sha256_hex,'hex'),p_content_length,p_storage_locator,'retained',p_source_filename,p_mime_type,jsonb_build_object('evidence','eyes-memory-v1'))
  ON CONFLICT (client_entity_id,content_sha256,content_length) DO NOTHING RETURNING * INTO a;
  IF NOT FOUND THEN SELECT * INTO a FROM public.import_artifacts WHERE client_entity_id=p_client_entity_id AND content_sha256=decode(p_content_sha256_hex,'hex') AND content_length=p_content_length FOR KEY SHARE; END IF;
  INSERT INTO public.document_evidence_extractions(practice_id,client_entity_id,ledger_book_id,artifact_id,extraction_fingerprint,extraction_payload,extractor_name,extractor_version,created_by_user_id)
  VALUES(p_practice_id,p_client_entity_id,p_ledger_book_id,a.id,decode(p_extraction_fingerprint_hex,'hex'),p_extraction_payload,p_extractor_name,p_extractor_version,p_actor_user_id)
  ON CONFLICT (client_entity_id,artifact_id,extraction_fingerprint) DO NOTHING RETURNING * INTO e;
  IF NOT FOUND THEN SELECT * INTO e FROM public.document_evidence_extractions WHERE client_entity_id=p_client_entity_id AND artifact_id=a.id AND extraction_fingerprint=decode(p_extraction_fingerprint_hex,'hex'); END IF;
  RETURN jsonb_build_object('outcome','CREATED','artifact_id',a.id,'extraction_id',e.id);
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_document_evidence_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid, p_actor_user_id uuid,
  p_extraction_id uuid, p_idempotency_key text, p_confirmed_fingerprint_hex text,
  p_document_kind text, p_confirmed_revision jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.document_evidence_extractions%ROWTYPE; x public.document_evidence_confirmations%ROWTYPE;
  d public.financial_documents%ROWTYPE; r public.financial_document_revisions%ROWTYPE;
  n integer; v_doc uuid; v_rev uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(concat_ws(':',p_client_entity_id::text,p_extraction_id::text,p_idempotency_key)));
  IF NOT public.posting_actor_can_post_v1(p_actor_user_id,p_practice_id,p_client_entity_id) THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  IF p_confirmed_fingerprint_hex !~ '^[0-9a-fA-F]{64}$' OR p_document_kind NOT IN ('invoice','receipt','credit_note','statement','other') OR jsonb_typeof(p_confirmed_revision) <> 'object' THEN RAISE EXCEPTION 'invalid document evidence confirmation input' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM public.document_evidence_extractions WHERE id=p_extraction_id AND practice_id=p_practice_id AND client_entity_id=p_client_entity_id AND ledger_book_id=p_ledger_book_id FOR KEY SHARE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.ledger_books WHERE id=p_ledger_book_id AND client_entity_id=p_client_entity_id AND status='active') THEN RETURN jsonb_build_object('outcome','DESTINATION_REJECTED'); END IF;
  SELECT * INTO x FROM public.document_evidence_confirmations WHERE client_entity_id=p_client_entity_id AND extraction_id=p_extraction_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF x.confirmed_fingerprint <> decode(p_confirmed_fingerprint_hex,'hex') THEN RETURN jsonb_build_object('outcome','IDEMPOTENCY_CONFLICT','confirmation_id',x.id); END IF;
    RETURN jsonb_build_object('outcome','RESUMED','confirmation_id',x.id,'document_id',x.financial_document_id,'revision_id',x.financial_document_revision_id);
  END IF;
  SELECT * INTO x FROM public.document_evidence_confirmations WHERE client_entity_id=p_client_entity_id AND extraction_id=p_extraction_id AND confirmed_fingerprint=decode(p_confirmed_fingerprint_hex,'hex') FOR UPDATE;
  IF FOUND THEN RETURN jsonb_build_object('outcome','RESUMED','confirmation_id',x.id,'document_id',x.financial_document_id,'revision_id',x.financial_document_revision_id); END IF;
  SELECT * INTO d FROM public.financial_documents WHERE client_entity_id=p_client_entity_id AND source_artifact_id=e.artifact_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    v_doc:=gen_random_uuid(); v_rev:=gen_random_uuid();
    INSERT INTO public.financial_documents(id,client_entity_id,source_artifact_id,document_kind) VALUES(v_doc,p_client_entity_id,e.artifact_id,p_document_kind);
    n:=1;
  ELSE
    v_doc:=d.id; SELECT * INTO r FROM public.financial_document_revisions WHERE id=d.current_revision_id AND document_id=d.id AND client_entity_id=p_client_entity_id; v_rev:=gen_random_uuid(); n:=r.revision_number+1;
  END IF;
  INSERT INTO public.financial_document_revisions(id,client_entity_id,document_id,revision_number,previous_revision_id,obligation_status,resolution_status,issuer_name,document_number,document_date,amount_minor,currency_code,minor_unit_exponent,raw_amount_text,raw_currency_text,change_reason,provenance,created_by_kind,created_by_user_id)
  VALUES(v_rev,p_client_entity_id,v_doc,n,CASE WHEN d.id IS NULL THEN NULL ELSE r.id END,COALESCE(NULLIF(p_confirmed_revision->>'obligation_status',''),'open'),COALESCE(NULLIF(p_confirmed_revision->>'resolution_status',''),'resolved'),p_confirmed_revision->>'issuer_name',p_confirmed_revision->>'document_number',NULLIF(p_confirmed_revision->>'document_date','')::date,NULLIF(p_confirmed_revision->>'amount_minor','')::bigint,NULLIF(p_confirmed_revision->>'currency_code',''),NULLIF(p_confirmed_revision->>'minor_unit_exponent','')::smallint,p_confirmed_revision->>'raw_amount_text',p_confirmed_revision->>'raw_currency_text','human confirmation',jsonb_build_object('artifact_id',e.artifact_id,'extraction_id',e.id,'extraction_fingerprint',encode(e.extraction_fingerprint,'hex'),'confirmation_fingerprint',p_confirmed_fingerprint_hex), 'user',p_actor_user_id);
  UPDATE public.financial_documents SET current_revision_id=v_rev WHERE id=v_doc AND client_entity_id=p_client_entity_id;
  INSERT INTO public.document_evidence_confirmations(practice_id,client_entity_id,ledger_book_id,extraction_id,idempotency_key,confirmed_fingerprint,confirmed_fields,financial_document_id,financial_document_revision_id,confirmed_by_user_id) VALUES(p_practice_id,p_client_entity_id,p_ledger_book_id,e.id,p_idempotency_key,decode(p_confirmed_fingerprint_hex,'hex'),p_confirmed_revision,v_doc,v_rev,p_actor_user_id) RETURNING * INTO x;
  PERFORM public.canonical_write_audit_v1(p_practice_id,p_client_entity_id,gen_random_uuid(),1,'user',p_actor_user_id,NULL,p_idempotency_key,'confirm','financial_document',v_doc,NULL,jsonb_build_object('revision_id',v_rev,'artifact_id',e.artifact_id,'extraction_id',e.id,'confirmation_id',x.id),'{}');
  RETURN jsonb_build_object('outcome','CREATED','confirmation_id',x.id,'document_id',v_doc,'revision_id',v_rev);
END; $$;

REVOKE ALL ON TABLE public.document_evidence_extractions,public.document_evidence_confirmations FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.confirm_document_evidence_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ingest_document_evidence_v1(uuid,uuid,uuid,uuid,text,bigint,text,text,text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_document_evidence_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_document_evidence_v1(uuid,uuid,uuid,uuid,text,bigint,text,text,text,text,jsonb,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
