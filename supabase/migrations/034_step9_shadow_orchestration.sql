-- Step 9 Day 4: additive SHADOW orchestration persistence only.
-- No posting operation, provider mutation, autonomous actor, or execution handoff exists here.

BEGIN;

CREATE OR REPLACE FUNCTION public.step9_decode_sha256_v1(p_value text, p_label text)
RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '% must be a lowercase SHA-256 digest', p_label USING ERRCODE = '22023';
  END IF;
  RETURN decode(p_value, 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_state_terminal_v1(p_state text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp
AS $$
  SELECT p_state IN ('SUCCEEDED','FAILED_SAFE','REVIEW_REQUIRED','BLOCKED','UNCERTAIN','CANCELLED')
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_transition_allowed_v1(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_from
    WHEN 'PENDING' THEN p_to IN ('RUNNING','CANCELLED','BLOCKED')
    WHEN 'RUNNING' THEN p_to IN ('SUCCEEDED','FAILED_SAFE','RETRYABLE','REVIEW_REQUIRED','BLOCKED','UNCERTAIN')
    WHEN 'RETRYABLE' THEN p_to IN ('RUNNING','FAILED_SAFE','REVIEW_REQUIRED','BLOCKED','UNCERTAIN','CANCELLED')
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_run_rollup_v1(p_states text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN 'UNCERTAIN' = ANY(p_states) THEN 'UNCERTAIN'
    WHEN 'BLOCKED' = ANY(p_states) THEN 'BLOCKED'
    WHEN 'REVIEW_REQUIRED' = ANY(p_states) THEN 'REVIEW_REQUIRED'
    WHEN 'RETRYABLE' = ANY(p_states) THEN 'RETRYABLE'
    WHEN 'FAILED_SAFE' = ANY(p_states) THEN 'FAILED_SAFE'
    WHEN 'SUCCEEDED' = ANY(p_states) THEN 'SUCCEEDED'
    WHEN 'RUNNING' = ANY(p_states) THEN 'RUNNING'
    WHEN 'PENDING' = ANY(p_states) THEN 'PENDING'
    WHEN 'CANCELLED' = ANY(p_states) THEN 'CANCELLED'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_stage_ordinal_v1(p_stage text)
RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_stage
    WHEN 'INGESTION' THEN 1 WHEN 'EXTRACTION' THEN 2 WHEN 'CANONICAL_UPDATE' THEN 3
    WHEN 'RECONCILIATION' THEN 4 WHEN 'BALANCE_PROOF' THEN 5 WHEN 'POLICY_EVALUATION' THEN 6
    WHEN 'STEP8_PLANNING' THEN 7 WHEN 'EXCEPTION_OUTPUT' THEN 8 ELSE NULL END
$$;

CREATE TABLE public.shadow_orchestration_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  contract_version      text NOT NULL CHECK (contract_version = 'step9-shadow-orchestration-v1'),
  schedule_key          text NOT NULL CHECK (btrim(schedule_key) <> ''),
  requested_for         timestamptz NOT NULL,
  correlation_id        text NOT NULL CHECK (btrim(correlation_id) <> ''),
  run_key               bytea NOT NULL UNIQUE CHECK (octet_length(run_key) = 32),
  input_fingerprint     bytea NOT NULL CHECK (octet_length(input_fingerprint) = 32),
  mode                  text NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  execution_permitted   boolean NOT NULL DEFAULT false CHECK (NOT execution_permitted),
  state                 text NOT NULL DEFAULT 'PENDING' CHECK (state IN
                          ('PENDING','RUNNING','SUCCEEDED','FAILED_SAFE','RETRYABLE',
                           'REVIEW_REQUIRED','BLOCKED','UNCERTAIN','CANCELLED')),
  terminal_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((terminal_at IS NOT NULL) = public.step9_shadow_state_terminal_v1(state))
);

CREATE TABLE public.shadow_orchestration_stages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  stage                 text NOT NULL CHECK (stage IN
                          ('INGESTION','EXTRACTION','CANONICAL_UPDATE','RECONCILIATION',
                           'BALANCE_PROOF','POLICY_EVALUATION','STEP8_PLANNING','EXCEPTION_OUTPUT')),
  stage_ordinal         smallint NOT NULL CHECK (stage_ordinal BETWEEN 1 AND 8),
  state                 text NOT NULL DEFAULT 'PENDING' CHECK (state IN
                          ('PENDING','RUNNING','SUCCEEDED','FAILED_SAFE','RETRYABLE',
                           'REVIEW_REQUIRED','BLOCKED','UNCERTAIN','CANCELLED')),
  input_fingerprint     bytea NOT NULL CHECK (octet_length(input_fingerprint) = 32),
  output_fingerprint    bytea CHECK (output_fingerprint IS NULL OR octet_length(output_fingerprint) = 32),
  terminal_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, stage),
  UNIQUE (id, run_id, practice_id, client_entity_id, ledger_book_id),
  FOREIGN KEY (run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_runs(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  CHECK (stage_ordinal = public.step9_shadow_stage_ordinal_v1(stage)),
  CHECK ((terminal_at IS NOT NULL) = public.step9_shadow_state_terminal_v1(state)),
  CHECK ((output_fingerprint IS NOT NULL) = public.step9_shadow_state_terminal_v1(state))
);

CREATE TABLE public.shadow_orchestration_stage_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id              uuid NOT NULL,
  run_id                uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  attempt_number        integer NOT NULL CHECK (attempt_number > 0),
  worker_id             text NOT NULL CHECK (btrim(worker_id) <> ''),
  fencing_token         bigint NOT NULL CHECK (fencing_token > 0),
  state                 text NOT NULL CHECK (state IN
                          ('RUNNING','SUCCEEDED','FAILED_SAFE','RETRYABLE','REVIEW_REQUIRED',
                           'BLOCKED','UNCERTAIN','CANCELLED')),
  reason_code           text CHECK (reason_code IS NULL OR btrim(reason_code) <> ''),
  started_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at           timestamptz,
  UNIQUE (stage_id, attempt_number),
  UNIQUE (stage_id, fencing_token),
  UNIQUE (id, stage_id, run_id),
  FOREIGN KEY (stage_id, run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_stages(id, run_id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  CHECK ((finished_at IS NOT NULL) = (state <> 'RUNNING'))
);

CREATE TABLE public.shadow_orchestration_transition_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL,
  stage_id              uuid,
  attempt_id            uuid,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  sequence_number       bigint NOT NULL CHECK (sequence_number > 0),
  entity_kind           text NOT NULL CHECK (entity_kind IN ('RUN','STAGE','ATTEMPT')),
  from_state            text,
  to_state              text NOT NULL,
  reason_code           text,
  fencing_token         bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  occurred_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, sequence_number),
  FOREIGN KEY (run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_runs(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  FOREIGN KEY (stage_id, run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_stages(id, run_id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, stage_id, run_id)
    REFERENCES public.shadow_orchestration_stage_attempts(id, stage_id, run_id) ON DELETE RESTRICT,
  CHECK ((entity_kind = 'RUN' AND stage_id IS NULL AND attempt_id IS NULL) OR
         (entity_kind = 'STAGE' AND stage_id IS NOT NULL AND attempt_id IS NULL) OR
         (entity_kind = 'ATTEMPT' AND stage_id IS NOT NULL AND attempt_id IS NOT NULL))
);

CREATE TABLE public.shadow_orchestration_stage_outputs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id              uuid NOT NULL UNIQUE,
  run_id                uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  input_fingerprint     bytea NOT NULL CHECK (octet_length(input_fingerprint) = 32),
  output_fingerprint    bytea NOT NULL CHECK (octet_length(output_fingerprint) = 32),
  output_payload        jsonb NOT NULL,
  output_canonical_json text NOT NULL CHECK (output_payload = output_canonical_json::jsonb),
  provenance            jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'array'),
  provenance_canonical_json text NOT NULL CHECK (provenance = provenance_canonical_json::jsonb),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, output_fingerprint),
  FOREIGN KEY (stage_id, run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_stages(id, run_id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT
);

CREATE TABLE public.shadow_extraction_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL,
  stage_id              uuid NOT NULL,
  attempt_id            uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  import_artifact_id    uuid NOT NULL,
  extraction_key        bytea NOT NULL UNIQUE CHECK (octet_length(extraction_key) = 32),
  input_fingerprint     bytea NOT NULL CHECK (octet_length(input_fingerprint) = 32),
  extractor_name        text NOT NULL CHECK (btrim(extractor_name) <> ''),
  extractor_version     text NOT NULL CHECK (btrim(extractor_version) <> ''),
  output_payload        jsonb NOT NULL,
  output_canonical_json text NOT NULL CHECK (output_payload = output_canonical_json::jsonb),
  output_fingerprint    bytea NOT NULL CHECK (octet_length(output_fingerprint) = 32),
  fencing_token         bigint NOT NULL CHECK (fencing_token > 0),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (attempt_id, stage_id, run_id)
    REFERENCES public.shadow_orchestration_stage_attempts(id, stage_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT
);

CREATE TABLE public.shadow_reconciliation_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL,
  stage_id              uuid NOT NULL,
  attempt_id            uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  statement_id          uuid NOT NULL,
  snapshot_role         text NOT NULL CHECK (snapshot_role IN ('INPUT','OUTPUT')),
  reconciliation_version text NOT NULL CHECK (btrim(reconciliation_version) <> ''),
  manifest              jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  manifest_canonical_json text NOT NULL CHECK (manifest = manifest_canonical_json::jsonb),
  manifest_fingerprint  bytea NOT NULL CHECK (octet_length(manifest_fingerprint) = 32),
  fencing_token         bigint NOT NULL CHECK (fencing_token > 0),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, statement_id, snapshot_role),
  FOREIGN KEY (attempt_id, stage_id, run_id)
    REFERENCES public.shadow_orchestration_stage_attempts(id, stage_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (statement_id, client_entity_id)
    REFERENCES public.bank_statements(id, client_entity_id) ON DELETE RESTRICT
);

CREATE TABLE public.shadow_orchestration_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  stage                 text NOT NULL CHECK (stage IN
                          ('INGESTION','EXTRACTION','CANONICAL_UPDATE','RECONCILIATION',
                           'BALANCE_PROOF','POLICY_EVALUATION','STEP8_PLANNING','EXCEPTION_OUTPUT')),
  exception_key         bytea NOT NULL UNIQUE CHECK (octet_length(exception_key) = 32),
  subject_namespace     text NOT NULL CHECK (btrim(subject_namespace) <> ''),
  subject_id            text NOT NULL CHECK (btrim(subject_id) <> ''),
  reason_code           text NOT NULL CHECK (btrim(reason_code) <> ''),
  evidence_fingerprint  bytea NOT NULL CHECK (octet_length(evidence_fingerprint) = 32),
  payload               jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_canonical_json text NOT NULL CHECK (payload = payload_canonical_json::jsonb),
  payload_fingerprint   bytea NOT NULL CHECK (octet_length(payload_fingerprint) = 32),
  correlation_id        text NOT NULL CHECK (btrim(correlation_id) <> ''),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.shadow_orchestration_runs(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT
);

CREATE TABLE public.shadow_orchestration_leases (
  resource_key          bytea PRIMARY KEY CHECK (octet_length(resource_key) = 32),
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid NOT NULL,
  stage                 text NOT NULL CHECK (stage IN
                          ('INGESTION','EXTRACTION','CANONICAL_UPDATE','RECONCILIATION',
                           'BALANCE_PROOF','POLICY_EVALUATION','STEP8_PLANNING','EXCEPTION_OUTPUT')),
  owner_id              text NOT NULL CHECK (btrim(owner_id) <> ''),
  fencing_token         bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at      timestamptz NOT NULL,
  heartbeat_at          timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  UNIQUE (client_entity_id, ledger_book_id, stage)
);

CREATE INDEX shadow_runs_scope_idx ON public.shadow_orchestration_runs
  (client_entity_id, ledger_book_id, created_at DESC);
CREATE INDEX shadow_stages_run_idx ON public.shadow_orchestration_stages (run_id, stage_ordinal);
CREATE INDEX shadow_attempts_stage_idx ON public.shadow_orchestration_stage_attempts (stage_id, attempt_number DESC);
CREATE INDEX shadow_exceptions_scope_idx ON public.shadow_orchestration_exceptions
  (client_entity_id, ledger_book_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.step9_immutable_row_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_run_update_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.practice_id <> NEW.practice_id OR OLD.client_entity_id <> NEW.client_entity_id
     OR OLD.ledger_book_id <> NEW.ledger_book_id OR OLD.contract_version <> NEW.contract_version
     OR OLD.schedule_key <> NEW.schedule_key OR OLD.requested_for <> NEW.requested_for
     OR OLD.run_key <> NEW.run_key OR OLD.input_fingerprint <> NEW.input_fingerprint
     OR OLD.mode <> NEW.mode OR OLD.execution_permitted <> NEW.execution_permitted
     OR OLD.correlation_id <> NEW.correlation_id OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'SHADOW_RUN_IMMUTABLE_FIELDS_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> NEW.state AND NOT public.step9_shadow_transition_allowed_v1(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION:%->%', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF public.step9_shadow_state_terminal_v1(OLD.state) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'TERMINAL_SHADOW_RUN_CANNOT_REOPEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_stage_update_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.run_id <> NEW.run_id OR OLD.practice_id <> NEW.practice_id
     OR OLD.client_entity_id <> NEW.client_entity_id OR OLD.ledger_book_id <> NEW.ledger_book_id
     OR OLD.stage <> NEW.stage OR OLD.stage_ordinal <> NEW.stage_ordinal
     OR OLD.input_fingerprint <> NEW.input_fingerprint OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'SHADOW_STAGE_IMMUTABLE_FIELDS_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF OLD.output_fingerprint IS NOT NULL AND NEW.output_fingerprint IS DISTINCT FROM OLD.output_fingerprint THEN
    RAISE EXCEPTION 'SHADOW_STAGE_OUTPUT_IS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> NEW.state AND NOT public.step9_shadow_transition_allowed_v1(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION:%->%', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF public.step9_shadow_state_terminal_v1(OLD.state) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'TERMINAL_SHADOW_STAGE_CANNOT_REOPEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_attempt_update_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.stage_id <> NEW.stage_id OR OLD.run_id <> NEW.run_id
     OR OLD.practice_id <> NEW.practice_id OR OLD.client_entity_id <> NEW.client_entity_id
     OR OLD.ledger_book_id <> NEW.ledger_book_id OR OLD.attempt_number <> NEW.attempt_number
     OR OLD.worker_id <> NEW.worker_id OR OLD.fencing_token <> NEW.fencing_token
     OR OLD.started_at <> NEW.started_at THEN
    RAISE EXCEPTION 'SHADOW_ATTEMPT_IMMUTABLE_FIELDS_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> NEW.state AND NOT public.step9_shadow_transition_allowed_v1(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION:%->%', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'RUNNING' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'TERMINAL_SHADOW_ATTEMPT_CANNOT_REOPEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_shadow_lease_update_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.resource_key <> NEW.resource_key OR OLD.practice_id <> NEW.practice_id
     OR OLD.client_entity_id <> NEW.client_entity_id OR OLD.ledger_book_id <> NEW.ledger_book_id
     OR OLD.stage <> NEW.stage THEN
    RAISE EXCEPTION 'SHADOW_LEASE_SCOPE_IS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token OR NEW.fencing_token > OLD.fencing_token + 1 THEN
    RAISE EXCEPTION 'SHADOW_FENCING_TOKEN_MUST_BE_MONOTONIC' USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token = OLD.fencing_token AND NEW.owner_id <> OLD.owner_id THEN
    RAISE EXCEPTION 'SHADOW_LEASE_OWNER_CHANGE_REQUIRES_NEW_FENCE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.step9_next_transition_sequence_v1(p_run_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_next bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('step9-transition:' || p_run_id::text, 0));
  SELECT COALESCE(max(sequence_number), 0) + 1 INTO v_next
  FROM public.shadow_orchestration_transition_events WHERE run_id = p_run_id;
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_shadow_orchestration_run_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_schedule_key text, p_requested_for timestamptz, p_correlation_id text,
  p_run_key_hex text, p_input_fingerprint_hex text,
  p_mode text, p_execution_permitted boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_run public.shadow_orchestration_runs%ROWTYPE; v_id uuid := gen_random_uuid(); v_reused boolean := false;
BEGIN
  IF p_mode IS DISTINCT FROM 'SHADOW' THEN RAISE EXCEPTION 'STEP9_SHADOW_MODE_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF p_execution_permitted IS DISTINCT FROM false THEN RAISE EXCEPTION 'STEP9_EXECUTION_MUST_BE_DISABLED' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('step9-run:' || p_run_key_hex, 0));
  INSERT INTO public.shadow_orchestration_runs (
    id, practice_id, client_entity_id, ledger_book_id, contract_version, schedule_key,
    requested_for, correlation_id, run_key, input_fingerprint, mode, execution_permitted
  ) VALUES (
    v_id, p_practice_id, p_client_entity_id, p_ledger_book_id, 'step9-shadow-orchestration-v1',
    p_schedule_key, p_requested_for, p_correlation_id,
    public.step9_decode_sha256_v1(p_run_key_hex, 'run key'),
    public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'input fingerprint'), 'SHADOW', false
  ) ON CONFLICT (run_key) DO NOTHING;
  SELECT * INTO STRICT v_run FROM public.shadow_orchestration_runs
    WHERE run_key = public.step9_decode_sha256_v1(p_run_key_hex, 'run key') FOR UPDATE;
  v_reused := v_run.id <> v_id;
  IF v_run.practice_id <> p_practice_id OR v_run.client_entity_id <> p_client_entity_id
     OR v_run.ledger_book_id <> p_ledger_book_id OR v_run.schedule_key <> p_schedule_key
     OR v_run.requested_for <> p_requested_for
     OR v_run.input_fingerprint <> public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'input fingerprint')
     OR v_run.mode <> 'SHADOW' OR v_run.execution_permitted THEN
    RAISE EXCEPTION 'SHADOW_RUN_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF NOT v_reused THEN
    INSERT INTO public.shadow_orchestration_transition_events (
      run_id, practice_id, client_entity_id, ledger_book_id, sequence_number,
      entity_kind, from_state, to_state
    ) VALUES (v_run.id, v_run.practice_id, v_run.client_entity_id, v_run.ledger_book_id,
      1, 'RUN', NULL, 'PENDING');
  END IF;
  RETURN jsonb_build_object('run_id', v_run.id, 'state', v_run.state, 'reused', v_reused);
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_shadow_stage_lease_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_stage text, p_resource_key_hex text, p_owner_id text, p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_lease public.shadow_orchestration_leases%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN RAISE EXCEPTION 'INVALID_SHADOW_LEASE_DURATION'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('step9-lease:' || p_resource_key_hex, 0));
  SELECT * INTO v_lease FROM public.shadow_orchestration_leases
    WHERE resource_key = public.step9_decode_sha256_v1(p_resource_key_hex, 'resource key') FOR UPDATE;
  IF FOUND AND (v_lease.practice_id <> p_practice_id OR v_lease.client_entity_id <> p_client_entity_id
     OR v_lease.ledger_book_id <> p_ledger_book_id OR v_lease.stage <> p_stage) THEN
    RAISE EXCEPTION 'SHADOW_LEASE_RESOURCE_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF FOUND AND v_lease.lease_expires_at > v_now THEN RAISE EXCEPTION 'SHADOW_LEASE_HELD' USING ERRCODE = '55P03'; END IF;
  INSERT INTO public.shadow_orchestration_leases (
    resource_key, practice_id, client_entity_id, ledger_book_id, stage, owner_id,
    fencing_token, lease_expires_at, heartbeat_at, updated_at
  ) VALUES (
    public.step9_decode_sha256_v1(p_resource_key_hex, 'resource key'), p_practice_id,
    p_client_entity_id, p_ledger_book_id, p_stage, p_owner_id,
    COALESCE(v_lease.fencing_token, 0) + 1, v_now + make_interval(secs => p_lease_seconds), v_now, v_now
  ) ON CONFLICT (resource_key) DO UPDATE SET
    owner_id = EXCLUDED.owner_id, fencing_token = public.shadow_orchestration_leases.fencing_token + 1,
    lease_expires_at = EXCLUDED.lease_expires_at, heartbeat_at = EXCLUDED.heartbeat_at,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_lease;
  RETURN jsonb_build_object('resource_key', encode(v_lease.resource_key, 'hex'),
    'fencing_token', v_lease.fencing_token, 'lease_expires_at', v_lease.lease_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_shadow_stage_lease_v1(
  p_resource_key_hex text, p_owner_id text, p_fencing_token bigint, p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_lease public.shadow_orchestration_leases%ROWTYPE; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN RAISE EXCEPTION 'INVALID_SHADOW_LEASE_DURATION'; END IF;
  UPDATE public.shadow_orchestration_leases SET
    lease_expires_at = v_now + make_interval(secs => p_lease_seconds), heartbeat_at = v_now, updated_at = v_now
  WHERE resource_key = public.step9_decode_sha256_v1(p_resource_key_hex, 'resource key')
    AND owner_id = p_owner_id AND fencing_token = p_fencing_token AND lease_expires_at > v_now
  RETURNING * INTO v_lease;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_SHADOW_FENCE' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('lease_expires_at', v_lease.lease_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.start_shadow_stage_attempt_v1(
  p_run_id uuid, p_stage text, p_input_fingerprint_hex text,
  p_worker_id text, p_fencing_token bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_run public.shadow_orchestration_runs%ROWTYPE; v_stage public.shadow_orchestration_stages%ROWTYPE;
  v_attempt_id uuid := gen_random_uuid(); v_attempt_number integer; v_prior_stage_state text; v_prior_run_state text;
  v_recovered_attempt_id uuid;
BEGIN
  SELECT * INTO STRICT v_run FROM public.shadow_orchestration_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.mode <> 'SHADOW' OR v_run.execution_permitted THEN RAISE EXCEPTION 'STEP9_SHADOW_INVARIANT_BROKEN'; END IF;
  IF public.step9_shadow_state_terminal_v1(v_run.state) THEN RAISE EXCEPTION 'TERMINAL_SHADOW_RUN_CANNOT_REOPEN'; END IF;
  INSERT INTO public.shadow_orchestration_stages (
    run_id, practice_id, client_entity_id, ledger_book_id, stage, stage_ordinal, input_fingerprint
  ) VALUES (v_run.id, v_run.practice_id, v_run.client_entity_id, v_run.ledger_book_id,
    p_stage, public.step9_shadow_stage_ordinal_v1(p_stage),
    public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'stage input fingerprint'))
  ON CONFLICT (run_id, stage) DO NOTHING;
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages
    WHERE run_id = p_run_id AND stage = p_stage FOR UPDATE;
  v_prior_stage_state := v_stage.state;
  v_prior_run_state := v_run.state;
  -- A new fencing token proves the prior lease expired. Shadow work has no
  -- provider mutation, so an abandoned RUNNING attempt is safely retryable.
  IF v_stage.state = 'RUNNING' THEN
    UPDATE public.shadow_orchestration_stage_attempts SET state = 'RETRYABLE',
      reason_code = 'WORKER_LEASE_EXPIRED', finished_at = clock_timestamp()
    WHERE stage_id = v_stage.id AND state = 'RUNNING' AND fencing_token < p_fencing_token
    RETURNING id INTO v_recovered_attempt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SHADOW_STAGE_ALREADY_RUNNING' USING ERRCODE = '55P03'; END IF;
    UPDATE public.shadow_orchestration_stages SET state = 'RETRYABLE', updated_at = clock_timestamp()
      WHERE id = v_stage.id;
    INSERT INTO public.shadow_orchestration_transition_events (
      run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
      sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
    ) VALUES (v_run.id, v_stage.id, v_recovered_attempt_id, v_run.practice_id,
      v_run.client_entity_id, v_run.ledger_book_id,
      public.step9_next_transition_sequence_v1(v_run.id), 'ATTEMPT', 'RUNNING', 'RETRYABLE',
      'WORKER_LEASE_EXPIRED', p_fencing_token - 1);
    INSERT INTO public.shadow_orchestration_transition_events (
      run_id, stage_id, practice_id, client_entity_id, ledger_book_id,
      sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
    ) VALUES (v_run.id, v_stage.id, v_run.practice_id, v_run.client_entity_id,
      v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id),
      'STAGE', 'RUNNING', 'RETRYABLE', 'WORKER_LEASE_EXPIRED', p_fencing_token - 1);
    v_stage.state := 'RETRYABLE';
    v_prior_stage_state := 'RETRYABLE';
  END IF;
  IF public.step9_shadow_state_terminal_v1(v_stage.state) THEN RAISE EXCEPTION 'TERMINAL_SHADOW_STAGE_CANNOT_REOPEN'; END IF;
  IF v_stage.input_fingerprint <> public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'stage input fingerprint') THEN
    RAISE EXCEPTION 'SHADOW_STAGE_INPUT_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF NOT public.step9_shadow_transition_allowed_v1(v_stage.state, 'RUNNING') THEN RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION'; END IF;
  IF v_stage.stage_ordinal > 1 AND p_stage <> 'EXCEPTION_OUTPUT' AND NOT EXISTS (
    SELECT 1 FROM public.shadow_orchestration_stages prior
    WHERE prior.run_id = p_run_id AND prior.stage_ordinal = v_stage.stage_ordinal - 1 AND prior.state = 'SUCCEEDED'
  ) THEN RAISE EXCEPTION 'SHADOW_STAGE_DEPENDENCY_NOT_SUCCEEDED'; END IF;
  SELECT COALESCE(max(attempt_number), 0) + 1 INTO v_attempt_number
    FROM public.shadow_orchestration_stage_attempts WHERE stage_id = v_stage.id;
  INSERT INTO public.shadow_orchestration_stage_attempts (
    id, stage_id, run_id, practice_id, client_entity_id, ledger_book_id,
    attempt_number, worker_id, fencing_token, state
  ) VALUES (v_attempt_id, v_stage.id, v_run.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, v_attempt_number, p_worker_id, p_fencing_token, 'RUNNING');
  UPDATE public.shadow_orchestration_stages SET state = 'RUNNING', updated_at = clock_timestamp()
    WHERE id = v_stage.id;
  IF v_run.state = 'PENDING' OR v_run.state = 'RETRYABLE' THEN
    UPDATE public.shadow_orchestration_runs SET state = 'RUNNING', updated_at = clock_timestamp() WHERE id = v_run.id;
  END IF;
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id),
    'STAGE', v_prior_stage_state, 'RUNNING', p_fencing_token);
  IF v_prior_run_state IN ('PENDING','RETRYABLE') THEN
    INSERT INTO public.shadow_orchestration_transition_events (
      run_id, practice_id, client_entity_id, ledger_book_id, sequence_number,
      entity_kind, from_state, to_state, fencing_token
    ) VALUES (v_run.id, v_run.practice_id, v_run.client_entity_id, v_run.ledger_book_id,
      public.step9_next_transition_sequence_v1(v_run.id), 'RUN', v_prior_run_state, 'RUNNING', p_fencing_token);
  END IF;
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_attempt_id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id),
    'ATTEMPT', NULL, 'RUNNING', p_fencing_token);
  RETURN jsonb_build_object('stage_id', v_stage.id, 'attempt_id', v_attempt_id,
    'attempt_number', v_attempt_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_shadow_stage_v1(
  p_run_id uuid, p_stage text, p_input_fingerprint_hex text,
  p_worker_id text, p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_run public.shadow_orchestration_runs%ROWTYPE; v_resource text; v_lease jsonb; v_attempt jsonb;
BEGIN
  SELECT * INTO STRICT v_run FROM public.shadow_orchestration_runs WHERE id = p_run_id;
  v_resource := encode(extensions.digest(convert_to(
    'step9-shadow-lease-v1|' || v_run.practice_id || '|' || v_run.client_entity_id || '|' || v_run.ledger_book_id || '|' || p_stage,
    'UTF8'), 'sha256'), 'hex');
  v_lease := public.acquire_shadow_stage_lease_v1(v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, p_stage, v_resource, p_worker_id, p_lease_seconds);
  v_attempt := public.start_shadow_stage_attempt_v1(p_run_id, p_stage, p_input_fingerprint_hex,
    p_worker_id, (v_lease->>'fencing_token')::bigint);
  RETURN v_attempt || v_lease;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_shadow_stage_output_v1(
  p_run_id uuid, p_stage_id uuid, p_input_fingerprint_hex text, p_output_fingerprint_hex text,
  p_output_canonical_json text, p_provenance_canonical_json text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_stage public.shadow_orchestration_stages%ROWTYPE; v_output public.shadow_orchestration_stage_outputs%ROWTYPE;
  v_id uuid := gen_random_uuid(); v_reused boolean := false;
BEGIN
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages
    WHERE id = p_stage_id AND run_id = p_run_id FOR UPDATE;
  IF v_stage.input_fingerprint <> public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'stage input fingerprint') THEN
    RAISE EXCEPTION 'SHADOW_STAGE_INPUT_CONFLICT';
  END IF;
  INSERT INTO public.shadow_orchestration_stage_outputs (
    id, stage_id, run_id, practice_id, client_entity_id, ledger_book_id,
    input_fingerprint, output_fingerprint, output_payload, output_canonical_json,
    provenance, provenance_canonical_json
  ) VALUES (v_id, v_stage.id, v_stage.run_id, v_stage.practice_id, v_stage.client_entity_id,
    v_stage.ledger_book_id, v_stage.input_fingerprint,
    public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'stage output fingerprint'),
    p_output_canonical_json::jsonb, p_output_canonical_json,
    p_provenance_canonical_json::jsonb, p_provenance_canonical_json)
  ON CONFLICT (stage_id) DO NOTHING;
  SELECT * INTO STRICT v_output FROM public.shadow_orchestration_stage_outputs WHERE stage_id = p_stage_id;
  v_reused := v_output.id <> v_id;
  IF v_output.input_fingerprint <> v_stage.input_fingerprint
     OR v_output.output_fingerprint <> public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'stage output fingerprint')
     OR v_output.output_canonical_json <> p_output_canonical_json
     OR v_output.provenance_canonical_json <> p_provenance_canonical_json THEN
    RAISE EXCEPTION 'SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('output_id', v_output.id, 'reused', v_reused);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_shadow_stage_retryable_v1(
  p_run_id uuid, p_stage_id uuid, p_attempt_id uuid, p_worker_id text,
  p_fencing_token bigint, p_reason_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_run public.shadow_orchestration_runs%ROWTYPE; v_stage public.shadow_orchestration_stages%ROWTYPE;
  v_attempt public.shadow_orchestration_stage_attempts%ROWTYPE; v_lease public.shadow_orchestration_leases%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO STRICT v_run FROM public.shadow_orchestration_runs WHERE id = p_run_id FOR UPDATE;
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages
    WHERE id = p_stage_id AND run_id = p_run_id FOR UPDATE;
  SELECT * INTO STRICT v_attempt FROM public.shadow_orchestration_stage_attempts
    WHERE id = p_attempt_id AND stage_id = p_stage_id AND run_id = p_run_id FOR UPDATE;
  SELECT * INTO STRICT v_lease FROM public.shadow_orchestration_leases
    WHERE client_entity_id = v_run.client_entity_id AND ledger_book_id = v_run.ledger_book_id
      AND stage = v_stage.stage FOR UPDATE;
  IF v_stage.state <> 'RUNNING' OR v_attempt.state <> 'RUNNING'
     OR v_lease.owner_id <> p_worker_id OR v_lease.fencing_token <> p_fencing_token
     OR v_lease.lease_expires_at <= v_now OR v_attempt.worker_id <> p_worker_id
     OR v_attempt.fencing_token <> p_fencing_token THEN
    RAISE EXCEPTION 'STALE_SHADOW_FENCE' USING ERRCODE = '55000';
  END IF;
  IF NOT public.step9_shadow_transition_allowed_v1('RUNNING', 'RETRYABLE') THEN RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION'; END IF;
  UPDATE public.shadow_orchestration_stage_attempts SET state = 'RETRYABLE',
    reason_code = p_reason_code, finished_at = v_now WHERE id = p_attempt_id;
  UPDATE public.shadow_orchestration_stages SET state = 'RETRYABLE', updated_at = v_now WHERE id = p_stage_id;
  UPDATE public.shadow_orchestration_runs SET state = 'RETRYABLE', updated_at = v_now WHERE id = p_run_id;
  UPDATE public.shadow_orchestration_leases SET lease_expires_at = v_now,
    heartbeat_at = v_now, updated_at = v_now WHERE resource_key = v_lease.resource_key;
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_attempt.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id), 'ATTEMPT',
    'RUNNING', 'RETRYABLE', p_reason_code, p_fencing_token);
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id), 'STAGE',
    'RUNNING', 'RETRYABLE', p_reason_code, p_fencing_token);
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, practice_id, client_entity_id, ledger_book_id, sequence_number,
    entity_kind, from_state, to_state, reason_code, fencing_token
  ) VALUES (v_run.id, v_run.practice_id, v_run.client_entity_id, v_run.ledger_book_id,
    public.step9_next_transition_sequence_v1(v_run.id), 'RUN', v_run.state,
    'RETRYABLE', p_reason_code, p_fencing_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_shadow_stage_attempt_v1(
  p_run_id uuid, p_stage_id uuid, p_attempt_id uuid, p_worker_id text, p_fencing_token bigint,
  p_terminal_state text, p_input_fingerprint_hex text, p_output_fingerprint_hex text,
  p_output_canonical_json text, p_provenance_canonical_json text, p_reason_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_run public.shadow_orchestration_runs%ROWTYPE; v_stage public.shadow_orchestration_stages%ROWTYPE;
  v_attempt public.shadow_orchestration_stage_attempts%ROWTYPE; v_lease public.shadow_orchestration_leases%ROWTYPE;
  v_output jsonb; v_now timestamptz := clock_timestamp(); v_run_state text;
BEGIN
  IF p_terminal_state NOT IN ('SUCCEEDED','FAILED_SAFE','REVIEW_REQUIRED','BLOCKED','UNCERTAIN','CANCELLED') THEN
    RAISE EXCEPTION 'FINAL_STATE_MUST_BE_TERMINAL';
  END IF;
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages
    WHERE id = p_stage_id AND run_id = p_run_id FOR UPDATE;
  SELECT * INTO STRICT v_attempt FROM public.shadow_orchestration_stage_attempts
    WHERE id = p_attempt_id AND stage_id = p_stage_id AND run_id = p_run_id FOR UPDATE;
  SELECT * INTO STRICT v_run FROM public.shadow_orchestration_runs WHERE id = p_run_id FOR UPDATE;
  SELECT * INTO v_lease FROM public.shadow_orchestration_leases
    WHERE client_entity_id = v_run.client_entity_id AND ledger_book_id = v_run.ledger_book_id
      AND stage = v_stage.stage FOR UPDATE;
  IF v_lease.owner_id IS DISTINCT FROM p_worker_id OR v_lease.fencing_token IS DISTINCT FROM p_fencing_token
     OR v_lease.lease_expires_at <= v_now OR v_attempt.worker_id <> p_worker_id
     OR v_attempt.fencing_token <> p_fencing_token THEN
    RAISE EXCEPTION 'STALE_SHADOW_FENCE' USING ERRCODE = '55000';
  END IF;
  IF public.step9_shadow_state_terminal_v1(v_stage.state) THEN
    SELECT jsonb_build_object('reused', true) INTO v_output
    FROM public.shadow_orchestration_stage_outputs output
    WHERE output.stage_id = v_stage.id
      AND output.input_fingerprint = public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'stage input fingerprint')
      AND output.output_fingerprint = public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'stage output fingerprint')
      AND output.output_canonical_json = p_output_canonical_json
      AND output.provenance_canonical_json = p_provenance_canonical_json;
    IF v_attempt.state <> p_terminal_state OR v_output IS NULL THEN
      RAISE EXCEPTION 'SHADOW_STAGE_OUTPUT_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_output;
  END IF;
  IF v_stage.state <> 'RUNNING' OR v_attempt.state <> 'RUNNING' THEN RAISE EXCEPTION 'SHADOW_ATTEMPT_NOT_RUNNING'; END IF;
  IF v_stage.stage = 'EXCEPTION_OUTPUT' AND EXISTS (
    SELECT 1 FROM public.shadow_orchestration_stages active
    WHERE active.run_id = p_run_id AND active.id <> v_stage.id
      AND active.state IN ('PENDING','RUNNING','RETRYABLE')
  ) THEN
    RAISE EXCEPTION 'SHADOW_RUN_HAS_ACTIVE_STAGE' USING ERRCODE = '55P03';
  END IF;
  IF NOT public.step9_shadow_transition_allowed_v1(v_stage.state, p_terminal_state) THEN RAISE EXCEPTION 'ILLEGAL_SHADOW_TRANSITION'; END IF;
  v_output := public.record_shadow_stage_output_v1(p_run_id, p_stage_id, p_input_fingerprint_hex,
    p_output_fingerprint_hex, p_output_canonical_json, p_provenance_canonical_json);
  UPDATE public.shadow_orchestration_stage_attempts SET state = p_terminal_state,
    reason_code = p_reason_code, finished_at = v_now WHERE id = p_attempt_id;
  UPDATE public.shadow_orchestration_stages SET state = p_terminal_state,
    output_fingerprint = public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'stage output fingerprint'),
    terminal_at = v_now, updated_at = v_now WHERE id = p_stage_id;
  IF v_stage.stage = 'EXCEPTION_OUTPUT' THEN
    SELECT public.step9_shadow_run_rollup_v1(
      COALESCE(array_agg(state) FILTER (WHERE stage <> 'EXCEPTION_OUTPUT'), ARRAY[]::text[])
      || ARRAY[p_terminal_state]
    ) INTO v_run_state FROM public.shadow_orchestration_stages WHERE run_id = p_run_id;
    UPDATE public.shadow_orchestration_runs SET state = v_run_state,
      terminal_at = v_now, updated_at = v_now WHERE id = p_run_id;
  END IF;
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_attempt.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id), 'ATTEMPT',
    'RUNNING', p_terminal_state, p_reason_code, p_fencing_token);
  INSERT INTO public.shadow_orchestration_transition_events (
    run_id, stage_id, practice_id, client_entity_id, ledger_book_id,
    sequence_number, entity_kind, from_state, to_state, reason_code, fencing_token
  ) VALUES (v_run.id, v_stage.id, v_run.practice_id, v_run.client_entity_id,
    v_run.ledger_book_id, public.step9_next_transition_sequence_v1(v_run.id), 'STAGE',
    'RUNNING', p_terminal_state, p_reason_code, p_fencing_token);
  IF v_stage.stage = 'EXCEPTION_OUTPUT' THEN
    INSERT INTO public.shadow_orchestration_transition_events (
      run_id, practice_id, client_entity_id, ledger_book_id, sequence_number,
      entity_kind, from_state, to_state, reason_code, fencing_token
    ) VALUES (v_run.id, v_run.practice_id, v_run.client_entity_id, v_run.ledger_book_id,
      public.step9_next_transition_sequence_v1(v_run.id), 'RUN', v_run.state,
      v_run_state, p_reason_code, p_fencing_token);
  END IF;
  RETURN jsonb_build_object('reused', COALESCE((v_output->>'reused')::boolean, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_shadow_extraction_result_v1(
  p_run_id uuid, p_stage_id uuid, p_attempt_id uuid, p_import_artifact_id uuid,
  p_extraction_key_hex text, p_input_fingerprint_hex text, p_extractor_name text,
  p_extractor_version text, p_output_canonical_json text, p_output_fingerprint_hex text,
  p_worker_id text, p_fencing_token bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_stage public.shadow_orchestration_stages%ROWTYPE; v_attempt public.shadow_orchestration_stage_attempts%ROWTYPE;
  v_lease public.shadow_orchestration_leases%ROWTYPE; v_record public.shadow_extraction_runs%ROWTYPE;
  v_id uuid := gen_random_uuid(); v_reused boolean := false;
BEGIN
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages WHERE id = p_stage_id AND run_id = p_run_id;
  IF v_stage.stage <> 'EXTRACTION' THEN RAISE EXCEPTION 'EXTRACTION_STAGE_REQUIRED'; END IF;
  SELECT * INTO STRICT v_attempt FROM public.shadow_orchestration_stage_attempts
    WHERE id = p_attempt_id AND stage_id = p_stage_id AND state = 'RUNNING';
  SELECT * INTO STRICT v_lease FROM public.shadow_orchestration_leases
    WHERE client_entity_id = v_stage.client_entity_id AND ledger_book_id = v_stage.ledger_book_id AND stage = 'EXTRACTION';
  IF v_lease.owner_id <> p_worker_id OR v_lease.fencing_token <> p_fencing_token
     OR v_lease.lease_expires_at <= clock_timestamp() OR v_attempt.fencing_token <> p_fencing_token
     OR v_attempt.worker_id <> p_worker_id THEN
    RAISE EXCEPTION 'STALE_SHADOW_FENCE' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.shadow_extraction_runs (
    id, run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
    import_artifact_id, extraction_key, input_fingerprint, extractor_name, extractor_version,
    output_payload, output_canonical_json, output_fingerprint, fencing_token
  ) VALUES (v_id, p_run_id, p_stage_id, p_attempt_id, v_stage.practice_id, v_stage.client_entity_id,
    v_stage.ledger_book_id, p_import_artifact_id,
    public.step9_decode_sha256_v1(p_extraction_key_hex, 'extraction key'),
    public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'extraction input fingerprint'),
    p_extractor_name, p_extractor_version, p_output_canonical_json::jsonb, p_output_canonical_json,
    public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'extraction output fingerprint'), p_fencing_token)
  ON CONFLICT (extraction_key) DO NOTHING;
  SELECT * INTO STRICT v_record FROM public.shadow_extraction_runs
    WHERE extraction_key = public.step9_decode_sha256_v1(p_extraction_key_hex, 'extraction key');
  v_reused := v_record.id <> v_id;
  IF v_record.client_entity_id <> v_stage.client_entity_id OR v_record.ledger_book_id <> v_stage.ledger_book_id
     OR v_record.import_artifact_id <> p_import_artifact_id
     OR v_record.input_fingerprint <> public.step9_decode_sha256_v1(p_input_fingerprint_hex, 'extraction input fingerprint')
     OR v_record.output_fingerprint <> public.step9_decode_sha256_v1(p_output_fingerprint_hex, 'extraction output fingerprint')
     OR v_record.output_canonical_json <> p_output_canonical_json THEN
    RAISE EXCEPTION 'SHADOW_EXTRACTION_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('extraction_run_id', v_record.id, 'reused', v_reused);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_shadow_reconciliation_snapshot_v1(
  p_run_id uuid, p_stage_id uuid, p_attempt_id uuid, p_statement_id uuid,
  p_snapshot_role text, p_reconciliation_version text, p_manifest_canonical_json text,
  p_manifest_fingerprint_hex text, p_worker_id text, p_fencing_token bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_stage public.shadow_orchestration_stages%ROWTYPE; v_attempt public.shadow_orchestration_stage_attempts%ROWTYPE;
  v_lease public.shadow_orchestration_leases%ROWTYPE; v_snapshot public.shadow_reconciliation_snapshots%ROWTYPE;
  v_id uuid := gen_random_uuid(); v_reused boolean := false;
BEGIN
  SELECT * INTO STRICT v_stage FROM public.shadow_orchestration_stages WHERE id = p_stage_id AND run_id = p_run_id;
  IF v_stage.stage <> 'RECONCILIATION' THEN RAISE EXCEPTION 'RECONCILIATION_STAGE_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_statements statement
    WHERE statement.id = p_statement_id AND statement.client_entity_id = v_stage.client_entity_id
      AND statement.ledger_book_id = v_stage.ledger_book_id
  ) THEN RAISE EXCEPTION 'RECONCILIATION_STATEMENT_SCOPE_MISMATCH' USING ERRCODE = '23503'; END IF;
  SELECT * INTO STRICT v_attempt FROM public.shadow_orchestration_stage_attempts
    WHERE id = p_attempt_id AND stage_id = p_stage_id AND state = 'RUNNING';
  SELECT * INTO STRICT v_lease FROM public.shadow_orchestration_leases
    WHERE client_entity_id = v_stage.client_entity_id AND ledger_book_id = v_stage.ledger_book_id AND stage = 'RECONCILIATION';
  IF v_lease.owner_id <> p_worker_id OR v_lease.fencing_token <> p_fencing_token
     OR v_lease.lease_expires_at <= clock_timestamp() OR v_attempt.fencing_token <> p_fencing_token
     OR v_attempt.worker_id <> p_worker_id THEN
    RAISE EXCEPTION 'STALE_SHADOW_FENCE' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.shadow_reconciliation_snapshots (
    id, run_id, stage_id, attempt_id, practice_id, client_entity_id, ledger_book_id,
    statement_id, snapshot_role, reconciliation_version, manifest, manifest_canonical_json,
    manifest_fingerprint, fencing_token
  ) VALUES (v_id, p_run_id, p_stage_id, p_attempt_id, v_stage.practice_id, v_stage.client_entity_id,
    v_stage.ledger_book_id, p_statement_id, p_snapshot_role, p_reconciliation_version,
    p_manifest_canonical_json::jsonb, p_manifest_canonical_json,
    public.step9_decode_sha256_v1(p_manifest_fingerprint_hex, 'manifest fingerprint'), p_fencing_token)
  ON CONFLICT (run_id, statement_id, snapshot_role) DO NOTHING;
  SELECT * INTO STRICT v_snapshot FROM public.shadow_reconciliation_snapshots
    WHERE run_id = p_run_id AND statement_id = p_statement_id AND snapshot_role = p_snapshot_role;
  v_reused := v_snapshot.id <> v_id;
  IF v_snapshot.reconciliation_version <> p_reconciliation_version
     OR v_snapshot.manifest_fingerprint <> public.step9_decode_sha256_v1(p_manifest_fingerprint_hex, 'manifest fingerprint')
     OR v_snapshot.manifest_canonical_json <> p_manifest_canonical_json THEN
    RAISE EXCEPTION 'SHADOW_RECONCILIATION_SNAPSHOT_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('snapshot_id', v_snapshot.id, 'reused', v_reused);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_shadow_exception_v1(
  p_run_id uuid, p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_stage text, p_exception_key_hex text, p_subject_namespace text, p_subject_id text,
  p_reason_code text, p_evidence_fingerprint_hex text, p_payload_canonical_json text,
  p_payload_fingerprint_hex text, p_correlation_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid := gen_random_uuid(); v_record public.shadow_orchestration_exceptions%ROWTYPE; v_reused boolean := false;
