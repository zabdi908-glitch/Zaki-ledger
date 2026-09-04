-- Step 6 Day 5: additive outstanding-item lifecycle and true-balance proof.
--
-- No provider is read and no legacy row is read or changed by this migration.
-- All monetary values are normalized signed minor units inherited from migration 029.

BEGIN;

-- ---------------------------------------------------------------------------
-- Outstanding items and append-only evidence revisions
-- ---------------------------------------------------------------------------

CREATE TABLE public.reconciliation_outstanding_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id                      uuid NOT NULL,
  client_entity_id              uuid NOT NULL,
  outstanding_identity_canonical text NOT NULL
                                CHECK (octet_length(outstanding_identity_canonical) BETWEEN 1 AND 2000),
  outstanding_identity_hash     bytea NOT NULL CHECK (octet_length(outstanding_identity_hash) = 32),
  item_kind                     text NOT NULL
                                CHECK (item_kind IN (
                                  'deposit_in_transit', 'outstanding_payment',
                                  'timing_difference', 'other_supported'
                                )),
  original_adjustment_minor     bigint NOT NULL CHECK (original_adjustment_minor <> 0),
  currency_code                 text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent           smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  discovered_at                 timestamptz NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_id),
  UNIQUE (id, scope_id, client_entity_id),
  UNIQUE (scope_id, outstanding_identity_canonical),
  UNIQUE (scope_id, outstanding_identity_hash),
  FOREIGN KEY (scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_scopes(id, client_entity_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.reconciliation_outstanding_item_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scope public.balance_reconciliation_scopes%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_scope
  FROM public.balance_reconciliation_scopes
  WHERE id = NEW.scope_id AND client_entity_id = NEW.client_entity_id;

  IF NEW.currency_code IS DISTINCT FROM v_scope.currency_code
     OR NEW.minor_unit_exponent IS DISTINCT FROM v_scope.minor_unit_exponent THEN
    RAISE EXCEPTION 'outstanding-item money metadata conflicts with reconciliation scope'
      USING ERRCODE = '23514';
  END IF;

  NEW.outstanding_identity_hash := extensions.digest(
    convert_to(NEW.outstanding_identity_canonical, 'UTF8'), 'sha256'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER reconciliation_outstanding_items_validate
BEFORE INSERT ON public.reconciliation_outstanding_items
FOR EACH ROW EXECUTE FUNCTION public.reconciliation_outstanding_item_validate_v1();

CREATE TABLE public.reconciliation_outstanding_item_revisions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outstanding_item_id        uuid NOT NULL,
  scope_id                   uuid NOT NULL,
  client_entity_id           uuid NOT NULL,
  revision_no                integer NOT NULL CHECK (revision_no > 0),
  previous_revision_id       uuid,
  state                      text NOT NULL
                             CHECK (state IN ('open', 'partially_cleared', 'cleared', 'invalidated')),
  effective_at               timestamptz NOT NULL,
  remaining_adjustment_minor bigint NOT NULL,
  evidence_state             text NOT NULL CHECK (evidence_state IN ('complete', 'incomplete', 'rejected')),
  artifact_id                uuid,
  observation_id             uuid,
  observation_revision_id    uuid,
  raw_payload_hash           bytea CHECK (raw_payload_hash IS NULL OR octet_length(raw_payload_hash) = 32),
  evidence_fingerprint       bytea NOT NULL CHECK (octet_length(evidence_fingerprint) = 32),
  authorized_by_user_id      uuid,
  authorized_at              timestamptz,
  rationale                  text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, outstanding_item_id),
  UNIQUE (id, outstanding_item_id, scope_id),
  UNIQUE (outstanding_item_id, revision_no),
  FOREIGN KEY (outstanding_item_id, scope_id, client_entity_id)
    REFERENCES public.reconciliation_outstanding_items(id, scope_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_id, outstanding_item_id, scope_id)
    REFERENCES public.reconciliation_outstanding_item_revisions(id, outstanding_item_id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_revision_id, observation_id, client_entity_id)
    REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorized_by_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CHECK ((observation_id IS NULL) = (observation_revision_id IS NULL)),
  CHECK ((authorized_by_user_id IS NULL) = (authorized_at IS NULL)),
  CHECK (
    (evidence_state = 'complete'
      AND authorized_by_user_id IS NOT NULL
      AND (artifact_id IS NOT NULL OR observation_revision_id IS NOT NULL OR raw_payload_hash IS NOT NULL))
    OR (evidence_state = 'incomplete'
      AND rationale IS NOT NULL AND btrim(rationale) <> '')
    OR (evidence_state = 'rejected'
      AND state = 'invalidated'
      AND rationale IS NOT NULL AND btrim(rationale) <> '')
  )
);

CREATE OR REPLACE FUNCTION public.reconciliation_outstanding_revision_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.reconciliation_outstanding_items%ROWTYPE;
  v_previous public.reconciliation_outstanding_item_revisions%ROWTYPE;
  v_latest_id uuid;
BEGIN
  SELECT * INTO STRICT v_item
  FROM public.reconciliation_outstanding_items
  WHERE id = NEW.outstanding_item_id
    AND scope_id = NEW.scope_id
    AND client_entity_id = NEW.client_entity_id;

  IF NEW.authorized_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.balance_reconciliation_scopes AS scope
    JOIN public.practice_memberships AS membership
      ON membership.practice_id = scope.practice_id
     AND membership.user_id = NEW.authorized_by_user_id
    WHERE scope.id = NEW.scope_id
      AND scope.client_entity_id = NEW.client_entity_id
  ) THEN
    RAISE EXCEPTION 'outstanding-item authorization must belong to the owning practice'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at < NEW.effective_at
     OR (NEW.authorized_at IS NOT NULL AND NEW.authorized_at > NEW.created_at) THEN
    RAISE EXCEPTION 'outstanding-item evidence timing is inconsistent'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision.id INTO v_latest_id
  FROM public.reconciliation_outstanding_item_revisions AS revision
  WHERE revision.outstanding_item_id = NEW.outstanding_item_id
  ORDER BY revision.revision_no DESC
  LIMIT 1;

  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL OR v_latest_id IS NOT NULL
       OR NEW.state <> 'open'
       OR NEW.remaining_adjustment_minor IS DISTINCT FROM v_item.original_adjustment_minor THEN
      RAISE EXCEPTION 'first outstanding-item revision must open the original signed adjustment'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.previous_revision_id IS NULL THEN
    RAISE EXCEPTION 'later outstanding-item revision requires its immediate predecessor'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT v_previous
  FROM public.reconciliation_outstanding_item_revisions
  WHERE id = NEW.previous_revision_id
    AND outstanding_item_id = NEW.outstanding_item_id
    AND scope_id = NEW.scope_id;

  IF v_latest_id IS DISTINCT FROM v_previous.id
     OR NEW.revision_no <> v_previous.revision_no + 1
     OR NEW.effective_at < v_previous.effective_at THEN
    RAISE EXCEPTION 'outstanding-item revision must extend the latest revision in order'
      USING ERRCODE = '23514';
  END IF;
  IF v_previous.state IN ('cleared', 'invalidated') THEN
    RAISE EXCEPTION 'cleared or invalidated outstanding item is terminal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'partially_cleared' THEN
    IF NEW.remaining_adjustment_minor = 0
       OR sign(NEW.remaining_adjustment_minor::numeric) <> sign(v_previous.remaining_adjustment_minor::numeric)
       OR abs(NEW.remaining_adjustment_minor::numeric) >= abs(v_previous.remaining_adjustment_minor::numeric) THEN
      RAISE EXCEPTION 'partial clearance must reduce magnitude without changing sign'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state IN ('cleared', 'invalidated') THEN
    IF NEW.remaining_adjustment_minor <> 0 THEN
      RAISE EXCEPTION 'cleared or invalidated outstanding item must have zero remainder'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'later outstanding-item revision must clear, partially clear, or invalidate'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reconciliation_outstanding_item_revisions_validate
