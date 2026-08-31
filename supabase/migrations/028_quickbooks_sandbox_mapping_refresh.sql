-- Migration 028: live, exact mapping revalidation for the bounded Sandbox pilot.
-- Provider reads happen in the authenticated executor. This migration only
-- exposes expected immutable material and atomically refreshes freshness after
-- exact account + tax observations have been rechecked under locks.
BEGIN;

CREATE OR REPLACE FUNCTION public.prepare_quickbooks_sandbox_pilot_mapping_refresh_v1(
  p_vendor_operation_id uuid,
  p_bill_operation_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vendor public.posting_operations%ROWTYPE;
  v_bill public.posting_operations%ROWTYPE;
  v_account public.provider_posting_account_mappings%ROWTYPE;
  v_tax public.provider_tax_treatment_mappings%ROWTYPE;
  v_account_id uuid;
  v_tax_id uuid;
BEGIN
  IF p_vendor_operation_id IS NULL OR p_bill_operation_id IS NULL
     OR p_vendor_operation_id = p_bill_operation_id OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Sandbox mapping refresh input';
  END IF;

  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id = p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id = p_bill_operation_id;
  IF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id
     OR v_vendor.practice_id <> v_bill.practice_id
     OR v_vendor.client_entity_id <> v_bill.client_entity_id
     OR v_vendor.ledger_book_id <> v_bill.ledger_book_id
     OR v_bill.provider <> 'quickbooks'
     OR v_bill.external_object_type <> 'BILL'
     OR NOT public.posting_actor_can_post_v1(
       p_actor_user_id, v_bill.practice_id, v_bill.client_entity_id) THEN
    RETURN jsonb_build_object('kind','STOP','state','DENIED',
      'reasonCode','PILOT_OPERATION_PAIR_SCOPE_MISMATCH');
  END IF;

  IF jsonb_typeof(v_bill.account_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_bill.account_treatment_snapshot) <> 1
     OR v_bill.account_treatment_snapshot->0->>'disposition' <> 'MAPPED'
     OR jsonb_typeof(v_bill.tax_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_bill.tax_treatment_snapshot) <> 1
     OR v_bill.tax_treatment_snapshot->0->>'disposition' <> 'MAPPED' THEN
    RETURN jsonb_build_object('kind','STOP','state','REVIEW',
      'reasonCode','PILOT_MAPPING_SNAPSHOT_INVALID');
  END IF;
  BEGIN
    v_account_id := (v_bill.account_treatment_snapshot->0->>'mappingId')::uuid;
    v_tax_id := (v_bill.tax_treatment_snapshot->0->>'treatmentId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('kind','STOP','state','REVIEW',
      'reasonCode','PILOT_MAPPING_SNAPSHOT_INVALID');
  END;

  SELECT * INTO v_account FROM public.provider_posting_account_mappings
    WHERE id = v_account_id;
  IF NOT FOUND OR v_account.practice_id <> v_bill.practice_id
     OR v_account.client_entity_id <> v_bill.client_entity_id
     OR v_account.ledger_book_id <> v_bill.ledger_book_id
     OR v_account.provider_connection_id <> v_bill.provider_connection_id
     OR v_account.provider <> v_bill.provider
     OR v_account.external_organisation_id <> v_bill.external_organisation_id
     OR v_account.mapping_status <> 'active' OR NOT v_account.is_postable
     OR v_account.effective_from > now()
     OR (v_account.effective_to IS NOT NULL AND v_account.effective_to <= now()) THEN
    RETURN jsonb_build_object('kind','STOP','state','REVIEW',
      'reasonCode','PILOT_ACCOUNT_MAPPING_NOT_REFRESHABLE');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.client_entities client
    JOIN public.ledger_books book ON book.id = v_bill.ledger_book_id
      AND book.client_entity_id = client.id AND book.status = 'active'
    JOIN public.provider_connections connection ON connection.id = v_bill.provider_connection_id
      AND connection.client_entity_id = client.id
      AND connection.ledger_book_id = book.id
      AND connection.provider = v_bill.provider
      AND connection.external_organisation_id = v_bill.external_organisation_id
      AND connection.status = 'active'
    JOIN public.financial_accounts account ON account.id = v_account.financial_account_id
      AND account.client_entity_id = client.id
      AND account.ledger_book_id = book.id AND account.status = 'active'
    WHERE client.id = v_bill.client_entity_id
      AND client.practice_id = v_bill.practice_id AND client.status = 'active'
  ) THEN
    RETURN jsonb_build_object('kind','STOP','state','REVIEW',
      'reasonCode','PILOT_ACCOUNT_MAPPING_NOT_REFRESHABLE');
  END IF;

  SELECT * INTO v_tax FROM public.provider_tax_treatment_mappings
    WHERE id = v_tax_id;
  IF NOT FOUND OR v_tax.practice_id <> v_bill.practice_id
     OR v_tax.client_entity_id <> v_bill.client_entity_id
     OR v_tax.ledger_book_id <> v_bill.ledger_book_id
     OR v_tax.provider_connection_id <> v_bill.provider_connection_id
     OR v_tax.provider <> v_bill.provider
     OR v_tax.external_organisation_id <> v_bill.external_organisation_id
     OR v_tax.mapping_status <> 'active'
     OR v_tax.effective_from > now()
     OR (v_tax.effective_to IS NOT NULL AND v_tax.effective_to <= now())
     OR v_tax.verified_at > now()
     OR v_tax.provider_tax_code <> v_bill.tax_treatment_snapshot->0->>'providerTaxCode'
     OR encode(v_tax.evidence_fingerprint,'hex') <>
        lower(v_bill.tax_treatment_snapshot->0->>'evidenceFingerprint') THEN
    RETURN jsonb_build_object('kind','STOP','state','REVIEW',
      'reasonCode','PILOT_TAX_MAPPING_NOT_REFRESHABLE');
  END IF;

  -- Expiry is deliberately not checked here: it is the one property this flow
  -- may refresh, and only after live provider observations match below.
  RETURN jsonb_build_object('kind','READY',
    'account',jsonb_build_object(
      'mappingId',v_account.id,
      'providerAccountId',v_account.provider_account_id,
      'providerAccountCode',v_account.provider_account_code,
      'providerAccountName',v_account.provider_account_name,
      'providerAccountType',v_account.provider_account_type,
      'providerAccountSubtype',v_account.provider_account_subtype,
      'providerVersion',v_account.provider_version),
    'tax',jsonb_build_object(
      'treatmentId',v_tax.id,
      'providerTaxCode',v_tax.provider_tax_code,
      'treatmentName',v_tax.treatment_name,
      'evidenceFingerprint',encode(v_tax.evidence_fingerprint,'hex'),
      'providerVersion',v_tax.provider_version));
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1(
  p_vendor_operation_id uuid,
  p_bill_operation_id uuid,
  p_actor_user_id uuid,
  p_account_observation jsonb,
  p_tax_observation jsonb,
  p_ttl_seconds integer DEFAULT 3600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vendor public.posting_operations%ROWTYPE;
  v_bill public.posting_operations%ROWTYPE;
  v_account public.provider_posting_account_mappings%ROWTYPE;
  v_tax public.provider_tax_treatment_mappings%ROWTYPE;
  v_account_id uuid;
  v_tax_id uuid;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_reason text;
BEGIN
  IF p_vendor_operation_id IS NULL OR p_bill_operation_id IS NULL
     OR p_vendor_operation_id = p_bill_operation_id OR p_actor_user_id IS NULL
     OR p_account_observation IS NULL OR jsonb_typeof(p_account_observation) <> 'object'
     OR p_tax_observation IS NULL OR jsonb_typeof(p_tax_observation) <> 'object'
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 300 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Sandbox mapping observation';
  END IF;
  v_expires_at := v_now + make_interval(secs => p_ttl_seconds);

  PERFORM 1 FROM public.posting_operations
    WHERE id IN (p_vendor_operation_id,p_bill_operation_id)
    ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id = p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id = p_bill_operation_id;

  IF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id
     OR v_vendor.practice_id <> v_bill.practice_id
     OR v_vendor.client_entity_id <> v_bill.client_entity_id
     OR v_vendor.ledger_book_id <> v_bill.ledger_book_id
     OR v_bill.provider <> 'quickbooks'
     OR v_bill.external_object_type <> 'BILL'
     OR v_bill.current_state NOT IN ('AUTHORIZED','SUCCEEDED')
     OR v_vendor.current_state NOT IN ('AUTHORIZED','SUCCEEDED')
     OR NOT public.posting_actor_can_post_v1(
       p_actor_user_id,v_bill.practice_id,v_bill.client_entity_id) THEN
    v_reason := 'PILOT_OPERATION_PAIR_SCOPE_MISMATCH';
  ELSIF jsonb_typeof(v_bill.account_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_bill.account_treatment_snapshot) <> 1
     OR v_bill.account_treatment_snapshot->0->>'disposition' <> 'MAPPED'
     OR jsonb_typeof(v_bill.tax_treatment_snapshot) <> 'array'
     OR jsonb_array_length(v_bill.tax_treatment_snapshot) <> 1
     OR v_bill.tax_treatment_snapshot->0->>'disposition' <> 'MAPPED' THEN
    v_reason := 'PILOT_MAPPING_SNAPSHOT_INVALID';
  END IF;

  IF v_reason IS NULL THEN
    BEGIN
      v_account_id := (v_bill.account_treatment_snapshot->0->>'mappingId')::uuid;
      v_tax_id := (v_bill.tax_treatment_snapshot->0->>'treatmentId')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_reason := 'PILOT_MAPPING_SNAPSHOT_INVALID';
    END;
  END IF;

  IF v_reason IS NULL THEN
    SELECT * INTO v_account FROM public.provider_posting_account_mappings
      WHERE id = v_account_id FOR UPDATE;
    IF NOT FOUND OR v_account.practice_id <> v_bill.practice_id
       OR v_account.client_entity_id <> v_bill.client_entity_id
       OR v_account.ledger_book_id <> v_bill.ledger_book_id
       OR v_account.provider_connection_id <> v_bill.provider_connection_id
       OR v_account.provider <> v_bill.provider
       OR v_account.external_organisation_id <> v_bill.external_organisation_id
       OR v_account.mapping_status <> 'active' OR NOT v_account.is_postable
       OR v_account.effective_from > v_now
       OR (v_account.effective_to IS NOT NULL AND v_account.effective_to <= v_now) THEN
      v_reason := 'PILOT_ACCOUNT_MAPPING_NOT_REFRESHABLE';
    END IF;
  END IF;

  IF v_reason IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_entities client
    JOIN public.ledger_books book ON book.id = v_bill.ledger_book_id
      AND book.client_entity_id = client.id AND book.status = 'active'
    JOIN public.provider_connections connection ON connection.id = v_bill.provider_connection_id
      AND connection.client_entity_id = client.id
      AND connection.ledger_book_id = book.id
      AND connection.provider = v_bill.provider
      AND connection.external_organisation_id = v_bill.external_organisation_id
      AND connection.status = 'active'
    JOIN public.financial_accounts account ON account.id = v_account.financial_account_id
      AND account.client_entity_id = client.id
      AND account.ledger_book_id = book.id AND account.status = 'active'
    WHERE client.id = v_bill.client_entity_id
      AND client.practice_id = v_bill.practice_id AND client.status = 'active'
  ) THEN
    v_reason := 'PILOT_ACCOUNT_MAPPING_NOT_REFRESHABLE';
  END IF;

  IF v_reason IS NULL THEN
    SELECT * INTO v_tax FROM public.provider_tax_treatment_mappings
      WHERE id = v_tax_id FOR UPDATE;
    IF NOT FOUND OR v_tax.practice_id <> v_bill.practice_id
       OR v_tax.client_entity_id <> v_bill.client_entity_id
       OR v_tax.ledger_book_id <> v_bill.ledger_book_id
       OR v_tax.provider_connection_id <> v_bill.provider_connection_id
       OR v_tax.provider <> v_bill.provider
       OR v_tax.external_organisation_id <> v_bill.external_organisation_id
       OR v_tax.mapping_status <> 'active'
       OR v_tax.effective_from > v_now
       OR (v_tax.effective_to IS NOT NULL AND v_tax.effective_to <= v_now)
       OR v_tax.verified_at > v_now
       OR v_tax.provider_tax_code <> v_bill.tax_treatment_snapshot->0->>'providerTaxCode'
       OR encode(v_tax.evidence_fingerprint,'hex') <>
          lower(v_bill.tax_treatment_snapshot->0->>'evidenceFingerprint') THEN
      v_reason := 'PILOT_TAX_MAPPING_NOT_REFRESHABLE';
    END IF;
  END IF;

  IF v_reason IS NULL AND (
       p_account_observation->>'mappingId' IS DISTINCT FROM v_account.id::text
       OR p_account_observation->>'providerAccountId' IS DISTINCT FROM v_account.provider_account_id
       OR NULLIF(p_account_observation->>'providerAccountCode','') IS DISTINCT FROM v_account.provider_account_code
       OR NULLIF(p_account_observation->>'providerAccountName','') IS DISTINCT FROM v_account.provider_account_name
       OR p_account_observation->>'providerAccountType' IS DISTINCT FROM v_account.provider_account_type
       OR NULLIF(p_account_observation->>'providerAccountSubtype','') IS DISTINCT FROM v_account.provider_account_subtype
       OR (v_account.provider_version IS NOT NULL AND
           NULLIF(p_account_observation->>'providerVersion','') IS DISTINCT FROM v_account.provider_version)
       OR p_account_observation->>'active' IS DISTINCT FROM 'true') THEN
    v_reason := 'PILOT_ACCOUNT_PROVIDER_MISMATCH';
  END IF;

  IF v_reason IS NULL AND (
       p_tax_observation->>'treatmentId' IS DISTINCT FROM v_tax.id::text
       OR p_tax_observation->>'providerTaxCode' IS DISTINCT FROM v_tax.provider_tax_code
       OR p_tax_observation->>'treatmentName' IS DISTINCT FROM v_tax.treatment_name
       OR lower(p_tax_observation->>'evidenceFingerprint') IS DISTINCT FROM
          encode(v_tax.evidence_fingerprint,'hex')
       OR (v_tax.provider_version IS NOT NULL AND
           NULLIF(p_tax_observation->>'providerVersion','') IS DISTINCT FROM v_tax.provider_version)
       OR p_tax_observation->>'active' IS DISTINCT FROM 'true'
       OR p_tax_observation->>'verificationSource' IS NULL
       OR p_tax_observation->>'verificationSource' NOT IN
          ('QBO_TAX_CODE','QBO_US_SPECIAL_NON')
       OR (p_tax_observation->>'verificationSource' = 'QBO_US_SPECIAL_NON'
           AND (v_tax.provider_tax_code <> 'NON'
                OR v_tax.treatment_name <> 'NON_TAXABLE'))) THEN
    v_reason := 'PILOT_TAX_PROVIDER_MISMATCH';
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.posting_pilot_append_event_v1(v_bill.id,
      'SANDBOX_PILOT_MAPPING_REFRESH_REVIEW',p_actor_user_id,
      jsonb_build_object('reasonCode',v_reason,'providerWrite',false,
        'billIntentMutated',false,
        'accountMappingId',v_account_id,'taxTreatmentId',v_tax_id,
        'accountProviderAccountId',p_account_observation->>'providerAccountId',
        'accountProviderVersion',p_account_observation->>'providerVersion',
        'taxProviderTaxCode',p_tax_observation->>'providerTaxCode',
        'taxEvidenceFingerprint',p_tax_observation->>'evidenceFingerprint',
        'taxProviderVersion',p_tax_observation->>'providerVersion',
        'taxVerificationSource',p_tax_observation->>'verificationSource'));
    RETURN jsonb_build_object('kind','STOP','state','REVIEW','reasonCode',v_reason);
  END IF;

  UPDATE public.provider_posting_account_mappings
    SET verified_at=v_now,eligibility_expires_at=v_expires_at
    WHERE id=v_account.id;
  UPDATE public.provider_tax_treatment_mappings
    SET verified_at=v_now,eligibility_expires_at=v_expires_at
    WHERE id=v_tax.id;

  PERFORM public.posting_pilot_append_event_v1(v_bill.id,
    'SANDBOX_PILOT_MAPPING_ELIGIBILITY_REFRESHED',p_actor_user_id,
    jsonb_build_object(
      'accountMappingId',v_account.id,'taxTreatmentId',v_tax.id,
      'accountPreviousExpiry',v_account.eligibility_expires_at,
      'taxPreviousExpiry',v_tax.eligibility_expires_at,
      'eligibilityExpiresAt',v_expires_at,
      'accountProviderRequestId',NULLIF(p_account_observation->>'providerRequestId',''),
      'accountProviderAccountId',p_account_observation->>'providerAccountId',
      'accountProviderAccountCode',p_account_observation->>'providerAccountCode',
      'accountProviderAccountName',p_account_observation->>'providerAccountName',
      'accountProviderAccountType',p_account_observation->>'providerAccountType',
      'accountProviderAccountSubtype',p_account_observation->>'providerAccountSubtype',
      'accountProviderVersion',p_account_observation->>'providerVersion',
      'taxProviderRequestId',NULLIF(p_tax_observation->>'providerRequestId',''),
      'taxProviderTaxCode',p_tax_observation->>'providerTaxCode',
      'taxTreatmentName',p_tax_observation->>'treatmentName',
      'taxEvidenceFingerprint',encode(v_tax.evidence_fingerprint,'hex'),
      'taxProviderVersion',p_tax_observation->>'providerVersion',
      'taxVerificationSource',p_tax_observation->>'verificationSource',
      'providerWrite',false,'billIntentMutated',false));
  RETURN jsonb_build_object('kind','READY','eligibilityExpiresAt',v_expires_at);