BEGIN
  INSERT INTO public.shadow_orchestration_exceptions (
    id, run_id, practice_id, client_entity_id, ledger_book_id, stage, exception_key,
    subject_namespace, subject_id, reason_code, evidence_fingerprint, payload,
    payload_canonical_json, payload_fingerprint, correlation_id
  ) VALUES (v_id, p_run_id, p_practice_id, p_client_entity_id, p_ledger_book_id, p_stage,
    public.step9_decode_sha256_v1(p_exception_key_hex, 'exception key'), p_subject_namespace,
    p_subject_id, p_reason_code, public.step9_decode_sha256_v1(p_evidence_fingerprint_hex, 'evidence fingerprint'),
    p_payload_canonical_json::jsonb, p_payload_canonical_json,
    public.step9_decode_sha256_v1(p_payload_fingerprint_hex, 'payload fingerprint'), p_correlation_id)
  ON CONFLICT (exception_key) DO NOTHING;
  SELECT * INTO STRICT v_record FROM public.shadow_orchestration_exceptions
    WHERE exception_key = public.step9_decode_sha256_v1(p_exception_key_hex, 'exception key');
  v_reused := v_record.id <> v_id;
  IF v_record.run_id <> p_run_id OR v_record.client_entity_id <> p_client_entity_id
     OR v_record.ledger_book_id <> p_ledger_book_id OR v_record.stage <> p_stage
     OR v_record.payload_fingerprint <> public.step9_decode_sha256_v1(p_payload_fingerprint_hex, 'payload fingerprint')
     OR v_record.payload_canonical_json <> p_payload_canonical_json THEN
    RAISE EXCEPTION 'SHADOW_EXCEPTION_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('exception_id', v_record.id, 'reused', v_reused);