BEFORE INSERT ON public.reconciliation_outstanding_item_revisions
FOR EACH ROW EXECUTE FUNCTION public.reconciliation_outstanding_revision_validate_v1();

-- ---------------------------------------------------------------------------
-- Immutable reconciliation run identity and proof revisions
-- ---------------------------------------------------------------------------

CREATE TABLE public.balance_reconciliation_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id                   uuid NOT NULL,
  client_entity_id           uuid NOT NULL,
  period_start               date NOT NULL,
  period_end                 date NOT NULL,
  period_start_utc           timestamptz NOT NULL,
  period_end_exclusive_utc   timestamptz NOT NULL,
  run_identity_canonical     text NOT NULL CHECK (octet_length(run_identity_canonical) BETWEEN 1 AND 2000),
  run_identity_hash          bytea NOT NULL CHECK (octet_length(run_identity_hash) = 32),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_id),
  UNIQUE (id, scope_id, client_entity_id),
  UNIQUE (scope_id, period_start, period_end, run_identity_canonical),
  UNIQUE (scope_id, period_start, period_end, run_identity_hash),
  FOREIGN KEY (scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_scopes(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start)
);

CREATE OR REPLACE FUNCTION public.balance_reconciliation_run_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_timezone text;
BEGIN
  SELECT account_timezone INTO STRICT v_timezone
  FROM public.balance_reconciliation_scopes
  WHERE id = NEW.scope_id AND client_entity_id = NEW.client_entity_id;

  IF NEW.period_start_utc IS DISTINCT FROM
       public.balance_period_start_utc_v1(NEW.period_start, v_timezone)
     OR NEW.period_end_exclusive_utc IS DISTINCT FROM
       public.balance_period_end_exclusive_utc_v1(NEW.period_end, v_timezone) THEN
    RAISE EXCEPTION 'reconciliation-run UTC boundaries conflict with scope timezone'
      USING ERRCODE = '23514';
  END IF;
  NEW.run_identity_hash := extensions.digest(
    convert_to(NEW.run_identity_canonical, 'UTF8'), 'sha256'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_reconciliation_runs_validate
BEFORE INSERT ON public.balance_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION public.balance_reconciliation_run_validate_v1();

CREATE TABLE public.balance_reconciliation_revisions (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id               uuid NOT NULL,
  scope_id                            uuid NOT NULL,
  client_entity_id                    uuid NOT NULL,
  revision_no                         integer NOT NULL CHECK (revision_no > 0),
  previous_revision_id                uuid,
  source_movement_set_id              uuid NOT NULL,
  ledger_movement_set_id              uuid NOT NULL,
  source_opening_snapshot_id          uuid NOT NULL,
  source_closing_snapshot_id          uuid NOT NULL,
  ledger_opening_snapshot_id          uuid NOT NULL,
  ledger_closing_snapshot_id          uuid NOT NULL,
  opening_outstanding_revision_ids    uuid[] NOT NULL DEFAULT '{}'::uuid[],
  closing_outstanding_revision_ids    uuid[] NOT NULL DEFAULT '{}'::uuid[],
  b0_minor                            bigint NOT NULL,
  delta_b_minor                       bigint NOT NULL,
  b1_minor                            bigint NOT NULL,
  l0_minor                            bigint NOT NULL,
  delta_l_minor                       bigint NOT NULL,
  l1_minor                            bigint NOT NULL,
  o0_minor                            numeric NOT NULL,
  o1_minor                            numeric NOT NULL,
  a0_minor                            numeric NOT NULL,
  a1_minor                            numeric NOT NULL,
  r0_minor                            numeric NOT NULL,
  r_minor                             numeric NOT NULL,
  source_validation_code              text NOT NULL,
  ledger_validation_code              text NOT NULL,
  opening_outstanding_validation_code text NOT NULL,
  closing_outstanding_validation_code text NOT NULL,
  evidence_complete                   boolean NOT NULL,
  reconciliation_state                text NOT NULL
                                       CHECK (reconciliation_state IN ('FAILED', 'REVIEW', 'RECONCILED')),
  primary_reason_code                 text NOT NULL,
  reason_codes                        text[] NOT NULL,
  frozen_input_fingerprint            bytea NOT NULL CHECK (octet_length(frozen_input_fingerprint) = 32),
  evaluated_at                        timestamptz NOT NULL DEFAULT now(),
  created_at                          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, reconciliation_run_id),
  UNIQUE (id, reconciliation_run_id, scope_id),
  UNIQUE (reconciliation_run_id, revision_no),
  UNIQUE (reconciliation_run_id, frozen_input_fingerprint),
  FOREIGN KEY (reconciliation_run_id, scope_id, client_entity_id)
    REFERENCES public.balance_reconciliation_runs(id, scope_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_id, reconciliation_run_id, scope_id)
    REFERENCES public.balance_reconciliation_revisions(id, reconciliation_run_id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_movement_set_id, scope_id)
    REFERENCES public.balance_movement_sets(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_movement_set_id, scope_id)
    REFERENCES public.balance_movement_sets(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_opening_snapshot_id, scope_id)
    REFERENCES public.balance_snapshots(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_closing_snapshot_id, scope_id)
    REFERENCES public.balance_snapshots(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_opening_snapshot_id, scope_id)
    REFERENCES public.balance_snapshots(id, scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_closing_snapshot_id, scope_id)
    REFERENCES public.balance_snapshots(id, scope_id) ON DELETE RESTRICT,
  CHECK (a0_minor = b0_minor::numeric + o0_minor),
  CHECK (a1_minor = b1_minor::numeric + o1_minor),
  CHECK (r0_minor = a0_minor - l0_minor::numeric),
  CHECK (r_minor = a1_minor - l1_minor::numeric),
  CHECK (cardinality(reason_codes) > 0 AND primary_reason_code = reason_codes[1])
);

