#!/usr/bin/env bash
set -euo pipefail

db="${ZAKI_LOCAL_DB_CONTAINER:-supabase_db_Zaki-ledger}"
q() { docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$1"; }
assert_eq() { [[ "$1" == "$2" ]] || { echo "assertion failed: expected [$2], got [$1]" >&2; exit 1; }; }

u=22000000-0000-0000-0000-000000000001
p1=22000000-0000-0000-0000-000000000002
c1=22000000-0000-0000-0000-000000000003
b1=22000000-0000-0000-0000-000000000004
p2=22000000-0000-0000-0000-000000000005
c2=22000000-0000-0000-0000-000000000006
b2=22000000-0000-0000-0000-000000000007
m1=22000000-0000-0000-0000-000000000008
m2=22000000-0000-0000-0000-000000000009
failed=22000000-0000-0000-0000-000000000010
resumed=22000000-0000-0000-0000-000000000011
concurrent=22000000-0000-0000-0000-000000000012
cross=22000000-0000-0000-0000-000000000013
rollback=22000000-0000-0000-0000-000000000014
tmp="$(mktemp -d)"

cleanup() {
  q "BEGIN;
    DROP TRIGGER IF EXISTS zaki_022_force_pending_update_failure ON public.pending_documents;
    DROP FUNCTION IF EXISTS public.zaki_022_force_pending_update_failure();
    DELETE FROM public.pending_documents WHERE user_id='$u';
    ALTER TABLE public.document_evidence_confirmations DISABLE TRIGGER document_evidence_confirmations_append_only;
    DELETE FROM public.document_evidence_confirmations WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.document_evidence_confirmations ENABLE TRIGGER document_evidence_confirmations_append_only;
    ALTER TABLE public.document_evidence_extractions DISABLE TRIGGER document_evidence_extractions_append_only;
    DELETE FROM public.document_evidence_extractions WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.document_evidence_extractions ENABLE TRIGGER document_evidence_extractions_append_only;
    ALTER TABLE public.financial_documents DISABLE TRIGGER financial_documents_require_current_revision;
    UPDATE public.financial_documents SET current_revision_id=NULL WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.financial_document_revisions DISABLE TRIGGER financial_document_revisions_immutable;
    DELETE FROM public.financial_document_revisions WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.financial_document_revisions ENABLE TRIGGER financial_document_revisions_immutable;
    DELETE FROM public.financial_documents WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.financial_documents ENABLE TRIGGER financial_documents_require_current_revision;
    DELETE FROM public.import_artifacts WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.canonical_audit_ledger DISABLE TRIGGER canonical_audit_ledger_immutable;
    DELETE FROM public.canonical_audit_ledger WHERE client_entity_id IN ('$c1','$c2');
    ALTER TABLE public.canonical_audit_ledger ENABLE TRIGGER canonical_audit_ledger_immutable;
    DELETE FROM public.default_tenant_identities WHERE user_id='$u';
    DELETE FROM public.ledger_books WHERE id IN ('$b1','$b2');
    DELETE FROM public.client_entities WHERE id IN ('$c1','$c2');
    DELETE FROM public.practice_memberships WHERE practice_id IN ('$p1','$p2');
    DELETE FROM public.practices WHERE id IN ('$p1','$p2');
    DELETE FROM auth.users WHERE id='$u';
  COMMIT;" >/dev/null
}
trap 'cleanup; rm -rf "$tmp"' EXIT
cleanup
mkdir -p "$tmp"

q "INSERT INTO auth.users(id,email,role,aud,created_at,updated_at) VALUES('$u','pending-evidence-022@test','authenticated','authenticated',now(),now());
  INSERT INTO public.practices(id,name,created_by_user_id) VALUES('$p1','Pending evidence one','$u'),('$p2','Pending evidence two','$u');
  INSERT INTO public.practice_memberships(id,practice_id,user_id,role) VALUES('$m1','$p1','$u','owner'),('$m2','$p2','$u','owner');
  INSERT INTO public.client_entities(id,practice_id,legal_name,display_name,base_currency) VALUES('$c1','$p1','Pending evidence one','Pending evidence one','USD'),('$c2','$p2','Pending evidence two','Pending evidence two','USD');
  INSERT INTO public.ledger_books(id,client_entity_id,book_kind,display_name,functional_currency) VALUES('$b1','$c1','internal','Pending evidence one','USD'),('$b2','$c2','internal','Pending evidence two','USD');
  INSERT INTO public.default_tenant_identities(user_id,practice_id,practice_membership_id,client_entity_id,internal_ledger_book_id) VALUES('$u','$p1','$m1','$c1','$b1');"

call_ingest() {
  local pending="$1" content="$2" extraction="$3" locator="$4"
  q "SELECT public.ingest_document_evidence_with_pending_v1('$p1','$c1','$b1','$u','$pending',repeat('$content',64),10,'$locator','evidence.pdf','application/pdf',repeat('$extraction',64),'{}','test','1');"
}
call_confirm() {
  local pending="$1" extraction_id="$2" key="$3" fingerprint="$4"
  q "SELECT public.confirm_document_evidence_with_pending_v1('$p1','$c1','$b1','$u','$pending','$extraction_id','$key',repeat('$fingerprint',64),'invoice',jsonb_build_object('issuer_name','Vendor','document_number','INV-022','amount_minor','1000','currency_code','USD','minor_unit_exponent','2'));"
}

# A failed queue update occurs after the inner evidence RPC has returned, so the
# wrapper transaction must erase that otherwise-successful retention.
q "INSERT INTO public.pending_documents(id,user_id,extraction) VALUES('$failed','$u',jsonb_build_object('__zakiCanonicalEvidence',jsonb_build_object('artifactId','00000000-0000-0000-0000-000000000001','extractionId','00000000-0000-0000-0000-000000000002','documentId',NULL,'revisionId',NULL)));"
if call_ingest "$failed" a b "$c1/failure" >/dev/null 2>&1; then
  echo 'expected linkage failure after retention' >&2; exit 1
fi
assert_eq "$(q "SELECT count(*) FROM public.import_artifacts WHERE client_entity_id='$c1' AND content_sha256=decode(repeat('a',64),'hex');")" 0
assert_eq "$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,artifactId}' FROM public.pending_documents WHERE id='$failed';")" 00000000-0000-0000-0000-000000000001
q "UPDATE public.pending_documents SET extraction='{}' WHERE id='$failed';"
call_ingest "$failed" a b "$c1/failure" >/dev/null
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_extractions WHERE client_entity_id='$c1' AND extraction_fingerprint=decode(repeat('b',64),'hex');")" 1