END;
$$;

CREATE TRIGGER shadow_transition_events_immutable BEFORE UPDATE OR DELETE ON public.shadow_orchestration_transition_events
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_stage_outputs_immutable BEFORE UPDATE OR DELETE ON public.shadow_orchestration_stage_outputs
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_extraction_runs_immutable BEFORE UPDATE OR DELETE ON public.shadow_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_reconciliation_snapshots_immutable BEFORE UPDATE OR DELETE ON public.shadow_reconciliation_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_exceptions_immutable BEFORE UPDATE OR DELETE ON public.shadow_orchestration_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_runs_update_guard BEFORE UPDATE ON public.shadow_orchestration_runs
  FOR EACH ROW EXECUTE FUNCTION public.step9_shadow_run_update_guard_v1();
CREATE TRIGGER shadow_runs_no_delete BEFORE DELETE ON public.shadow_orchestration_runs
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_stages_update_guard BEFORE UPDATE ON public.shadow_orchestration_stages
  FOR EACH ROW EXECUTE FUNCTION public.step9_shadow_stage_update_guard_v1();
CREATE TRIGGER shadow_stages_no_delete BEFORE DELETE ON public.shadow_orchestration_stages
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_attempts_update_guard BEFORE UPDATE ON public.shadow_orchestration_stage_attempts
  FOR EACH ROW EXECUTE FUNCTION public.step9_shadow_attempt_update_guard_v1();
