-- Step 6 Day 4: additive true-balance reconciliation foundation.
--
-- This migration intentionally does not read from or modify the semantics of
-- legacy reconciliation tables. It adds account scope, immutable balance and
-- movement evidence, exact minor-unit normalization, cutoff helpers, and
-- deterministic completeness validation only.

BEGIN;

-- ---------------------------------------------------------------------------
-- Exact money and cutoff primitives
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_checked_add_minor_v1(
  p_left bigint,
  p_right bigint
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result numeric;
BEGIN
  v_result := p_left::numeric + p_right::numeric;
  IF v_result < -9223372036854775808::numeric
     OR v_result > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'minor-unit arithmetic overflow' USING ERRCODE = '22003';
  END IF;
  RETURN v_result::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_normalize_legacy_movement_v1(
  p_account_class text,
  p_legacy_amount_minor bigint
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result numeric;
BEGIN
  IF p_account_class NOT IN ('asset', 'liability', 'credit_card', 'overdraft') THEN
    RAISE EXCEPTION 'unsupported reconciliation account class' USING ERRCODE = '22023';
  END IF;

  -- Legacy Zaki amounts are positive for money out. Asset position decreases
  -- on money out; liability/card/overdraft position increases.
  v_result := CASE WHEN p_account_class = 'asset'
                   THEN -p_legacy_amount_minor::numeric
                   ELSE p_legacy_amount_minor::numeric END;
  IF v_result < -9223372036854775808::numeric
     OR v_result > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'normalized movement exceeds bigint minor-unit range'
      USING ERRCODE = '22003';
  END IF;
  RETURN v_result::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_normalize_raw_balance_v1(
  p_raw_balance_minor bigint,
  p_sign_multiplier integer
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result numeric;
BEGIN
  IF p_sign_multiplier NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'balance sign multiplier must be -1 or 1' USING ERRCODE = '22023';
  END IF;
  v_result := p_raw_balance_minor::numeric * p_sign_multiplier::numeric;
  IF v_result < -9223372036854775808::numeric
     OR v_result > 9223372036854775807::numeric THEN
    RAISE EXCEPTION 'normalized balance exceeds bigint minor-unit range'
      USING ERRCODE = '22003';
  END IF;
  RETURN v_result::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_assert_iana_timezone_v1(
  p_timezone text
) RETURNS text
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  v_timezone text := btrim(p_timezone);
BEGIN
  IF v_timezone = ''
     OR (v_timezone <> 'UTC' AND v_timezone NOT LIKE '%/%')
     OR v_timezone LIKE 'posix/%'
     OR v_timezone LIKE 'right/%'
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_timezone) THEN
    RAISE EXCEPTION 'valid IANA account timezone is required' USING ERRCODE = '22023';
  END IF;
  RETURN v_timezone;
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_period_start_utc_v1(
  p_period_start date,
  p_timezone text
) RETURNS timestamptz
LANGUAGE sql
STABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT p_period_start::timestamp
         AT TIME ZONE public.balance_assert_iana_timezone_v1(p_timezone);
$$;

CREATE OR REPLACE FUNCTION public.balance_period_end_exclusive_utc_v1(
  p_period_end date,
  p_timezone text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_period_end = '9999-12-31'::date THEN
    RAISE EXCEPTION 'period end cannot be advanced to an exclusive boundary'
      USING ERRCODE = '22008';
  END IF;
  RETURN (p_period_end + 1)::timestamp
         AT TIME ZONE public.balance_assert_iana_timezone_v1(p_timezone);
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_date_in_period_v1(
  p_effective_on date,
  p_period_start date,
  p_period_end date
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT p_period_end >= p_period_start
     AND p_effective_on >= p_period_start
     AND p_effective_on <= p_period_end;
$$;

CREATE OR REPLACE FUNCTION public.balance_timestamp_in_period_v1(
  p_effective_at timestamptz,
  p_period_start date,
  p_period_end date,
  p_timezone text
) RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT p_period_end >= p_period_start
     AND p_effective_at >= public.balance_period_start_utc_v1(p_period_start, p_timezone)
     AND p_effective_at < public.balance_period_end_exclusive_utc_v1(p_period_end, p_timezone);
$$;

-- ---------------------------------------------------------------------------
-- Account reconciliation scope
-- ---------------------------------------------------------------------------

CREATE TABLE public.balance_reconciliation_scopes (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid NOT NULL,
  financial_account_id            uuid NOT NULL,
  ledger_provider_connection_id   uuid NOT NULL,
  ledger_provider                 text NOT NULL CHECK (ledger_provider IN ('quickbooks', 'xero')),
  ledger_external_organisation_id text NOT NULL CHECK (btrim(ledger_external_organisation_id) <> ''),
  ledger_provider_account_id      text NOT NULL CHECK (btrim(ledger_provider_account_id) <> ''),
  source_provider                 text NOT NULL CHECK (btrim(source_provider) <> ''),
  source_external_organisation_id text,
  source_account_id               text NOT NULL CHECK (btrim(source_account_id) <> ''),
  account_class                   text NOT NULL
                                  CHECK (account_class IN ('asset', 'liability', 'credit_card', 'overdraft')),
  currency_code                   text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent             smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  account_timezone                text NOT NULL CHECK (btrim(account_timezone) <> ''),
  source_date_basis               text NOT NULL
                                  CHECK (source_date_basis IN ('posted_date', 'value_date', 'transaction_date')),
  ledger_date_basis               text NOT NULL
                                  CHECK (ledger_date_basis IN ('accounting_date', 'posted_date', 'provider_transaction_date')),
  source_balance_sign_multiplier  smallint NOT NULL CHECK (source_balance_sign_multiplier IN (-1, 1)),
  ledger_balance_sign_multiplier  smallint NOT NULL CHECK (ledger_balance_sign_multiplier IN (-1, 1)),
  contract_version                text NOT NULL CHECK (btrim(contract_version) <> ''),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  UNIQUE (id, client_entity_id, ledger_book_id, financial_account_id),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    ledger_provider_connection_id, client_entity_id, ledger_book_id,
    ledger_provider, ledger_external_organisation_id
  ) REFERENCES public.provider_connections(
    id, client_entity_id, ledger_book_id, provider, external_organisation_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    financial_account_id, client_entity_id, ledger_book_id
  ) REFERENCES public.financial_accounts(
    id, client_entity_id, ledger_book_id
  ) ON DELETE RESTRICT,
  CHECK (source_external_organisation_id IS NULL OR btrim(source_external_organisation_id) <> '')
);

CREATE UNIQUE INDEX balance_reconciliation_scopes_identity_idx
  ON public.balance_reconciliation_scopes (
    client_entity_id, ledger_book_id, financial_account_id,
    source_provider, COALESCE(source_external_organisation_id, ''), source_account_id,
    ledger_provider_connection_id, ledger_provider_account_id, currency_code,
    contract_version
  );

CREATE OR REPLACE FUNCTION public.balance_scope_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_currency text;
  v_minor_unit smallint;
BEGIN
  NEW.account_timezone := public.balance_assert_iana_timezone_v1(NEW.account_timezone);

  SELECT account.currency_code INTO v_currency
  FROM public.financial_accounts AS account
  WHERE account.id = NEW.financial_account_id
    AND account.client_entity_id = NEW.client_entity_id
    AND account.ledger_book_id = NEW.ledger_book_id
    AND account.status = 'active'
    AND account.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active owned financial account is required' USING ERRCODE = '23514';
  END IF;
  IF v_currency IS NOT NULL AND v_currency IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION 'reconciliation scope currency conflicts with financial account'
      USING ERRCODE = '23514';
  END IF;

  SELECT default_minor_unit INTO v_minor_unit
  FROM public.currency_definitions
  WHERE code = NEW.currency_code AND status = 'active';
  IF NOT FOUND OR v_minor_unit IS DISTINCT FROM NEW.minor_unit_exponent THEN
    RAISE EXCEPTION 'reconciliation scope minor unit conflicts with active currency definition'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_posting_account_mappings AS mapping
    WHERE mapping.practice_id = NEW.practice_id
      AND mapping.client_entity_id = NEW.client_entity_id
      AND mapping.ledger_book_id = NEW.ledger_book_id
      AND mapping.provider_connection_id = NEW.ledger_provider_connection_id
      AND mapping.financial_account_id = NEW.financial_account_id
      AND mapping.provider = NEW.ledger_provider
      AND mapping.external_organisation_id = NEW.ledger_external_organisation_id
      AND mapping.provider_account_id = NEW.ledger_provider_account_id
      AND mapping.mapping_status = 'active'
      AND mapping.archived_at IS NULL
      AND mapping.effective_from <= NEW.created_at
      AND (mapping.effective_to IS NULL OR mapping.effective_to > NEW.created_at)
  ) THEN
    RAISE EXCEPTION 'active exact provider account mapping is required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_reconciliation_scopes_validate
BEFORE INSERT ON public.balance_reconciliation_scopes
FOR EACH ROW EXECUTE FUNCTION public.balance_scope_validate_v1();

-- ---------------------------------------------------------------------------
-- Immutable balance evidence
-- ---------------------------------------------------------------------------

CREATE TABLE public.balance_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id                 uuid NOT NULL,
  client_entity_id         uuid NOT NULL,
  side                     text NOT NULL CHECK (side IN ('source', 'ledger')),
  boundary                 text NOT NULL CHECK (boundary IN ('opening', 'closing')),
  local_boundary_date      date NOT NULL,
  as_of_exclusive          timestamptz NOT NULL,
  raw_balance_text         text NOT NULL CHECK (btrim(raw_balance_text) <> ''),
  raw_currency_text        text NOT NULL CHECK (btrim(raw_currency_text) <> ''),
  raw_balance_minor        bigint NOT NULL,
  balance_sign_multiplier  smallint NOT NULL CHECK (balance_sign_multiplier IN (-1, 1)),
  balance_minor            bigint NOT NULL,
  currency_code            text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent      smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  snapshot_origin          text NOT NULL
                           CHECK (snapshot_origin IN ('provider_reported', 'artifact_reported', 'prior_closing_carry')),
  verification_state       text NOT NULL CHECK (verification_state IN ('verified', 'rejected')),
  provider_version         text,
  provider_updated_at      timestamptz,
  retrieved_at             timestamptz NOT NULL,
  artifact_id              uuid,
  carried_from_snapshot_id uuid,
  raw_payload_hash         bytea CHECK (raw_payload_hash IS NULL OR octet_length(raw_payload_hash) = 32),
  evidence_fingerprint     bytea NOT NULL CHECK (octet_length(evidence_fingerprint) = 32),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_id),
  UNIQUE (id, scope_id, side),
  UNIQUE (scope_id, side, boundary, as_of_exclusive, evidence_fingerprint),
  FOREIGN KEY (scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_scopes(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (carried_from_snapshot_id, scope_id)
    REFERENCES public.balance_snapshots(id, scope_id) ON DELETE RESTRICT,
  CHECK (balance_minor::numeric = raw_balance_minor::numeric * balance_sign_multiplier::numeric),
  CHECK (
    (snapshot_origin = 'provider_reported' AND raw_payload_hash IS NOT NULL
      AND artifact_id IS NULL AND carried_from_snapshot_id IS NULL)
    OR (snapshot_origin = 'artifact_reported' AND artifact_id IS NOT NULL
      AND carried_from_snapshot_id IS NULL)
    OR (snapshot_origin = 'prior_closing_carry' AND carried_from_snapshot_id IS NOT NULL
      AND artifact_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION public.balance_snapshot_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
  v_expected_multiplier smallint;
  v_carried public.balance_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_scope
  FROM public.balance_reconciliation_scopes
  WHERE id = NEW.scope_id AND client_entity_id = NEW.client_entity_id;

  v_expected_multiplier := CASE WHEN NEW.side = 'source'
    THEN v_scope.source_balance_sign_multiplier
    ELSE v_scope.ledger_balance_sign_multiplier END;
  IF NEW.balance_sign_multiplier IS DISTINCT FROM v_expected_multiplier THEN
    RAISE EXCEPTION 'snapshot sign multiplier conflicts with reconciliation scope'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.currency_code IS DISTINCT FROM v_scope.currency_code
     OR NEW.minor_unit_exponent IS DISTINCT FROM v_scope.minor_unit_exponent THEN
    RAISE EXCEPTION 'snapshot money metadata conflicts with reconciliation scope'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.as_of_exclusive IS DISTINCT FROM
     (NEW.local_boundary_date::timestamp AT TIME ZONE v_scope.account_timezone) THEN
    RAISE EXCEPTION 'snapshot cutoff does not equal local boundary in account timezone'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.snapshot_origin = 'prior_closing_carry' THEN
    SELECT * INTO STRICT v_carried
    FROM public.balance_snapshots
    WHERE id = NEW.carried_from_snapshot_id AND scope_id = NEW.scope_id;
    IF v_carried.side IS DISTINCT FROM NEW.side
       OR v_carried.boundary <> 'closing'
       OR v_carried.verification_state <> 'verified'
       OR v_carried.as_of_exclusive IS DISTINCT FROM NEW.as_of_exclusive
       OR v_carried.balance_minor IS DISTINCT FROM NEW.balance_minor THEN
      RAISE EXCEPTION 'opening carry must exactly reuse a verified closing snapshot at the same boundary'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_snapshots_validate
BEFORE INSERT ON public.balance_snapshots
FOR EACH ROW EXECUTE FUNCTION public.balance_snapshot_validate_v1();

-- ---------------------------------------------------------------------------
-- Immutable movement manifests and evidence members
-- ---------------------------------------------------------------------------

CREATE TABLE public.balance_movement_sets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id                 uuid NOT NULL,
  client_entity_id         uuid NOT NULL,
  side                     text NOT NULL CHECK (side IN ('source', 'ledger')),
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  period_start_utc         timestamptz NOT NULL,
  period_end_exclusive_utc timestamptz NOT NULL,
  date_basis               text NOT NULL,
  opening_snapshot_id      uuid NOT NULL,
  closing_snapshot_id      uuid NOT NULL,
  pagination_mode          text NOT NULL
                           CHECK (pagination_mode IN ('provider_cursor', 'artifact_pages', 'not_applicable')),
  page_count               integer NOT NULL CHECK (page_count >= 0),
  pagination_complete      boolean NOT NULL,
  terminal_boundary_seen   boolean NOT NULL,
  coverage_complete        boolean NOT NULL,
  result_truncated         boolean NOT NULL DEFAULT false,
  error_count              integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  returned_count           integer NOT NULL CHECK (returned_count >= 0),
  accepted_count           integer NOT NULL CHECK (accepted_count >= 0),
  rejected_count           integer NOT NULL CHECK (rejected_count >= 0),
  duplicate_count          integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  movement_total_minor     bigint NOT NULL,
  completeness_state       text NOT NULL CHECK (completeness_state IN ('complete', 'incomplete', 'conflicted')),
  incompleteness_reason    text,
  request_fingerprint      bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  response_fingerprint     bytea NOT NULL CHECK (octet_length(response_fingerprint) = 32),
  set_fingerprint          bytea NOT NULL CHECK (octet_length(set_fingerprint) = 32),
  retrieval_started_at     timestamptz NOT NULL,
  retrieval_completed_at   timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_id),
  UNIQUE (scope_id, side, period_start, period_end, set_fingerprint),
  FOREIGN KEY (scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_scopes(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (opening_snapshot_id, scope_id, side)
    REFERENCES public.balance_snapshots(id, scope_id, side) ON DELETE RESTRICT,
  FOREIGN KEY (closing_snapshot_id, scope_id, side)
    REFERENCES public.balance_snapshots(id, scope_id, side) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (retrieval_completed_at >= retrieval_started_at),
  CHECK (returned_count = accepted_count + rejected_count + duplicate_count),
  CHECK ((completeness_state = 'complete' AND incompleteness_reason IS NULL)
      OR (completeness_state <> 'complete' AND incompleteness_reason IS NOT NULL AND btrim(incompleteness_reason) <> ''))
);

CREATE TABLE public.balance_movement_members (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_set_id             uuid NOT NULL,
  scope_id                    uuid NOT NULL,
  client_entity_id            uuid NOT NULL,
  movement_identity_canonical text NOT NULL
                              CHECK (octet_length(movement_identity_canonical) BETWEEN 1 AND 2000),
  movement_identity_hash      bytea NOT NULL CHECK (octet_length(movement_identity_hash) = 32),
  legacy_record_type          text REFERENCES public.legacy_record_types(code) ON DELETE RESTRICT,
  legacy_record_id            uuid,
  observation_id              uuid,
  observation_revision_id     uuid,
  date_precision              text NOT NULL CHECK (date_precision IN ('date', 'timestamp')),
  effective_on                date,
  effective_at                timestamptz,
  raw_amount_minor            bigint NOT NULL,
  normalization_basis         text NOT NULL
                              CHECK (normalization_basis IN ('legacy_positive_out', 'normalized_account_effect')),
  movement_minor              bigint NOT NULL,
  currency_code               text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent         smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  source_status               text NOT NULL
                              CHECK (source_status IN ('pending', 'posted', 'settled', 'corrected', 'voided', 'superseded', 'unknown')),
  included                    boolean NOT NULL,
  exclusion_reason            text,
  evidence_hash               bytea NOT NULL CHECK (octet_length(evidence_hash) = 32),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, movement_set_id),
  UNIQUE (movement_set_id, movement_identity_canonical),
  UNIQUE (movement_set_id, movement_identity_hash),
  FOREIGN KEY (movement_set_id, scope_id)
    REFERENCES public.balance_movement_sets(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_scopes(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_revision_id, observation_id, client_entity_id)
    REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((legacy_record_type IS NULL) = (legacy_record_id IS NULL)),
  CHECK ((observation_id IS NULL) = (observation_revision_id IS NULL)),
  CHECK ((date_precision = 'date' AND effective_on IS NOT NULL AND effective_at IS NULL)
      OR (date_precision = 'timestamp' AND effective_at IS NOT NULL AND effective_on IS NULL)),
  CHECK ((included AND exclusion_reason IS NULL)
      OR (NOT included AND exclusion_reason IS NOT NULL AND btrim(exclusion_reason) <> ''))
);

CREATE OR REPLACE FUNCTION public.balance_movement_set_static_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
  v_expected_basis text;
  v_opening public.balance_snapshots%ROWTYPE;
  v_closing public.balance_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_scope FROM public.balance_reconciliation_scopes
  WHERE id = NEW.scope_id AND client_entity_id = NEW.client_entity_id;
  v_expected_basis := CASE WHEN NEW.side = 'source'
    THEN v_scope.source_date_basis ELSE v_scope.ledger_date_basis END;

  IF NEW.date_basis IS DISTINCT FROM v_expected_basis THEN
    RAISE EXCEPTION 'movement-set date basis conflicts with reconciliation scope'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.period_start_utc IS DISTINCT FROM
       public.balance_period_start_utc_v1(NEW.period_start, v_scope.account_timezone)
     OR NEW.period_end_exclusive_utc IS DISTINCT FROM
       public.balance_period_end_exclusive_utc_v1(NEW.period_end, v_scope.account_timezone) THEN
    RAISE EXCEPTION 'movement-set UTC boundaries conflict with local period and timezone'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO STRICT v_opening FROM public.balance_snapshots
  WHERE id = NEW.opening_snapshot_id AND scope_id = NEW.scope_id AND side = NEW.side;
  SELECT * INTO STRICT v_closing FROM public.balance_snapshots
  WHERE id = NEW.closing_snapshot_id AND scope_id = NEW.scope_id AND side = NEW.side;
  IF v_opening.boundary <> 'opening' OR v_opening.verification_state <> 'verified'
     OR v_opening.as_of_exclusive IS DISTINCT FROM NEW.period_start_utc THEN
    RAISE EXCEPTION 'movement set requires verified opening snapshot at period start'
      USING ERRCODE = '23514';
  END IF;
  IF v_closing.boundary <> 'closing' OR v_closing.verification_state <> 'verified'
     OR v_closing.as_of_exclusive IS DISTINCT FROM NEW.period_end_exclusive_utc THEN
    RAISE EXCEPTION 'movement set requires verified closing snapshot at period cutoff'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.completeness_state = 'complete' AND (
       NOT NEW.pagination_complete OR NOT NEW.terminal_boundary_seen
       OR NOT NEW.coverage_complete OR NEW.result_truncated
       OR NEW.error_count <> 0 OR NEW.duplicate_count <> 0
       OR NEW.page_count = 0) THEN
    RAISE EXCEPTION 'complete movement set has incomplete retrieval evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_movement_sets_static_validate
BEFORE INSERT ON public.balance_movement_sets
FOR EACH ROW EXECUTE FUNCTION public.balance_movement_set_static_validate_v1();

CREATE OR REPLACE FUNCTION public.balance_movement_member_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set public.balance_movement_sets%ROWTYPE;
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
  v_expected bigint;
BEGIN
  NEW.movement_identity_hash := extensions.digest(
    convert_to(NEW.movement_identity_canonical, 'UTF8'), 'sha256'
  );
  SELECT * INTO STRICT v_set FROM public.balance_movement_sets
  WHERE id = NEW.movement_set_id AND scope_id = NEW.scope_id;
  SELECT * INTO STRICT v_scope FROM public.balance_reconciliation_scopes
  WHERE id = NEW.scope_id AND client_entity_id = NEW.client_entity_id;

  IF NEW.currency_code IS DISTINCT FROM v_scope.currency_code
     OR NEW.minor_unit_exponent IS DISTINCT FROM v_scope.minor_unit_exponent THEN
    RAISE EXCEPTION 'movement money metadata conflicts with reconciliation scope'
      USING ERRCODE = '23514';
  END IF;

  v_expected := CASE WHEN NEW.normalization_basis = 'legacy_positive_out'
    THEN public.balance_normalize_legacy_movement_v1(v_scope.account_class, NEW.raw_amount_minor)
    ELSE NEW.raw_amount_minor END;
  IF NEW.movement_minor IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'movement sign normalization is inconsistent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.included AND NEW.source_status NOT IN ('posted', 'settled', 'corrected') THEN
    RAISE EXCEPTION 'pending, voided, superseded, or unknown movement cannot be included'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.included AND NEW.date_precision = 'date'
     AND NOT public.balance_date_in_period_v1(NEW.effective_on, v_set.period_start, v_set.period_end) THEN
    RAISE EXCEPTION 'included date movement is outside the frozen period'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.included AND NEW.date_precision = 'timestamp'
     AND NOT public.balance_timestamp_in_period_v1(
       NEW.effective_at, v_set.period_start, v_set.period_end, v_scope.account_timezone
     ) THEN
    RAISE EXCEPTION 'included timestamp movement is outside the frozen cutoff'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_movement_members_validate
BEFORE INSERT ON public.balance_movement_members
FOR EACH ROW EXECUTE FUNCTION public.balance_movement_member_validate_v1();

CREATE OR REPLACE FUNCTION public.balance_movement_set_validation_v1(
  p_movement_set_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set public.balance_movement_sets%ROWTYPE;
  v_opening bigint;
  v_closing bigint;
  v_member_count bigint;
  v_total numeric;
  v_rollforward numeric;
BEGIN
  SELECT * INTO v_set FROM public.balance_movement_sets WHERE id = p_movement_set_id;
  IF NOT FOUND THEN RETURN 'MOVEMENT_SET_NOT_FOUND'; END IF;
  IF NOT v_set.coverage_complete THEN RETURN 'COVERAGE_INCOMPLETE'; END IF;
  IF NOT v_set.pagination_complete THEN RETURN 'PAGINATION_INCOMPLETE'; END IF;
  IF NOT v_set.terminal_boundary_seen THEN RETURN 'TERMINAL_BOUNDARY_NOT_SEEN'; END IF;
  IF v_set.result_truncated THEN RETURN 'PROVIDER_RESULT_TRUNCATED'; END IF;
  IF v_set.error_count <> 0 THEN RETURN 'RETRIEVAL_ERRORS'; END IF;
  IF v_set.duplicate_count <> 0 THEN RETURN 'DUPLICATE_IDENTITIES_REPORTED'; END IF;
  IF v_set.page_count = 0 THEN RETURN 'NO_RETRIEVAL_PAGES'; END IF;
  IF v_set.returned_count <> v_set.accepted_count + v_set.rejected_count + v_set.duplicate_count THEN
    RETURN 'RETURNED_COUNT_MISMATCH';
  END IF;

  SELECT count(*), COALESCE(sum(member.movement_minor::numeric) FILTER (WHERE member.included), 0)
    INTO v_member_count, v_total
  FROM public.balance_movement_members AS member
  WHERE member.movement_set_id = v_set.id;
  IF v_member_count <> v_set.accepted_count + v_set.rejected_count THEN
    RETURN 'MEMBER_COUNT_MISMATCH';
  END IF;
  IF v_total <> v_set.movement_total_minor::numeric THEN RETURN 'MOVEMENT_TOTAL_MISMATCH'; END IF;

  SELECT balance_minor INTO v_opening FROM public.balance_snapshots
  WHERE id = v_set.opening_snapshot_id AND verification_state = 'verified';
  IF NOT FOUND THEN RETURN 'OPENING_SNAPSHOT_UNVERIFIED'; END IF;
  SELECT balance_minor INTO v_closing FROM public.balance_snapshots
  WHERE id = v_set.closing_snapshot_id AND verification_state = 'verified';
  IF NOT FOUND THEN RETURN 'CLOSING_SNAPSHOT_UNVERIFIED'; END IF;
  v_rollforward := v_opening::numeric + v_total;
  IF v_rollforward < -9223372036854775808::numeric
     OR v_rollforward > 9223372036854775807::numeric THEN
    RETURN 'MINOR_UNIT_ARITHMETIC_OVERFLOW';
  END IF;
  IF v_rollforward <> v_closing::numeric THEN RETURN 'BALANCE_ROLLFORWARD_BROKEN'; END IF;
  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_assert_complete_movement_set_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set_id uuid;
  v_state text;
  v_validation text;
BEGIN
  IF TG_TABLE_NAME = 'balance_movement_sets' THEN
    v_set_id := NEW.id;
  ELSE
    v_set_id := NEW.movement_set_id;
  END IF;
  SELECT completeness_state INTO v_state
  FROM public.balance_movement_sets WHERE id = v_set_id;
  IF v_state = 'complete' THEN
    v_validation := public.balance_movement_set_validation_v1(v_set_id);
    IF v_validation <> 'OK' THEN
      RAISE EXCEPTION 'complete movement set failed validation: %', v_validation
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER balance_movement_sets_complete_ck
AFTER INSERT ON public.balance_movement_sets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.balance_assert_complete_movement_set_v1();

CREATE CONSTRAINT TRIGGER balance_movement_members_complete_ck
AFTER INSERT ON public.balance_movement_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.balance_assert_complete_movement_set_v1();

-- All Day 4 financial evidence is append-only. Corrections are new rows with
-- new fingerprints; no service or user may rewrite an observed proof.
CREATE OR REPLACE FUNCTION public.balance_foundation_reject_update_delete_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER balance_reconciliation_scopes_append_only
BEFORE UPDATE OR DELETE ON public.balance_reconciliation_scopes
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER balance_snapshots_append_only
BEFORE UPDATE OR DELETE ON public.balance_snapshots
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER balance_movement_sets_append_only
BEFORE UPDATE OR DELETE ON public.balance_movement_sets
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER balance_movement_members_append_only
BEFORE UPDATE OR DELETE ON public.balance_movement_members
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();

-- ---------------------------------------------------------------------------
-- Tenant-readable, RPC-write-only security boundary
-- ---------------------------------------------------------------------------

ALTER TABLE public.balance_reconciliation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_movement_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_movement_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY balance_reconciliation_scopes_authenticated_select
  ON public.balance_reconciliation_scopes FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY balance_snapshots_authenticated_select
  ON public.balance_snapshots FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY balance_movement_sets_authenticated_select
  ON public.balance_movement_sets FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY balance_movement_members_authenticated_select
  ON public.balance_movement_members FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

REVOKE ALL PRIVILEGES ON TABLE
  public.balance_reconciliation_scopes,
  public.balance_snapshots,
  public.balance_movement_sets,
  public.balance_movement_members
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.balance_reconciliation_scopes,
  public.balance_snapshots,
  public.balance_movement_sets,
  public.balance_movement_members
TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.balance_checked_add_minor_v1(bigint, bigint),
  public.balance_normalize_legacy_movement_v1(text, bigint),
  public.balance_normalize_raw_balance_v1(bigint, integer),
  public.balance_assert_iana_timezone_v1(text),
  public.balance_period_start_utc_v1(date, text),
  public.balance_period_end_exclusive_utc_v1(date, text),
  public.balance_date_in_period_v1(date, date, date),
  public.balance_timestamp_in_period_v1(timestamptz, date, date, text),
  public.balance_movement_set_validation_v1(uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.balance_checked_add_minor_v1(bigint, bigint),
  public.balance_normalize_legacy_movement_v1(text, bigint),
  public.balance_normalize_raw_balance_v1(bigint, integer),
  public.balance_assert_iana_timezone_v1(text),
  public.balance_period_start_utc_v1(date, text),
  public.balance_period_end_exclusive_utc_v1(date, text),
  public.balance_date_in_period_v1(date, date, date),
  public.balance_timestamp_in_period_v1(timestamptz, date, date, text),
  public.balance_movement_set_validation_v1(uuid)
TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.balance_scope_validate_v1(),
  public.balance_snapshot_validate_v1(),
  public.balance_movement_set_static_validate_v1(),
  public.balance_movement_member_validate_v1(),
  public.balance_assert_complete_movement_set_v1(),
  public.balance_foundation_reject_update_delete_v1()
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.balance_reconciliation_scopes IS
  'Step 6 immutable account/currency/orientation/cutoff contract; additive beside legacy reconciliation.';
COMMENT ON TABLE public.balance_snapshots IS
  'Step 6 immutable source or ledger balance observations in exact signed minor units.';
COMMENT ON TABLE public.balance_movement_sets IS
  'Step 6 immutable retrieval manifests; complete sets require deferred count, total, and rollforward proof.';
COMMENT ON TABLE public.balance_movement_members IS
  'Step 6 immutable movement evidence; legacy signs are normalized without changing legacy rows.';

NOTIFY pgrst, 'reload schema';

COMMIT;