# Emulate the old partial-success failure: canonical retention already exists,
# but the legacy queue row is unlinked.  Retry must reuse, then link, that row.
q "INSERT INTO public.pending_documents(id,user_id,extraction) VALUES('$resumed','$u','{}');"
prior="$(q "SELECT public.ingest_document_evidence_v1('$p1','$c1','$b1','$u',repeat('c',64),10,'$c1/resume','resume.pdf','application/pdf',repeat('d',64),'{}','test','1');")"
prior_artifact="$(sed -E 's/.*\"artifact_id\" *: *\"([^\"]+)\".*/\1/' <<<"$prior")"
prior_extraction="$(sed -E 's/.*\"extraction_id\" *: *\"([^\"]+)\".*/\1/' <<<"$prior")"
call_ingest "$resumed" c d "$c1/resume" >/dev/null
assert_eq "$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,artifactId}' FROM public.pending_documents WHERE id='$resumed';")" "$prior_artifact"
assert_eq "$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,extractionId}' FROM public.pending_documents WHERE id='$resumed';")" "$prior_extraction"
call_ingest "$resumed" c d "$c1/resume" >/dev/null
assert_eq "$(q "SELECT count(*) FROM public.import_artifacts WHERE client_entity_id='$c1' AND content_sha256=decode(repeat('c',64),'hex');")" 1
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_extractions WHERE client_entity_id='$c1' AND extraction_fingerprint=decode(repeat('d',64),'hex');")" 1

# Two workers race the complete retry path.  Both must observe one retained
# identity and one linked confirmation/document/revision.
q "INSERT INTO public.pending_documents(id,user_id,extraction) VALUES('$concurrent','$u','{}');"
concurrent_ingest="SELECT public.ingest_document_evidence_with_pending_v1('$p1','$c1','$b1','$u','$concurrent',repeat('e',64),10,'$c1/concurrent','concurrent.pdf','application/pdf',repeat('f',64),'{}','test','1');"
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$concurrent_ingest" >"$tmp/ingest-1" &
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$concurrent_ingest" >"$tmp/ingest-2" &
wait
assert_eq "$(grep -h -c '"outcome": "CREATED"' "$tmp"/ingest-* | awk '{n+=$1} END{print n}')" 2
concurrent_extraction="$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,extractionId}' FROM public.pending_documents WHERE id='$concurrent';")"
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_extractions WHERE client_entity_id='$c1' AND extraction_fingerprint=decode(repeat('f',64),'hex');")" 1
concurrent_confirm="SELECT public.confirm_document_evidence_with_pending_v1('$p1','$c1','$b1','$u','$concurrent','$concurrent_extraction','concurrent-confirm',repeat('1',64),'invoice',jsonb_build_object('issuer_name','Vendor','document_number','INV-CONCURRENT','amount_minor','1000','currency_code','USD','minor_unit_exponent','2'));"
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$concurrent_confirm" >"$tmp/confirm-1" &
docker exec "$db" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -Atc "$concurrent_confirm" >"$tmp/confirm-2" &
wait
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_confirmations WHERE client_entity_id='$c1' AND extraction_id='$concurrent_extraction';")" 1
assert_eq "$(q "SELECT count(*) FROM public.financial_document_revisions WHERE client_entity_id='$c1' AND document_id=(SELECT financial_document_id FROM public.document_evidence_confirmations WHERE extraction_id='$concurrent_extraction');")" 1
assert_eq "$(q "SELECT count(*) FROM public.pending_documents WHERE id='$concurrent' AND extraction#>>'{__zakiCanonicalEvidence,documentId}'=(SELECT financial_document_id::text FROM public.document_evidence_confirmations WHERE extraction_id='$concurrent_extraction');")" 1
call_confirm "$concurrent" "$concurrent_extraction" concurrent-confirm 1 >/dev/null
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_confirmations WHERE client_entity_id='$c1' AND extraction_id='$concurrent_extraction';")" 1
concurrent_document="$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,documentId}' FROM public.pending_documents WHERE id='$concurrent';")"
concurrent_revision="$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,revisionId}' FROM public.pending_documents WHERE id='$concurrent';")"
call_ingest "$concurrent" e f "$c1/concurrent" >/dev/null
assert_eq "$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,documentId}' FROM public.pending_documents WHERE id='$concurrent';")" "$concurrent_document"
assert_eq "$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,revisionId}' FROM public.pending_documents WHERE id='$concurrent';")" "$concurrent_revision"