CREATE OR REPLACE FUNCTION public.balance_outstanding_selection_validation_v1(
  p_scope_id uuid,
  p_cutoff_exclusive timestamptz,
  p_evaluated_at timestamptz,
  p_revision_ids uuid[]
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total integer := COALESCE(cardinality(p_revision_ids), 0);
  v_distinct integer;
BEGIN
  SELECT count(DISTINCT selected_id) INTO v_distinct FROM unnest(COALESCE(p_revision_ids, '{}'::uuid[])) AS selected(selected_id);
  IF v_total <> v_distinct THEN RETURN 'OUTSTANDING_REVISION_DUPLICATE'; END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_revision_ids, '{}'::uuid[])) AS selected(id)
    LEFT JOIN public.reconciliation_outstanding_item_revisions AS revision ON revision.id = selected.id
    WHERE revision.id IS NULL OR revision.scope_id <> p_scope_id
       OR revision.state = 'invalidated' OR revision.effective_at >= p_cutoff_exclusive
       OR revision.created_at > p_evaluated_at
  ) THEN RETURN 'OUTSTANDING_ITEM_INVALID'; END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_revision_ids, '{}'::uuid[])) AS selected(id)
    JOIN public.reconciliation_outstanding_item_revisions AS chosen ON chosen.id = selected.id
    JOIN public.reconciliation_outstanding_item_revisions AS later
      ON later.outstanding_item_id = chosen.outstanding_item_id
     AND later.revision_no > chosen.revision_no
     AND later.effective_at < p_cutoff_exclusive
     AND later.created_at <= p_evaluated_at
  ) THEN RETURN 'OUTSTANDING_EVIDENCE_STALE'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reconciliation_outstanding_items AS item
    JOIN LATERAL (
      SELECT revision.id, revision.state
      FROM public.reconciliation_outstanding_item_revisions AS revision
      WHERE revision.outstanding_item_id = item.id
        AND revision.effective_at < p_cutoff_exclusive
        AND revision.created_at <= p_evaluated_at
      ORDER BY revision.revision_no DESC
      LIMIT 1
    ) AS latest ON true
    WHERE item.scope_id = p_scope_id
      AND latest.state <> 'invalidated'
      AND NOT (latest.id = ANY(COALESCE(p_revision_ids, '{}'::uuid[])))
  ) THEN RETURN 'OUTSTANDING_EVIDENCE_INCOMPLETE'; END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_revision_ids, '{}'::uuid[])) AS selected(id)
    JOIN public.reconciliation_outstanding_item_revisions AS revision ON revision.id = selected.id
    WHERE revision.evidence_state <> 'complete'
  ) THEN RETURN 'OUTSTANDING_EVIDENCE_INCOMPLETE'; END IF;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_outstanding_total_v1(
  p_revision_ids uuid[]
) RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(revision.remaining_adjustment_minor::numeric), 0)
  FROM unnest(COALESCE(p_revision_ids, '{}'::uuid[])) AS selected(id)
  JOIN public.reconciliation_outstanding_item_revisions AS revision ON revision.id = selected.id
  WHERE revision.state IN ('open', 'partially_cleared');