END;
$$;

-- Permit the coordinator to audit a provider-read failure before the refresh
-- RPC has an exact observation to record. Preserve the complete 027 surface.
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
    'SANDBOX_PILOT_OAUTH_REVIEW','SANDBOX_PILOT_OAUTH_VERIFIED',
    'SANDBOX_PILOT_LIVE_MAPPING_REVIEW',
    'SANDBOX_PILOT_AUTHORIZATION_REVIEW','SANDBOX_PILOT_AUTHORIZATION_REFRESHED',
    'SANDBOX_PILOT_VENDOR_SUCCEEDED','SANDBOX_PILOT_STOPPED_AFTER_VENDOR',
    'SANDBOX_PILOT_STOPPED_AFTER_BILL','SANDBOX_PILOT_EXISTING_SUCCESS',
    'SANDBOX_PILOT_SUCCEEDED'
  ];
BEGIN
  IF NOT (p_reason_code = ANY(v_allowed)) OR p_details IS NULL
     OR jsonb_typeof(p_details) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid Sandbox pilot audit event';
  END IF;
  SELECT * INTO STRICT v_vendor FROM public.posting_operations
    WHERE id=p_vendor_operation_id;
  SELECT * INTO STRICT v_bill FROM public.posting_operations
    WHERE id=p_bill_operation_id FOR UPDATE;
  IF v_vendor.parent_operation_id <> v_bill.id
     OR v_vendor.provider_connection_id <> v_bill.provider_connection_id
     OR v_vendor.external_organisation_id <> v_bill.external_organisation_id
     OR NOT public.posting_actor_can_post_v1(
       p_actor_user_id,v_bill.practice_id,v_bill.client_entity_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sandbox pilot audit scope denied';
  END IF;
  PERFORM public.posting_pilot_append_event_v1(v_bill.id,p_reason_code,
    p_actor_user_id,p_details || jsonb_build_object(
      'environment','sandbox','vendorOperationId',v_vendor.id));
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_quickbooks_sandbox_pilot_mapping_refresh_v1(
  uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1(
  uuid,uuid,uuid,jsonb,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_quickbooks_sandbox_pilot_mapping_refresh_v1(
  uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1(
  uuid,uuid,uuid,jsonb,jsonb,integer) TO service_role;

COMMENT ON FUNCTION public.prepare_quickbooks_sandbox_pilot_mapping_refresh_v1(
  uuid,uuid,uuid) IS
  'Returns exact account/tax mapping material for bounded live Sandbox reads; ignores freshness expiry only.';
COMMENT ON FUNCTION public.refresh_quickbooks_sandbox_pilot_mapping_eligibility_v1(
  uuid,uuid,uuid,jsonb,jsonb,integer) IS
  'Atomically audits and refreshes account/tax eligibility only after exact provider observations; never mutates posting intent.';

NOTIFY pgrst,'reload schema';
COMMIT;