CREATE TRIGGER shadow_attempts_no_delete BEFORE DELETE ON public.shadow_orchestration_stage_attempts
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();
CREATE TRIGGER shadow_leases_update_guard BEFORE UPDATE ON public.shadow_orchestration_leases
  FOR EACH ROW EXECUTE FUNCTION public.step9_shadow_lease_update_guard_v1();
CREATE TRIGGER shadow_leases_no_delete BEFORE DELETE ON public.shadow_orchestration_leases
  FOR EACH ROW EXECUTE FUNCTION public.step9_immutable_row_v1();

ALTER TABLE public.shadow_orchestration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_stage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_transition_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_stage_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_reconciliation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_orchestration_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY shadow_runs_read ON public.shadow_orchestration_runs FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_stages_read ON public.shadow_orchestration_stages FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_attempts_read ON public.shadow_orchestration_stage_attempts FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_transitions_read ON public.shadow_orchestration_transition_events FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_outputs_read ON public.shadow_orchestration_stage_outputs FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_extractions_read ON public.shadow_extraction_runs FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_reconciliation_snapshots_read ON public.shadow_reconciliation_snapshots FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY shadow_exceptions_read ON public.shadow_orchestration_exceptions FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));

REVOKE ALL ON TABLE
  public.shadow_orchestration_runs, public.shadow_orchestration_stages,
  public.shadow_orchestration_stage_attempts, public.shadow_orchestration_transition_events,
  public.shadow_orchestration_stage_outputs, public.shadow_extraction_runs,
  public.shadow_reconciliation_snapshots, public.shadow_orchestration_exceptions,
  public.shadow_orchestration_leases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE
  public.shadow_orchestration_runs, public.shadow_orchestration_stages,
  public.shadow_orchestration_stage_attempts, public.shadow_orchestration_transition_events,
  public.shadow_orchestration_stage_outputs, public.shadow_extraction_runs,
  public.shadow_reconciliation_snapshots, public.shadow_orchestration_exceptions
  TO authenticated;