$$;

CREATE OR REPLACE FUNCTION public.balance_reconciliation_revision_validate_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.balance_reconciliation_runs%ROWTYPE;
  v_source public.balance_movement_sets%ROWTYPE;
  v_ledger public.balance_movement_sets%ROWTYPE;
  v_latest public.balance_reconciliation_revisions%ROWTYPE;
  v_source_open public.balance_snapshots%ROWTYPE;
  v_source_close public.balance_snapshots%ROWTYPE;
  v_ledger_open public.balance_snapshots%ROWTYPE;
  v_ledger_close public.balance_snapshots%ROWTYPE;
  v_open_material text;
  v_close_material text;
  v_open_universe_material text;
  v_close_universe_material text;
  v_reasons text[] := '{}'::text[];
BEGIN
  SELECT * INTO STRICT v_run
  FROM public.balance_reconciliation_runs
  WHERE id = NEW.reconciliation_run_id
    AND scope_id = NEW.scope_id
    AND client_entity_id = NEW.client_entity_id;
  IF NEW.evaluated_at < v_run.period_end_exclusive_utc OR NEW.evaluated_at > now() THEN
    RAISE EXCEPTION 'reconciliation proof evaluation must occur after cutoff and not in the future'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT v_source FROM public.balance_movement_sets
  WHERE id = NEW.source_movement_set_id AND scope_id = NEW.scope_id;
  SELECT * INTO STRICT v_ledger FROM public.balance_movement_sets
  WHERE id = NEW.ledger_movement_set_id AND scope_id = NEW.scope_id;

  IF v_source.side <> 'source' OR v_ledger.side <> 'ledger'
     OR v_source.period_start <> v_run.period_start OR v_source.period_end <> v_run.period_end
     OR v_ledger.period_start <> v_run.period_start OR v_ledger.period_end <> v_run.period_end
     OR v_source.period_start_utc <> v_run.period_start_utc
     OR v_source.period_end_exclusive_utc <> v_run.period_end_exclusive_utc
     OR v_ledger.period_start_utc <> v_run.period_start_utc
     OR v_ledger.period_end_exclusive_utc <> v_run.period_end_exclusive_utc THEN
    RAISE EXCEPTION 'reconciliation proof requires source and ledger sets for its exact scope and period'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO STRICT v_source_open FROM public.balance_snapshots WHERE id = v_source.opening_snapshot_id;
  SELECT * INTO STRICT v_source_close FROM public.balance_snapshots WHERE id = v_source.closing_snapshot_id;
  SELECT * INTO STRICT v_ledger_open FROM public.balance_snapshots WHERE id = v_ledger.opening_snapshot_id;
  SELECT * INTO STRICT v_ledger_close FROM public.balance_snapshots WHERE id = v_ledger.closing_snapshot_id;

  NEW.source_opening_snapshot_id := v_source_open.id;
  NEW.source_closing_snapshot_id := v_source_close.id;
  NEW.ledger_opening_snapshot_id := v_ledger_open.id;
  NEW.ledger_closing_snapshot_id := v_ledger_close.id;
  NEW.b0_minor := v_source_open.balance_minor;
  NEW.delta_b_minor := v_source.movement_total_minor;
  NEW.b1_minor := v_source_close.balance_minor;
  NEW.l0_minor := v_ledger_open.balance_minor;
  NEW.delta_l_minor := v_ledger.movement_total_minor;
  NEW.l1_minor := v_ledger_close.balance_minor;

  SELECT * INTO v_latest
  FROM public.balance_reconciliation_revisions
  WHERE reconciliation_run_id = NEW.reconciliation_run_id
  ORDER BY revision_no DESC LIMIT 1;
  IF NEW.revision_no = 1 THEN
    IF NEW.previous_revision_id IS NOT NULL OR FOUND THEN
      RAISE EXCEPTION 'first reconciliation revision cannot have a predecessor'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT FOUND OR NEW.previous_revision_id IS DISTINCT FROM v_latest.id
        OR NEW.revision_no <> v_latest.revision_no + 1 THEN
    RAISE EXCEPTION 'reconciliation revision must extend the latest revision in order'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(cardinality(NEW.opening_outstanding_revision_ids), 0) <>
       (SELECT count(DISTINCT id) FROM unnest(COALESCE(NEW.opening_outstanding_revision_ids, '{}'::uuid[])) AS chosen(id)) THEN
    v_reasons := array_append(v_reasons, 'FAILED_OUTSTANDING_REVISION_DUPLICATE');
  END IF;
  IF COALESCE(cardinality(NEW.closing_outstanding_revision_ids), 0) <>
       (SELECT count(DISTINCT id) FROM unnest(COALESCE(NEW.closing_outstanding_revision_ids, '{}'::uuid[])) AS chosen(id))
     AND NOT ('FAILED_OUTSTANDING_REVISION_DUPLICATE' = ANY(v_reasons)) THEN
    v_reasons := array_append(v_reasons, 'FAILED_OUTSTANDING_REVISION_DUPLICATE');
  END IF;

  NEW.opening_outstanding_validation_code := public.balance_outstanding_selection_validation_v1(
    NEW.scope_id, v_run.period_start_utc, NEW.evaluated_at, NEW.opening_outstanding_revision_ids
  );
  NEW.closing_outstanding_validation_code := public.balance_outstanding_selection_validation_v1(
    NEW.scope_id, v_run.period_end_exclusive_utc, NEW.evaluated_at, NEW.closing_outstanding_revision_ids
  );
  IF NEW.opening_outstanding_validation_code = 'OUTSTANDING_ITEM_INVALID'
     OR NEW.closing_outstanding_validation_code = 'OUTSTANDING_ITEM_INVALID' THEN
    v_reasons := array_append(v_reasons, 'FAILED_OUTSTANDING_ITEM_INVALID');
  END IF;
  IF NEW.opening_outstanding_validation_code = 'OUTSTANDING_EVIDENCE_STALE'
     OR NEW.closing_outstanding_validation_code = 'OUTSTANDING_EVIDENCE_STALE' THEN
    v_reasons := array_append(v_reasons, 'FAILED_OUTSTANDING_EVIDENCE_STALE');
  END IF;

  NEW.source_validation_code := public.balance_movement_set_validation_v1(v_source.id);
  NEW.ledger_validation_code := public.balance_movement_set_validation_v1(v_ledger.id);
  IF NEW.source_validation_code = 'BALANCE_ROLLFORWARD_BROKEN' THEN
    v_reasons := array_append(v_reasons, 'FAILED_SOURCE_ROLLFORWARD_BROKEN');
  END IF;
  IF NEW.ledger_validation_code = 'BALANCE_ROLLFORWARD_BROKEN' THEN
    v_reasons := array_append(v_reasons, 'FAILED_LEDGER_ROLLFORWARD_BROKEN');
  END IF;
  IF NEW.source_validation_code NOT IN (
       'OK', 'COVERAGE_INCOMPLETE', 'PAGINATION_INCOMPLETE', 'TERMINAL_BOUNDARY_NOT_SEEN',
       'PROVIDER_RESULT_TRUNCATED', 'RETRIEVAL_ERRORS', 'NO_RETRIEVAL_PAGES',
       'BALANCE_ROLLFORWARD_BROKEN'
     ) THEN v_reasons := array_append(v_reasons, 'FAILED_SOURCE_MOVEMENT_PROOF_INVALID'); END IF;
  IF NEW.ledger_validation_code NOT IN (
       'OK', 'COVERAGE_INCOMPLETE', 'PAGINATION_INCOMPLETE', 'TERMINAL_BOUNDARY_NOT_SEEN',
       'PROVIDER_RESULT_TRUNCATED', 'RETRIEVAL_ERRORS', 'NO_RETRIEVAL_PAGES',
       'BALANCE_ROLLFORWARD_BROKEN'
     ) THEN v_reasons := array_append(v_reasons, 'FAILED_LEDGER_MOVEMENT_PROOF_INVALID'); END IF;

  IF NEW.source_validation_code <> 'OK'
     AND NEW.source_validation_code IN (
       'COVERAGE_INCOMPLETE', 'PAGINATION_INCOMPLETE', 'TERMINAL_BOUNDARY_NOT_SEEN',
       'PROVIDER_RESULT_TRUNCATED', 'RETRIEVAL_ERRORS', 'NO_RETRIEVAL_PAGES'
     ) THEN v_reasons := array_append(v_reasons, 'REVIEW_SOURCE_EVIDENCE_INCOMPLETE'); END IF;
  IF NEW.ledger_validation_code <> 'OK'
     AND NEW.ledger_validation_code IN (
       'COVERAGE_INCOMPLETE', 'PAGINATION_INCOMPLETE', 'TERMINAL_BOUNDARY_NOT_SEEN',
       'PROVIDER_RESULT_TRUNCATED', 'RETRIEVAL_ERRORS', 'NO_RETRIEVAL_PAGES'
     ) THEN v_reasons := array_append(v_reasons, 'REVIEW_LEDGER_EVIDENCE_INCOMPLETE'); END IF;
  IF NEW.opening_outstanding_validation_code = 'OUTSTANDING_EVIDENCE_INCOMPLETE'
     OR NEW.closing_outstanding_validation_code = 'OUTSTANDING_EVIDENCE_INCOMPLETE' THEN
    v_reasons := array_append(v_reasons, 'REVIEW_OUTSTANDING_EVIDENCE_INCOMPLETE');
  END IF;

  NEW.opening_outstanding_revision_ids := ARRAY(
    SELECT id FROM unnest(COALESCE(NEW.opening_outstanding_revision_ids, '{}'::uuid[])) AS chosen(id) ORDER BY id
  );
  NEW.closing_outstanding_revision_ids := ARRAY(
    SELECT id FROM unnest(COALESCE(NEW.closing_outstanding_revision_ids, '{}'::uuid[])) AS chosen(id) ORDER BY id
  );
  NEW.o0_minor := public.balance_outstanding_total_v1(NEW.opening_outstanding_revision_ids);
  NEW.o1_minor := public.balance_outstanding_total_v1(NEW.closing_outstanding_revision_ids);
  NEW.a0_minor := NEW.b0_minor::numeric + NEW.o0_minor;
  NEW.a1_minor := NEW.b1_minor::numeric + NEW.o1_minor;
  NEW.r0_minor := NEW.a0_minor - NEW.l0_minor::numeric;
  NEW.r_minor := NEW.a1_minor - NEW.l1_minor::numeric;

  IF NEW.r0_minor <> 0 THEN v_reasons := array_append(v_reasons, 'REVIEW_OPENING_RESIDUAL_NONZERO'); END IF;
  IF NEW.r_minor <> 0 THEN v_reasons := array_append(v_reasons, 'REVIEW_CLOSING_RESIDUAL_NONZERO'); END IF;

  NEW.evidence_complete := NEW.source_validation_code = 'OK'
    AND NEW.ledger_validation_code = 'OK'
    AND NEW.opening_outstanding_validation_code = 'OK'
    AND NEW.closing_outstanding_validation_code = 'OK';

  IF cardinality(v_reasons) = 0 THEN
    v_reasons := ARRAY['RECONCILED_EXACT_ZERO_RESIDUAL'];
  END IF;
  NEW.reason_codes := v_reasons;
  NEW.primary_reason_code := v_reasons[1];
  NEW.reconciliation_state := CASE
    WHEN NEW.primary_reason_code LIKE 'FAILED_%' THEN 'FAILED'
    WHEN NEW.primary_reason_code LIKE 'REVIEW_%' THEN 'REVIEW'
    ELSE 'RECONCILED'
  END;

  SELECT COALESCE(string_agg(
    chosen.id::text || ':' || COALESCE(encode(revision.evidence_fingerprint, 'hex'), 'MISSING'),
    ',' ORDER BY chosen.id
  ), '') INTO v_open_material
  FROM unnest(NEW.opening_outstanding_revision_ids) AS chosen(id)
  LEFT JOIN public.reconciliation_outstanding_item_revisions AS revision ON revision.id = chosen.id;
  SELECT COALESCE(string_agg(
    chosen.id::text || ':' || COALESCE(encode(revision.evidence_fingerprint, 'hex'), 'MISSING'),
    ',' ORDER BY chosen.id
  ), '') INTO v_close_material
  FROM unnest(NEW.closing_outstanding_revision_ids) AS chosen(id)
  LEFT JOIN public.reconciliation_outstanding_item_revisions AS revision ON revision.id = chosen.id;

  -- Bind the complete outstanding evidence universe known at evaluation time,
  -- not only the caller-selected rows. Late/backdated evidence therefore creates
  -- a different frozen input rather than silently changing an earlier proof.
  SELECT COALESCE(string_agg(
    latest.id::text || ':' || encode(latest.evidence_fingerprint, 'hex'), ',' ORDER BY latest.id
  ), '') INTO v_open_universe_material
  FROM public.reconciliation_outstanding_items AS item
  JOIN LATERAL (
    SELECT revision.id, revision.evidence_fingerprint
    FROM public.reconciliation_outstanding_item_revisions AS revision
    WHERE revision.outstanding_item_id = item.id
      AND revision.effective_at < v_run.period_start_utc
      AND revision.created_at <= NEW.evaluated_at
    ORDER BY revision.revision_no DESC LIMIT 1
  ) AS latest ON true
  WHERE item.scope_id = NEW.scope_id;
  SELECT COALESCE(string_agg(
    latest.id::text || ':' || encode(latest.evidence_fingerprint, 'hex'), ',' ORDER BY latest.id
  ), '') INTO v_close_universe_material
  FROM public.reconciliation_outstanding_items AS item
  JOIN LATERAL (
    SELECT revision.id, revision.evidence_fingerprint
    FROM public.reconciliation_outstanding_item_revisions AS revision
    WHERE revision.outstanding_item_id = item.id
      AND revision.effective_at < v_run.period_end_exclusive_utc
      AND revision.created_at <= NEW.evaluated_at
    ORDER BY revision.revision_no DESC LIMIT 1
  ) AS latest ON true
  WHERE item.scope_id = NEW.scope_id;

  NEW.frozen_input_fingerprint := extensions.digest(convert_to(
    concat_ws('|', 'balance-proof-v1', NEW.scope_id::text, v_run.period_start::text, v_run.period_end::text,
      encode(v_source.set_fingerprint, 'hex'), encode(v_ledger.set_fingerprint, 'hex'),
      encode(v_source_open.evidence_fingerprint, 'hex'), encode(v_source_close.evidence_fingerprint, 'hex'),
      encode(v_ledger_open.evidence_fingerprint, 'hex'), encode(v_ledger_close.evidence_fingerprint, 'hex'),
      v_open_material, v_close_material, v_open_universe_material, v_close_universe_material), 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$;

CREATE TRIGGER balance_reconciliation_revisions_validate
BEFORE INSERT ON public.balance_reconciliation_revisions
FOR EACH ROW EXECUTE FUNCTION public.balance_reconciliation_revision_validate_v1();

-- Every Day 5 record is immutable. Lifecycle change means a new revision.
CREATE TRIGGER reconciliation_outstanding_items_append_only
BEFORE UPDATE OR DELETE ON public.reconciliation_outstanding_items
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER reconciliation_outstanding_item_revisions_append_only
BEFORE UPDATE OR DELETE ON public.reconciliation_outstanding_item_revisions
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER balance_reconciliation_runs_append_only
BEFORE UPDATE OR DELETE ON public.balance_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();
CREATE TRIGGER balance_reconciliation_revisions_append_only
BEFORE UPDATE OR DELETE ON public.balance_reconciliation_revisions
FOR EACH ROW EXECUTE FUNCTION public.balance_foundation_reject_update_delete_v1();

-- Tenant-readable, RPC-write-only security boundary, matching migration 029.
ALTER TABLE public.reconciliation_outstanding_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_outstanding_item_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_reconciliation_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_outstanding_items_authenticated_select
  ON public.reconciliation_outstanding_items FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY reconciliation_outstanding_item_revisions_authenticated_select
  ON public.reconciliation_outstanding_item_revisions FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY balance_reconciliation_runs_authenticated_select
  ON public.balance_reconciliation_runs FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));
