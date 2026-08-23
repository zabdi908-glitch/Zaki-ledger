-- Step 5 Day 3 Task 1: durable posting identity and history foundation.
--
-- This migration intentionally adds no provider executor and changes no
-- approval route. It establishes only the destination, operation identity,
-- duplicate-claim, attempt, provider-object, and append-only audit primitives
-- required by the approved Step 5 posting contract.

BEGIN;

-- Composite parent keys used below make ledger/account/connection coherence a
-- database property rather than an application convention. Nullable legacy
-- rows remain valid; a posting destination must supply every component.
ALTER TABLE public.provider_connections
  ADD CONSTRAINT provider_connections_posting_scope_key
  UNIQUE (id, client_entity_id, ledger_book_id, provider, external_organisation_id);

ALTER TABLE public.financial_accounts
  ADD CONSTRAINT financial_accounts_posting_scope_key
  UNIQUE (id, client_entity_id, ledger_book_id, provider_connection_id);

CREATE TABLE public.provider_posting_account_mappings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                uuid NOT NULL,
  client_entity_id           uuid NOT NULL,
  ledger_book_id             uuid NOT NULL,
  provider_connection_id     uuid NOT NULL,
  financial_account_id       uuid NOT NULL,
  provider                   text NOT NULL
                             CHECK (provider IN ('quickbooks', 'xero')),
  external_organisation_id   text NOT NULL
                             CHECK (btrim(external_organisation_id) <> ''),
  provider_account_id        text NOT NULL
                             CHECK (btrim(provider_account_id) <> ''),
  provider_account_code      text,
  provider_account_name      text,
  posting_role               text NOT NULL
                             CHECK (posting_role IN ('general_ledger', 'nominal')),
  provider_account_type      text NOT NULL
                             CHECK (btrim(provider_account_type) <> ''),
  provider_account_subtype   text,
  mapping_status             text NOT NULL DEFAULT 'active'
                             CHECK (mapping_status IN ('active', 'inactive', 'archived', 'unknown')),
  is_postable                boolean NOT NULL DEFAULT false,
  effective_from             timestamptz NOT NULL DEFAULT now(),
  effective_to               timestamptz,
  verified_at                timestamptz NOT NULL,
  eligibility_expires_at     timestamptz NOT NULL,
  provider_updated_at        timestamptz,
  provider_version           text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  archived_at                timestamptz,
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id),
  UNIQUE (provider_connection_id, external_organisation_id, provider_account_id),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id, ledger_book_id,
               provider, external_organisation_id)
    REFERENCES public.provider_connections
      (id, client_entity_id, ledger_book_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (financial_account_id, client_entity_id, ledger_book_id,
               provider_connection_id)
    REFERENCES public.financial_accounts
      (id, client_entity_id, ledger_book_id, provider_connection_id)
    ON DELETE RESTRICT,
  CHECK (provider_account_code IS NULL OR btrim(provider_account_code) <> ''),
  CHECK (provider_account_name IS NULL OR btrim(provider_account_name) <> ''),
  CHECK (provider_account_subtype IS NULL OR btrim(provider_account_subtype) <> ''),
  CHECK (provider_version IS NULL OR btrim(provider_version) <> ''),
  CHECK ((provider = 'quickbooks' AND posting_role = 'general_ledger')
      OR (provider = 'xero' AND posting_role = 'nominal')),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (eligibility_expires_at > verified_at),
  CHECK ((mapping_status = 'archived') = (archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX provider_posting_accounts_one_active_financial_idx
  ON public.provider_posting_account_mappings
    (financial_account_id, provider_connection_id)
  WHERE mapping_status = 'active';

CREATE INDEX provider_posting_accounts_destination_idx
  ON public.provider_posting_account_mappings
    (client_entity_id, ledger_book_id, provider_connection_id, provider);

-- Operations own the immutable semantic intent. Current state and operational
-- bookkeeping may change, but target, identity, parentage, source claim, and
-- every fingerprinted intent input cannot be rewritten in place.
CREATE TABLE public.posting_operations (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid NOT NULL,
  provider_connection_id          uuid NOT NULL,
  provider                        text NOT NULL
                                  CHECK (provider IN ('quickbooks', 'xero')),
  external_organisation_id        text NOT NULL
                                  CHECK (btrim(external_organisation_id) <> ''),
  parent_operation_id             uuid,
  operation_kind                  text NOT NULL CHECK (btrim(operation_kind) <> ''),
  external_object_type            text NOT NULL CHECK (btrim(external_object_type) <> ''),
  action                          text NOT NULL
                                  CHECK (action IN ('CREATE', 'UPDATE', 'VOID', 'DELETE',
                                                    'PAYMENT', 'JOURNAL', 'TRANSFER')),
  idempotency_key                 text NOT NULL
                                  CHECK (octet_length(idempotency_key) BETWEEN 1 AND 500),
  source_action_claim_fingerprint bytea,
  authorized_request_fingerprint  bytea NOT NULL
                                  CHECK (octet_length(authorized_request_fingerprint) = 32),
  intent_schema_version           text NOT NULL CHECK (btrim(intent_schema_version) <> ''),
  canonicalization_version        text NOT NULL CHECK (btrim(canonicalization_version) <> ''),
  validation_rule_set_version     text NOT NULL CHECK (btrim(validation_rule_set_version) <> ''),
  requested_object                jsonb NOT NULL
                                  CHECK (jsonb_typeof(requested_object) = 'object'),
  evidence_snapshot               jsonb NOT NULL DEFAULT '[]'::jsonb
                                  CHECK (jsonb_typeof(evidence_snapshot) = 'array'),
  account_treatment_snapshot      jsonb NOT NULL DEFAULT '[]'::jsonb
                                  CHECK (jsonb_typeof(account_treatment_snapshot) = 'array'),
  tax_treatment_snapshot          jsonb NOT NULL DEFAULT '[]'::jsonb
                                  CHECK (jsonb_typeof(tax_treatment_snapshot) = 'array'),
  expected_material_state         jsonb NOT NULL
                                  CHECK (jsonb_typeof(expected_material_state) = 'object'),
  current_state                   text NOT NULL DEFAULT 'PROPOSED'
                                  CHECK (current_state IN
                                    ('PROPOSED', 'REVIEW', 'VALIDATED', 'AUTHORIZED',
                                     'SUBMITTING', 'VERIFYING', 'FAILED_SAFE',
                                     'UNCERTAIN', 'DENIED', 'SUCCEEDED')),
  human_authorization_id          uuid,
  permission_decision_id          uuid,
  supersedes_operation_id         uuid,
  row_version                     bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, authorized_request_fingerprint),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id),
  UNIQUE (id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id,
          external_object_type),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id, ledger_book_id,
               provider, external_organisation_id)
    REFERENCES public.provider_connections
      (id, client_entity_id, ledger_book_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (parent_operation_id, practice_id, client_entity_id, ledger_book_id,
               provider_connection_id, provider, external_organisation_id)
    REFERENCES public.posting_operations
      (id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_operation_id, practice_id, client_entity_id,
               ledger_book_id, provider_connection_id, provider,
               external_organisation_id)
    REFERENCES public.posting_operations
      (id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  CHECK (parent_operation_id IS NULL OR parent_operation_id <> id),
  CHECK (supersedes_operation_id IS NULL OR supersedes_operation_id <> id),
  CHECK ((action = 'CREATE' AND source_action_claim_fingerprint IS NOT NULL
          AND octet_length(source_action_claim_fingerprint) = 32)
      OR (action <> 'CREATE' AND source_action_claim_fingerprint IS NULL))
);

-- The contract namespace is intentionally independent of the operation UUID.
CREATE UNIQUE INDEX posting_operations_scoped_idempotency_idx
  ON public.posting_operations
    (client_entity_id, ledger_book_id, provider_connection_id,
     external_object_type, action, idempotency_key);

-- A different caller key cannot claim the same CREATE business effect.
CREATE UNIQUE INDEX posting_operations_create_claim_idx
  ON public.posting_operations
    (client_entity_id, ledger_book_id, provider_connection_id,
     external_object_type, action, source_action_claim_fingerprint)
  WHERE action = 'CREATE';

CREATE INDEX posting_operations_parent_idx
  ON public.posting_operations (parent_operation_id)
  WHERE parent_operation_id IS NOT NULL;

CREATE INDEX posting_operations_state_idx
  ON public.posting_operations
    (client_entity_id, ledger_book_id, provider_connection_id, current_state);

CREATE TABLE public.posting_attempts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id                    uuid NOT NULL,
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid NOT NULL,
  provider_connection_id          uuid NOT NULL,
  provider                        text NOT NULL,
  external_organisation_id        text NOT NULL,
  attempt_number                  integer NOT NULL CHECK (attempt_number > 0),
  attempt_kind                    text NOT NULL
                                  CHECK (attempt_kind IN ('SUBMIT', 'VERIFY', 'RECOVERY')),
  execution_lease_id              uuid NOT NULL,
  adapter_name                    text NOT NULL CHECK (btrim(adapter_name) <> ''),
  adapter_version                 text NOT NULL CHECK (btrim(adapter_version) <> ''),
  authorized_request_fingerprint  bytea NOT NULL
                                  CHECK (octet_length(authorized_request_fingerprint) = 32),
  provider_idempotency_token      text,
  provider_request_id             text,
  lease_acquired_at               timestamptz NOT NULL DEFAULT now(),
  lease_expires_at                timestamptz NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, attempt_number),
  UNIQUE (operation_id, execution_lease_id),
  UNIQUE (id, operation_id, practice_id, client_entity_id, ledger_book_id,
          provider_connection_id, provider, external_organisation_id),
  FOREIGN KEY (operation_id, practice_id, client_entity_id, ledger_book_id,
               provider_connection_id, provider, external_organisation_id)
    REFERENCES public.posting_operations
      (id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, authorized_request_fingerprint)
    REFERENCES public.posting_operations(id, authorized_request_fingerprint)
    ON DELETE RESTRICT,
  CHECK (lease_expires_at > lease_acquired_at),
  CHECK (provider_idempotency_token IS NULL OR btrim(provider_idempotency_token) <> ''),
  CHECK (provider_request_id IS NULL OR btrim(provider_request_id) <> '')
);

