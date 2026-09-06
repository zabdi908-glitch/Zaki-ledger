-- Step 8 Day 4: generic audit and reversibility foundation only.
-- This migration is additive. It creates no correction executor, provider
-- mutation capability, Step 7 execution wiring, or Step 5 posting changes.

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_decode_sha256_v1(p_value text, p_label text)
RETURNS bytea
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

CREATE OR REPLACE FUNCTION public.audit_text_array_unique_v1(p_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(p_values) = (SELECT count(DISTINCT value) FROM unnest(p_values) AS value)
$$;

CREATE TABLE public.provider_reversibility_bundles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_version           text NOT NULL UNIQUE CHECK (btrim(bundle_version) <> ''),
  contract_version         text NOT NULL CHECK (btrim(contract_version) <> ''),
  planner_version          text NOT NULL CHECK (btrim(planner_version) <> ''),
  canonicalization_version text NOT NULL CHECK (btrim(canonicalization_version) <> ''),
  capability_json          jsonb NOT NULL CHECK (jsonb_typeof(capability_json) = 'object'),
  capability_sha256        bytea NOT NULL UNIQUE CHECK (octet_length(capability_sha256) = 32),
  ratification_evidence    jsonb NOT NULL CHECK (jsonb_typeof(ratification_evidence) = 'object'),
  published_at             timestamptz NOT NULL DEFAULT now(),
  published_by             text NOT NULL CHECK (btrim(published_by) <> ''),
  supersedes_bundle_id     uuid REFERENCES public.provider_reversibility_bundles(id) ON DELETE RESTRICT,
  UNIQUE (id, capability_sha256),
  CHECK (supersedes_bundle_id IS NULL OR supersedes_bundle_id <> id),
  CHECK (capability_json->>'bundleVersion' = bundle_version),
  CHECK (capability_json->>'contractVersion' = contract_version),
  CHECK (capability_json->>'plannerVersion' = planner_version),
  CHECK (capability_json->>'grantsExecutionPermission' = 'false')
);