CREATE POLICY balance_reconciliation_revisions_authenticated_select
  ON public.balance_reconciliation_revisions FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

REVOKE ALL PRIVILEGES ON TABLE
  public.reconciliation_outstanding_items,
  public.reconciliation_outstanding_item_revisions,
  public.balance_reconciliation_runs,
  public.balance_reconciliation_revisions
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.reconciliation_outstanding_items,
  public.reconciliation_outstanding_item_revisions,
  public.balance_reconciliation_runs,
  public.balance_reconciliation_revisions
TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.balance_outstanding_selection_validation_v1(uuid, timestamptz, timestamptz, uuid[]),
  public.balance_outstanding_total_v1(uuid[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.balance_outstanding_selection_validation_v1(uuid, timestamptz, timestamptz, uuid[]),
  public.balance_outstanding_total_v1(uuid[])
TO authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.reconciliation_outstanding_item_validate_v1(),
  public.reconciliation_outstanding_revision_validate_v1(),
  public.balance_reconciliation_run_validate_v1(),
  public.balance_reconciliation_revision_validate_v1()
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.reconciliation_outstanding_items IS
  'Stable scoped identities for legitimate source-to-ledger balance adjustments.';
COMMENT ON TABLE public.reconciliation_outstanding_item_revisions IS
  'Append-only evidence and lifecycle revisions for outstanding balance adjustments.';
COMMENT ON TABLE public.balance_reconciliation_runs IS
  'Immutable scope and period identity for a true-balance reconciliation run.';
COMMENT ON TABLE public.balance_reconciliation_revisions IS
  'Immutable proof revisions with frozen inputs, exact B/L/O/A/R equations, and deterministic outcome.';

NOTIFY pgrst, 'reload schema';

COMMIT;