CREATE TABLE public.provider_object_bindings (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  originating_operation_id         uuid NOT NULL,
  practice_id                      uuid NOT NULL,
  client_entity_id                 uuid NOT NULL,
  ledger_book_id                   uuid NOT NULL,
  provider_connection_id           uuid NOT NULL,
  provider                         text NOT NULL,
  external_organisation_id         text NOT NULL,
  external_object_type             text NOT NULL CHECK (btrim(external_object_type) <> ''),
  external_object_id               text NOT NULL CHECK (btrim(external_object_id) <> ''),
  binding_kind                     text NOT NULL
                                   CHECK (binding_kind IN ('CREATED', 'ADOPTED', 'REUSED')),
  verified_provider_state_fingerprint bytea NOT NULL
                                   CHECK (octet_length(verified_provider_state_fingerprint) = 32),
  provider_version                 text,
  bound_at                         timestamptz NOT NULL DEFAULT now(),
  verified_at                      timestamptz NOT NULL,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (originating_operation_id),
  UNIQUE (provider_connection_id, external_organisation_id,
          external_object_type, external_object_id),
  UNIQUE (id, originating_operation_id, practice_id, client_entity_id,
          ledger_book_id, provider_connection_id, provider,
          external_organisation_id),
  FOREIGN KEY (originating_operation_id, practice_id, client_entity_id,
               ledger_book_id, provider_connection_id, provider,
               external_organisation_id, external_object_type)
    REFERENCES public.posting_operations
      (id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id,
       external_object_type)
    ON DELETE RESTRICT,
  CHECK (provider_version IS NULL OR btrim(provider_version) <> '')
);

