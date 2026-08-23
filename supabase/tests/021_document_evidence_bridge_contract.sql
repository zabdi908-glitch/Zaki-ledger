BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='document_evidence_extractions') THEN RAISE EXCEPTION 'missing extraction bridge'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='document_evidence_confirmations') THEN RAISE EXCEPTION 'missing confirmation bridge'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='confirm_document_evidence_v1') THEN RAISE EXCEPTION 'missing confirmation RPC'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='ingest_document_evidence_v1') THEN RAISE EXCEPTION 'missing ingest RPC'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='document_evidence_extractions_append_only') THEN RAISE EXCEPTION 'extractions must be append-only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='document_evidence_confirmations_append_only') THEN RAISE EXCEPTION 'confirmations must be append-only'; END IF;
END $$;
ROLLBACK;
\echo 021_DOCUMENT_EVIDENCE_BRIDGE_CONTRACT_OK