CREATE TABLE public.audit_streams (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id         uuid NOT NULL,
  client_entity_id    uuid NOT NULL,
  ledger_book_id      uuid,
  stream_key          text NOT NULL CHECK (octet_length(stream_key) BETWEEN 1 AND 500),
  stream_kind         text NOT NULL CHECK (stream_kind IN
                        ('CLIENT', 'EVIDENCE', 'CANONICAL_EVENT', 'RECONCILIATION',
                         'POLICY_DECISION', 'POSTING_OPERATION', 'CORRECTION_OPERATION',
                         'PROVIDER_OBJECT')),
  last_sequence       bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_hash     bytea CHECK (last_event_hash IS NULL OR octet_length(last_event_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL CHECK (btrim(created_by) <> ''),
  UNIQUE (id, practice_id, client_entity_id),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id),
  UNIQUE (client_entity_id, stream_key),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((last_sequence = 0) = (last_event_hash IS NULL))
);

CREATE TABLE public.audit_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id             uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid,
  stream_sequence       bigint NOT NULL CHECK (stream_sequence > 0),
  event_key             text NOT NULL CHECK (octet_length(event_key) BETWEEN 1 AND 500),
  event_type            text NOT NULL CHECK (btrim(event_type) <> ''),
  actor_type            text NOT NULL CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM', 'PROVIDER')),
  actor_id              text NOT NULL CHECK (btrim(actor_id) <> ''),
  occurred_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  policy_version        text,
  evidence_provenance   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_provenance) = 'array'),
  operation_id          uuid,
  provider_object_ids   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(provider_object_ids) = 'array'),
  event_payload         jsonb NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
  event_payload_canonical_json text NOT NULL CHECK (event_payload = event_payload_canonical_json::jsonb),
  content_sha256        bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  previous_event_hash   bytea CHECK (previous_event_hash IS NULL OR octet_length(previous_event_hash) = 32),
  event_hash            bytea NOT NULL CHECK (octet_length(event_hash) = 32),
  UNIQUE (id, client_entity_id),
  UNIQUE (stream_id, stream_sequence),
  UNIQUE (client_entity_id, event_key),
  UNIQUE (stream_id, event_hash),
  UNIQUE (stream_id, stream_sequence, event_hash),
  FOREIGN KEY (stream_id, practice_id, client_entity_id)
    REFERENCES public.audit_streams(id, practice_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (stream_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.audit_streams(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  CHECK ((stream_sequence = 1) = (previous_event_hash IS NULL)),
  CHECK (policy_version IS NULL OR btrim(policy_version) <> '')
);

CREATE INDEX audit_events_client_recorded_idx
  ON public.audit_events (client_entity_id, recorded_at DESC);
CREATE INDEX audit_events_operation_idx
  ON public.audit_events (client_entity_id, operation_id) WHERE operation_id IS NOT NULL;

CREATE TABLE public.audit_state_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id        uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid,
  snapshot_role         text NOT NULL CHECK (snapshot_role IN ('BEFORE', 'AFTER', 'OBSERVED')),
  object_namespace      text NOT NULL CHECK (btrim(object_namespace) <> ''),
  object_id             text NOT NULL CHECK (btrim(object_id) <> ''),
  provider_connection_id uuid,
  provider_object_id    text,
  provider_version_token text,
  canonical_state       jsonb NOT NULL CHECK (jsonb_typeof(canonical_state) = 'object'),
  canonical_state_json  text NOT NULL CHECK (canonical_state = canonical_state_json::jsonb),
  state_sha256          bytea NOT NULL CHECK (octet_length(state_sha256) = 32),
  captured_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  UNIQUE (audit_event_id, snapshot_role, object_namespace, object_id),
  FOREIGN KEY (audit_event_id, client_entity_id)
    REFERENCES public.audit_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((provider_object_id IS NULL) = (provider_connection_id IS NULL)),
  CHECK (provider_object_id IS NULL OR btrim(provider_object_id) <> ''),
  CHECK (provider_version_token IS NULL OR btrim(provider_version_token) <> '')
);

CREATE TABLE public.audit_event_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id        uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid,
  link_role             text NOT NULL CHECK (link_role IN
                          ('SOURCE_EVIDENCE', 'CANONICAL_EVENT', 'RECONCILIATION_RESULT',
                           'POLICY_DECISION', 'HUMAN_AUTHORIZATION', 'POSTING_OPERATION',
                           'PROVIDER_OBJECT', 'SUPERSEDES', 'CORRECTS', 'REVERSES')),
  target_namespace      text NOT NULL CHECK (btrim(target_namespace) <> ''),
  target_id             text NOT NULL CHECK (btrim(target_id) <> ''),
  target_practice_id    uuid NOT NULL,
  target_client_entity_id uuid NOT NULL,
  target_ledger_book_id uuid,
  target_fingerprint    bytea CHECK (target_fingerprint IS NULL OR octet_length(target_fingerprint) = 32),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_event_id, link_role, target_namespace, target_id),
  FOREIGN KEY (audit_event_id, client_entity_id)
    REFERENCES public.audit_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_client_entity_id, target_practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  CHECK (target_practice_id = practice_id AND target_client_entity_id = client_entity_id),
  CHECK (target_ledger_book_id IS NOT DISTINCT FROM ledger_book_id)
);