CREATE INDEX provider_object_bindings_operation_idx
  ON public.provider_object_bindings (originating_operation_id);

CREATE TABLE public.posting_events (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id                    uuid NOT NULL,
  practice_id                     uuid NOT NULL,
  client_entity_id                uuid NOT NULL,
  ledger_book_id                  uuid NOT NULL,
  provider_connection_id          uuid NOT NULL,
  provider                        text NOT NULL,
  external_organisation_id        text NOT NULL,
  attempt_id                      uuid,
  provider_object_binding_id      uuid,
  event_sequence                  bigint NOT NULL CHECK (event_sequence > 0),
  event_type                      text NOT NULL
                                  CHECK (event_type IN
                                    ('DECISION', 'TRANSITION', 'DISPATCH',
                                     'PROVIDER_RESPONSE', 'PROVIDER_OBSERVATION',
                                     'RECOVERY', 'MANUAL_INTERVENTION')),
  prior_state                     text,
  new_state                       text,
  reason_code                     text NOT NULL CHECK (btrim(reason_code) <> ''),
  actor_kind                      text NOT NULL
                                  CHECK (actor_kind IN ('USER', 'SERVICE', 'SYSTEM', 'MIGRATION')),
  actor_user_id                   uuid,
  actor_service                   text,
  authorized_request_fingerprint  bytea NOT NULL
                                  CHECK (octet_length(authorized_request_fingerprint) = 32),
  provider_state_fingerprint      bytea,
  normalized_provider_state       jsonb,
  comparison_outcome              text
                                  CHECK (comparison_outcome IN ('MATCH', 'MISMATCH', 'INCONCLUSIVE')),
  provider_correlation_id         text,
  details                         jsonb NOT NULL DEFAULT '{}'::jsonb
                                  CHECK (jsonb_typeof(details) = 'object'),
  occurred_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, event_sequence),
  FOREIGN KEY (operation_id, practice_id, client_entity_id, ledger_book_id,
               provider_connection_id, provider, external_organisation_id)
    REFERENCES public.posting_operations
      (id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, authorized_request_fingerprint)
    REFERENCES public.posting_operations(id, authorized_request_fingerprint)
    ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, operation_id, practice_id, client_entity_id,
               ledger_book_id, provider_connection_id, provider,
               external_organisation_id)
    REFERENCES public.posting_attempts
      (id, operation_id, practice_id, client_entity_id, ledger_book_id,
       provider_connection_id, provider, external_organisation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (provider_object_binding_id, operation_id, practice_id,
               client_entity_id, ledger_book_id, provider_connection_id,
               provider, external_organisation_id)
    REFERENCES public.provider_object_bindings
      (id, originating_operation_id, practice_id, client_entity_id,
       ledger_book_id, provider_connection_id, provider,
       external_organisation_id)
    ON DELETE RESTRICT,
  CHECK ((actor_kind = 'USER' AND actor_user_id IS NOT NULL AND actor_service IS NULL)
      OR (actor_kind IN ('SERVICE', 'SYSTEM', 'MIGRATION')
          AND actor_user_id IS NULL AND actor_service IS NOT NULL
          AND btrim(actor_service) <> '')),
  CHECK ((event_type = 'TRANSITION' AND prior_state IS NOT NULL AND new_state IS NOT NULL)
      OR (event_type <> 'TRANSITION' AND prior_state IS NULL AND new_state IS NULL)),
  CHECK (prior_state IS NULL OR prior_state IN
    ('PROPOSED', 'REVIEW', 'VALIDATED', 'AUTHORIZED', 'SUBMITTING',
     'VERIFYING', 'FAILED_SAFE', 'UNCERTAIN', 'DENIED', 'SUCCEEDED')),
  CHECK (new_state IS NULL OR new_state IN
    ('PROPOSED', 'REVIEW', 'VALIDATED', 'AUTHORIZED', 'SUBMITTING',
     'VERIFYING', 'FAILED_SAFE', 'UNCERTAIN', 'DENIED', 'SUCCEEDED')),
  CHECK ((event_type = 'PROVIDER_OBSERVATION'
          AND provider_state_fingerprint IS NOT NULL
          AND octet_length(provider_state_fingerprint) = 32
          AND normalized_provider_state IS NOT NULL
          AND jsonb_typeof(normalized_provider_state) = 'object'
          AND comparison_outcome IS NOT NULL)
      OR (event_type <> 'PROVIDER_OBSERVATION'
          AND provider_state_fingerprint IS NULL
          AND normalized_provider_state IS NULL
          AND comparison_outcome IS NULL)),
  CHECK (provider_correlation_id IS NULL OR btrim(provider_correlation_id) <> '')
);