# The actor owns both practices, so this proves the pending RPC itself (not
# merely membership denial) rejects a second tenant.
q "INSERT INTO public.pending_documents(id,user_id,extraction) VALUES('$cross','$u','{}');"
if q "SELECT public.ingest_document_evidence_with_pending_v1('$p2','$c2','$b2','$u','$cross',repeat('2',64),10,'$c2/cross','cross.pdf','application/pdf',repeat('3',64),'{}','test','1');" >/dev/null 2>&1; then
  echo 'expected cross-tenant linkage rejection' >&2; exit 1
fi
assert_eq "$(q "SELECT count(*) FROM public.import_artifacts WHERE client_entity_id='$c2';")" 0
assert_eq "$(q "SELECT extraction FROM public.pending_documents WHERE id='$cross';")" '{}'

# Fail exactly at the final pending-row update after confirmation has created
# all canonical records.  The rollback cannot leave a document/revision ID on
# the queue, or retain any partial canonical confirmation.
q "INSERT INTO public.pending_documents(id,user_id,extraction) VALUES('$rollback','$u','{}');"
call_ingest "$rollback" 4 5 "$c1/rollback" >/dev/null
rollback_extraction="$(q "SELECT extraction#>>'{__zakiCanonicalEvidence,extractionId}' FROM public.pending_documents WHERE id='$rollback';")"
q "CREATE OR REPLACE FUNCTION public.zaki_022_force_pending_update_failure() RETURNS trigger LANGUAGE plpgsql AS \$zaki\$ BEGIN IF NEW.id='$rollback' THEN RAISE EXCEPTION 'forced 022 linkage failure'; END IF; RETURN NEW; END; \$zaki\$; CREATE TRIGGER zaki_022_force_pending_update_failure BEFORE UPDATE ON public.pending_documents FOR EACH ROW EXECUTE FUNCTION public.zaki_022_force_pending_update_failure();"
if call_confirm "$rollback" "$rollback_extraction" rollback-confirm 6 >/dev/null 2>&1; then
  echo 'expected final pending linkage failure' >&2; exit 1
fi
q "DROP TRIGGER zaki_022_force_pending_update_failure ON public.pending_documents; DROP FUNCTION public.zaki_022_force_pending_update_failure();"
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_confirmations WHERE extraction_id='$rollback_extraction';")" 0
assert_eq "$(q "SELECT count(*) FROM public.financial_documents WHERE client_entity_id='$c1' AND source_artifact_id=(SELECT artifact_id FROM public.document_evidence_extractions WHERE id='$rollback_extraction');")" 0
assert_eq "$(q "SELECT COALESCE(extraction#>>'{__zakiCanonicalEvidence,documentId}','') || ':' || COALESCE(extraction#>>'{__zakiCanonicalEvidence,revisionId}','') FROM public.pending_documents WHERE id='$rollback';")" :
call_confirm "$rollback" "$rollback_extraction" rollback-confirm 6 >/dev/null
assert_eq "$(q "SELECT count(*) FROM public.document_evidence_confirmations WHERE extraction_id='$rollback_extraction';")" 1
assert_eq "$(q "SELECT count(*) FROM public.pending_documents WHERE id='$rollback' AND extraction#>>'{__zakiCanonicalEvidence,documentId}' IS NOT NULL AND extraction#>>'{__zakiCanonicalEvidence,revisionId}' IS NOT NULL;")" 1

echo '022_PENDING_EVIDENCE_ADVERSARIAL_OK retention-rollback retry-resume idempotent concurrent-convergence cross-tenant-rejection confirmation-rollback'