REVOKE ALL ON FUNCTION public.claim_shadow_orchestration_run_v1(uuid,uuid,uuid,text,timestamptz,text,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acquire_shadow_stage_lease_v1(uuid,uuid,uuid,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_shadow_stage_lease_v1(text,text,bigint,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_shadow_stage_attempt_v1(uuid,text,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_shadow_stage_v1(uuid,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_shadow_stage_output_v1(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_shadow_stage_retryable_v1(uuid,uuid,uuid,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_shadow_stage_attempt_v1(uuid,uuid,uuid,text,bigint,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_shadow_extraction_result_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_shadow_reconciliation_snapshot_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_shadow_exception_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_shadow_orchestration_run_v1(uuid,uuid,uuid,text,timestamptz,text,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_shadow_stage_lease_v1(uuid,uuid,uuid,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_shadow_stage_lease_v1(text,text,bigint,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_shadow_stage_attempt_v1(uuid,text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_shadow_stage_v1(uuid,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_shadow_stage_output_v1(uuid,uuid,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_shadow_stage_retryable_v1(uuid,uuid,uuid,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_shadow_stage_attempt_v1(uuid,uuid,uuid,text,bigint,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_shadow_extraction_result_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_shadow_reconciliation_snapshot_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_shadow_exception_v1(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text) TO service_role;

COMMIT;