CREATE INDEX posting_events_operation_time_idx
  ON public.posting_events (operation_id, event_sequence, occurred_at);

CREATE INDEX posting_events_attempt_idx
  ON public.posting_events (attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.posting_reject_update_delete_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER posting_attempts_append_only
  BEFORE UPDATE OR DELETE ON public.posting_attempts
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE TRIGGER posting_events_append_only
  BEFORE UPDATE OR DELETE ON public.posting_events
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE TRIGGER provider_object_bindings_append_only
  BEFORE UPDATE OR DELETE ON public.provider_object_bindings
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE TRIGGER posting_operations_no_delete
  BEFORE DELETE ON public.posting_operations
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.posting_account_mapping_protect_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
       NEW.id, NEW.practice_id, NEW.client_entity_id, NEW.ledger_book_id,
       NEW.provider_connection_id, NEW.financial_account_id, NEW.provider,
       NEW.external_organisation_id, NEW.provider_account_id, NEW.posting_role,
       NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.practice_id, OLD.client_entity_id, OLD.ledger_book_id,
       OLD.provider_connection_id, OLD.financial_account_id, OLD.provider,
       OLD.external_organisation_id, OLD.provider_account_id, OLD.posting_role,
       OLD.created_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'provider posting-account mapping identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_posting_account_mapping_identity_immutable
  BEFORE UPDATE ON public.provider_posting_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.posting_account_mapping_protect_identity_v1();

CREATE TRIGGER provider_posting_account_mapping_no_delete
  BEFORE DELETE ON public.provider_posting_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.posting_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.posting_operations_protect_intent_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
       NEW.practice_id, NEW.client_entity_id, NEW.ledger_book_id,
       NEW.provider_connection_id, NEW.provider, NEW.external_organisation_id,
       NEW.parent_operation_id, NEW.operation_kind, NEW.external_object_type,
       NEW.action, NEW.idempotency_key, NEW.source_action_claim_fingerprint,
       NEW.authorized_request_fingerprint, NEW.intent_schema_version,
       NEW.canonicalization_version, NEW.validation_rule_set_version,
       NEW.requested_object, NEW.evidence_snapshot,
       NEW.account_treatment_snapshot, NEW.tax_treatment_snapshot,
       NEW.expected_material_state, NEW.supersedes_operation_id
     ) IS DISTINCT FROM ROW(
       OLD.practice_id, OLD.client_entity_id, OLD.ledger_book_id,
       OLD.provider_connection_id, OLD.provider, OLD.external_organisation_id,
       OLD.parent_operation_id, OLD.operation_kind, OLD.external_object_type,
       OLD.action, OLD.idempotency_key, OLD.source_action_claim_fingerprint,
       OLD.authorized_request_fingerprint, OLD.intent_schema_version,
       OLD.canonicalization_version, OLD.validation_rule_set_version,
       OLD.requested_object, OLD.evidence_snapshot,
       OLD.account_treatment_snapshot, OLD.tax_treatment_snapshot,
       OLD.expected_material_state, OLD.supersedes_operation_id
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'posting operation semantic intent is immutable';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'posting operation row_version must increment by exactly one';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER posting_operations_protect_intent
  BEFORE UPDATE ON public.posting_operations
  FOR EACH ROW EXECUTE FUNCTION public.posting_operations_protect_intent_v1();

-- A provider account qualifies only through this view. An active mapping is
-- insufficient if its book, canonical account, connection, postability, or
-- freshness window is not also valid at evaluation time.
CREATE VIEW public.eligible_provider_posting_accounts
WITH (security_invoker = true)
AS
SELECT mapping.*
FROM public.provider_posting_account_mappings AS mapping
JOIN public.client_entities AS client
  ON client.id = mapping.client_entity_id
 AND client.practice_id = mapping.practice_id
 AND client.status = 'active'
JOIN public.ledger_books AS book
  ON book.id = mapping.ledger_book_id
 AND book.client_entity_id = mapping.client_entity_id
 AND book.status = 'active'
JOIN public.provider_connections AS connection
  ON connection.id = mapping.provider_connection_id
 AND connection.client_entity_id = mapping.client_entity_id
 AND connection.ledger_book_id = mapping.ledger_book_id
 AND connection.provider = mapping.provider
 AND connection.external_organisation_id = mapping.external_organisation_id
 AND connection.status = 'active'
JOIN public.financial_accounts AS account
  ON account.id = mapping.financial_account_id
 AND account.client_entity_id = mapping.client_entity_id
 AND account.ledger_book_id = mapping.ledger_book_id
 AND account.provider_connection_id = mapping.provider_connection_id
 AND account.status = 'active'
WHERE mapping.mapping_status = 'active'
  AND mapping.is_postable
  AND mapping.effective_from <= now()
  AND (mapping.effective_to IS NULL OR mapping.effective_to > now())
  AND mapping.verified_at <= now()
  AND mapping.eligibility_expires_at > now();

ALTER TABLE public.provider_posting_account_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_object_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posting_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_posting_account_mappings_authenticated_select
  ON public.provider_posting_account_mappings FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

CREATE POLICY posting_operations_authenticated_select
  ON public.posting_operations FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

CREATE POLICY posting_attempts_authenticated_select
  ON public.posting_attempts FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

CREATE POLICY provider_object_bindings_authenticated_select
  ON public.provider_object_bindings FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

CREATE POLICY posting_events_authenticated_select
  ON public.posting_events FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

REVOKE ALL PRIVILEGES ON TABLE
  public.provider_posting_account_mappings,
  public.posting_operations,
  public.posting_attempts,
  public.provider_object_bindings,
  public.posting_events
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL PRIVILEGES ON TABLE public.eligible_provider_posting_accounts
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.provider_posting_account_mappings,
  public.posting_operations,
  public.posting_attempts,
  public.provider_object_bindings,
  public.posting_events,
  public.eligible_provider_posting_accounts
TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.posting_reject_update_delete_v1()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.posting_operations_protect_intent_v1()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.posting_account_mapping_protect_identity_v1()
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON VIEW public.eligible_provider_posting_accounts IS
  'Only destination-bound, active, postable, current QB/Xero posting account mappings whose entire canonical destination remains active.';

NOTIFY pgrst, 'reload schema';

COMMIT;
