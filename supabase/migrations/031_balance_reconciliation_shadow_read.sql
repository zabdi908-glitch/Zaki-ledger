-- Step 6 Day 6: one additive, read-only evidence ingestion path into SHADOW proof runs.
-- Provider I/O remains in the application reader. This RPC can only persist immutable
-- evidence and invoke the migration-030 proof engine; it exposes no posting capability.

BEGIN;

ALTER TABLE public.balance_reconciliation_runs
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'PROOF'
    CHECK (execution_mode IN ('PROOF', 'SHADOW')),
  ADD COLUMN shadow_request_fingerprint bytea
    CHECK (shadow_request_fingerprint IS NULL OR octet_length(shadow_request_fingerprint) = 32),
  ADD CHECK (
    (execution_mode = 'PROOF' AND shadow_request_fingerprint IS NULL)
    OR (execution_mode = 'SHADOW' AND shadow_request_fingerprint IS NOT NULL)
  );

CREATE UNIQUE INDEX balance_reconciliation_runs_shadow_request_idx
  ON public.balance_reconciliation_runs (scope_id, period_start, period_end, shadow_request_fingerprint)
  WHERE execution_mode = 'SHADOW';

CREATE OR REPLACE FUNCTION public.balance_shadow_decode_sha256_v1(
  p_value text,
  p_label text
) RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '% must be a lowercase SHA-256 hex digest', p_label USING ERRCODE = '22023';
  END IF;
  RETURN decode(p_value, 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_shadow_set_fingerprint_v1(
  p_evidence jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT encode(extensions.digest(convert_to(
    (p_evidence->>'requestFingerprint') || '|' ||
    (p_evidence->>'responseFingerprint') || '|' ||
    COALESCE((
      SELECT string_agg(member.value->>'evidenceHash', ',' ORDER BY member.ordinality)
      FROM jsonb_array_elements(COALESCE(p_evidence->'members', '[]'::jsonb))
        WITH ORDINALITY AS member(value, ordinality)
    ), ''),
    'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.prepare_balance_reconciliation_shadow_scope_v1(
  p_actor_user_id uuid,
  p_scope_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
BEGIN
  SELECT scope.* INTO v_scope
  FROM public.balance_reconciliation_scopes AS scope
  JOIN public.practice_memberships AS membership
    ON membership.practice_id = scope.practice_id
   AND membership.user_id = p_actor_user_id
   AND membership.status = 'active'
   AND membership.valid_from <= now()
   AND (membership.valid_to IS NULL OR membership.valid_to > now())
  JOIN public.provider_connections AS connection
    ON connection.id = scope.ledger_provider_connection_id
   AND connection.client_entity_id = scope.client_entity_id
   AND connection.ledger_book_id = scope.ledger_book_id
   AND connection.provider = scope.ledger_provider
   AND connection.external_organisation_id = scope.ledger_external_organisation_id
   AND connection.status = 'active'
  WHERE scope.id = p_scope_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'REVIEW', 'reason_code', 'BALANCE_SHADOW_SCOPE_OWNERSHIP_UNPROVEN');
  END IF;
  IF v_scope.account_class <> 'asset'
     OR v_scope.account_timezone <> 'UTC'
     OR v_scope.source_provider <> 'ofx'
     OR v_scope.source_date_basis <> 'posted_date'
     OR v_scope.ledger_provider <> 'quickbooks'
     OR v_scope.ledger_date_basis <> 'accounting_date' THEN
    RETURN jsonb_build_object('outcome', 'REVIEW', 'reason_code', 'BALANCE_SHADOW_NARROW_CONTRACT_UNSUPPORTED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_posting_account_mappings AS mapping
    WHERE mapping.practice_id = v_scope.practice_id
      AND mapping.client_entity_id = v_scope.client_entity_id
      AND mapping.ledger_book_id = v_scope.ledger_book_id
      AND mapping.provider_connection_id = v_scope.ledger_provider_connection_id
      AND mapping.financial_account_id = v_scope.financial_account_id
      AND mapping.provider = v_scope.ledger_provider
      AND mapping.external_organisation_id = v_scope.ledger_external_organisation_id
      AND mapping.provider_account_id = v_scope.ledger_provider_account_id
      AND mapping.mapping_status = 'active'
      AND mapping.archived_at IS NULL
      AND mapping.effective_from <= now()
      AND (mapping.effective_to IS NULL OR mapping.effective_to > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'REVIEW', 'reason_code', 'BALANCE_SHADOW_ACCOUNT_MAPPING_NOT_CURRENT');
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'READY',
    'scope', jsonb_build_object(
      'scopeId', v_scope.id,
      'clientEntityId', v_scope.client_entity_id,
      'accountClass', v_scope.account_class,
      'currencyCode', v_scope.currency_code,
      'minorUnitExponent', v_scope.minor_unit_exponent,
      'accountTimezone', v_scope.account_timezone,
      'sourceProvider', v_scope.source_provider,
      'sourceOrganisationId', v_scope.source_external_organisation_id,
      'sourceAccountId', v_scope.source_account_id,
      'sourceDateBasis', v_scope.source_date_basis,
      'sourceBalanceSignMultiplier', v_scope.source_balance_sign_multiplier,
      'ledgerProvider', v_scope.ledger_provider,
      'ledgerProviderConnectionId', v_scope.ledger_provider_connection_id,
      'ledgerOrganisationId', v_scope.ledger_external_organisation_id,
      'ledgerAccountId', v_scope.ledger_provider_account_id,
      'ledgerDateBasis', v_scope.ledger_date_basis,
      'ledgerBalanceSignMultiplier', v_scope.ledger_balance_sign_multiplier
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_record_shadow_side_v1(
  p_scope public.balance_reconciliation_scopes,
  p_period_start date,
  p_period_end date,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_side text := p_evidence->>'side';
  v_open jsonb := p_evidence->'opening';
  v_close jsonb := p_evidence->'closing';
  v_member jsonb;
  v_open_id uuid;
  v_close_id uuid;
  v_set_id uuid;
  v_expected_provider text;
  v_expected_org text;
  v_expected_account text;
  v_expected_basis text;
  v_expected_multiplier smallint;
  v_expected_origin text;
  v_members jsonb := COALESCE(p_evidence->'members', '[]'::jsonb);
  v_computed_set_fingerprint text;
  v_existing_set public.balance_movement_sets%ROWTYPE;
  v_existing_open_fingerprint bytea;
  v_existing_close_fingerprint bytea;
BEGIN
  IF v_side NOT IN ('source', 'ledger') OR jsonb_typeof(v_members) <> 'array' THEN
    RAISE EXCEPTION 'invalid shadow side evidence' USING ERRCODE = '22023';
  END IF;
  IF v_side = 'source' THEN
    v_expected_provider := p_scope.source_provider;
    v_expected_org := p_scope.source_external_organisation_id;
    v_expected_account := p_scope.source_account_id;
    v_expected_basis := p_scope.source_date_basis;
    v_expected_multiplier := p_scope.source_balance_sign_multiplier;
    v_expected_origin := 'artifact_reported';
  ELSE
    v_expected_provider := p_scope.ledger_provider;
    v_expected_org := p_scope.ledger_external_organisation_id;
    v_expected_account := p_scope.ledger_provider_account_id;
    v_expected_basis := p_scope.ledger_date_basis;
    v_expected_multiplier := p_scope.ledger_balance_sign_multiplier;
    v_expected_origin := 'provider_reported';
  END IF;

  IF p_evidence->>'provider' IS DISTINCT FROM v_expected_provider
     OR p_evidence->>'organisationId' IS DISTINCT FROM v_expected_org
     OR p_evidence->>'accountId' IS DISTINCT FROM v_expected_account
     OR p_evidence->>'currencyCode' IS DISTINCT FROM p_scope.currency_code
     OR (p_evidence->>'minorUnitExponent')::smallint IS DISTINCT FROM p_scope.minor_unit_exponent
     OR p_evidence->>'dateBasis' IS DISTINCT FROM v_expected_basis THEN
    RAISE EXCEPTION 'shadow evidence conflicts with exact provider/account scope'
      USING ERRCODE = '23514';
  END IF;
  IF v_open->>'origin' <> v_expected_origin OR v_close->>'origin' <> v_expected_origin
     OR (v_open->>'localBoundaryDate')::date <> p_period_start
     OR (v_close->>'localBoundaryDate')::date <> p_period_end + 1
     OR (v_open->>'asOfExclusive')::timestamptz <>
        public.balance_period_start_utc_v1(p_period_start, p_scope.account_timezone)
     OR (v_close->>'asOfExclusive')::timestamptz <>
        public.balance_period_end_exclusive_utc_v1(p_period_end, p_scope.account_timezone) THEN
    RAISE EXCEPTION 'shadow balance evidence conflicts with exact cutoff contract'
      USING ERRCODE = '23514';
  END IF;
  IF (p_evidence->>'acceptedCount')::integer <> jsonb_array_length(v_members) THEN
    RAISE EXCEPTION 'shadow accepted count must equal persisted movement members'
      USING ERRCODE = '23514';
  END IF;
  IF v_side = 'source' AND (
    NOT EXISTS (
      SELECT 1 FROM public.import_artifacts AS artifact
      WHERE artifact.id = (v_open->>'artifactId')::uuid
        AND artifact.client_entity_id = p_scope.client_entity_id
        AND artifact.content_sha256 = public.balance_shadow_decode_sha256_v1(
          v_open->>'rawPayloadHash', 'opening artifact payload hash'
        )
        AND artifact.storage_state = 'retained'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.import_artifacts AS artifact
      WHERE artifact.id = (v_close->>'artifactId')::uuid
        AND artifact.client_entity_id = p_scope.client_entity_id
        AND artifact.content_sha256 = public.balance_shadow_decode_sha256_v1(
          v_close->>'rawPayloadHash', 'closing artifact payload hash'
        )
        AND artifact.storage_state = 'retained'
    )
  ) THEN
    RAISE EXCEPTION 'source balance evidence does not match retained immutable artifacts'
      USING ERRCODE = '23514';
  END IF;

  v_computed_set_fingerprint := public.balance_shadow_set_fingerprint_v1(p_evidence);
  IF p_evidence->>'setFingerprint' IS DISTINCT FROM v_computed_set_fingerprint THEN
    RAISE EXCEPTION 'movement set fingerprint does not bind its evidence members'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing_set
  FROM public.balance_movement_sets
  WHERE scope_id = p_scope.id
    AND side = v_side
    AND period_start = p_period_start
    AND period_end = p_period_end
    AND set_fingerprint = public.balance_shadow_decode_sha256_v1(
      p_evidence->>'setFingerprint', 'movement set fingerprint'
    );
  IF FOUND THEN
    SELECT evidence_fingerprint INTO STRICT v_existing_open_fingerprint
    FROM public.balance_snapshots WHERE id = v_existing_set.opening_snapshot_id;
    SELECT evidence_fingerprint INTO STRICT v_existing_close_fingerprint
    FROM public.balance_snapshots WHERE id = v_existing_set.closing_snapshot_id;
    IF v_existing_set.request_fingerprint <>
         public.balance_shadow_decode_sha256_v1(p_evidence->>'requestFingerprint', 'movement request fingerprint')
       OR v_existing_set.response_fingerprint <>
         public.balance_shadow_decode_sha256_v1(p_evidence->>'responseFingerprint', 'movement response fingerprint')
       OR v_existing_set.completeness_state <> p_evidence->>'completenessState'
       OR v_existing_set.movement_total_minor <> (p_evidence->>'movementTotalMinor')::bigint
       OR v_existing_open_fingerprint <>
         public.balance_shadow_decode_sha256_v1(v_open->>'evidenceFingerprint', 'opening evidence fingerprint')
       OR v_existing_close_fingerprint <>
         public.balance_shadow_decode_sha256_v1(v_close->>'evidenceFingerprint', 'closing evidence fingerprint') THEN
      RAISE EXCEPTION 'existing immutable movement fingerprint conflicts with supplied evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object(
      'openingSnapshotId', v_existing_set.opening_snapshot_id,
      'closingSnapshotId', v_existing_set.closing_snapshot_id,
      'movementSetId', v_existing_set.id
    );
  END IF;

  INSERT INTO public.balance_snapshots (
    scope_id, client_entity_id, side, boundary, local_boundary_date, as_of_exclusive,
    raw_balance_text, raw_currency_text, raw_balance_minor, balance_sign_multiplier,
    balance_minor, currency_code, minor_unit_exponent, snapshot_origin,
    verification_state, provider_version, retrieved_at, artifact_id,
    raw_payload_hash, evidence_fingerprint
  ) VALUES (
    p_scope.id, p_scope.client_entity_id, v_side, 'opening',
    (v_open->>'localBoundaryDate')::date, (v_open->>'asOfExclusive')::timestamptz,
    v_open->>'rawBalanceText', p_scope.currency_code, (v_open->>'rawBalanceMinor')::bigint,
    v_expected_multiplier, (v_open->>'balanceMinor')::bigint, p_scope.currency_code,
    p_scope.minor_unit_exponent, v_expected_origin, 'verified',
    CASE WHEN v_side = 'ledger' THEN p_evidence->>'providerRequestId' ELSE NULL END,
    (p_evidence->>'retrievalCompletedAt')::timestamptz,
    CASE WHEN v_side = 'source' THEN (v_open->>'artifactId')::uuid ELSE NULL END,
    CASE WHEN v_open->>'rawPayloadHash' IS NULL THEN NULL
      ELSE public.balance_shadow_decode_sha256_v1(v_open->>'rawPayloadHash', 'opening raw payload hash') END,
    public.balance_shadow_decode_sha256_v1(v_open->>'evidenceFingerprint', 'opening evidence fingerprint')
  ) RETURNING id INTO v_open_id;

  INSERT INTO public.balance_snapshots (
    scope_id, client_entity_id, side, boundary, local_boundary_date, as_of_exclusive,
    raw_balance_text, raw_currency_text, raw_balance_minor, balance_sign_multiplier,
    balance_minor, currency_code, minor_unit_exponent, snapshot_origin,
    verification_state, provider_version, retrieved_at, artifact_id,
    raw_payload_hash, evidence_fingerprint
  ) VALUES (
    p_scope.id, p_scope.client_entity_id, v_side, 'closing',
    (v_close->>'localBoundaryDate')::date, (v_close->>'asOfExclusive')::timestamptz,
    v_close->>'rawBalanceText', p_scope.currency_code, (v_close->>'rawBalanceMinor')::bigint,
    v_expected_multiplier, (v_close->>'balanceMinor')::bigint, p_scope.currency_code,
    p_scope.minor_unit_exponent, v_expected_origin, 'verified',
    CASE WHEN v_side = 'ledger' THEN p_evidence->>'providerRequestId' ELSE NULL END,
    (p_evidence->>'retrievalCompletedAt')::timestamptz,
    CASE WHEN v_side = 'source' THEN (v_close->>'artifactId')::uuid ELSE NULL END,
    CASE WHEN v_close->>'rawPayloadHash' IS NULL THEN NULL
      ELSE public.balance_shadow_decode_sha256_v1(v_close->>'rawPayloadHash', 'closing raw payload hash') END,
    public.balance_shadow_decode_sha256_v1(v_close->>'evidenceFingerprint', 'closing evidence fingerprint')
  ) RETURNING id INTO v_close_id;

  INSERT INTO public.balance_movement_sets (
    scope_id, client_entity_id, side, period_start, period_end,
    period_start_utc, period_end_exclusive_utc, date_basis,
    opening_snapshot_id, closing_snapshot_id, pagination_mode, page_count,
    pagination_complete, terminal_boundary_seen, coverage_complete, result_truncated,
    error_count, returned_count, accepted_count, rejected_count, duplicate_count,
    movement_total_minor, completeness_state, incompleteness_reason,
    request_fingerprint, response_fingerprint, set_fingerprint,
    retrieval_started_at, retrieval_completed_at
  ) VALUES (
    p_scope.id, p_scope.client_entity_id, v_side, p_period_start, p_period_end,
    public.balance_period_start_utc_v1(p_period_start, p_scope.account_timezone),
    public.balance_period_end_exclusive_utc_v1(p_period_end, p_scope.account_timezone),
    v_expected_basis, v_open_id, v_close_id, p_evidence->>'paginationMode',
    (p_evidence->>'pageCount')::integer, (p_evidence->>'paginationComplete')::boolean,
    (p_evidence->>'terminalBoundarySeen')::boolean, (p_evidence->>'coverageComplete')::boolean,
    (p_evidence->>'resultTruncated')::boolean, (p_evidence->>'errorCount')::integer,
    (p_evidence->>'returnedCount')::integer, (p_evidence->>'acceptedCount')::integer,
    (p_evidence->>'rejectedCount')::integer, (p_evidence->>'duplicateCount')::integer,
    (p_evidence->>'movementTotalMinor')::bigint, p_evidence->>'completenessState',
    p_evidence->>'incompletenessReason',
    public.balance_shadow_decode_sha256_v1(p_evidence->>'requestFingerprint', 'movement request fingerprint'),
    public.balance_shadow_decode_sha256_v1(p_evidence->>'responseFingerprint', 'movement response fingerprint'),
    public.balance_shadow_decode_sha256_v1(p_evidence->>'setFingerprint', 'movement set fingerprint'),
    (p_evidence->>'retrievalStartedAt')::timestamptz,
    (p_evidence->>'retrievalCompletedAt')::timestamptz
  ) RETURNING id INTO v_set_id;

  FOR v_member IN SELECT value FROM jsonb_array_elements(v_members) LOOP
    INSERT INTO public.balance_movement_members (
      movement_set_id, scope_id, client_entity_id, movement_identity_canonical,
      movement_identity_hash, date_precision, effective_on, raw_amount_minor,
      normalization_basis, movement_minor, currency_code, minor_unit_exponent,
      source_status, included, evidence_hash
    ) VALUES (
      v_set_id, p_scope.id, p_scope.client_entity_id,
      v_member->>'identityCanonical', decode(repeat('00', 32), 'hex'),
      'date', (v_member->>'effectiveOn')::date, (v_member->>'rawAmountMinor')::bigint,
      'normalized_account_effect', (v_member->>'movementMinor')::bigint,
      p_scope.currency_code, p_scope.minor_unit_exponent,
      v_member->>'sourceStatus', true,
      public.balance_shadow_decode_sha256_v1(v_member->>'evidenceHash', 'movement evidence hash')
    );
  END LOOP;

  RETURN jsonb_build_object(
    'openingSnapshotId', v_open_id,
    'closingSnapshotId', v_close_id,
    'movementSetId', v_set_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_balance_reconciliation_shadow_v1(
  p_actor_user_id uuid,
  p_scope_id uuid,
  p_period_start date,
  p_period_end date,
  p_request_fingerprint_hex text,
  p_source_evidence jsonb,
  p_ledger_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_preflight jsonb;
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
  v_expected_hex text;
  v_source_ids jsonb;
  v_ledger_ids jsonb;
  v_run public.balance_reconciliation_runs%ROWTYPE;
  v_revision public.balance_reconciliation_revisions%ROWTYPE;
BEGIN
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'shadow period end precedes period start' USING ERRCODE = '22023';
  END IF;
  v_preflight := public.prepare_balance_reconciliation_shadow_scope_v1(p_actor_user_id, p_scope_id);
  IF v_preflight->>'outcome' <> 'READY' THEN
    RAISE EXCEPTION '%', v_preflight->>'reason_code' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT v_scope FROM public.balance_reconciliation_scopes WHERE id = p_scope_id;

  IF p_source_evidence->>'side' <> 'source'
     OR p_source_evidence->>'provider' IS DISTINCT FROM v_scope.source_provider
     OR p_source_evidence->>'organisationId' IS DISTINCT FROM v_scope.source_external_organisation_id
     OR p_source_evidence->>'accountId' IS DISTINCT FROM v_scope.source_account_id
     OR p_source_evidence->>'currencyCode' IS DISTINCT FROM v_scope.currency_code
     OR (p_source_evidence->>'minorUnitExponent')::smallint IS DISTINCT FROM v_scope.minor_unit_exponent
     OR p_source_evidence->>'dateBasis' IS DISTINCT FROM v_scope.source_date_basis
     OR p_source_evidence->'opening'->>'origin' <> 'artifact_reported'
     OR p_source_evidence->'closing'->>'origin' <> 'artifact_reported'
     OR (p_source_evidence->'opening'->>'localBoundaryDate')::date <> p_period_start
     OR (p_source_evidence->'closing'->>'localBoundaryDate')::date <> p_period_end + 1
     OR (p_source_evidence->'opening'->>'asOfExclusive')::timestamptz <>
        public.balance_period_start_utc_v1(p_period_start, v_scope.account_timezone)
     OR (p_source_evidence->'closing'->>'asOfExclusive')::timestamptz <>
        public.balance_period_end_exclusive_utc_v1(p_period_end, v_scope.account_timezone)
     OR p_source_evidence->>'setFingerprint' IS DISTINCT FROM
        public.balance_shadow_set_fingerprint_v1(p_source_evidence) THEN
    RAISE EXCEPTION 'source evidence does not satisfy the frozen shadow contract'
      USING ERRCODE = '23514';
  END IF;
  IF p_ledger_evidence->>'side' <> 'ledger'
     OR p_ledger_evidence->>'provider' IS DISTINCT FROM v_scope.ledger_provider
     OR p_ledger_evidence->>'organisationId' IS DISTINCT FROM v_scope.ledger_external_organisation_id
     OR p_ledger_evidence->>'accountId' IS DISTINCT FROM v_scope.ledger_provider_account_id
     OR p_ledger_evidence->>'currencyCode' IS DISTINCT FROM v_scope.currency_code
     OR (p_ledger_evidence->>'minorUnitExponent')::smallint IS DISTINCT FROM v_scope.minor_unit_exponent
     OR p_ledger_evidence->>'dateBasis' IS DISTINCT FROM v_scope.ledger_date_basis
     OR p_ledger_evidence->'opening'->>'origin' <> 'provider_reported'
     OR p_ledger_evidence->'closing'->>'origin' <> 'provider_reported'
     OR (p_ledger_evidence->'opening'->>'localBoundaryDate')::date <> p_period_start
     OR (p_ledger_evidence->'closing'->>'localBoundaryDate')::date <> p_period_end + 1
     OR (p_ledger_evidence->'opening'->>'asOfExclusive')::timestamptz <>
        public.balance_period_start_utc_v1(p_period_start, v_scope.account_timezone)
     OR (p_ledger_evidence->'closing'->>'asOfExclusive')::timestamptz <>
        public.balance_period_end_exclusive_utc_v1(p_period_end, v_scope.account_timezone)
     OR p_ledger_evidence->>'setFingerprint' IS DISTINCT FROM
        public.balance_shadow_set_fingerprint_v1(p_ledger_evidence) THEN
    RAISE EXCEPTION 'ledger evidence does not satisfy the frozen shadow contract'
      USING ERRCODE = '23514';
  END IF;

  v_expected_hex := encode(extensions.digest(convert_to(concat_ws('|',
    'balance-shadow-v1', p_scope_id::text, p_period_start::text, p_period_end::text,
    p_source_evidence->>'setFingerprint', p_ledger_evidence->>'setFingerprint'
  ), 'UTF8'), 'sha256'), 'hex');
  IF p_request_fingerprint_hex IS DISTINCT FROM v_expected_hex THEN
    RAISE EXCEPTION 'shadow request fingerprint does not bind the exact evidence inputs'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_scope_id::text || ':' || p_request_fingerprint_hex, 0));
  SELECT * INTO v_run
  FROM public.balance_reconciliation_runs
  WHERE scope_id = p_scope_id
    AND period_start = p_period_start
    AND period_end = p_period_end
    AND execution_mode = 'SHADOW'
    AND shadow_request_fingerprint = public.balance_shadow_decode_sha256_v1(
      p_request_fingerprint_hex, 'shadow request fingerprint'
    );
  IF FOUND THEN
    SELECT * INTO STRICT v_revision
    FROM public.balance_reconciliation_revisions
    WHERE reconciliation_run_id = v_run.id
    ORDER BY revision_no DESC LIMIT 1;
    RETURN jsonb_build_object(
      'mode', 'SHADOW', 'state', v_revision.reconciliation_state,
      'reasonCode', v_revision.primary_reason_code, 'runId', v_run.id,
      'revisionId', v_revision.id,
      'frozenInputFingerprint', encode(v_revision.frozen_input_fingerprint, 'hex'),
      'sourceCompleteness', v_revision.source_validation_code,
      'ledgerCompleteness', v_revision.ledger_validation_code,
      'residualMinor', v_revision.r_minor::text, 'reused', true
    );
  END IF;

  v_source_ids := public.balance_record_shadow_side_v1(
    v_scope, p_period_start, p_period_end, p_source_evidence
  );
  v_ledger_ids := public.balance_record_shadow_side_v1(
    v_scope, p_period_start, p_period_end, p_ledger_evidence
  );

  INSERT INTO public.balance_reconciliation_runs (
    scope_id, client_entity_id, period_start, period_end,
    period_start_utc, period_end_exclusive_utc, run_identity_canonical,
    execution_mode, shadow_request_fingerprint
  ) VALUES (
    v_scope.id, v_scope.client_entity_id, p_period_start, p_period_end,
    public.balance_period_start_utc_v1(p_period_start, v_scope.account_timezone),
    public.balance_period_end_exclusive_utc_v1(p_period_end, v_scope.account_timezone),
    'shadow|' || p_request_fingerprint_hex, 'SHADOW',
    public.balance_shadow_decode_sha256_v1(p_request_fingerprint_hex, 'shadow request fingerprint')
  ) RETURNING * INTO v_run;

  INSERT INTO public.balance_reconciliation_revisions (
    reconciliation_run_id, scope_id, client_entity_id, revision_no,
    source_movement_set_id, ledger_movement_set_id,
    opening_outstanding_revision_ids, closing_outstanding_revision_ids,
    evaluated_at
  ) VALUES (
    v_run.id, v_scope.id, v_scope.client_entity_id, 1,
    (v_source_ids->>'movementSetId')::uuid,
    (v_ledger_ids->>'movementSetId')::uuid,
    '{}'::uuid[], '{}'::uuid[], now()
  ) RETURNING * INTO v_revision;

  RETURN jsonb_build_object(
    'mode', 'SHADOW', 'state', v_revision.reconciliation_state,
    'reasonCode', v_revision.primary_reason_code, 'runId', v_run.id,
    'revisionId', v_revision.id,
    'frozenInputFingerprint', encode(v_revision.frozen_input_fingerprint, 'hex'),
    'sourceCompleteness', v_revision.source_validation_code,
    'ledgerCompleteness', v_revision.ledger_validation_code,
    'residualMinor', v_revision.r_minor::text, 'reused', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_shadow_decode_sha256_v1(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.balance_shadow_set_fingerprint_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_balance_reconciliation_shadow_scope_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.balance_record_shadow_side_v1(
  public.balance_reconciliation_scopes, date, date, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_balance_reconciliation_shadow_v1(
  uuid, uuid, date, date, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.prepare_balance_reconciliation_shadow_scope_v1(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_balance_reconciliation_shadow_v1(
  uuid, uuid, date, date, text, jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.record_balance_reconciliation_shadow_v1(
  uuid, uuid, date, date, text, jsonb, jsonb
) IS 'Persists immutable paired-OFX and QuickBooks GL evidence and invokes only a SHADOW balance proof.';

NOTIFY pgrst, 'reload schema';

COMMIT;