CREATE TABLE public.correction_operations (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid,
  idempotency_key                 text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 500),
  source_audit_event_id           uuid NOT NULL,
  source_operation_id             uuid,
  provider_connection_id          uuid,
  provider                        text NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
  external_object_type            text NOT NULL CHECK (btrim(external_object_type) <> ''),
  external_object_id              text NOT NULL CHECK (btrim(external_object_id) <> ''),
  correction_kind                 text NOT NULL CHECK (correction_kind IN
                                  ('SUPERSEDE', 'VOID', 'DELETE', 'COMPENSATING_ENTRY',
                                   'REVERSAL_ENTRY', 'CREDIT_NOTE', 'REFUND', 'UPDATE',
                                   'INACTIVATE', 'ARCHIVE')),
  original_outcome                text NOT NULL CHECK (original_outcome IN ('CONFIRMED', 'UNCERTAIN')),
  planner_decision                text NOT NULL CHECK (planner_decision IN
                                  ('SAFE_METHOD', 'REVIEW', 'NO_SAFE_METHOD')),
  reason_codes                    text[] NOT NULL CHECK (
                                  cardinality(reason_codes) > 0 AND
                                  public.audit_text_array_unique_v1(reason_codes)),
  reversibility_bundle_id         uuid NOT NULL,
  reversibility_bundle_sha256     bytea NOT NULL CHECK (octet_length(reversibility_bundle_sha256) = 32),
  planner_version                 text NOT NULL CHECK (btrim(planner_version) <> ''),
  requested_correction            jsonb NOT NULL CHECK (jsonb_typeof(requested_correction) = 'object'),
  step_count                      integer NOT NULL CHECK (step_count >= 0),
  plan_fingerprint                bytea NOT NULL CHECK (octet_length(plan_fingerprint) = 32),
  execution_permission_granted    boolean NOT NULL DEFAULT false CHECK (NOT execution_permission_granted),
  execution_state                 text NOT NULL DEFAULT 'DISABLED' CHECK (execution_state = 'DISABLED'),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by_actor_type           text NOT NULL CHECK (created_by_actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
  created_by_actor_id             text NOT NULL CHECK (btrim(created_by_actor_id) <> ''),
  UNIQUE (id, practice_id, client_entity_id),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id),
  UNIQUE (client_entity_id, idempotency_key),
  UNIQUE (client_entity_id, plan_fingerprint),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_audit_event_id, client_entity_id)
    REFERENCES public.audit_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (reversibility_bundle_id, reversibility_bundle_sha256)
    REFERENCES public.provider_reversibility_bundles(id, capability_sha256) ON DELETE RESTRICT,
  CHECK (original_outcome <> 'UNCERTAIN' OR
         (planner_decision = 'NO_SAFE_METHOD' AND reason_codes @> ARRAY['ORIGINAL_OUTCOME_UNCERTAIN']::text[])),
  CHECK ((planner_decision = 'SAFE_METHOD' AND step_count > 0) OR
         (planner_decision <> 'SAFE_METHOD' AND step_count = 0)),
  CHECK (planner_decision = 'SAFE_METHOD' OR execution_state = 'DISABLED')
);

