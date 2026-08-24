BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ingest_document_evidence_with_pending_v1') THEN
    RAISE EXCEPTION 'missing atomic pending evidence ingestion RPC';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'confirm_document_evidence_with_pending_v1') THEN
    RAISE EXCEPTION 'missing atomic pending evidence confirmation RPC';
  END IF;
END $$;
ROLLBACK;
\echo 022_ATOMIC_PENDING_DOCUMENT_EVIDENCE_LINKAGE_CONTRACT_OK