CREATE TABLE public.correction_operation_steps (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_operation_id           uuid NOT NULL,
  practice_id                       uuid NOT NULL,
  client_entity_id                  uuid NOT NULL,
  ledger_book_id                    uuid,
  step_index                        integer NOT NULL CHECK (step_index > 0),
  method                            text NOT NULL CHECK (btrim(method) <> ''),
  before_snapshot_id                uuid NOT NULL,
  required_provider_version_token   text NOT NULL CHECK (btrim(required_provider_version_token) <> ''),
  preconditions                     jsonb NOT NULL CHECK (jsonb_typeof(preconditions) = 'object'),
  requested_after_state             jsonb NOT NULL CHECK (jsonb_typeof(requested_after_state) = 'object'),
  after_state_verification          text NOT NULL CHECK (after_state_verification = 'READ_BACK_AND_FINGERPRINT'),
  step_fingerprint                  bytea NOT NULL CHECK (octet_length(step_fingerprint) = 32),
  execution_permission_granted      boolean NOT NULL DEFAULT false CHECK (NOT execution_permission_granted),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (correction_operation_id, step_index),
  UNIQUE (correction_operation_id, step_fingerprint),
  FOREIGN KEY (correction_operation_id, practice_id, client_entity_id)
    REFERENCES public.correction_operations(id, practice_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (correction_operation_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.correction_operations(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  FOREIGN KEY (before_snapshot_id, client_entity_id)
    REFERENCES public.audit_state_snapshots(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (method IN
    ('QBO_VENDOR_SPARSE_UPDATE', 'QBO_VENDOR_INACTIVATE',
     'QBO_BILL_SPARSE_UPDATE', 'QBO_BILL_DELETE',
     'XERO_CONTACT_UPDATE', 'XERO_CONTACT_ARCHIVE',
     'XERO_DRAFT_BILL_UPDATE', 'XERO_DRAFT_BILL_DELETE',
     'XERO_APPROVED_BILL_UPDATE', 'XERO_APPROVED_BILL_VOID',
     'XERO_PAID_BILL_METADATA_UPDATE'))
);

CREATE TABLE public.correction_relationships (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_operation_id  uuid NOT NULL,
  practice_id              uuid NOT NULL,
  client_entity_id         uuid NOT NULL,
  ledger_book_id            uuid,
  relationship_kind        text NOT NULL CHECK (relationship_kind IN
                            ('SUPERSEDES', 'VOIDS', 'DELETES', 'COMPENSATES',
                             'REVERSES', 'CREDITS', 'REFUNDS', 'CORRECTS')),
  target_namespace         text NOT NULL CHECK (btrim(target_namespace) <> ''),
  target_id                text NOT NULL CHECK (btrim(target_id) <> ''),
  target_practice_id       uuid NOT NULL,
  target_client_entity_id  uuid NOT NULL,
  target_ledger_book_id    uuid,
  target_fingerprint       bytea CHECK (target_fingerprint IS NULL OR octet_length(target_fingerprint) = 32),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (correction_operation_id, relationship_kind, target_namespace, target_id),
  FOREIGN KEY (correction_operation_id, practice_id, client_entity_id)
    REFERENCES public.correction_operations(id, practice_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (correction_operation_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.correction_operations(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_client_entity_id, target_practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  CHECK (target_practice_id = practice_id AND target_client_entity_id = client_entity_id),
  CHECK (target_ledger_book_id IS NOT DISTINCT FROM ledger_book_id)
);

CREATE TABLE public.audit_integrity_checkpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id             uuid NOT NULL,
  practice_id           uuid NOT NULL,
  client_entity_id      uuid NOT NULL,
  ledger_book_id        uuid,
  through_sequence      bigint NOT NULL CHECK (through_sequence > 0),
  through_event_hash    bytea NOT NULL CHECK (octet_length(through_event_hash) = 32),
  checkpoint_sha256     bytea NOT NULL CHECK (octet_length(checkpoint_sha256) = 32),
  verifier_version      text NOT NULL CHECK (btrim(verifier_version) <> ''),
  verified_at           timestamptz NOT NULL,
  verified_by           text NOT NULL CHECK (btrim(verified_by) <> ''),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, through_sequence),
  FOREIGN KEY (stream_id, practice_id, client_entity_id)
    REFERENCES public.audit_streams(id, practice_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (stream_id, practice_id, client_entity_id, ledger_book_id)
    REFERENCES public.audit_streams(id, practice_id, client_entity_id, ledger_book_id) ON DELETE RESTRICT,
  FOREIGN KEY (stream_id, through_sequence, through_event_hash)
    REFERENCES public.audit_events(stream_id, stream_sequence, event_hash) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.audit_stream_head_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.id <> NEW.id OR OLD.practice_id <> NEW.practice_id OR
     OLD.client_entity_id <> NEW.client_entity_id OR
     OLD.ledger_book_id IS DISTINCT FROM NEW.ledger_book_id OR
     OLD.stream_key <> NEW.stream_key OR OLD.stream_kind <> NEW.stream_kind OR
     OLD.created_at <> NEW.created_at OR OLD.created_by <> NEW.created_by THEN
    RAISE EXCEPTION 'audit stream identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_sequence <> OLD.last_sequence + 1 OR NEW.last_event_hash IS NULL OR
     NEW.last_event_hash IS NOT DISTINCT FROM OLD.last_event_hash THEN
    RAISE EXCEPTION 'audit stream head may only advance by one event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_streams_head_guard
BEFORE UPDATE ON public.audit_streams
FOR EACH ROW EXECUTE FUNCTION public.audit_stream_head_guard_v1();
CREATE TRIGGER audit_streams_no_delete
BEFORE DELETE ON public.audit_streams
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.audit_compute_event_hash_v1(
  p_previous_event_hash bytea, p_content_sha256 bytea, p_stream_id uuid,
  p_stream_sequence bigint, p_event_key text, p_event_type text,
  p_actor_type text, p_actor_id text, p_occurred_at timestamptz,
  p_policy_version text, p_practice_id uuid, p_client_entity_id uuid,
  p_ledger_book_id uuid, p_evidence_provenance jsonb, p_operation_id uuid,
  p_provider_object_ids jsonb
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT extensions.digest(
    COALESCE(p_previous_event_hash, ''::bytea) || p_content_sha256 ||
    convert_to(p_stream_id::text || ':' || p_stream_sequence::text || ':' || p_event_key || ':' ||
               p_event_type || ':' || p_actor_type || ':' || p_actor_id || ':' ||
               to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || ':' ||
               COALESCE(p_policy_version, '') || ':' || p_practice_id::text || ':' ||
               p_client_entity_id::text || ':' || COALESCE(p_ledger_book_id::text, '') || ':' ||
               p_evidence_provenance::text || ':' || COALESCE(p_operation_id::text, '') || ':' ||
               p_provider_object_ids::text, 'UTF8'), 'sha256')
$$;

CREATE OR REPLACE FUNCTION public.audit_event_integrity_before_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_stream public.audit_streams%ROWTYPE; v_expected_hash bytea;
BEGIN
  SELECT * INTO STRICT v_stream FROM public.audit_streams
  WHERE id = NEW.stream_id AND practice_id = NEW.practice_id AND
        client_entity_id = NEW.client_entity_id AND
        ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id
  FOR UPDATE;
  IF NEW.stream_sequence <> v_stream.last_sequence + 1 OR
     NEW.previous_event_hash IS DISTINCT FROM v_stream.last_event_hash THEN
    RAISE EXCEPTION 'AUDIT_PREVIOUS_EVENT_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF extensions.digest(convert_to(NEW.event_payload_canonical_json, 'UTF8'), 'sha256') <> NEW.content_sha256 THEN
    RAISE EXCEPTION 'AUDIT_CONTENT_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  v_expected_hash := public.audit_compute_event_hash_v1(
    NEW.previous_event_hash, NEW.content_sha256, NEW.stream_id, NEW.stream_sequence,
    NEW.event_key, NEW.event_type, NEW.actor_type, NEW.actor_id, NEW.occurred_at,
    NEW.policy_version, NEW.practice_id, NEW.client_entity_id, NEW.ledger_book_id,
    NEW.evidence_provenance, NEW.operation_id, NEW.provider_object_ids);
  IF NEW.event_hash <> v_expected_hash THEN
    RAISE EXCEPTION 'AUDIT_EVENT_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_event_advance_stream_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.audit_streams
  SET last_sequence = NEW.stream_sequence, last_event_hash = NEW.event_hash
  WHERE id = NEW.stream_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_integrity_before
BEFORE INSERT ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.audit_event_integrity_before_insert_v1();
CREATE TRIGGER audit_events_advance_stream_after
AFTER INSERT ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.audit_event_advance_stream_v1();

CREATE OR REPLACE FUNCTION public.audit_snapshot_integrity_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF extensions.digest(convert_to(NEW.canonical_state_json, 'UTF8'), 'sha256') <> NEW.state_sha256 THEN
    RAISE EXCEPTION 'AUDIT_STATE_SNAPSHOT_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_events event
    WHERE event.id = NEW.audit_event_id AND event.practice_id = NEW.practice_id AND
          event.client_entity_id = NEW.client_entity_id AND
          event.ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id
  ) THEN
    RAISE EXCEPTION 'AUDIT_SNAPSHOT_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_state_snapshots_integrity
BEFORE INSERT ON public.audit_state_snapshots
FOR EACH ROW EXECUTE FUNCTION public.audit_snapshot_integrity_v1();

CREATE OR REPLACE FUNCTION public.audit_owned_link_scope_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_operation_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'audit_event_links' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.audit_events event
      WHERE event.id = NEW.audit_event_id AND event.practice_id = NEW.practice_id AND
            event.client_entity_id = NEW.client_entity_id AND
            event.ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id
    ) THEN RAISE EXCEPTION 'AUDIT_EVENT_LINK_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'correction_operations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.audit_events event
      WHERE event.id = NEW.source_audit_event_id AND event.practice_id = NEW.practice_id AND
            event.client_entity_id = NEW.client_entity_id AND
            event.ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id
    ) THEN RAISE EXCEPTION 'CORRECTION_SOURCE_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
  ELSE
    v_operation_id := NEW.correction_operation_id;
    IF NOT EXISTS (
      SELECT 1 FROM public.correction_operations operation
      WHERE operation.id = v_operation_id AND operation.practice_id = NEW.practice_id AND
            operation.client_entity_id = NEW.client_entity_id AND
            operation.ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id
    ) THEN RAISE EXCEPTION 'CORRECTION_CHILD_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
    IF TG_TABLE_NAME = 'correction_operation_steps' AND NOT EXISTS (
      SELECT 1 FROM public.audit_state_snapshots snapshot
      WHERE snapshot.id = (to_jsonb(NEW)->>'before_snapshot_id')::uuid AND snapshot.practice_id = NEW.practice_id AND
            snapshot.client_entity_id = NEW.client_entity_id AND
            snapshot.ledger_book_id IS NOT DISTINCT FROM NEW.ledger_book_id AND
            snapshot.snapshot_role IN ('BEFORE', 'OBSERVED')
    ) THEN RAISE EXCEPTION 'CORRECTION_BEFORE_SNAPSHOT_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_links_scope BEFORE INSERT ON public.audit_event_links
FOR EACH ROW EXECUTE FUNCTION public.audit_owned_link_scope_v1();
CREATE TRIGGER correction_operations_scope BEFORE INSERT ON public.correction_operations
FOR EACH ROW EXECUTE FUNCTION public.audit_owned_link_scope_v1();
CREATE TRIGGER correction_operation_steps_scope BEFORE INSERT ON public.correction_operation_steps
FOR EACH ROW EXECUTE FUNCTION public.audit_owned_link_scope_v1();
CREATE TRIGGER correction_relationships_scope BEFORE INSERT ON public.correction_relationships
FOR EACH ROW EXECUTE FUNCTION public.audit_owned_link_scope_v1();

CREATE OR REPLACE FUNCTION public.publish_provider_reversibility_bundle_v1(
  p_bundle_version text, p_contract_version text, p_planner_version text,
  p_canonicalization_version text, p_capability_canonical_json text,
  p_capability_sha256_hex text, p_ratification_evidence jsonb, p_published_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_id uuid; v_bundle jsonb; v_hash bytea;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  v_hash := public.audit_decode_sha256_v1(p_capability_sha256_hex, 'reversibility bundle hash');
  IF extensions.digest(convert_to(p_capability_canonical_json, 'UTF8'), 'sha256') <> v_hash THEN
    RAISE EXCEPTION 'REVERSIBILITY_BUNDLE_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  v_bundle := p_capability_canonical_json::jsonb;
  IF p_bundle_version <> 'step8-provider-reversibility-v1' OR
     p_contract_version <> 'step8-reversibility-planner-v1' OR
     p_planner_version <> 'step8-pure-reversibility-planner-v1' OR
     p_canonicalization_version <> 'step8-audit-canonical-json-v1' OR
     p_capability_sha256_hex <> 'e192d819d7927ca9884bdc157afd668d2a89de10b4c607c257fdcac93bc5057f' OR
     v_bundle->>'bundleVersion' <> p_bundle_version OR
     v_bundle->>'contractVersion' <> p_contract_version OR
     v_bundle->>'plannerVersion' <> p_planner_version OR
     v_bundle->>'grantsExecutionPermission' <> 'false' THEN
    RAISE EXCEPTION 'ONLY_RATIFIED_V1_REVERSIBILITY_BUNDLE_ACCEPTED' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.provider_reversibility_bundles (
    bundle_version, contract_version, planner_version, canonicalization_version,
    capability_json, capability_sha256, ratification_evidence, published_by
  ) VALUES (
    p_bundle_version, p_contract_version, p_planner_version, p_canonicalization_version,
    v_bundle, v_hash, p_ratification_evidence, p_published_by
  ) ON CONFLICT (bundle_version) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO STRICT v_id FROM public.provider_reversibility_bundles
    WHERE bundle_version = p_bundle_version AND capability_sha256 = v_hash;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_audit_stream_v1(
  p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_stream_key text, p_stream_kind text, p_created_by text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_stream public.audit_streams%ROWTYPE;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.audit_streams (
    practice_id, client_entity_id, ledger_book_id, stream_key, stream_kind, created_by
  ) VALUES (
    p_practice_id, p_client_entity_id, p_ledger_book_id, p_stream_key, p_stream_kind, p_created_by
  ) ON CONFLICT (client_entity_id, stream_key) DO NOTHING RETURNING * INTO v_stream;
  IF v_stream.id IS NULL THEN
    SELECT * INTO STRICT v_stream FROM public.audit_streams
    WHERE client_entity_id = p_client_entity_id AND stream_key = p_stream_key;
    IF v_stream.practice_id <> p_practice_id OR
       v_stream.ledger_book_id IS DISTINCT FROM p_ledger_book_id OR
       v_stream.stream_kind <> p_stream_kind THEN
      RAISE EXCEPTION 'AUDIT_STREAM_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN v_stream.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_audit_event_v1(
  p_stream_id uuid, p_practice_id uuid, p_client_entity_id uuid, p_ledger_book_id uuid,
  p_event_key text, p_event_type text, p_actor_type text, p_actor_id text,
  p_occurred_at timestamptz, p_policy_version text, p_evidence_provenance jsonb,
  p_operation_id uuid, p_provider_object_ids jsonb, p_event_payload_canonical_json text,
  p_content_sha256_hex text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_stream public.audit_streams%ROWTYPE;
  v_existing public.audit_events%ROWTYPE;
  v_content_hash bytea;
  v_previous_hash bytea;
  v_sequence bigint;
  v_event_hash bytea;
  v_reused boolean := false;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  v_content_hash := public.audit_decode_sha256_v1(p_content_sha256_hex, 'audit content hash');
  IF extensions.digest(convert_to(p_event_payload_canonical_json, 'UTF8'), 'sha256') <> v_content_hash THEN
    RAISE EXCEPTION 'AUDIT_CONTENT_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_client_entity_id::text || ':' || p_event_key, 0));
  SELECT * INTO v_existing FROM public.audit_events
    WHERE client_entity_id = p_client_entity_id AND event_key = p_event_key;
  IF FOUND THEN
    IF v_existing.stream_id <> p_stream_id OR v_existing.practice_id <> p_practice_id OR
       v_existing.ledger_book_id IS DISTINCT FROM p_ledger_book_id OR
       v_existing.event_type <> p_event_type OR
       v_existing.actor_type <> p_actor_type OR v_existing.actor_id <> p_actor_id OR
       v_existing.occurred_at <> p_occurred_at OR
       v_existing.policy_version IS DISTINCT FROM p_policy_version OR
       v_existing.evidence_provenance IS DISTINCT FROM p_evidence_provenance OR
       v_existing.operation_id IS DISTINCT FROM p_operation_id OR
       v_existing.provider_object_ids IS DISTINCT FROM p_provider_object_ids OR
       v_existing.content_sha256 <> v_content_hash OR
       v_existing.event_payload_canonical_json <> p_event_payload_canonical_json OR
       v_existing.event_payload IS DISTINCT FROM p_event_payload_canonical_json::jsonb THEN
      RAISE EXCEPTION 'AUDIT_EVENT_KEY_INTEGRITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    v_reused := true;
  ELSE
    SELECT * INTO STRICT v_stream FROM public.audit_streams
      WHERE id = p_stream_id AND practice_id = p_practice_id AND
            client_entity_id = p_client_entity_id AND ledger_book_id IS NOT DISTINCT FROM p_ledger_book_id
      FOR UPDATE;
    v_sequence := v_stream.last_sequence + 1;
    v_previous_hash := v_stream.last_event_hash;
    v_event_hash := public.audit_compute_event_hash_v1(
      v_previous_hash, v_content_hash, p_stream_id, v_sequence, p_event_key,
      p_event_type, p_actor_type, p_actor_id, p_occurred_at, p_policy_version,
      p_practice_id, p_client_entity_id, p_ledger_book_id, p_evidence_provenance,
      p_operation_id, p_provider_object_ids);
    INSERT INTO public.audit_events (
      stream_id, practice_id, client_entity_id, ledger_book_id, stream_sequence,
      event_key, event_type, actor_type, actor_id, occurred_at, policy_version,
      evidence_provenance, operation_id, provider_object_ids, event_payload,
      event_payload_canonical_json,
      content_sha256, previous_event_hash, event_hash
    ) VALUES (
      p_stream_id, p_practice_id, p_client_entity_id, p_ledger_book_id, v_sequence,
      p_event_key, p_event_type, p_actor_type, p_actor_id, p_occurred_at, p_policy_version,
      p_evidence_provenance, p_operation_id, p_provider_object_ids,
      p_event_payload_canonical_json::jsonb, p_event_payload_canonical_json,
      v_content_hash, v_previous_hash, v_event_hash
    ) RETURNING * INTO v_existing;
  END IF;
  RETURN jsonb_build_object(
    'audit_event_id', v_existing.id,
    'stream_sequence', v_existing.stream_sequence,
    'previous_event_hash', CASE WHEN v_existing.previous_event_hash IS NULL THEN NULL
                                ELSE encode(v_existing.previous_event_hash, 'hex') END,
    'event_hash', encode(v_existing.event_hash, 'hex'),
    'reused', v_reused
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_assert_linear_correction_plan_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_expected integer; v_count integer; v_min integer; v_max integer;
BEGIN
  IF TG_TABLE_NAME = 'correction_operations' THEN
    v_expected := NEW.step_count;
  ELSE
    SELECT step_count INTO STRICT v_expected FROM public.correction_operations WHERE id = NEW.correction_operation_id;
  END IF;
  SELECT count(*), min(step_index), max(step_index) INTO v_count, v_min, v_max
    FROM public.correction_operation_steps
    WHERE correction_operation_id = CASE WHEN TG_TABLE_NAME = 'correction_operations'
                                         THEN NEW.id ELSE NEW.correction_operation_id END;
  IF v_count <> v_expected OR
     (v_expected > 0 AND (v_min <> 1 OR v_max <> v_expected)) THEN
    RAISE EXCEPTION 'compound correction plan must be contiguous and complete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER correction_operation_steps_linear
AFTER INSERT ON public.correction_operation_steps
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.audit_assert_linear_correction_plan_v1();

CREATE CONSTRAINT TRIGGER correction_operations_linear
AFTER INSERT ON public.correction_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.audit_assert_linear_correction_plan_v1();

-- Every historical fact and every proposed correction is immutable. Audit
-- stream head movement above is the sole, guarded sequencing exception.
CREATE TRIGGER provider_reversibility_bundles_immutable BEFORE UPDATE OR DELETE ON public.provider_reversibility_bundles
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER audit_state_snapshots_immutable BEFORE UPDATE OR DELETE ON public.audit_state_snapshots
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER audit_event_links_immutable BEFORE UPDATE OR DELETE ON public.audit_event_links
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER correction_operations_immutable BEFORE UPDATE OR DELETE ON public.correction_operations
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER correction_operation_steps_immutable BEFORE UPDATE OR DELETE ON public.correction_operation_steps
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER correction_relationships_immutable BEFORE UPDATE OR DELETE ON public.correction_relationships
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();
CREATE TRIGGER audit_integrity_checkpoints_immutable BEFORE UPDATE OR DELETE ON public.audit_integrity_checkpoints
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

ALTER TABLE public.provider_reversibility_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_event_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_operation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correction_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_integrity_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_reversibility_bundles_read ON public.provider_reversibility_bundles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY audit_streams_read ON public.audit_streams FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY audit_events_read ON public.audit_events FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY audit_state_snapshots_read ON public.audit_state_snapshots FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY audit_event_links_read ON public.audit_event_links FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY correction_operations_read ON public.correction_operations FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY correction_operation_steps_read ON public.correction_operation_steps FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY correction_relationships_read ON public.correction_relationships FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));
CREATE POLICY audit_integrity_checkpoints_read ON public.audit_integrity_checkpoints FOR SELECT TO authenticated
  USING (public.canonical_can_access_client_v1(client_entity_id));

REVOKE ALL PRIVILEGES ON TABLE
  public.provider_reversibility_bundles, public.audit_streams, public.audit_events,
  public.audit_state_snapshots, public.audit_event_links, public.correction_operations,
  public.correction_operation_steps, public.correction_relationships,
  public.audit_integrity_checkpoints
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.provider_reversibility_bundles, public.audit_streams, public.audit_events,
  public.audit_state_snapshots, public.audit_event_links, public.correction_operations,
  public.correction_operation_steps, public.correction_relationships,
  public.audit_integrity_checkpoints
TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_audit_stream_v1(uuid,uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_audit_event_v1(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,text,jsonb,uuid,jsonb,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_provider_reversibility_bundle_v1(text,text,text,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_audit_stream_v1(uuid,uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_audit_event_v1(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,text,jsonb,uuid,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_provider_reversibility_bundle_v1(text,text,text,text,text,text,jsonb,text) TO service_role;

COMMIT;
