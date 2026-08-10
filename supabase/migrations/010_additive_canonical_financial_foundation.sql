-- Zaki Ledger - additive canonical financial foundation
--
-- Migration 010 creates an empty canonical economic-event model. It performs
-- no legacy backfill, creates no legacy mappings or aliases, changes no legacy
-- table or foreign key, and does not replace the Step 2 ingestion functions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Lookup / foundation
-- ---------------------------------------------------------------------------

CREATE TABLE public.currency_definitions (
  code                 text PRIMARY KEY,
  default_minor_unit   smallint NOT NULL CHECK (default_minor_unit BETWEEN 0 AND 6),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'retired')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (code ~ '^[A-Z]{3}$')
);

-- The foundation seeds the currencies needed by existing Zaki flows and
-- representative zero-/three-decimal currencies. Adding another ISO code is a
-- reviewed lookup-data migration, never an inference during ingestion.
INSERT INTO public.currency_definitions (code, default_minor_unit) VALUES
  ('AED', 2), ('AUD', 2), ('BHD', 3), ('CAD', 2), ('CHF', 2), ('CNY', 2),
  ('DKK', 2), ('EUR', 2), ('GBP', 2), ('HKD', 2), ('INR', 2), ('JPY', 0),
  ('KWD', 3), ('NOK', 2), ('NZD', 2), ('OMR', 3), ('PLN', 2), ('QAR', 2),
  ('SAR', 2), ('SEK', 2), ('SGD', 2), ('USD', 2), ('ZAR', 2);

CREATE TABLE public.financial_relationship_types (
  code                         text PRIMARY KEY,
  supports_allocations         boolean NOT NULL DEFAULT false,
  allow_source_overallocation  boolean NOT NULL DEFAULT false,
  allow_target_overallocation  boolean NOT NULL DEFAULT false,
  -- Migration 010 deliberately classifies every seeded relationship as a
  -- relationship between distinct physical subjects. Future relationship
  -- types must make an explicit reviewed choice instead of inheriting an
  -- accidental self-edge policy.
  allows_same_subject          boolean NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

INSERT INTO public.financial_relationship_types
  (code, supports_allocations, allow_source_overallocation,
   allow_target_overallocation, allows_same_subject)
VALUES
  ('reconciles_with', false, false, false, false),
  ('settles', true, false, false, false),
  ('partially_settles', true, false, false, false),
  ('batch_contains', true, false, false, false),
  ('split_into', true, false, false, false),
  ('refunds', false, false, false, false),
  ('reverses', false, false, false, false),
  ('transfers_to', false, false, false, false),
  ('supersedes', false, false, false, false),
  ('derived_from', false, false, false, false),
  ('applies_credit', true, false, true, false),
  ('records_overpayment', true, true, true, false);

CREATE TABLE public.financial_identity_claim_kinds (
  code                 text NOT NULL,
  allowed_strength     text NOT NULL
                       CHECK (allowed_strength IN
                         ('authoritative', 'strong', 'probabilistic', 'weak')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, allowed_strength),
  CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

INSERT INTO public.financial_identity_claim_kinds (code, allowed_strength) VALUES
  ('quickbooks_object_id', 'authoritative'),
  ('xero_object_id', 'authoritative'),
  ('provider_transaction_id', 'authoritative'),
  ('ofx_fitid', 'strong'),
  ('artifact_record', 'strong'),
  ('versioned_fingerprint', 'probabilistic'),
  ('fuzzy_candidate', 'weak'),
  ('manual_adjudication', 'strong');

CREATE TABLE public.legacy_record_types (
  code                 text PRIMARY KEY,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

INSERT INTO public.legacy_record_types (code) VALUES
  ('bank_transactions'),
  ('qb_transactions'),
  ('bank_statement_transaction_observations'),
  ('bank_statements'),
  ('invoices'),
  ('reconciliation_matches'),
  ('invoice_matches'),
  ('oauth_connections');

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE public.practices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (btrim(name) <> ''),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'archived')),
  created_by_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE public.practice_memberships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id          uuid NOT NULL REFERENCES public.practices(id) ON DELETE RESTRICT,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role                 text NOT NULL
                       CHECK (role IN ('owner', 'admin', 'bookkeeper', 'reviewer', 'viewer')),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'revoked')),
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, practice_id, user_id),
  CHECK ((status = 'active' AND valid_to IS NULL) OR
         (status <> 'active' AND valid_to IS NOT NULL))
);

CREATE UNIQUE INDEX practice_memberships_one_active_idx
  ON public.practice_memberships (practice_id, user_id)
  WHERE status = 'active';

CREATE TABLE public.client_entities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id          uuid NOT NULL REFERENCES public.practices(id) ON DELETE RESTRICT,
  legal_name           text NOT NULL CHECK (btrim(legal_name) <> ''),
  display_name         text NOT NULL CHECK (btrim(display_name) <> ''),
  jurisdiction         text,
  base_currency        text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'archived')),
  legacy_owner_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (id, practice_id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE public.client_access (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL,
  practice_id          uuid NOT NULL,
  membership_id        uuid NOT NULL,
  user_id              uuid NOT NULL,
  role                 text NOT NULL
                       CHECK (role IN ('admin', 'bookkeeper', 'reviewer', 'viewer')),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended', 'revoked')),
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (membership_id, practice_id, user_id)
    REFERENCES public.practice_memberships(id, practice_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND valid_to IS NULL) OR
         (status <> 'active' AND valid_to IS NOT NULL))
);

CREATE UNIQUE INDEX client_access_one_active_idx
  ON public.client_access (client_entity_id, user_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Ledger / provider / financial account
-- ---------------------------------------------------------------------------

CREATE TABLE public.ledger_books (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  book_kind            text NOT NULL
                       CHECK (book_kind IN ('internal', 'quickbooks', 'xero', 'other')),
  display_name         text NOT NULL CHECK (btrim(display_name) <> ''),
  functional_currency  text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disconnected', 'archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (id, client_entity_id)
);

CREATE TABLE public.provider_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id           uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  ledger_book_id             uuid,
  provider                   text NOT NULL CHECK (btrim(provider) <> ''),
  external_organisation_id   text,
  status                     text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'expired', 'disconnected', 'archived')),
  provider_metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
                             CHECK (jsonb_typeof(provider_metadata) = 'object'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  archived_at                timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX provider_connections_active_namespace_idx
  ON public.provider_connections
    (client_entity_id, provider, external_organisation_id)
  WHERE status = 'active' AND external_organisation_id IS NOT NULL;

CREATE TABLE public.financial_accounts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id           uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  ledger_book_id             uuid,
  provider_connection_id     uuid,
  account_kind               text NOT NULL CHECK (btrim(account_kind) <> ''),
  stable_account_key_canonical text,
  stable_account_key_hash    bytea,
  display_name               text,
  masked_identifier          text,
  currency_code              text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  status                     text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'closed', 'unknown', 'archived')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  archived_at                timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((stable_account_key_canonical IS NULL) = (stable_account_key_hash IS NULL)),
  CHECK (stable_account_key_canonical IS NULL OR
         octet_length(stable_account_key_canonical) BETWEEN 1 AND 1000),
  CHECK (stable_account_key_hash IS NULL OR octet_length(stable_account_key_hash) = 32)
);

CREATE UNIQUE INDEX financial_accounts_active_provider_key_idx
  ON public.financial_accounts
    (client_entity_id, provider_connection_id, stable_account_key_canonical)
  WHERE status = 'active'
    AND provider_connection_id IS NOT NULL
    AND stable_account_key_canonical IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

CREATE TABLE public.import_artifacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  artifact_kind        text NOT NULL CHECK (btrim(artifact_kind) <> ''),
  content_sha256       bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  content_length       bigint NOT NULL CHECK (content_length >= 0),
  storage_locator      text,
  storage_state        text NOT NULL DEFAULT 'retained'
                       CHECK (storage_state IN ('retained', 'quarantined', 'purged', 'unavailable')),
  source_filename      text,
  mime_type            text,
  source_created_at    timestamptz,
  received_at          timestamptz NOT NULL DEFAULT now(),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at          timestamptz,
  UNIQUE (id, client_entity_id),
  UNIQUE (client_entity_id, content_sha256, content_length)
);

CREATE TABLE public.import_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id       uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  artifact_id            uuid,
  provider_connection_id uuid,
  idempotency_key        text,
  request_hash           bytea,
  parser_name            text NOT NULL CHECK (btrim(parser_name) <> ''),
  parser_version         text NOT NULL CHECK (btrim(parser_version) <> ''),
  status                 text NOT NULL DEFAULT 'started'
                         CHECK (status IN
                           ('started', 'completed', 'partially_completed', 'failed', 'reused')),
  requested_by_kind      text NOT NULL
                         CHECK (requested_by_kind IN ('user', 'service', 'system', 'migration')),
  requested_by_user_id   uuid,
  requested_by_service   text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  inserted_count         integer NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  reused_count           integer NOT NULL DEFAULT 0 CHECK (reused_count >= 0),
  updated_count          integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  rejected_count         integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  error_summary          jsonb,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((idempotency_key IS NULL) = (request_hash IS NULL)),
  CHECK (request_hash IS NULL OR octet_length(request_hash) = 32),
  CHECK ((requested_by_kind = 'user' AND requested_by_user_id IS NOT NULL AND requested_by_service IS NULL)
      OR (requested_by_kind IN ('service', 'system', 'migration') AND requested_by_user_id IS NULL
          AND requested_by_service IS NOT NULL))
);

CREATE UNIQUE INDEX import_runs_idempotency_idx
  ON public.import_runs (client_entity_id, parser_name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Canonical event, observation, and document roots
-- ---------------------------------------------------------------------------

CREATE TABLE public.financial_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  created_by_kind      text NOT NULL
                       CHECK (created_by_kind IN ('import', 'provider', 'manual', 'backfill', 'merge')),
  current_revision_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (id, client_entity_id)
);

CREATE TABLE public.financial_event_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL,
  event_id             uuid NOT NULL,
  revision_number      integer NOT NULL CHECK (revision_number > 0),
  previous_revision_id uuid,
  event_kind           text NOT NULL CHECK (btrim(event_kind) <> ''),
  lifecycle_status     text NOT NULL DEFAULT 'active'
                       CHECK (lifecycle_status IN ('active', 'superseded', 'merged', 'archived')),
  resolution_status    text NOT NULL DEFAULT 'incomplete'
                       CHECK (resolution_status IN ('resolved', 'incomplete', 'conflicted')),
  occurred_on          date,
  occurred_at          timestamptz,
  amount_minor         bigint CHECK (amount_minor >= 0),
  currency_code        text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent  smallint CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  direction            text CHECK (direction IN ('inflow', 'outflow', 'neutral', 'mixed', 'unknown')),
  display_label        text,
  change_reason        text NOT NULL CHECK (btrim(change_reason) <> ''),
  provenance           jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(provenance) = 'object'),
  created_by_kind      text NOT NULL
                       CHECK (created_by_kind IN ('user', 'service', 'system', 'migration')),
  created_by_user_id   uuid,
  created_by_service   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id, client_entity_id),
  UNIQUE (event_id, revision_number),
  FOREIGN KEY (event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_id, event_id, client_entity_id)
    REFERENCES public.financial_event_revisions(id, event_id, client_entity_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((amount_minor IS NULL AND currency_code IS NULL AND minor_unit_exponent IS NULL)
      OR (amount_minor IS NOT NULL AND currency_code IS NOT NULL AND minor_unit_exponent IS NOT NULL)),
  CHECK (amount_minor IS NULL OR direction IS NOT NULL),
  CHECK ((created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_service IS NULL)
      OR (created_by_kind IN ('service', 'system', 'migration') AND created_by_user_id IS NULL
          AND created_by_service IS NOT NULL))
);

CREATE TABLE public.financial_observations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id       uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  observation_kind       text NOT NULL CHECK (btrim(observation_kind) <> ''),
  ledger_book_id         uuid,
  financial_account_id   uuid,
  provider_connection_id uuid,
  current_revision_id    uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (ledger_book_id, client_entity_id)
    REFERENCES public.ledger_books(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (financial_account_id, client_entity_id)
    REFERENCES public.financial_accounts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT
);

CREATE TABLE public.financial_observation_revisions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id          uuid NOT NULL,
  observation_id            uuid NOT NULL,
  revision_number           integer NOT NULL CHECK (revision_number > 0),
  previous_revision_id      uuid,
  source_status             text NOT NULL DEFAULT 'unknown'
                            CHECK (source_status IN
                              ('pending', 'posted', 'settled', 'corrected', 'voided',
                               'superseded', 'unknown')),
  amount_minor              bigint CHECK (amount_minor >= 0),
  currency_code             text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent       smallint CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  direction                 text CHECK (direction IN ('inflow', 'outflow', 'neutral', 'mixed', 'unknown')),
  raw_amount_text           text,
  raw_currency_text         text,
  source_transaction_on     date,
  source_transaction_at     timestamptz,
  authorization_on          date,
  authorization_at          timestamptz,
  posted_on                 date,
  posted_at                 timestamptz,
  value_date                date,
  accounting_date           date,
  source_timezone           text,
  description               text,
  counterparty              text,
  reference_text            text,
  raw_payload_hash          bytea,
  provider_updated_at       timestamptz,
  observed_at               timestamptz NOT NULL DEFAULT now(),
  change_reason             text NOT NULL CHECK (btrim(change_reason) <> ''),
  created_by_kind           text NOT NULL
                            CHECK (created_by_kind IN ('user', 'service', 'system', 'migration')),
  created_by_user_id        uuid,
  created_by_service        text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, observation_id, client_entity_id),
  UNIQUE (observation_id, revision_number),
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_id, observation_id, client_entity_id)
    REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((amount_minor IS NULL AND currency_code IS NULL AND minor_unit_exponent IS NULL)
      OR (amount_minor IS NOT NULL AND currency_code IS NOT NULL AND minor_unit_exponent IS NOT NULL)),
  CHECK (amount_minor IS NULL OR direction IS NOT NULL),
  CHECK (raw_payload_hash IS NULL OR octet_length(raw_payload_hash) = 32),
  CHECK ((created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_service IS NULL)
      OR (created_by_kind IN ('service', 'system', 'migration') AND created_by_user_id IS NULL
          AND created_by_service IS NOT NULL))
);

CREATE TABLE public.financial_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  source_artifact_id   uuid,
  document_kind        text NOT NULL
                       CHECK (document_kind IN ('invoice', 'receipt', 'credit_note', 'statement', 'other')),
  current_revision_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (source_artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT
);

CREATE TABLE public.financial_document_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL,
  document_id          uuid NOT NULL,
  revision_number      integer NOT NULL CHECK (revision_number > 0),
  previous_revision_id uuid,
  obligation_status    text NOT NULL
                       CHECK (obligation_status IN
                         ('open', 'partially_settled', 'settled', 'disputed', 'voided', 'not_applicable')),
  resolution_status    text NOT NULL DEFAULT 'incomplete'
                       CHECK (resolution_status IN ('resolved', 'incomplete', 'conflicted')),
  issuer_name          text,
  document_number      text,
  document_date        date,
  due_date             date,
  amount_minor         bigint CHECK (amount_minor >= 0),
  currency_code        text REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  minor_unit_exponent  smallint CHECK (minor_unit_exponent BETWEEN 0 AND 6),
  raw_amount_text      text,
  raw_currency_text    text,
  change_reason        text NOT NULL CHECK (btrim(change_reason) <> ''),
  provenance           jsonb NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(provenance) = 'object'),
  created_by_kind      text NOT NULL
                       CHECK (created_by_kind IN ('user', 'service', 'system', 'migration')),
  created_by_user_id   uuid,
  created_by_service   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, document_id, client_entity_id),
  UNIQUE (document_id, revision_number),
  FOREIGN KEY (document_id, client_entity_id)
    REFERENCES public.financial_documents(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_id, document_id, client_entity_id)
    REFERENCES public.financial_document_revisions(id, document_id, client_entity_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((amount_minor IS NULL AND currency_code IS NULL AND minor_unit_exponent IS NULL)
      OR (amount_minor IS NOT NULL AND currency_code IS NOT NULL AND minor_unit_exponent IS NOT NULL)),
  CHECK ((created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_service IS NULL)
      OR (created_by_kind IN ('service', 'system', 'migration') AND created_by_user_id IS NULL
          AND created_by_service IS NOT NULL))
);

-- The deferred composite pointers prove that a current revision belongs to the
-- same root and client without requiring an impossible insertion order.
ALTER TABLE public.financial_events
  ADD CONSTRAINT financial_events_current_revision_fk
  FOREIGN KEY (current_revision_id, id, client_entity_id)
  REFERENCES public.financial_event_revisions(id, event_id, client_entity_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.financial_observations
  ADD CONSTRAINT financial_observations_current_revision_fk
  FOREIGN KEY (current_revision_id, id, client_entity_id)
  REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.financial_documents
  ADD CONSTRAINT financial_documents_current_revision_fk
  FOREIGN KEY (current_revision_id, id, client_entity_id)
  REFERENCES public.financial_document_revisions(id, document_id, client_entity_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.financial_observation_occurrences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id      uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  observation_id        uuid NOT NULL,
  import_run_id         uuid NOT NULL,
  artifact_id           uuid,
  source_locator        text,
  source_row_number     integer CHECK (source_row_number IS NULL OR source_row_number > 0),
  source_reference_hash bytea,
  raw_payload_hash      bytea,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_run_id, client_entity_id)
    REFERENCES public.import_runs(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (source_locator IS NOT NULL OR source_row_number IS NOT NULL OR source_reference_hash IS NOT NULL),
  CHECK (source_reference_hash IS NULL OR octet_length(source_reference_hash) = 32),
  CHECK (raw_payload_hash IS NULL OR octet_length(raw_payload_hash) = 32)
);

CREATE UNIQUE INDEX financial_occurrences_run_locator_idx
  ON public.financial_observation_occurrences (import_run_id, source_locator)
  WHERE source_locator IS NOT NULL;

CREATE UNIQUE INDEX financial_occurrences_run_row_idx
  ON public.financial_observation_occurrences (import_run_id, source_row_number)
  WHERE source_row_number IS NOT NULL;

CREATE TABLE public.financial_event_observation_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  event_id             uuid NOT NULL,
  observation_id       uuid NOT NULL,
  role                 text NOT NULL
                       CHECK (role IN ('primary', 'supporting', 'component', 'counter_leg')),
  attachment_basis     text NOT NULL CHECK (btrim(attachment_basis) <> ''),
  attached_by_kind     text NOT NULL
                       CHECK (attached_by_kind IN ('user', 'service', 'system', 'migration')),
  attached_by_user_id  uuid,
  attached_by_service  text,
  valid_from           timestamptz NOT NULL DEFAULT now(),
  valid_to             timestamptz,
  replaced_by_link_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, observation_id, client_entity_id),
  FOREIGN KEY (event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (replaced_by_link_id, observation_id, client_entity_id)
    REFERENCES public.financial_event_observation_links(id, observation_id, client_entity_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((attached_by_kind = 'user' AND attached_by_user_id IS NOT NULL AND attached_by_service IS NULL)
      OR (attached_by_kind IN ('service', 'system', 'migration') AND attached_by_user_id IS NULL
          AND attached_by_service IS NOT NULL))
);

CREATE UNIQUE INDEX financial_event_observation_one_active_idx
  ON public.financial_event_observation_links (observation_id)
  WHERE valid_to IS NULL;

CREATE TABLE public.financial_event_fact_resolutions (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id                 uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  event_revision_id                uuid NOT NULL,
  event_id                         uuid NOT NULL,
  fact_name                        text NOT NULL
                                   CHECK (fact_name IN
                                     ('event_kind', 'occurred_on', 'occurred_at', 'amount',
                                      'currency', 'direction', 'display_label')),
  resolution_state                 text NOT NULL
                                   CHECK (resolution_state IN ('resolved', 'unresolved', 'conflicted')),
  selected_observation_revision_id uuid,
  selected_observation_id          uuid,
  resolution_method                text NOT NULL
                                   CHECK (resolution_method IN ('deterministic', 'provider', 'manual', 'merge')),
  evidence_hash                    bytea,
  reason                           text NOT NULL CHECK (btrim(reason) <> ''),
  reviewed_by_user_id              uuid,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_revision_id, fact_name),
  FOREIGN KEY (event_revision_id, event_id, client_entity_id)
    REFERENCES public.financial_event_revisions(id, event_id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_observation_revision_id, selected_observation_id, client_entity_id)
    REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id)
    ON DELETE RESTRICT,
  CHECK ((selected_observation_revision_id IS NULL) = (selected_observation_id IS NULL)),
  CHECK (evidence_hash IS NULL OR octet_length(evidence_hash) = 32)
);

-- ---------------------------------------------------------------------------
-- Identity claims
-- ---------------------------------------------------------------------------

CREATE TABLE public.financial_identity_claims (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id               uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  observation_id                 uuid NOT NULL,
  claim_kind                     text NOT NULL,
  strength                       text NOT NULL
                                 CHECK (strength IN ('authoritative', 'strong', 'probabilistic', 'weak')),
  status                         text NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'superseded', 'invalidated', 'conflicted')),
  canonicalisation_version       integer NOT NULL CHECK (canonicalisation_version > 0),
  namespace_canonical            text NOT NULL,
  claim_key_canonical            text NOT NULL,
  namespace_hash                 bytea NOT NULL CHECK (octet_length(namespace_hash) = 32),
  claim_key_hash                 bytea NOT NULL CHECK (octet_length(claim_key_hash) = 32),
  components                     jsonb NOT NULL CHECK (jsonb_typeof(components) = 'object'),
  source_artifact_id             uuid,
  source_observation_revision_id uuid,
  supersedes_claim_id            uuid,
  reviewed_by_user_id            uuid,
  review_reason                  text,
  valid_from                     timestamptz NOT NULL DEFAULT now(),
  valid_to                       timestamptz,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (claim_kind, strength)
    REFERENCES public.financial_identity_claim_kinds(code, allowed_strength) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_observation_revision_id, observation_id, client_entity_id)
    REFERENCES public.financial_observation_revisions(id, observation_id, client_entity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_claim_id, client_entity_id)
    REFERENCES public.financial_identity_claims(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (octet_length(namespace_canonical) BETWEEN 1 AND 1000),
  CHECK (octet_length(claim_key_canonical) BETWEEN 1 AND 1000),
  CHECK ((status = 'active' AND valid_to IS NULL) OR
         (status <> 'active' AND valid_to IS NOT NULL)),
  CHECK (supersedes_claim_id IS NULL OR review_reason IS NOT NULL)
);

CREATE UNIQUE INDEX financial_identity_active_strong_exact_idx
  ON public.financial_identity_claims
    (client_entity_id, claim_kind, namespace_canonical, claim_key_canonical)
  WHERE status = 'active' AND strength IN ('authoritative', 'strong');

-- This broader exact-value lookup remains usable when a caller has not yet
-- classified strength. Hashes are candidates only; exact canonical strings
-- are always part of identity resolution.
CREATE INDEX financial_identity_active_exact_lookup_idx
  ON public.financial_identity_claims
    (client_entity_id, claim_kind, namespace_canonical, claim_key_canonical)
  INCLUDE (observation_id, strength)
  WHERE status = 'active';

CREATE INDEX financial_identity_hash_candidate_idx
  ON public.financial_identity_claims
    (client_entity_id, claim_kind, namespace_hash, claim_key_hash)
  WHERE status = 'active';

CREATE INDEX financial_identity_probabilistic_candidate_idx
  ON public.financial_identity_claims
    (client_entity_id, claim_kind, namespace_hash, claim_key_hash)
  WHERE status = 'active' AND strength IN ('probabilistic', 'weak');

-- ---------------------------------------------------------------------------
-- Relationships and allocations
-- ---------------------------------------------------------------------------

CREATE TABLE public.financial_relationships (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id           uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  relationship_type          text NOT NULL REFERENCES public.financial_relationship_types(code) ON DELETE RESTRICT,
  status                     text NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed', 'confirmed', 'rejected', 'revoked', 'superseded')),
  evidence_strength          text NOT NULL DEFAULT 'weak'
                             CHECK (evidence_strength IN ('authoritative', 'strong', 'probabilistic', 'weak')),
  confidence_basis_points    integer CHECK (confidence_basis_points BETWEEN 0 AND 10000),
  source_kind                text NOT NULL
                             CHECK (source_kind IN ('manual', 'engine', 'provider', 'legacy', 'system')),
  reason                     text NOT NULL CHECK (btrim(reason) <> ''),
  created_by_kind            text NOT NULL
                             CHECK (created_by_kind IN ('user', 'service', 'system', 'migration')),
  created_by_user_id         uuid,
  created_by_service         text,
  reviewed_by_user_id        uuid,
  supersedes_relationship_id uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  reviewed_at                timestamptz,
  closed_at                  timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (supersedes_relationship_id, client_entity_id)
    REFERENCES public.financial_relationships(id, client_entity_id) ON DELETE RESTRICT,
  CHECK ((status IN ('revoked', 'superseded') AND closed_at IS NOT NULL)
      OR (status NOT IN ('revoked', 'superseded'))),
  CHECK ((created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_service IS NULL)
      OR (created_by_kind IN ('service', 'system', 'migration') AND created_by_user_id IS NULL
          AND created_by_service IS NOT NULL))
);

CREATE TABLE public.financial_relationship_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id     uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  relationship_id      uuid NOT NULL,
  endpoint_role        text NOT NULL CHECK (btrim(endpoint_role) <> ''),
  ordinal              integer NOT NULL CHECK (ordinal >= 0),
  event_id             uuid,
  observation_id       uuid,
  document_id          uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, relationship_id, client_entity_id),
  UNIQUE (relationship_id, endpoint_role, ordinal),
  FOREIGN KEY (relationship_id, client_entity_id)
    REFERENCES public.financial_relationships(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, client_entity_id)
    REFERENCES public.financial_documents(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(event_id, observation_id, document_id) = 1)
);

CREATE UNIQUE INDEX financial_endpoint_event_role_idx
  ON public.financial_relationship_endpoints (relationship_id, event_id, endpoint_role)
  WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX financial_endpoint_observation_role_idx
  ON public.financial_relationship_endpoints (relationship_id, observation_id, endpoint_role)
  WHERE observation_id IS NOT NULL;
CREATE UNIQUE INDEX financial_endpoint_document_role_idx
  ON public.financial_relationship_endpoints (relationship_id, document_id, endpoint_role)
  WHERE document_id IS NOT NULL;

CREATE TABLE public.financial_allocations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id           uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  relationship_id            uuid NOT NULL,
  from_endpoint_id           uuid NOT NULL,
  to_endpoint_id             uuid NOT NULL,
  source_amount_minor        bigint NOT NULL CHECK (source_amount_minor >= 0),
  source_currency_code       text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  source_minor_unit_exponent smallint NOT NULL CHECK (source_minor_unit_exponent BETWEEN 0 AND 6),
  target_amount_minor        bigint NOT NULL CHECK (target_amount_minor >= 0),
  target_currency_code       text NOT NULL REFERENCES public.currency_definitions(code) ON DELETE RESTRICT,
  target_minor_unit_exponent smallint NOT NULL CHECK (target_minor_unit_exponent BETWEEN 0 AND 6),
  fx_rate_numerator          bigint CHECK (fx_rate_numerator > 0),
  fx_rate_denominator        bigint CHECK (fx_rate_denominator > 0),
  status                     text NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed', 'confirmed', 'revoked', 'superseded')),
  supersedes_allocation_id   uuid,
  created_by_kind            text NOT NULL
                             CHECK (created_by_kind IN ('user', 'service', 'system', 'migration')),
  created_by_user_id         uuid,
  created_by_service         text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  closed_at                  timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (relationship_id, client_entity_id)
    REFERENCES public.financial_relationships(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_endpoint_id, relationship_id, client_entity_id)
    REFERENCES public.financial_relationship_endpoints(id, relationship_id, client_entity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (to_endpoint_id, relationship_id, client_entity_id)
    REFERENCES public.financial_relationship_endpoints(id, relationship_id, client_entity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_allocation_id, client_entity_id)
    REFERENCES public.financial_allocations(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (from_endpoint_id <> to_endpoint_id),
  CHECK ((fx_rate_numerator IS NULL) = (fx_rate_denominator IS NULL)),
  CHECK ((source_currency_code = target_currency_code
          AND source_amount_minor = target_amount_minor
          AND source_minor_unit_exponent = target_minor_unit_exponent)
      OR source_currency_code <> target_currency_code),
  CHECK ((status IN ('revoked', 'superseded') AND closed_at IS NOT NULL)
      OR (status NOT IN ('revoked', 'superseded'))),
  CHECK ((created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_service IS NULL)
      OR (created_by_kind IN ('service', 'system', 'migration') AND created_by_user_id IS NULL
          AND created_by_service IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Merge / alias, legacy mapping, and immutable audit
-- ---------------------------------------------------------------------------

CREATE TABLE public.financial_merge_operations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id        uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  survivor_event_id       uuid NOT NULL,
  status                  text NOT NULL
                          CHECK (status IN ('proposed', 'approved', 'applied', 'reversed', 'failed')),
  requested_by_kind       text NOT NULL
                          CHECK (requested_by_kind IN ('user', 'service', 'system', 'migration')),
  requested_by_user_id    uuid,
  requested_by_service    text,
  approved_by_user_id     uuid,
  evidence                jsonb NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(evidence) = 'object'),
  reason                  text NOT NULL CHECK (btrim(reason) <> ''),
  reversal_of_operation_id uuid,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  approved_at             timestamptz,
  applied_at              timestamptz,
  reversed_at             timestamptz,
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (survivor_event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (reversal_of_operation_id, client_entity_id)
    REFERENCES public.financial_merge_operations(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id IS DISTINCT FROM requested_by_user_id),
  CHECK ((requested_by_kind = 'user' AND requested_by_user_id IS NOT NULL AND requested_by_service IS NULL)
      OR (requested_by_kind IN ('service', 'system', 'migration') AND requested_by_user_id IS NULL
          AND requested_by_service IS NOT NULL))
);

CREATE TABLE public.financial_event_aliases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id         uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  alias_event_id           uuid NOT NULL,
  survivor_event_id        uuid NOT NULL,
  merge_operation_id       uuid NOT NULL,
  valid_from               timestamptz NOT NULL DEFAULT now(),
  valid_to                 timestamptz,
  reversed_by_operation_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (alias_event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (survivor_event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (merge_operation_id, client_entity_id)
    REFERENCES public.financial_merge_operations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (reversed_by_operation_id, client_entity_id)
    REFERENCES public.financial_merge_operations(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (alias_event_id <> survivor_event_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((valid_to IS NULL) = (reversed_by_operation_id IS NULL))
);

CREATE UNIQUE INDEX financial_event_aliases_one_active_idx
  ON public.financial_event_aliases (alias_event_id)
  WHERE valid_to IS NULL;

CREATE INDEX financial_event_aliases_active_survivor_idx
  ON public.financial_event_aliases (survivor_event_id)
  WHERE valid_to IS NULL;

CREATE TABLE public.legacy_record_mappings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_entity_id         uuid NOT NULL REFERENCES public.client_entities(id) ON DELETE RESTRICT,
  legacy_record_type       text NOT NULL REFERENCES public.legacy_record_types(code) ON DELETE RESTRICT,
  legacy_id                uuid NOT NULL,
  mapping_kind             text NOT NULL
                           CHECK (mapping_kind IN
                             ('event', 'observation', 'document', 'artifact',
                              'relationship', 'provider_connection')),
  event_id                 uuid,
  observation_id           uuid,
  document_id              uuid,
  artifact_id              uuid,
  relationship_id          uuid,
  provider_connection_id   uuid,
  mapping_version          integer NOT NULL DEFAULT 1 CHECK (mapping_version > 0),
  status                   text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'superseded', 'reversed')),
  valid_from               timestamptz NOT NULL DEFAULT now(),
  valid_to                 timestamptz,
  created_operation_id     uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, client_entity_id),
  FOREIGN KEY (event_id, client_entity_id)
    REFERENCES public.financial_events(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, client_entity_id)
    REFERENCES public.financial_observations(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, client_entity_id)
    REFERENCES public.financial_documents(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, client_entity_id)
    REFERENCES public.import_artifacts(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (relationship_id, client_entity_id)
    REFERENCES public.financial_relationships(id, client_entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, client_entity_id)
    REFERENCES public.provider_connections(id, client_entity_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(event_id, observation_id, document_id, artifact_id,
                      relationship_id, provider_connection_id) = 1),
  CHECK ((mapping_kind = 'event' AND event_id IS NOT NULL)
      OR (mapping_kind = 'observation' AND observation_id IS NOT NULL)
      OR (mapping_kind = 'document' AND document_id IS NOT NULL)
      OR (mapping_kind = 'artifact' AND artifact_id IS NOT NULL)
      OR (mapping_kind = 'relationship' AND relationship_id IS NOT NULL)
      OR (mapping_kind = 'provider_connection' AND provider_connection_id IS NOT NULL)),
  CHECK ((status = 'active' AND valid_to IS NULL) OR
         (status <> 'active' AND valid_to IS NOT NULL))
);

CREATE UNIQUE INDEX legacy_record_mappings_one_active_idx
  ON public.legacy_record_mappings (legacy_record_type, legacy_id, mapping_kind)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.canonical_audit_metadata_allowed_v1(p_metadata jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_object_keys(COALESCE(p_metadata, '{}'::jsonb)) AS key_name
       WHERE key_name NOT IN
         ('request_source', 'reason_code', 'parser_version', 'relationship_type',
          'claim_kind', 'outcome', 'detail_code')
     );
$$;

CREATE TABLE public.canonical_audit_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id          uuid NOT NULL REFERENCES public.practices(id) ON DELETE RESTRICT,
  client_entity_id     uuid,
  operation_id         uuid NOT NULL,
  operation_sequence   integer NOT NULL CHECK (operation_sequence > 0),
  actor_kind           text NOT NULL
                       CHECK (actor_kind IN ('user', 'service', 'system', 'migration')),
  actor_user_id        uuid,
  actor_service        text,
  request_id           text,
  action               text NOT NULL CHECK (btrim(action) <> ''),
  entity_kind          text NOT NULL CHECK (btrim(entity_kind) <> ''),
  entity_id            uuid NOT NULL,
  before_hash          bytea,
  after_hash           bytea,
  hash_version         integer NOT NULL DEFAULT 1 CHECK (hash_version > 0),
  metadata_redacted    jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, operation_sequence),
  FOREIGN KEY (client_entity_id, practice_id)
    REFERENCES public.client_entities(id, practice_id) ON DELETE RESTRICT,
  CHECK (before_hash IS NULL OR octet_length(before_hash) = 32),
  CHECK (after_hash IS NULL OR octet_length(after_hash) = 32),
  CHECK (before_hash IS NOT NULL OR after_hash IS NOT NULL),
  CHECK (public.canonical_audit_metadata_allowed_v1(metadata_redacted)),
  CHECK ((actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_service IS NULL)
      OR (actor_kind IN ('service', 'system', 'migration') AND actor_user_id IS NULL
          AND actor_service IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Supporting indexes for foreign keys, RLS, and canonical reads
-- ---------------------------------------------------------------------------

CREATE INDEX practice_memberships_practice_user_idx
  ON public.practice_memberships (practice_id, user_id, status);
CREATE INDEX client_entities_practice_idx
  ON public.client_entities (practice_id, status);
CREATE INDEX client_access_membership_idx
  ON public.client_access (membership_id, practice_id, user_id);
CREATE INDEX client_access_client_user_idx
  ON public.client_access (client_entity_id, user_id, status);
CREATE INDEX ledger_books_client_idx ON public.ledger_books (client_entity_id);
CREATE INDEX provider_connections_client_ledger_idx
  ON public.provider_connections (client_entity_id, ledger_book_id);
CREATE INDEX financial_accounts_client_provider_idx
  ON public.financial_accounts (client_entity_id, provider_connection_id);
CREATE INDEX import_artifacts_client_idx ON public.import_artifacts (client_entity_id);
CREATE INDEX import_runs_artifact_idx ON public.import_runs (artifact_id, client_entity_id);
CREATE INDEX import_runs_provider_idx ON public.import_runs (provider_connection_id, client_entity_id);
CREATE INDEX financial_event_revisions_event_idx
  ON public.financial_event_revisions (event_id, client_entity_id, revision_number DESC);
CREATE INDEX financial_observations_account_idx
  ON public.financial_observations (financial_account_id, client_entity_id);
CREATE INDEX financial_observations_provider_idx
  ON public.financial_observations (provider_connection_id, client_entity_id);
CREATE INDEX financial_observation_revisions_observation_idx
  ON public.financial_observation_revisions (observation_id, client_entity_id, revision_number DESC);
CREATE INDEX financial_document_revisions_document_idx
  ON public.financial_document_revisions (document_id, client_entity_id, revision_number DESC);
CREATE INDEX financial_occurrences_observation_idx
  ON public.financial_observation_occurrences (observation_id, client_entity_id);
CREATE INDEX financial_occurrences_artifact_idx
  ON public.financial_observation_occurrences (artifact_id, client_entity_id);
CREATE INDEX financial_links_event_idx
  ON public.financial_event_observation_links (event_id, client_entity_id)
  WHERE valid_to IS NULL;
CREATE INDEX financial_fact_resolution_observation_revision_idx
  ON public.financial_event_fact_resolutions
    (selected_observation_revision_id, selected_observation_id, client_entity_id);
CREATE INDEX financial_identity_observation_idx
  ON public.financial_identity_claims (observation_id, client_entity_id);
CREATE INDEX financial_relationships_client_status_idx
  ON public.financial_relationships (client_entity_id, status, relationship_type);
CREATE INDEX financial_relationships_client_recent_idx
  ON public.financial_relationships (client_entity_id, status, created_at DESC, id)
  INCLUDE (relationship_type);
CREATE INDEX financial_endpoints_relationship_idx
  ON public.financial_relationship_endpoints (relationship_id, client_entity_id);
CREATE INDEX financial_endpoints_event_idx
  ON public.financial_relationship_endpoints (event_id, client_entity_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX financial_endpoints_observation_idx
  ON public.financial_relationship_endpoints (observation_id, client_entity_id)
  WHERE observation_id IS NOT NULL;
CREATE INDEX financial_endpoints_document_idx
  ON public.financial_relationship_endpoints (document_id, client_entity_id)
  WHERE document_id IS NOT NULL;
CREATE INDEX financial_allocations_relationship_idx
  ON public.financial_allocations (relationship_id, client_entity_id, status);
CREATE INDEX financial_allocations_from_idx
  ON public.financial_allocations (from_endpoint_id, relationship_id, client_entity_id)
  WHERE status = 'confirmed';
CREATE INDEX financial_allocations_to_idx
  ON public.financial_allocations (to_endpoint_id, relationship_id, client_entity_id)
  WHERE status = 'confirmed';
CREATE INDEX financial_merge_operations_client_idx
  ON public.financial_merge_operations (client_entity_id, status, applied_at);
CREATE INDEX legacy_record_mappings_target_event_idx
  ON public.legacy_record_mappings (event_id, client_entity_id) WHERE event_id IS NOT NULL;
CREATE INDEX legacy_record_mappings_target_observation_idx
  ON public.legacy_record_mappings (observation_id, client_entity_id) WHERE observation_id IS NOT NULL;
CREATE INDEX canonical_audit_client_time_idx
  ON public.canonical_audit_ledger (client_entity_id, occurred_at DESC);
CREATE INDEX canonical_audit_entity_idx
  ON public.canonical_audit_ledger (entity_kind, entity_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Immutable history and deferred root completeness
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_reject_update_delete_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER financial_event_revisions_immutable
BEFORE UPDATE OR DELETE ON public.financial_event_revisions
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE TRIGGER financial_observation_revisions_immutable
BEFORE UPDATE OR DELETE ON public.financial_observation_revisions
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE TRIGGER financial_document_revisions_immutable
BEFORE UPDATE OR DELETE ON public.financial_document_revisions
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE TRIGGER financial_event_fact_resolutions_immutable
BEFORE UPDATE OR DELETE ON public.financial_event_fact_resolutions
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE TRIGGER canonical_audit_ledger_immutable
BEFORE UPDATE OR DELETE ON public.canonical_audit_ledger
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

CREATE OR REPLACE FUNCTION public.canonical_require_current_revision_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pointer uuid;
BEGIN
  IF TG_TABLE_NAME = 'financial_events' THEN
    SELECT current_revision_id INTO v_pointer
    FROM public.financial_events WHERE id = NEW.id;
  ELSIF TG_TABLE_NAME = 'financial_observations' THEN
    SELECT current_revision_id INTO v_pointer
    FROM public.financial_observations WHERE id = NEW.id;
  ELSIF TG_TABLE_NAME = 'financial_documents' THEN
    SELECT current_revision_id INTO v_pointer
    FROM public.financial_documents WHERE id = NEW.id;
  ELSE
    RAISE EXCEPTION 'unsupported current revision root %', TG_TABLE_NAME;
  END IF;

  IF v_pointer IS NULL THEN
    RAISE EXCEPTION '% % must have a current revision before commit', TG_TABLE_NAME, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_events_require_current_revision
AFTER INSERT OR UPDATE OF current_revision_id ON public.financial_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.canonical_require_current_revision_v1();

CREATE CONSTRAINT TRIGGER financial_observations_require_current_revision
AFTER INSERT OR UPDATE OF current_revision_id ON public.financial_observations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.canonical_require_current_revision_v1();

CREATE CONSTRAINT TRIGGER financial_documents_require_current_revision
AFTER INSERT OR UPDATE OF current_revision_id ON public.financial_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.canonical_require_current_revision_v1();

-- ---------------------------------------------------------------------------
-- Deferred relationship semantics
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_validate_relationship_v1(p_relationship_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type text;
  v_allows_same_subject boolean;
  v_total integer;
  v_events integer;
  v_observations integer;
  v_documents integer;
  v_distinct_events integer;
  v_distinct_observations integer;
  v_distinct_documents integer;
  v_parents integer;
BEGIN
  SELECT relationship.relationship_type, relationship_type.allows_same_subject
    INTO v_type, v_allows_same_subject
  FROM public.financial_relationships AS relationship
  JOIN public.financial_relationship_types AS relationship_type
    ON relationship_type.code = relationship.relationship_type
  WHERE relationship.id = p_relationship_id;

  IF v_type IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*), count(event_id), count(observation_id), count(document_id),
         count(DISTINCT event_id), count(DISTINCT observation_id),
         count(DISTINCT document_id),
         count(*) FILTER (WHERE endpoint_role = 'parent')
    INTO v_total, v_events, v_observations, v_documents,
         v_distinct_events, v_distinct_observations, v_distinct_documents,
         v_parents
  FROM public.financial_relationship_endpoints
  WHERE relationship_id = p_relationship_id;

  IF NOT v_allows_same_subject AND
     (v_distinct_events <> v_events
      OR v_distinct_observations <> v_observations
      OR v_distinct_documents <> v_documents) THEN
    RAISE EXCEPTION '% forbids the same physical subject in more than one endpoint', v_type
      USING ERRCODE = '23514';
  END IF;

  IF v_type = 'reconciles_with' AND NOT
       (v_total = 2 AND v_observations = 2) THEN
    RAISE EXCEPTION 'reconciles_with requires exactly two observations' USING ERRCODE = '23514';
  ELSIF v_type IN ('settles', 'partially_settles', 'applies_credit', 'records_overpayment') AND NOT
       (v_total >= 2 AND v_events >= 1 AND v_documents >= 1 AND v_observations = 0) THEN
    RAISE EXCEPTION '% requires event and document endpoints', v_type USING ERRCODE = '23514';
  ELSIF v_type = 'batch_contains' AND NOT
       (v_total >= 2 AND v_events = v_total AND v_parents = 1) THEN
    RAISE EXCEPTION 'batch_contains requires one parent and event children' USING ERRCODE = '23514';
  ELSIF v_type = 'split_into' AND NOT
       (v_total >= 2 AND v_documents = 0 AND v_parents = 1
        AND (v_events = v_total OR v_observations = v_total)) THEN
    RAISE EXCEPTION 'split_into requires one parent and homogeneous event or observation children'
      USING ERRCODE = '23514';
  ELSIF v_type IN ('refunds', 'reverses', 'transfers_to') AND NOT
       (v_total = 2 AND v_events = 2) THEN
    RAISE EXCEPTION '% requires exactly two events', v_type USING ERRCODE = '23514';
  ELSIF v_type = 'supersedes' AND NOT
       (v_total = 2 AND v_documents = 0
        AND (v_events = 2 OR v_observations = 2)) THEN
    RAISE EXCEPTION 'supersedes requires two events or two observations' USING ERRCODE = '23514';
  ELSIF v_type = 'derived_from' AND v_total <> 2 THEN
    RAISE EXCEPTION 'derived_from requires exactly two endpoints' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_validate_relationship_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_relationship_id uuid;
  v_seen boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'financial_relationships' THEN
    v_relationship_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_relationship_id := OLD.relationship_id;
  ELSE
    v_relationship_id := NEW.relationship_id;
  END IF;
  -- The first deferred event validates the final relationship state and marks
  -- it for this transaction; redundant root/endpoint events become indexed
  -- lookups. The immediate dirty trigger below removes the mark if a caller
  -- mutates again after SET CONSTRAINTS.
  IF to_regclass('pg_temp.canonical_relationship_validation_seen') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM pg_temp.canonical_relationship_validation_seen WHERE relationship_id = $1)'
      INTO v_seen USING v_relationship_id;
    IF v_seen THEN RETURN NULL; END IF;
  END IF;
  PERFORM public.canonical_validate_relationship_v1(v_relationship_id);
  IF to_regclass('pg_temp.canonical_relationship_validation_seen') IS NULL THEN
    CREATE TEMP TABLE canonical_relationship_validation_seen (
      relationship_id uuid PRIMARY KEY
    ) ON COMMIT DELETE ROWS;
  END IF;
  INSERT INTO pg_temp.canonical_relationship_validation_seen (relationship_id)
  VALUES (v_relationship_id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_mark_relationship_dirty_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_relationship_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'financial_relationships' THEN
    v_relationship_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_relationship_id := OLD.relationship_id;
  ELSE
    v_relationship_id := NEW.relationship_id;
  END IF;
  IF to_regclass('pg_temp.canonical_relationship_validation_seen') IS NOT NULL THEN
    DELETE FROM pg_temp.canonical_relationship_validation_seen
    WHERE relationship_id = v_relationship_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_relationships_mark_dirty
BEFORE INSERT OR UPDATE OF relationship_type ON public.financial_relationships
FOR EACH ROW EXECUTE FUNCTION public.canonical_mark_relationship_dirty_v1();

CREATE TRIGGER financial_relationship_endpoints_mark_dirty
BEFORE INSERT OR UPDATE OR DELETE ON public.financial_relationship_endpoints
FOR EACH ROW EXECUTE FUNCTION public.canonical_mark_relationship_dirty_v1();

CREATE CONSTRAINT TRIGGER financial_relationships_semantic_check
AFTER INSERT OR UPDATE OF relationship_type ON public.financial_relationships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.canonical_validate_relationship_trigger_v1();

-- ---------------------------------------------------------------------------
-- Allocation serialization and capacity checks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_allocation_subject_v1(
  p_endpoint_id uuid,
  p_relationship_id uuid,
  p_client_entity_id uuid
) RETURNS TABLE(subject_kind text, subject_id uuid, amount_minor bigint,
                currency_code text, minor_unit_exponent smallint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_document_id uuid;
BEGIN
  SELECT endpoint.event_id, endpoint.document_id
    INTO v_event_id, v_document_id
  FROM public.financial_relationship_endpoints AS endpoint
  WHERE endpoint.id = p_endpoint_id
    AND endpoint.relationship_id = p_relationship_id
    AND endpoint.client_entity_id = p_client_entity_id;

  IF v_event_id IS NOT NULL THEN
    RETURN QUERY
    SELECT 'event'::text, event_root.id, revision.amount_minor,
           revision.currency_code, revision.minor_unit_exponent
    FROM public.financial_events AS event_root
    JOIN public.financial_event_revisions AS revision
      ON revision.id = event_root.current_revision_id
     AND revision.event_id = event_root.id
     AND revision.client_entity_id = event_root.client_entity_id
    WHERE event_root.id = v_event_id
      AND event_root.client_entity_id = p_client_entity_id;
  ELSIF v_document_id IS NOT NULL THEN
    RETURN QUERY
    SELECT 'document'::text, document_root.id, revision.amount_minor,
           revision.currency_code, revision.minor_unit_exponent
    FROM public.financial_documents AS document_root
    JOIN public.financial_document_revisions AS revision
      ON revision.id = document_root.current_revision_id
     AND revision.document_id = document_root.id
     AND revision.client_entity_id = document_root.client_entity_id
    WHERE document_root.id = v_document_id
      AND document_root.client_entity_id = p_client_entity_id;
  ELSE
    RAISE EXCEPTION 'allocation endpoints must resolve to an event or document'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_guard_allocation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_relationship_status text;
  v_supports boolean;
  v_allow_source boolean;
  v_allow_target boolean;
  v_from_kind text;
  v_from_id uuid;
  v_from_capacity bigint;
  v_from_currency text;
  v_from_exponent smallint;
  v_to_kind text;
  v_to_id uuid;
  v_to_capacity bigint;
  v_to_currency text;
  v_to_exponent smallint;
  v_allocated bigint;
  v_lock_kind text;
  v_lock_id uuid;
BEGIN
  IF NEW.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;

  SELECT relationship.status, relationship_type.supports_allocations,
         relationship_type.allow_source_overallocation,
         relationship_type.allow_target_overallocation
    INTO v_relationship_status, v_supports, v_allow_source, v_allow_target
  FROM public.financial_relationships AS relationship
  JOIN public.financial_relationship_types AS relationship_type
    ON relationship_type.code = relationship.relationship_type
  WHERE relationship.id = NEW.relationship_id
    AND relationship.client_entity_id = NEW.client_entity_id;

  IF v_relationship_status <> 'confirmed' OR NOT COALESCE(v_supports, false) THEN
    RAISE EXCEPTION 'confirmed allocation requires a confirmed allocation-capable relationship'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve only stable subject identifiers before locking. Reading revision
  -- capacity here was wasted work and could be stale by the time a concurrent
  -- waiter acquired the subject lock.
  SELECT CASE WHEN endpoint.event_id IS NOT NULL THEN 'event'
              WHEN endpoint.document_id IS NOT NULL THEN 'document' END,
         COALESCE(endpoint.event_id, endpoint.document_id)
    INTO v_from_kind, v_from_id
  FROM public.financial_relationship_endpoints AS endpoint
  WHERE endpoint.id = NEW.from_endpoint_id
    AND endpoint.relationship_id = NEW.relationship_id
    AND endpoint.client_entity_id = NEW.client_entity_id;
  SELECT CASE WHEN endpoint.event_id IS NOT NULL THEN 'event'
              WHEN endpoint.document_id IS NOT NULL THEN 'document' END,
         COALESCE(endpoint.event_id, endpoint.document_id)
    INTO v_to_kind, v_to_id
  FROM public.financial_relationship_endpoints AS endpoint
  WHERE endpoint.id = NEW.to_endpoint_id
    AND endpoint.relationship_id = NEW.relationship_id
    AND endpoint.client_entity_id = NEW.client_entity_id;
  IF v_from_kind IS NULL OR v_to_kind IS NULL THEN
    RAISE EXCEPTION 'allocation endpoints must resolve to an event or document'
      USING ERRCODE = '23514';
  END IF;

  -- Lock the actual economic subjects, not endpoint rows. Deterministic UUID /
  -- kind order prevents inversion while PostgreSQL row locks avoid exhausting
  -- max_locks_per_transaction during reviewed bulk confirmation.
  FOR v_lock_kind, v_lock_id IN
    SELECT subject.kind, subject.id
    FROM (VALUES (v_from_kind, v_from_id), (v_to_kind, v_to_id)) AS subject(kind,id)
    GROUP BY subject.kind, subject.id
    ORDER BY subject.id, subject.kind
  LOOP
    IF v_lock_kind = 'event' THEN
      PERFORM 1 FROM public.financial_events
      WHERE id = v_lock_id AND client_entity_id = NEW.client_entity_id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.financial_documents
      WHERE id = v_lock_id AND client_entity_id = NEW.client_entity_id FOR UPDATE;
    END IF;
  END LOOP;

  -- A waiter must refresh capacities after acquiring the subject locks; the
  -- earlier lookup may have used a snapshot taken before another transaction
  -- committed a revision.
  SELECT * INTO v_from_kind, v_from_id, v_from_capacity, v_from_currency, v_from_exponent
  FROM public.canonical_allocation_subject_v1(
    NEW.from_endpoint_id, NEW.relationship_id, NEW.client_entity_id
  );
  SELECT * INTO v_to_kind, v_to_id, v_to_capacity, v_to_currency, v_to_exponent
  FROM public.canonical_allocation_subject_v1(
    NEW.to_endpoint_id, NEW.relationship_id, NEW.client_entity_id
  );

  IF v_from_capacity IS NULL OR v_to_capacity IS NULL THEN
    RAISE EXCEPTION 'confirmed allocation requires known source and target capacities'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.source_currency_code, NEW.source_minor_unit_exponent)
       IS DISTINCT FROM (v_from_currency, v_from_exponent) THEN
    RAISE EXCEPTION 'allocation source money does not match source subject currency/exponent'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.target_currency_code, NEW.target_minor_unit_exponent)
       IS DISTINCT FROM (v_to_currency, v_to_exponent) THEN
    RAISE EXCEPTION 'allocation target money does not match target subject currency/exponent'
      USING ERRCODE = '23514';
  END IF;

  IF NOT v_allow_source THEN
    IF v_from_kind = 'event' THEN
      SELECT COALESCE(sum((
        SELECT COALESCE(sum(allocation.source_amount_minor), 0)
        FROM public.financial_allocations AS allocation
        WHERE allocation.from_endpoint_id = endpoint.id
          AND allocation.client_entity_id = NEW.client_entity_id
          AND allocation.status = 'confirmed'
          AND allocation.id IS DISTINCT FROM NEW.id
      )), 0) INTO v_allocated
      FROM public.financial_relationship_endpoints AS endpoint
      WHERE endpoint.event_id = v_from_id
        AND endpoint.client_entity_id = NEW.client_entity_id;
    ELSE
      SELECT COALESCE(sum((
        SELECT COALESCE(sum(allocation.source_amount_minor), 0)
        FROM public.financial_allocations AS allocation
        WHERE allocation.from_endpoint_id = endpoint.id
          AND allocation.client_entity_id = NEW.client_entity_id
          AND allocation.status = 'confirmed'
          AND allocation.id IS DISTINCT FROM NEW.id
      )), 0) INTO v_allocated
      FROM public.financial_relationship_endpoints AS endpoint
      WHERE endpoint.document_id = v_from_id
        AND endpoint.client_entity_id = NEW.client_entity_id;
    END IF;
    IF v_allocated + NEW.source_amount_minor > v_from_capacity THEN
      RAISE EXCEPTION 'source allocation would exceed available amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT v_allow_target THEN
    IF v_to_kind = 'event' THEN
      SELECT COALESCE(sum((
        SELECT COALESCE(sum(allocation.target_amount_minor), 0)
        FROM public.financial_allocations AS allocation
        WHERE allocation.to_endpoint_id = endpoint.id
          AND allocation.client_entity_id = NEW.client_entity_id
          AND allocation.status = 'confirmed'
          AND allocation.id IS DISTINCT FROM NEW.id
      )), 0) INTO v_allocated
      FROM public.financial_relationship_endpoints AS endpoint
      WHERE endpoint.event_id = v_to_id
        AND endpoint.client_entity_id = NEW.client_entity_id;
    ELSE
      SELECT COALESCE(sum((
        SELECT COALESCE(sum(allocation.target_amount_minor), 0)
        FROM public.financial_allocations AS allocation
        WHERE allocation.to_endpoint_id = endpoint.id
          AND allocation.client_entity_id = NEW.client_entity_id
          AND allocation.status = 'confirmed'
          AND allocation.id IS DISTINCT FROM NEW.id
      )), 0) INTO v_allocated
      FROM public.financial_relationship_endpoints AS endpoint
      WHERE endpoint.document_id = v_to_id
        AND endpoint.client_entity_id = NEW.client_entity_id;
    END IF;
    IF v_allocated + NEW.target_amount_minor > v_to_capacity THEN
      RAISE EXCEPTION 'target allocation would exceed available amount'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_allocations_capacity_guard
BEFORE INSERT OR UPDATE OF status, source_amount_minor, target_amount_minor,
  source_currency_code, target_currency_code, source_minor_unit_exponent,
  target_minor_unit_exponent, from_endpoint_id, to_endpoint_id
ON public.financial_allocations
FOR EACH ROW EXECUTE FUNCTION public.canonical_guard_allocation_v1();

CREATE TRIGGER financial_allocations_no_delete
BEFORE DELETE ON public.financial_allocations
FOR EACH ROW EXECUTE FUNCTION public.canonical_reject_update_delete_v1();

-- ---------------------------------------------------------------------------
-- Alias root resolution, cycle prevention, and serialized graph changes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_canonical_event_root_v1(
  p_client_entity_id uuid,
  p_event_id uuid
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current uuid := p_event_id;
  v_next uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_events
    WHERE id = p_event_id AND client_entity_id = p_client_entity_id
  ) THEN
    RAISE EXCEPTION 'event does not belong to client' USING ERRCODE = '23503';
  END IF;

  LOOP
    IF v_current = ANY(v_seen) THEN
      RAISE EXCEPTION 'canonical alias cycle detected' USING ERRCODE = '23514';
    END IF;
    v_seen := array_append(v_seen, v_current);

    SELECT survivor_event_id INTO v_next
    FROM public.financial_event_aliases
    WHERE client_entity_id = p_client_entity_id
      AND alias_event_id = v_current
      AND valid_to IS NULL;

    IF v_next IS NULL THEN
      RETURN v_current;
    END IF;
    v_current := v_next;
  END LOOP;
  RETURN v_current;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_guard_alias_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_root uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('canonical-merge:' || NEW.client_entity_id::text, 10)
  );
  IF NEW.alias_event_id = NEW.survivor_event_id THEN
    RAISE EXCEPTION 'an event cannot alias itself' USING ERRCODE = '23514';
  END IF;
  v_root := public.resolve_canonical_event_root_v1(
    NEW.client_entity_id, NEW.survivor_event_id
  );
  IF v_root <> NEW.survivor_event_id THEN
    RAISE EXCEPTION 'alias survivor must be a current root' USING ERRCODE = '23514';
  END IF;
  IF public.resolve_canonical_event_root_v1(NEW.client_entity_id, NEW.survivor_event_id)
       = NEW.alias_event_id THEN
    RAISE EXCEPTION 'alias would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_event_aliases_cycle_guard
BEFORE INSERT OR UPDATE OF alias_event_id, survivor_event_id, valid_to
ON public.financial_event_aliases
FOR EACH ROW WHEN (NEW.valid_to IS NULL)
EXECUTE FUNCTION public.canonical_guard_alias_v1();

-- ---------------------------------------------------------------------------
-- Mutation context and audit helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_jsonb_sha256_v1(p_value jsonb)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT extensions.digest(convert_to(COALESCE(p_value, 'null'::jsonb)::text, 'UTF8'), 'sha256');
$$;

CREATE OR REPLACE FUNCTION public.canonical_assert_mutation_context_v1(
  p_client_entity_id uuid,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_authorized boolean := false;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'canonical mutations require service_role' USING ERRCODE = '42501';
  END IF;
  IF NOT ((p_actor_kind = 'user' AND p_actor_user_id IS NOT NULL AND p_actor_service IS NULL)
     OR (p_actor_kind IN ('service', 'system', 'migration')
         AND p_actor_user_id IS NULL AND NULLIF(btrim(p_actor_service), '') IS NOT NULL)) THEN
    RAISE EXCEPTION 'explicit actor identity is required' USING ERRCODE = '22023';
  END IF;

  SELECT practice_id INTO v_practice_id
  FROM public.client_entities
  WHERE id = p_client_entity_id;
  IF v_practice_id IS NULL THEN
    RAISE EXCEPTION 'unknown client entity' USING ERRCODE = '23503';
  END IF;

  IF p_actor_kind = 'user' THEN
    -- Owner/admin authorization is practice-wide. Every other frozen role must
    -- have an active grant for this exact client. Suspended/revoked membership
    -- or access rows never satisfy the predicate.
    SELECT EXISTS (
      SELECT 1
      FROM public.practice_memberships AS membership
      WHERE membership.practice_id = v_practice_id
        AND membership.user_id = p_actor_user_id
        AND membership.status = 'active'
        AND (
          membership.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1
            FROM public.client_access AS access_grant
            WHERE access_grant.client_entity_id = p_client_entity_id
              AND access_grant.practice_id = v_practice_id
              AND access_grant.membership_id = membership.id
              AND access_grant.user_id = p_actor_user_id
              AND access_grant.status = 'active'
          )
        )
    ) INTO v_authorized;
    IF NOT v_authorized THEN
      RAISE EXCEPTION 'user actor is not authorized for client entity'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Service identities are a closed versioned contract. A new worker name
    -- requires a reviewed migration change; arbitrary caller-supplied labels
    -- cannot enter the immutable audit ledger.
    v_authorized := CASE p_actor_kind
      WHEN 'service' THEN p_actor_service = ANY (ARRAY[
        'canonical-api', 'canonical-ingestion', 'canonical-reconciliation',
        'canonical-import', 'canonical-test'
      ])
      WHEN 'system' THEN p_actor_service = ANY (ARRAY[
        'canonical-reconciliation', 'canonical-import', 'canonical-test'
      ])
      WHEN 'migration' THEN p_actor_service = ANY (ARRAY[
        'canonical-backfill', 'canonical-migration', 'canonical-test'
      ])
      ELSE false
    END;
    IF NOT v_authorized THEN
      RAISE EXCEPTION 'service actor is not allowlisted for actor kind %', p_actor_kind
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN v_practice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_write_audit_v1(
  p_practice_id uuid,
  p_client_entity_id uuid,
  p_operation_id uuid,
  p_operation_sequence integer,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text,
  p_action text,
  p_entity_kind text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_metadata_redacted jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.canonical_audit_ledger (
    id, practice_id, client_entity_id, operation_id, operation_sequence,
    actor_kind, actor_user_id, actor_service, request_id, action,
    entity_kind, entity_id, before_hash, after_hash, hash_version,
    metadata_redacted
  ) VALUES (
    v_id, p_practice_id, p_client_entity_id, p_operation_id, p_operation_sequence,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id, p_action,
    p_entity_kind, p_entity_id,
    CASE WHEN p_before IS NULL THEN NULL ELSE public.canonical_jsonb_sha256_v1(p_before) END,
    CASE WHEN p_after IS NULL THEN NULL ELSE public.canonical_jsonb_sha256_v1(p_after) END,
    1, COALESCE(p_metadata_redacted, '{}'::jsonb)
  );
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Event root and revision RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_financial_event_v1(
  p_client_entity_id uuid,
  p_created_by_kind text,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_event_id uuid := gen_random_uuid();
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  IF jsonb_typeof(p_revision) <> 'object' THEN
    RAISE EXCEPTION 'p_revision must be an object' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.financial_events
    (id, client_entity_id, created_by_kind)
  VALUES (v_event_id, p_client_entity_id, p_created_by_kind);

  INSERT INTO public.financial_event_revisions (
    id, client_entity_id, event_id, revision_number, event_kind,
    lifecycle_status, resolution_status, occurred_on, occurred_at,
    amount_minor, currency_code, minor_unit_exponent, direction,
    display_label, change_reason, provenance, created_by_kind,
    created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, v_event_id, 1,
    p_revision->>'event_kind',
    COALESCE(NULLIF(p_revision->>'lifecycle_status', ''), 'active'),
    COALESCE(NULLIF(p_revision->>'resolution_status', ''), 'incomplete'),
    NULLIF(p_revision->>'occurred_on', '')::date,
    NULLIF(p_revision->>'occurred_at', '')::timestamptz,
    NULLIF(p_revision->>'amount_minor', '')::bigint,
    NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    NULLIF(p_revision->>'direction', ''),
    NULLIF(p_revision->>'display_label', ''),
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'initial event revision'),
    COALESCE(p_revision->'provenance', '{}'::jsonb),
    p_actor_kind, p_actor_user_id, p_actor_service
  );

  UPDATE public.financial_events
  SET current_revision_id = v_revision_id
  WHERE id = v_event_id;

  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_event', v_event_id, NULL,
    jsonb_build_object('id', v_event_id, 'revision_id', v_revision_id),
    '{}'::jsonb
  );
  RETURN jsonb_build_object(
    'event_id', v_event_id, 'revision_id', v_revision_id, 'operation_id', v_operation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_financial_event_revision_v1(
  p_client_entity_id uuid,
  p_event_id uuid,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_previous_id uuid;
  v_previous_number integer;
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
  v_resolution_status text;
  v_amount bigint;
  v_allocated bigint;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );

  SELECT root.current_revision_id INTO v_previous_id
  FROM public.financial_events AS root
  WHERE root.id = p_event_id AND root.client_entity_id = p_client_entity_id
  FOR UPDATE OF root;
  IF v_previous_id IS NULL THEN
    RAISE EXCEPTION 'event does not belong to client' USING ERRCODE = '23503';
  END IF;
  SELECT revision_number INTO STRICT v_previous_number
  FROM public.financial_event_revisions
  WHERE id = v_previous_id AND event_id = p_event_id
    AND client_entity_id = p_client_entity_id;

  v_amount := NULLIF(p_revision->>'amount_minor', '')::bigint;
  v_resolution_status := COALESCE(NULLIF(p_revision->>'resolution_status', ''), 'incomplete');

  SELECT GREATEST(
    COALESCE(sum(a.source_amount_minor) FILTER (WHERE from_ep.event_id = p_event_id), 0),
    COALESCE(sum(a.target_amount_minor) FILTER (WHERE to_ep.event_id = p_event_id), 0)
  ) INTO v_allocated
  FROM public.financial_allocations AS a
  JOIN public.financial_relationship_endpoints AS from_ep ON from_ep.id = a.from_endpoint_id
  JOIN public.financial_relationship_endpoints AS to_ep ON to_ep.id = a.to_endpoint_id
  WHERE a.client_entity_id = p_client_entity_id AND a.status = 'confirmed'
    AND (from_ep.event_id = p_event_id OR to_ep.event_id = p_event_id);
  IF v_amount IS NOT NULL AND COALESCE(v_allocated, 0) > v_amount THEN
    v_resolution_status := 'conflicted';
  END IF;

  INSERT INTO public.financial_event_revisions (
    id, client_entity_id, event_id, revision_number, previous_revision_id,
    event_kind, lifecycle_status, resolution_status, occurred_on, occurred_at,
    amount_minor, currency_code, minor_unit_exponent, direction, display_label,
    change_reason, provenance, created_by_kind, created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, p_event_id, v_previous_number + 1, v_previous_id,
    p_revision->>'event_kind',
    COALESCE(NULLIF(p_revision->>'lifecycle_status', ''), 'active'),
    v_resolution_status,
    NULLIF(p_revision->>'occurred_on', '')::date,
    NULLIF(p_revision->>'occurred_at', '')::timestamptz,
    v_amount, NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    NULLIF(p_revision->>'direction', ''), NULLIF(p_revision->>'display_label', ''),
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'event revision'),
    COALESCE(p_revision->'provenance', '{}'::jsonb),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  UPDATE public.financial_events SET current_revision_id = v_revision_id
  WHERE id = p_event_id AND client_entity_id = p_client_entity_id;

  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'append_revision', 'financial_event', p_event_id,
    jsonb_build_object('revision_id', v_previous_id),
    jsonb_build_object('revision_id', v_revision_id, 'resolution_status', v_resolution_status),
    jsonb_build_object('outcome', v_resolution_status)
  );
  RETURN jsonb_build_object(
    'event_id', p_event_id, 'revision_id', v_revision_id,
    'revision_number', v_previous_number + 1, 'operation_id', v_operation_id,
    'resolution_status', v_resolution_status
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Observation root and revision RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_financial_observation_v1(
  p_client_entity_id uuid,
  p_root jsonb,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_observation_id uuid := gen_random_uuid();
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  INSERT INTO public.financial_observations (
    id, client_entity_id, observation_kind, ledger_book_id,
    financial_account_id, provider_connection_id
  ) VALUES (
    v_observation_id, p_client_entity_id, p_root->>'observation_kind',
    NULLIF(p_root->>'ledger_book_id', '')::uuid,
    NULLIF(p_root->>'financial_account_id', '')::uuid,
    NULLIF(p_root->>'provider_connection_id', '')::uuid
  );

  INSERT INTO public.financial_observation_revisions (
    id, client_entity_id, observation_id, revision_number, source_status,
    amount_minor, currency_code, minor_unit_exponent, direction,
    raw_amount_text, raw_currency_text, source_transaction_on, source_transaction_at,
    authorization_on, authorization_at, posted_on, posted_at, value_date,
    accounting_date, source_timezone, description, counterparty, reference_text,
    raw_payload_hash, provider_updated_at, observed_at, change_reason,
    created_by_kind, created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, v_observation_id, 1,
    COALESCE(NULLIF(p_revision->>'source_status', ''), 'unknown'),
    NULLIF(p_revision->>'amount_minor', '')::bigint,
    NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    NULLIF(p_revision->>'direction', ''),
    p_revision->>'raw_amount_text', p_revision->>'raw_currency_text',
    NULLIF(p_revision->>'source_transaction_on', '')::date,
    NULLIF(p_revision->>'source_transaction_at', '')::timestamptz,
    NULLIF(p_revision->>'authorization_on', '')::date,
    NULLIF(p_revision->>'authorization_at', '')::timestamptz,
    NULLIF(p_revision->>'posted_on', '')::date,
    NULLIF(p_revision->>'posted_at', '')::timestamptz,
    NULLIF(p_revision->>'value_date', '')::date,
    NULLIF(p_revision->>'accounting_date', '')::date,
    NULLIF(p_revision->>'source_timezone', ''), p_revision->>'description',
    p_revision->>'counterparty', p_revision->>'reference_text',
    CASE WHEN NULLIF(p_revision->>'raw_payload_hash_hex', '') IS NULL THEN NULL
         ELSE decode(p_revision->>'raw_payload_hash_hex', 'hex') END,
    NULLIF(p_revision->>'provider_updated_at', '')::timestamptz,
    COALESCE(NULLIF(p_revision->>'observed_at', '')::timestamptz, now()),
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'initial observation revision'),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  UPDATE public.financial_observations SET current_revision_id = v_revision_id
  WHERE id = v_observation_id;

  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_observation', v_observation_id, NULL,
    jsonb_build_object('id', v_observation_id, 'revision_id', v_revision_id), '{}'::jsonb
  );
  RETURN jsonb_build_object(
    'observation_id', v_observation_id, 'revision_id', v_revision_id,
    'operation_id', v_operation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_financial_observation_revision_v1(
  p_client_entity_id uuid,
  p_observation_id uuid,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_previous_id uuid;
  v_previous_number integer;
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  SELECT root.current_revision_id INTO v_previous_id
  FROM public.financial_observations AS root
  WHERE root.id = p_observation_id AND root.client_entity_id = p_client_entity_id
  FOR UPDATE OF root;
  IF v_previous_id IS NULL THEN
    RAISE EXCEPTION 'observation does not belong to client' USING ERRCODE = '23503';
  END IF;
  SELECT revision_number INTO STRICT v_previous_number
  FROM public.financial_observation_revisions
  WHERE id = v_previous_id AND observation_id = p_observation_id
    AND client_entity_id = p_client_entity_id;

  INSERT INTO public.financial_observation_revisions (
    id, client_entity_id, observation_id, revision_number, previous_revision_id,
    source_status, amount_minor, currency_code, minor_unit_exponent, direction,
    raw_amount_text, raw_currency_text, source_transaction_on, source_transaction_at,
    authorization_on, authorization_at, posted_on, posted_at, value_date,
    accounting_date, source_timezone, description, counterparty, reference_text,
    raw_payload_hash, provider_updated_at, observed_at, change_reason,
    created_by_kind, created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, p_observation_id, v_previous_number + 1, v_previous_id,
    COALESCE(NULLIF(p_revision->>'source_status', ''), 'unknown'),
    NULLIF(p_revision->>'amount_minor', '')::bigint,
    NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    NULLIF(p_revision->>'direction', ''), p_revision->>'raw_amount_text',
    p_revision->>'raw_currency_text', NULLIF(p_revision->>'source_transaction_on', '')::date,
    NULLIF(p_revision->>'source_transaction_at', '')::timestamptz,
    NULLIF(p_revision->>'authorization_on', '')::date,
    NULLIF(p_revision->>'authorization_at', '')::timestamptz,
    NULLIF(p_revision->>'posted_on', '')::date,
    NULLIF(p_revision->>'posted_at', '')::timestamptz,
    NULLIF(p_revision->>'value_date', '')::date,
    NULLIF(p_revision->>'accounting_date', '')::date,
    NULLIF(p_revision->>'source_timezone', ''), p_revision->>'description',
    p_revision->>'counterparty', p_revision->>'reference_text',
    CASE WHEN NULLIF(p_revision->>'raw_payload_hash_hex', '') IS NULL THEN NULL
         ELSE decode(p_revision->>'raw_payload_hash_hex', 'hex') END,
    NULLIF(p_revision->>'provider_updated_at', '')::timestamptz,
    COALESCE(NULLIF(p_revision->>'observed_at', '')::timestamptz, now()),
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'observation revision'),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  UPDATE public.financial_observations SET current_revision_id = v_revision_id
  WHERE id = p_observation_id AND client_entity_id = p_client_entity_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'append_revision', 'financial_observation', p_observation_id,
    jsonb_build_object('revision_id', v_previous_id),
    jsonb_build_object('revision_id', v_revision_id), '{}'::jsonb
  );
  RETURN jsonb_build_object(
    'observation_id', p_observation_id, 'revision_id', v_revision_id,
    'revision_number', v_previous_number + 1, 'operation_id', v_operation_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Document root and revision RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_financial_document_v1(
  p_client_entity_id uuid,
  p_document_kind text,
  p_source_artifact_id uuid,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_document_id uuid := gen_random_uuid();
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  INSERT INTO public.financial_documents
    (id, client_entity_id, source_artifact_id, document_kind)
  VALUES (v_document_id, p_client_entity_id, p_source_artifact_id, p_document_kind);
  INSERT INTO public.financial_document_revisions (
    id, client_entity_id, document_id, revision_number, obligation_status,
    resolution_status, issuer_name, document_number, document_date, due_date,
    amount_minor, currency_code, minor_unit_exponent, raw_amount_text,
    raw_currency_text, change_reason, provenance, created_by_kind,
    created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, v_document_id, 1,
    COALESCE(NULLIF(p_revision->>'obligation_status', ''), 'not_applicable'),
    COALESCE(NULLIF(p_revision->>'resolution_status', ''), 'incomplete'),
    p_revision->>'issuer_name', p_revision->>'document_number',
    NULLIF(p_revision->>'document_date', '')::date, NULLIF(p_revision->>'due_date', '')::date,
    NULLIF(p_revision->>'amount_minor', '')::bigint, NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    p_revision->>'raw_amount_text', p_revision->>'raw_currency_text',
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'initial document revision'),
    COALESCE(p_revision->'provenance', '{}'::jsonb),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  UPDATE public.financial_documents SET current_revision_id = v_revision_id
  WHERE id = v_document_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_document', v_document_id, NULL,
    jsonb_build_object('id', v_document_id, 'revision_id', v_revision_id), '{}'::jsonb
  );
  RETURN jsonb_build_object(
    'document_id', v_document_id, 'revision_id', v_revision_id,
    'operation_id', v_operation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_financial_document_revision_v1(
  p_client_entity_id uuid,
  p_document_id uuid,
  p_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_previous_id uuid;
  v_previous_number integer;
  v_revision_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
  v_resolution_status text;
  v_amount bigint;
  v_allocated bigint;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  SELECT root.current_revision_id INTO v_previous_id
  FROM public.financial_documents AS root
  WHERE root.id = p_document_id AND root.client_entity_id = p_client_entity_id
  FOR UPDATE OF root;
  IF v_previous_id IS NULL THEN
    RAISE EXCEPTION 'document does not belong to client' USING ERRCODE = '23503';
  END IF;
  SELECT revision_number INTO STRICT v_previous_number
  FROM public.financial_document_revisions
  WHERE id = v_previous_id AND document_id = p_document_id
    AND client_entity_id = p_client_entity_id;
  v_amount := NULLIF(p_revision->>'amount_minor', '')::bigint;
  v_resolution_status := COALESCE(NULLIF(p_revision->>'resolution_status', ''), 'incomplete');
  SELECT COALESCE(sum(a.target_amount_minor), 0) INTO v_allocated
  FROM public.financial_allocations a
  JOIN public.financial_relationship_endpoints ep ON ep.id = a.to_endpoint_id
  WHERE a.client_entity_id = p_client_entity_id AND a.status = 'confirmed'
    AND ep.document_id = p_document_id;
  IF v_amount IS NOT NULL AND v_allocated > v_amount THEN
    v_resolution_status := 'conflicted';
  END IF;

  INSERT INTO public.financial_document_revisions (
    id, client_entity_id, document_id, revision_number, previous_revision_id,
    obligation_status, resolution_status, issuer_name, document_number,
    document_date, due_date, amount_minor, currency_code, minor_unit_exponent,
    raw_amount_text, raw_currency_text, change_reason, provenance,
    created_by_kind, created_by_user_id, created_by_service
  ) VALUES (
    v_revision_id, p_client_entity_id, p_document_id, v_previous_number + 1, v_previous_id,
    COALESCE(NULLIF(p_revision->>'obligation_status', ''), 'not_applicable'),
    v_resolution_status, p_revision->>'issuer_name', p_revision->>'document_number',
    NULLIF(p_revision->>'document_date', '')::date, NULLIF(p_revision->>'due_date', '')::date,
    v_amount, NULLIF(p_revision->>'currency_code', ''),
    NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
    p_revision->>'raw_amount_text', p_revision->>'raw_currency_text',
    COALESCE(NULLIF(p_revision->>'change_reason', ''), 'document revision'),
    COALESCE(p_revision->'provenance', '{}'::jsonb),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  UPDATE public.financial_documents SET current_revision_id = v_revision_id
  WHERE id = p_document_id AND client_entity_id = p_client_entity_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'append_revision', 'financial_document', p_document_id,
    jsonb_build_object('revision_id', v_previous_id),
    jsonb_build_object('revision_id', v_revision_id, 'resolution_status', v_resolution_status),
    jsonb_build_object('outcome', v_resolution_status)
  );
  RETURN jsonb_build_object(
    'document_id', p_document_id, 'revision_id', v_revision_id,
    'revision_number', v_previous_number + 1, 'operation_id', v_operation_id,
    'resolution_status', v_resolution_status
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Import, occurrence, attachment, identity, and relationship RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ingest_import_artifact_v1(
  p_client_entity_id uuid,
  p_artifact_kind text,
  p_content_sha256_hex text,
  p_content_length bigint,
  p_metadata jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_artifact_id uuid := gen_random_uuid();
  v_existing_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_hash bytea := decode(p_content_sha256_hex, 'hex');
  v_reused boolean := false;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  INSERT INTO public.import_artifacts (
    id, client_entity_id, artifact_kind, content_sha256, content_length, metadata
  ) VALUES (
    v_artifact_id, p_client_entity_id, p_artifact_kind, v_hash,
    p_content_length, COALESCE(p_metadata, '{}'::jsonb)
  ) ON CONFLICT (client_entity_id, content_sha256, content_length) DO NOTHING
  RETURNING id INTO v_existing_id;
  IF v_existing_id IS NULL THEN
    SELECT id INTO v_existing_id FROM public.import_artifacts
    WHERE client_entity_id = p_client_entity_id
      AND content_sha256 = v_hash AND content_length = p_content_length;
    v_reused := true;
  END IF;
  v_artifact_id := v_existing_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    CASE WHEN v_reused THEN 'reuse' ELSE 'create' END,
    'import_artifact', v_artifact_id, NULL,
    jsonb_build_object('id', v_artifact_id, 'content_sha256', p_content_sha256_hex),
    jsonb_build_object('outcome', CASE WHEN v_reused THEN 'reused' ELSE 'inserted' END)
  );
  RETURN jsonb_build_object('artifact_id', v_artifact_id, 'reused', v_reused,
                            'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.start_import_run_v1(
  p_client_entity_id uuid,
  p_artifact_id uuid,
  p_provider_connection_id uuid,
  p_idempotency_key text,
  p_request_hash_hex text,
  p_parser_name text,
  p_parser_version text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_run_id uuid := gen_random_uuid();
  v_existing_id uuid;
  v_existing_hash bytea;
  v_request_hash bytea := CASE WHEN p_request_hash_hex IS NULL THEN NULL
                               ELSE decode(p_request_hash_hex, 'hex') END;
  v_operation_id uuid := gen_random_uuid();
  v_reused boolean := false;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  IF p_idempotency_key IS NULL OR v_request_hash IS NULL THEN
    RAISE EXCEPTION 'import run requires idempotency key and request hash' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.import_runs (
    id, client_entity_id, artifact_id, provider_connection_id,
    idempotency_key, request_hash, parser_name, parser_version,
    requested_by_kind, requested_by_user_id, requested_by_service
  ) VALUES (
    v_run_id, p_client_entity_id, p_artifact_id, p_provider_connection_id,
    p_idempotency_key, v_request_hash, p_parser_name, p_parser_version,
    p_actor_kind, p_actor_user_id, p_actor_service
  ) ON CONFLICT (client_entity_id, parser_name, idempotency_key)
    WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_existing_id;
  IF v_existing_id IS NULL THEN
    SELECT id, request_hash INTO v_existing_id, v_existing_hash
    FROM public.import_runs
    WHERE client_entity_id = p_client_entity_id
      AND parser_name = p_parser_name AND idempotency_key = p_idempotency_key;
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency key was reused with a different request hash'
        USING ERRCODE = '23505';
    END IF;
    v_reused := true;
  END IF;
  v_run_id := v_existing_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    CASE WHEN v_reused THEN 'reuse' ELSE 'create' END,
    'import_run', v_run_id, NULL,
    jsonb_build_object('id', v_run_id, 'idempotency_key', p_idempotency_key),
    jsonb_build_object('parser_version', p_parser_version,
                       'outcome', CASE WHEN v_reused THEN 'reused' ELSE 'inserted' END)
  );
  RETURN jsonb_build_object('run_id', v_run_id, 'reused', v_reused,
                            'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_financial_observation_occurrence_v1(
  p_client_entity_id uuid,
  p_observation_id uuid,
  p_import_run_id uuid,
  p_artifact_id uuid,
  p_occurrence jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_occurrence_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
  v_existing public.financial_observation_occurrences%ROWTYPE;
  v_locator text := NULLIF(p_occurrence->>'source_locator', '');
  v_row_number integer := NULLIF(p_occurrence->>'source_row_number', '')::integer;
  v_reference_hash bytea := CASE
    WHEN NULLIF(p_occurrence->>'source_reference_hash_hex', '') IS NULL THEN NULL
    ELSE decode(p_occurrence->>'source_reference_hash_hex', 'hex') END;
  v_payload_hash bytea := CASE
    WHEN NULLIF(p_occurrence->>'raw_payload_hash_hex', '') IS NULL THEN NULL
    ELSE decode(p_occurrence->>'raw_payload_hash_hex', 'hex') END;
  v_observed_at timestamptz := NULLIF(p_occurrence->>'observed_at', '')::timestamptz;
  v_reused boolean := false;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  INSERT INTO public.financial_observation_occurrences (
    id, client_entity_id, observation_id, import_run_id, artifact_id,
    source_locator, source_row_number, source_reference_hash, raw_payload_hash, observed_at
  ) VALUES (
    v_occurrence_id, p_client_entity_id, p_observation_id, p_import_run_id, p_artifact_id,
    v_locator, v_row_number, v_reference_hash, v_payload_hash,
    COALESCE(v_observed_at, now())
  ) ON CONFLICT DO NOTHING
  RETURNING * INTO v_existing;
  IF v_existing.id IS NULL THEN
    -- A locator and row may each collide with an existing record. They must
    -- identify the same row; otherwise the replay identity itself is
    -- contradictory and cannot be silently reused.
    SELECT occurrence.* INTO v_existing
    FROM public.financial_observation_occurrences AS occurrence
    WHERE occurrence.import_run_id = p_import_run_id
      AND ((v_locator IS NOT NULL AND occurrence.source_locator = v_locator)
        OR (v_row_number IS NOT NULL AND occurrence.source_row_number = v_row_number))
    ORDER BY occurrence.id
    LIMIT 1
    FOR UPDATE;
    IF v_existing.id IS NULL
       OR v_existing.client_entity_id <> p_client_entity_id
       OR v_existing.observation_id <> p_observation_id
       OR v_existing.artifact_id IS DISTINCT FROM p_artifact_id
       OR v_existing.source_locator IS DISTINCT FROM v_locator
       OR v_existing.source_row_number IS DISTINCT FROM v_row_number
       OR v_existing.source_reference_hash IS DISTINCT FROM v_reference_hash
       OR v_existing.raw_payload_hash IS DISTINCT FROM v_payload_hash
       OR (v_observed_at IS NOT NULL
           AND v_existing.observed_at IS DISTINCT FROM v_observed_at)
       OR EXISTS (
         SELECT 1 FROM public.financial_observation_occurrences AS other
         WHERE other.import_run_id = p_import_run_id
           AND other.id <> v_existing.id
           AND ((v_locator IS NOT NULL AND other.source_locator = v_locator)
             OR (v_row_number IS NOT NULL AND other.source_row_number = v_row_number))
       ) THEN
      RAISE EXCEPTION 'observation occurrence idempotency conflict'
        USING ERRCODE = '23505';
    END IF;
    v_occurrence_id := v_existing.id;
    v_reused := true;
  END IF;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    CASE WHEN v_reused THEN 'reuse' ELSE 'create' END,
    'financial_observation_occurrence', v_occurrence_id, NULL,
    jsonb_build_object('id', v_occurrence_id, 'observation_id', p_observation_id),
    jsonb_build_object('outcome', CASE WHEN v_reused THEN 'reused' ELSE 'inserted' END)
  );
  RETURN jsonb_build_object('occurrence_id', v_occurrence_id, 'reused', v_reused,
                            'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_financial_observation_v1(
  p_client_entity_id uuid,
  p_event_id uuid,
  p_observation_id uuid,
  p_role text,
  p_attachment_basis text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_link_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  PERFORM 1 FROM public.financial_observations
  WHERE id = p_observation_id AND client_entity_id = p_client_entity_id FOR UPDATE;
  INSERT INTO public.financial_event_observation_links (
    id, client_entity_id, event_id, observation_id, role, attachment_basis,
    attached_by_kind, attached_by_user_id, attached_by_service
  ) VALUES (
    v_link_id, p_client_entity_id, p_event_id, p_observation_id, p_role,
    p_attachment_basis, p_actor_kind, p_actor_user_id, p_actor_service
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'attach', 'financial_event_observation_link', v_link_id, NULL,
    jsonb_build_object('event_id', p_event_id, 'observation_id', p_observation_id), '{}'::jsonb
  );
  RETURN jsonb_build_object('link_id', v_link_id, 'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_financial_identity_claim_v1(
  p_client_entity_id uuid,
  p_observation_id uuid,
  p_claim jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_claim_id uuid := gen_random_uuid();
  v_existing_id uuid;
  v_existing_observation uuid;
  v_supersedes uuid := NULLIF(p_claim->>'supersedes_claim_id', '')::uuid;
  v_operation_id uuid := gen_random_uuid();
  v_namespace text := p_claim->>'namespace_canonical';
  v_key text := p_claim->>'claim_key_canonical';
  v_strength text := p_claim->>'strength';
  v_kind text := p_claim->>'claim_kind';
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  IF v_strength IN ('authoritative', 'strong')
     AND v_kind <> 'manual_adjudication'
     AND v_supersedes IS NULL THEN
    RAISE EXCEPTION 'new provider strong identities require atomic observation ingestion'
      USING ERRCODE = '42501';
  END IF;
  IF v_supersedes IS NOT NULL THEN
    UPDATE public.financial_identity_claims
    SET status = 'superseded', valid_to = now()
    WHERE id = v_supersedes AND client_entity_id = p_client_entity_id
      AND observation_id = p_observation_id AND status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded claim is not an active claim for this observation'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF v_strength IN ('authoritative', 'strong') THEN
    SELECT id, observation_id INTO v_existing_id, v_existing_observation
    FROM public.financial_identity_claims
    WHERE client_entity_id = p_client_entity_id AND claim_kind = v_kind
      AND namespace_canonical = v_namespace AND claim_key_canonical = v_key
      AND status = 'active' AND strength IN ('authoritative', 'strong')
    FOR UPDATE;
    IF v_existing_id IS NOT NULL THEN
      IF v_existing_observation <> p_observation_id THEN
        RAISE EXCEPTION 'active strong identity belongs to another observation'
          USING ERRCODE = '23505';
      END IF;
      RETURN jsonb_build_object('claim_id', v_existing_id, 'reused', true);
    END IF;
  END IF;

  INSERT INTO public.financial_identity_claims (
    id, client_entity_id, observation_id, claim_kind, strength,
    canonicalisation_version, namespace_canonical, claim_key_canonical,
    namespace_hash, claim_key_hash, components, source_artifact_id,
    source_observation_revision_id, supersedes_claim_id, reviewed_by_user_id,
    review_reason
  ) VALUES (
    v_claim_id, p_client_entity_id, p_observation_id, v_kind, v_strength,
    COALESCE(NULLIF(p_claim->>'canonicalisation_version', '')::integer, 1),
    v_namespace, v_key,
    decode(p_claim->>'namespace_hash_hex', 'hex'),
    decode(p_claim->>'claim_key_hash_hex', 'hex'),
    COALESCE(p_claim->'components', '{}'::jsonb),
    NULLIF(p_claim->>'source_artifact_id', '')::uuid,
    NULLIF(p_claim->>'source_observation_revision_id', '')::uuid,
    v_supersedes, p_actor_user_id, p_claim->>'review_reason'
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_identity_claim', v_claim_id, NULL,
    jsonb_build_object('id', v_claim_id, 'observation_id', p_observation_id,
                       'claim_kind', v_kind),
    jsonb_build_object('claim_kind', v_kind)
  );
  RETURN jsonb_build_object('claim_id', v_claim_id, 'reused', false,
                            'operation_id', v_operation_id);
END;
$$;

-- Resolve exact provider identity before creating any roots. This RPC is the
-- only automatic merge path: probabilistic/weak claims must use the separate
-- observation and claim primitives and can never select an existing root.
CREATE OR REPLACE FUNCTION public.ingest_financial_observation_v1(
  p_client_entity_id uuid,
  p_root jsonb,
  p_revision jsonb,
  p_identity_claims jsonb,
  p_event_revision jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_claim jsonb;
  v_claim_normalized jsonb;
  v_claim_id uuid;
  v_claim_count integer := 0;
  v_observation_id uuid;
  v_candidate_observation_id uuid;
  v_event_id uuid;
  v_current_revision_id uuid;
  v_revision_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_result jsonb;
  v_existing_projection jsonb;
  v_incoming_projection jsonb;
  v_revision_appended boolean := false;
  v_reused boolean := false;
  v_provider_connection_id uuid := NULLIF(p_root->>'provider_connection_id', '')::uuid;
  v_financial_account_id uuid := NULLIF(p_root->>'financial_account_id', '')::uuid;
  v_ledger_book_id uuid := NULLIF(p_root->>'ledger_book_id', '')::uuid;
  v_existing_observation_kind text;
  v_existing_provider_connection_id uuid;
  v_existing_financial_account_id uuid;
  v_existing_ledger_book_id uuid;
  v_provider text;
  v_external_organisation_id text;
  v_account_namespace text;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  IF jsonb_typeof(p_root) <> 'object'
     OR jsonb_typeof(p_revision) <> 'object'
     OR jsonb_typeof(p_event_revision) <> 'object'
     OR jsonb_typeof(p_identity_claims) <> 'array'
     OR jsonb_array_length(p_identity_claims) = 0 THEN
    RAISE EXCEPTION 'root/revisions must be objects and identity claims a non-empty array'
      USING ERRCODE = '22023';
  END IF;

  -- Composite ownership FKs remain the final boundary. These early checks
  -- provide a stable error before any identity lock or root creation.
  IF v_provider_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.provider_connections
    WHERE id = v_provider_connection_id AND client_entity_id = p_client_entity_id
  ) THEN
    RAISE EXCEPTION 'provider connection does not belong to client'
      USING ERRCODE = '23503';
  END IF;
  IF v_ledger_book_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ledger_books
    WHERE id = v_ledger_book_id AND client_entity_id = p_client_entity_id
  ) THEN
    RAISE EXCEPTION 'ledger book does not belong to client'
      USING ERRCODE = '23503';
  END IF;
  IF v_financial_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.financial_accounts
    WHERE id = v_financial_account_id AND client_entity_id = p_client_entity_id
  ) THEN
    RAISE EXCEPTION 'financial account does not belong to client'
      USING ERRCODE = '23503';
  END IF;
  IF v_provider_connection_id IS NOT NULL THEN
    SELECT connection.provider, connection.external_organisation_id
      INTO v_provider, v_external_organisation_id
    FROM public.provider_connections AS connection
    WHERE connection.id = v_provider_connection_id
      AND connection.client_entity_id = p_client_entity_id;
    IF v_ledger_book_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.provider_connections AS connection
      WHERE connection.id = v_provider_connection_id
        AND connection.client_entity_id = p_client_entity_id
        AND connection.ledger_book_id IS NOT NULL
        AND connection.ledger_book_id <> v_ledger_book_id
    ) THEN
      RAISE EXCEPTION 'provider connection and ledger book namespaces disagree'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_financial_account_id IS NOT NULL THEN
    SELECT account.stable_account_key_canonical INTO v_account_namespace
    FROM public.financial_accounts AS account
    WHERE account.id = v_financial_account_id
      AND account.client_entity_id = p_client_entity_id;
    IF v_provider_connection_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.financial_accounts AS account
      WHERE account.id = v_financial_account_id
        AND account.client_entity_id = p_client_entity_id
        AND account.provider_connection_id IS DISTINCT FROM v_provider_connection_id
    ) THEN
      RAISE EXCEPTION 'financial account and provider connection namespaces disagree'
        USING ERRCODE = '23514';
    END IF;
    IF v_ledger_book_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.financial_accounts AS account
      WHERE account.id = v_financial_account_id
        AND account.client_entity_id = p_client_entity_id
        AND account.ledger_book_id IS NOT NULL
        AND account.ledger_book_id <> v_ledger_book_id
    ) THEN
      RAISE EXCEPTION 'financial account and ledger book namespaces disagree'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  FOR v_claim IN SELECT value FROM jsonb_array_elements(p_identity_claims)
  LOOP
    v_claim_count := v_claim_count + 1;
    IF jsonb_typeof(v_claim) <> 'object'
       OR v_claim->>'strength' NOT IN ('authoritative', 'strong') THEN
      RAISE EXCEPTION 'atomic identity ingestion accepts authoritative/strong claims only'
        USING ERRCODE = '22023';
    END IF;
    IF NULLIF(btrim(v_claim->>'claim_kind'), '') IS NULL
       OR NULLIF(btrim(v_claim->>'namespace_canonical'), '') IS NULL
       OR NULLIF(btrim(v_claim->>'claim_key_canonical'), '') IS NULL THEN
      RAISE EXCEPTION 'exact identity kind, namespace, and key are required'
        USING ERRCODE = '22023';
    END IF;
    IF v_claim->>'claim_kind' IN
         ('quickbooks_object_id', 'xero_object_id', 'provider_transaction_id')
       AND v_provider_connection_id IS NULL THEN
      RAISE EXCEPTION '% requires a client-scoped provider connection', v_claim->>'claim_kind'
        USING ERRCODE = '22023';
    END IF;
    IF v_claim->>'claim_kind' IN
         ('quickbooks_object_id', 'xero_object_id', 'provider_transaction_id') THEN
      IF v_external_organisation_id IS NULL
         OR NULLIF(btrim(v_claim->'components'->>'object_type'), '') IS NULL
         OR v_claim->>'namespace_canonical' IS DISTINCT FROM
              concat(v_provider, '|', v_external_organisation_id, '|',
                     v_claim->'components'->>'object_type')
         OR (v_claim->>'claim_kind' = 'quickbooks_object_id'
             AND v_provider <> 'quickbooks')
         OR (v_claim->>'claim_kind' = 'xero_object_id'
             AND v_provider <> 'xero') THEN
        RAISE EXCEPTION 'provider identity namespace does not match provider connection'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF v_claim->>'claim_kind' = 'ofx_fitid' AND v_financial_account_id IS NULL THEN
      RAISE EXCEPTION 'ofx_fitid requires a client-scoped financial account'
        USING ERRCODE = '22023';
    END IF;
    IF v_claim->>'claim_kind' = 'ofx_fitid'
       AND (v_account_namespace IS NULL
            OR v_claim->>'namespace_canonical' IS DISTINCT FROM
                 concat('ofx|', v_account_namespace)) THEN
      RAISE EXCEPTION 'OFX identity namespace does not match financial account'
        USING ERRCODE = '23514';
    END IF;
    IF v_claim->>'claim_kind' = 'artifact_record'
       AND NULLIF(v_claim->>'source_artifact_id', '') IS NULL THEN
      RAISE EXCEPTION 'artifact_record requires source_artifact_id'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Exact identities are locked in deterministic lexical order. Advisory lock
  -- collisions only serialize unrelated work; resolution still compares the
  -- complete canonical strings and never trusts a digest alone.
  FOR v_claim IN
    SELECT value FROM jsonb_array_elements(p_identity_claims)
    ORDER BY value->>'claim_kind', value->>'namespace_canonical',
             value->>'claim_key_canonical'
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_client_entity_id::text || '|' || (v_claim->>'claim_kind') || '|' ||
      (v_claim->>'namespace_canonical') || '|' || (v_claim->>'claim_key_canonical'), 10
    ));
  END LOOP;

  FOR v_claim IN SELECT value FROM jsonb_array_elements(p_identity_claims)
  LOOP
    SELECT claim.observation_id INTO v_candidate_observation_id
    FROM public.financial_identity_claims AS claim
    WHERE claim.client_entity_id = p_client_entity_id
      AND claim.claim_kind = v_claim->>'claim_kind'
      AND claim.namespace_canonical = v_claim->>'namespace_canonical'
      AND claim.claim_key_canonical = v_claim->>'claim_key_canonical'
      AND claim.status = 'active'
      AND claim.strength IN ('authoritative', 'strong')
    FOR UPDATE;
    IF v_candidate_observation_id IS NOT NULL THEN
      IF v_observation_id IS NOT NULL
         AND v_observation_id <> v_candidate_observation_id THEN
        RAISE EXCEPTION 'exact identity claims resolve to conflicting observations'
          USING ERRCODE = '23505';
      END IF;
      v_observation_id := v_candidate_observation_id;
    END IF;
    v_candidate_observation_id := NULL;
  END LOOP;

  IF v_observation_id IS NULL THEN
    v_result := public.create_financial_observation_v1(
      p_client_entity_id, p_root, p_revision,
      p_actor_kind, p_actor_user_id, p_actor_service, p_request_id
    );
    v_observation_id := (v_result->>'observation_id')::uuid;
    v_revision_id := (v_result->>'revision_id')::uuid;
    v_result := public.create_financial_event_v1(
      p_client_entity_id, 'provider', p_event_revision,
      p_actor_kind, p_actor_user_id, p_actor_service, p_request_id
    );
    v_event_id := (v_result->>'event_id')::uuid;
    PERFORM public.attach_financial_observation_v1(
      p_client_entity_id, v_event_id, v_observation_id, 'primary',
      'atomic exact identity ingestion', p_actor_kind, p_actor_user_id,
      p_actor_service, p_request_id
    );
  ELSE
    v_reused := true;
    SELECT root.current_revision_id, root.observation_kind,
           root.provider_connection_id, root.financial_account_id,
           root.ledger_book_id
      INTO v_current_revision_id, v_existing_observation_kind,
           v_existing_provider_connection_id, v_existing_financial_account_id,
           v_existing_ledger_book_id
    FROM public.financial_observations AS root
    WHERE root.id = v_observation_id
      AND root.client_entity_id = p_client_entity_id
    FOR UPDATE;
    IF v_current_revision_id IS NULL THEN
      RAISE EXCEPTION 'resolved observation is not complete for client'
        USING ERRCODE = '23514';
    END IF;
    -- An exact claim may only reuse the observation in the same physical
    -- provider/account namespace. Client-scoped identity uniqueness alone is
    -- not enough when a client has multiple realms, tenants, or accounts.
    IF v_existing_observation_kind IS DISTINCT FROM p_root->>'observation_kind'
       OR v_existing_provider_connection_id IS DISTINCT FROM v_provider_connection_id
       OR v_existing_financial_account_id IS DISTINCT FROM v_financial_account_id
       OR v_existing_ledger_book_id IS DISTINCT FROM v_ledger_book_id THEN
      RAISE EXCEPTION 'resolved identity belongs to a different observation namespace'
        USING ERRCODE = '23505';
    END IF;

    SELECT jsonb_strip_nulls(jsonb_build_object(
      'source_status', revision.source_status,
      'amount_minor', revision.amount_minor,
      'currency_code', revision.currency_code,
      'minor_unit_exponent', revision.minor_unit_exponent,
      'direction', revision.direction,
      'raw_amount_text', revision.raw_amount_text,
      'raw_currency_text', revision.raw_currency_text,
      'source_transaction_on', revision.source_transaction_on,
      'source_transaction_at', revision.source_transaction_at,
      'authorization_on', revision.authorization_on,
      'authorization_at', revision.authorization_at,
      'posted_on', revision.posted_on,
      'posted_at', revision.posted_at,
      'value_date', revision.value_date,
      'accounting_date', revision.accounting_date,
      'source_timezone', revision.source_timezone,
      'description', revision.description,
      'counterparty', revision.counterparty,
      'reference_text', revision.reference_text,
      'raw_payload_hash_hex', CASE WHEN revision.raw_payload_hash IS NULL THEN NULL
                                   ELSE encode(revision.raw_payload_hash, 'hex') END,
      'provider_updated_at', revision.provider_updated_at
    )) INTO v_existing_projection
    FROM public.financial_observation_revisions AS revision
    WHERE revision.id = v_current_revision_id;

    v_incoming_projection := jsonb_strip_nulls(jsonb_build_object(
      'source_status', COALESCE(NULLIF(p_revision->>'source_status', ''), 'unknown'),
      'amount_minor', NULLIF(p_revision->>'amount_minor', '')::bigint,
      'currency_code', NULLIF(p_revision->>'currency_code', ''),
      'minor_unit_exponent', NULLIF(p_revision->>'minor_unit_exponent', '')::smallint,
      'direction', NULLIF(p_revision->>'direction', ''),
      'raw_amount_text', p_revision->>'raw_amount_text',
      'raw_currency_text', p_revision->>'raw_currency_text',
      'source_transaction_on', NULLIF(p_revision->>'source_transaction_on', '')::date,
      'source_transaction_at', NULLIF(p_revision->>'source_transaction_at', '')::timestamptz,
      'authorization_on', NULLIF(p_revision->>'authorization_on', '')::date,
      'authorization_at', NULLIF(p_revision->>'authorization_at', '')::timestamptz,
      'posted_on', NULLIF(p_revision->>'posted_on', '')::date,
      'posted_at', NULLIF(p_revision->>'posted_at', '')::timestamptz,
      'value_date', NULLIF(p_revision->>'value_date', '')::date,
      'accounting_date', NULLIF(p_revision->>'accounting_date', '')::date,
      'source_timezone', NULLIF(p_revision->>'source_timezone', ''),
      'description', p_revision->>'description',
      'counterparty', p_revision->>'counterparty',
      'reference_text', p_revision->>'reference_text',
      'raw_payload_hash_hex', lower(NULLIF(p_revision->>'raw_payload_hash_hex', '')),
      'provider_updated_at', NULLIF(p_revision->>'provider_updated_at', '')::timestamptz
    ));
    IF v_existing_projection IS DISTINCT FROM v_incoming_projection THEN
      v_result := public.append_financial_observation_revision_v1(
        p_client_entity_id, v_observation_id, p_revision,
        p_actor_kind, p_actor_user_id, p_actor_service, p_request_id
      );
      v_revision_id := (v_result->>'revision_id')::uuid;
      v_revision_appended := true;
    ELSE
      v_revision_id := v_current_revision_id;
    END IF;

    SELECT link.event_id INTO v_event_id
    FROM public.financial_event_observation_links AS link
    WHERE link.client_entity_id = p_client_entity_id
      AND link.observation_id = v_observation_id
      AND link.valid_to IS NULL;
    IF v_event_id IS NULL THEN
      v_result := public.create_financial_event_v1(
        p_client_entity_id, 'provider', p_event_revision,
        p_actor_kind, p_actor_user_id, p_actor_service, p_request_id
      );
      v_event_id := (v_result->>'event_id')::uuid;
      PERFORM public.attach_financial_observation_v1(
        p_client_entity_id, v_event_id, v_observation_id, 'primary',
        'atomic exact identity ingestion', p_actor_kind, p_actor_user_id,
        p_actor_service, p_request_id
      );
    ELSE
      v_event_id := public.resolve_canonical_event_root_v1(
        p_client_entity_id, v_event_id
      );
    END IF;
  END IF;

  FOR v_claim IN SELECT value FROM jsonb_array_elements(p_identity_claims)
  LOOP
    v_claim_normalized := v_claim || jsonb_build_object(
      'namespace_hash_hex', encode(extensions.digest(
        convert_to(v_claim->>'namespace_canonical', 'UTF8'), 'sha256'), 'hex'),
      'claim_key_hash_hex', encode(extensions.digest(
        convert_to(v_claim->>'claim_key_canonical', 'UTF8'), 'sha256'), 'hex')
    );
    v_claim_id := gen_random_uuid();
    INSERT INTO public.financial_identity_claims (
      id, client_entity_id, observation_id, claim_kind, strength,
      canonicalisation_version, namespace_canonical, claim_key_canonical,
      namespace_hash, claim_key_hash, components, source_artifact_id,
      source_observation_revision_id, reviewed_by_user_id, review_reason
    ) VALUES (
      v_claim_id, p_client_entity_id, v_observation_id,
      v_claim_normalized->>'claim_kind', v_claim_normalized->>'strength',
      COALESCE(NULLIF(v_claim_normalized->>'canonicalisation_version', '')::integer, 1),
      v_claim_normalized->>'namespace_canonical',
      v_claim_normalized->>'claim_key_canonical',
      decode(v_claim_normalized->>'namespace_hash_hex', 'hex'),
      decode(v_claim_normalized->>'claim_key_hash_hex', 'hex'),
      COALESCE(v_claim_normalized->'components', '{}'::jsonb),
      NULLIF(v_claim_normalized->>'source_artifact_id', '')::uuid,
      NULLIF(v_claim_normalized->>'source_observation_revision_id', '')::uuid,
      p_actor_user_id, v_claim_normalized->>'review_reason'
    ) ON CONFLICT (client_entity_id, claim_kind, namespace_canonical, claim_key_canonical)
      WHERE status = 'active' AND strength IN ('authoritative', 'strong')
      DO NOTHING
    RETURNING id INTO v_claim_id;
    IF v_claim_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.financial_identity_claims AS existing
      WHERE existing.client_entity_id = p_client_entity_id
        AND existing.observation_id = v_observation_id
        AND existing.claim_kind = v_claim_normalized->>'claim_kind'
        AND existing.namespace_canonical = v_claim_normalized->>'namespace_canonical'
        AND existing.claim_key_canonical = v_claim_normalized->>'claim_key_canonical'
        AND existing.status = 'active'
        AND existing.strength IN ('authoritative', 'strong')
    ) THEN
      RAISE EXCEPTION 'exact strong identity race resolved to another observation'
        USING ERRCODE = '23505';
    END IF;
  END LOOP;

  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    CASE WHEN v_reused THEN 'reuse' ELSE 'create' END,
    'atomic_financial_observation_ingest', v_observation_id, NULL,
    jsonb_build_object('observation_id', v_observation_id,
                       'event_id', v_event_id,
                       'revision_id', v_revision_id),
    jsonb_build_object('outcome', CASE WHEN v_reused THEN 'reused' ELSE 'inserted' END)
  );
  RETURN jsonb_build_object(
    'observation_id', v_observation_id,
    'event_id', v_event_id,
    'revision_id', v_revision_id,
    'reused', v_reused,
    'revision_appended', v_revision_appended,
    'operation_id', v_operation_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_financial_relationship_v1(
  p_client_entity_id uuid,
  p_relationship jsonb,
  p_endpoints jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_relationship_id uuid := gen_random_uuid();
  v_endpoint jsonb;
  v_endpoint_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_sequence integer := 1;
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  IF jsonb_typeof(p_endpoints) <> 'array' OR jsonb_array_length(p_endpoints) < 2 THEN
    RAISE EXCEPTION 'p_endpoints must contain at least two endpoints' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.financial_relationships (
    id, client_entity_id, relationship_type, status, evidence_strength,
    confidence_basis_points, source_kind, reason, created_by_kind,
    created_by_user_id, created_by_service, reviewed_by_user_id, reviewed_at
  ) VALUES (
    v_relationship_id, p_client_entity_id, p_relationship->>'relationship_type',
    COALESCE(NULLIF(p_relationship->>'status', ''), 'proposed'),
    COALESCE(NULLIF(p_relationship->>'evidence_strength', ''), 'weak'),
    NULLIF(p_relationship->>'confidence_basis_points', '')::integer,
    COALESCE(NULLIF(p_relationship->>'source_kind', ''), 'manual'),
    COALESCE(NULLIF(p_relationship->>'reason', ''), 'relationship created'),
    p_actor_kind, p_actor_user_id, p_actor_service,
    CASE WHEN p_relationship->>'status' = 'confirmed' THEN p_actor_user_id ELSE NULL END,
    CASE WHEN p_relationship->>'status' = 'confirmed' THEN now() ELSE NULL END
  );
  FOR v_endpoint IN SELECT value FROM jsonb_array_elements(p_endpoints)
  LOOP
    v_endpoint_id := gen_random_uuid();
    INSERT INTO public.financial_relationship_endpoints (
      id, client_entity_id, relationship_id, endpoint_role, ordinal,
      event_id, observation_id, document_id
    ) VALUES (
      v_endpoint_id, p_client_entity_id, v_relationship_id,
      v_endpoint->>'endpoint_role', (v_endpoint->>'ordinal')::integer,
      CASE WHEN v_endpoint->>'endpoint_kind' = 'event'
           THEN (v_endpoint->>'entity_id')::uuid END,
      CASE WHEN v_endpoint->>'endpoint_kind' = 'observation'
           THEN (v_endpoint->>'entity_id')::uuid END,
      CASE WHEN v_endpoint->>'endpoint_kind' = 'document'
           THEN (v_endpoint->>'entity_id')::uuid END
    );
    v_sequence := v_sequence + 1;
  END LOOP;
  PERFORM public.canonical_validate_relationship_v1(v_relationship_id);
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_relationship', v_relationship_id, NULL,
    jsonb_build_object('id', v_relationship_id,
                       'relationship_type', p_relationship->>'relationship_type'),
    jsonb_build_object('relationship_type', p_relationship->>'relationship_type')
  );
  RETURN jsonb_build_object('relationship_id', v_relationship_id,
                            'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.allocate_financial_relationship_v1(
  p_client_entity_id uuid,
  p_relationship_id uuid,
  p_from_endpoint_id uuid,
  p_to_endpoint_id uuid,
  p_allocation jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_allocation_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  INSERT INTO public.financial_allocations (
    id, client_entity_id, relationship_id, from_endpoint_id, to_endpoint_id,
    source_amount_minor, source_currency_code, source_minor_unit_exponent,
    target_amount_minor, target_currency_code, target_minor_unit_exponent,
    fx_rate_numerator, fx_rate_denominator, status,
    created_by_kind, created_by_user_id, created_by_service
  ) VALUES (
    v_allocation_id, p_client_entity_id, p_relationship_id,
    p_from_endpoint_id, p_to_endpoint_id,
    (p_allocation->>'source_amount_minor')::bigint,
    p_allocation->>'source_currency_code',
    (p_allocation->>'source_minor_unit_exponent')::smallint,
    (p_allocation->>'target_amount_minor')::bigint,
    p_allocation->>'target_currency_code',
    (p_allocation->>'target_minor_unit_exponent')::smallint,
    NULLIF(p_allocation->>'fx_rate_numerator', '')::bigint,
    NULLIF(p_allocation->>'fx_rate_denominator', '')::bigint,
    COALESCE(NULLIF(p_allocation->>'status', ''), 'proposed'),
    p_actor_kind, p_actor_user_id, p_actor_service
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'create', 'financial_allocation', v_allocation_id, NULL,
    jsonb_build_object('id', v_allocation_id, 'relationship_id', p_relationship_id,
                       'status', COALESCE(NULLIF(p_allocation->>'status', ''), 'proposed')),
    jsonb_build_object('relationship_type', (
      SELECT relationship_type FROM public.financial_relationships WHERE id = p_relationship_id
    ))
  );
  RETURN jsonb_build_object('allocation_id', v_allocation_id,
                            'operation_id', v_operation_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Reversible merge RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.merge_financial_events_v1(
  p_client_entity_id uuid,
  p_survivor_event_id uuid,
  p_alias_event_id uuid,
  p_reason text,
  p_evidence jsonb,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_survivor_root uuid;
  v_alias_root uuid;
  v_merge_id uuid := gen_random_uuid();
  v_alias_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('canonical-merge:' || p_client_entity_id::text, 10)
  );
  v_survivor_root := public.resolve_canonical_event_root_v1(
    p_client_entity_id, p_survivor_event_id
  );
  IF v_survivor_root <> p_survivor_event_id THEN
    RAISE EXCEPTION 'requested survivor must be a current canonical root'
      USING ERRCODE = '23514';
  END IF;
  v_alias_root := public.resolve_canonical_event_root_v1(p_client_entity_id, p_alias_event_id);
  IF v_alias_root = v_survivor_root THEN
    RAISE EXCEPTION 'events already resolve to the same root' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.financial_events
  WHERE client_entity_id = p_client_entity_id
    AND id IN (v_survivor_root, v_alias_root)
  ORDER BY id FOR UPDATE;

  INSERT INTO public.financial_merge_operations (
    id, client_entity_id, survivor_event_id, status,
    requested_by_kind, requested_by_user_id, requested_by_service,
    evidence, reason, applied_at
  ) VALUES (
    v_merge_id, p_client_entity_id, v_survivor_root, 'applied',
    p_actor_kind, p_actor_user_id, p_actor_service,
    COALESCE(p_evidence, '{}'::jsonb), p_reason, now()
  );
  INSERT INTO public.financial_event_aliases (
    id, client_entity_id, alias_event_id, survivor_event_id, merge_operation_id
  ) VALUES (
    v_alias_id, p_client_entity_id, v_alias_root, v_survivor_root, v_merge_id
  );
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'merge', 'financial_merge_operation', v_merge_id, NULL,
    jsonb_build_object('survivor_event_id', v_survivor_root,
                       'alias_event_id', v_alias_root), '{}'::jsonb
  );
  RETURN jsonb_build_object('merge_operation_id', v_merge_id, 'alias_id', v_alias_id,
                            'canonical_root_id', v_survivor_root,
                            'operation_id', v_operation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_financial_merge_v1(
  p_client_entity_id uuid,
  p_merge_operation_id uuid,
  p_reason text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_service text,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_practice_id uuid;
  v_original public.financial_merge_operations%ROWTYPE;
  v_reversal_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
BEGIN
  v_practice_id := public.canonical_assert_mutation_context_v1(
    p_client_entity_id, p_actor_kind, p_actor_user_id, p_actor_service
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('canonical-merge:' || p_client_entity_id::text, 10)
  );
  SELECT * INTO v_original FROM public.financial_merge_operations
  WHERE id = p_merge_operation_id AND client_entity_id = p_client_entity_id
  FOR UPDATE;
  IF v_original.id IS NULL OR v_original.status <> 'applied' THEN
    RAISE EXCEPTION 'merge is not active and reversible' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_event_aliases dependency
    WHERE dependency.client_entity_id = p_client_entity_id
      AND dependency.alias_event_id = v_original.survivor_event_id
      AND dependency.valid_to IS NULL
      AND dependency.merge_operation_id <> p_merge_operation_id
  ) THEN
    RAISE EXCEPTION 'a later active merge depends on this survivor'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.financial_merge_operations (
    id, client_entity_id, survivor_event_id, status,
    requested_by_kind, requested_by_user_id, requested_by_service,
    evidence, reason, reversal_of_operation_id, applied_at
  ) VALUES (
    v_reversal_id, p_client_entity_id, v_original.survivor_event_id, 'applied',
    p_actor_kind, p_actor_user_id, p_actor_service, '{}'::jsonb,
    p_reason, p_merge_operation_id, now()
  );
  UPDATE public.financial_event_aliases
  SET valid_to = GREATEST(clock_timestamp(), valid_from + interval '1 microsecond'),
      reversed_by_operation_id = v_reversal_id
  WHERE client_entity_id = p_client_entity_id
    AND merge_operation_id = p_merge_operation_id AND valid_to IS NULL;
  UPDATE public.financial_merge_operations
  SET status = 'reversed', reversed_at = now()
  WHERE id = p_merge_operation_id;
  PERFORM public.canonical_write_audit_v1(
    v_practice_id, p_client_entity_id, v_operation_id, 1,
    p_actor_kind, p_actor_user_id, p_actor_service, p_request_id,
    'reverse_merge', 'financial_merge_operation', p_merge_operation_id,
    jsonb_build_object('status', 'applied'), jsonb_build_object('status', 'reversed'), '{}'::jsonb
  );
  RETURN jsonb_build_object('reversal_operation_id', v_reversal_id,
                            'operation_id', v_operation_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS: practice membership plus explicit client access is the read boundary.
-- Owner/admin memberships are practice-wide; all other roles need a grant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.canonical_can_read_practice_v1(p_practice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.practice_memberships membership
    WHERE membership.practice_id = p_practice_id
      AND membership.user_id = auth.uid()
      AND membership.status = 'active'
  );
$$;

-- Return the caller's complete client scope once. RLS policies use this
-- uncorrelated set instead of invoking a membership/access join independently
-- for every candidate client row.
CREATE OR REPLACE FUNCTION public.canonical_accessible_client_ids_v1()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT client.id
  FROM public.client_entities AS client
  JOIN public.practice_memberships AS membership
    ON membership.practice_id = client.practice_id
   AND membership.user_id = auth.uid()
   AND membership.status = 'active'
  WHERE membership.role IN ('owner', 'admin')
     OR EXISTS (
       SELECT 1
       FROM public.client_access AS access_grant
       WHERE access_grant.client_entity_id = client.id
         AND access_grant.practice_id = client.practice_id
         AND access_grant.membership_id = membership.id
         AND access_grant.user_id = auth.uid()
         AND access_grant.status = 'active'
     );
$$;

CREATE OR REPLACE FUNCTION public.canonical_can_access_client_v1(p_client_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND p_client_entity_id IN (
    SELECT public.canonical_accessible_client_ids_v1()
  );
$$;

ALTER TABLE public.practices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practice_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY practices_authenticated_select
  ON public.practices FOR SELECT TO authenticated
  USING (public.canonical_can_read_practice_v1(id));

CREATE POLICY practice_memberships_authenticated_select
  ON public.practice_memberships FOR SELECT TO authenticated
  USING (public.canonical_can_read_practice_v1(practice_id));

CREATE POLICY client_entities_authenticated_select
  ON public.client_entities FOR SELECT TO authenticated
  USING (id IN (SELECT public.canonical_accessible_client_ids_v1()));

CREATE POLICY client_access_authenticated_select
  ON public.client_access FOR SELECT TO authenticated
  USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()));

DO $rls$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'ledger_books', 'provider_connections', 'financial_accounts',
    'import_artifacts', 'import_runs', 'financial_events',
    'financial_event_revisions', 'financial_observations',
    'financial_observation_revisions', 'financial_observation_occurrences',
    'financial_event_observation_links', 'financial_event_fact_resolutions',
    'financial_identity_claims', 'financial_documents',
    'financial_document_revisions', 'financial_relationships',
    'financial_relationship_endpoints', 'financial_allocations',
    'financial_merge_operations', 'financial_event_aliases',
    'legacy_record_mappings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()))',
      v_table || '_authenticated_select', v_table
    );
  END LOOP;
END;
$rls$;

ALTER TABLE public.canonical_audit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY canonical_audit_ledger_authenticated_select
  ON public.canonical_audit_ledger FOR SELECT TO authenticated
  USING (
    (client_entity_id IS NOT NULL AND client_entity_id IN (SELECT public.canonical_accessible_client_ids_v1()))
    OR (client_entity_id IS NULL AND public.canonical_can_read_practice_v1(practice_id))
  );

-- ---------------------------------------------------------------------------
-- Least-privilege ACL. Canonical writes are available only through the
-- versioned SECURITY DEFINER RPCs. The service role receives no table DML.
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  public.currency_definitions,
  public.financial_relationship_types,
  public.financial_identity_claim_kinds,
  public.legacy_record_types,
  public.practices,
  public.practice_memberships,
  public.client_entities,
  public.client_access,
  public.ledger_books,
  public.provider_connections,
  public.financial_accounts,
  public.import_artifacts,
  public.import_runs,
  public.financial_events,
  public.financial_event_revisions,
  public.financial_observations,
  public.financial_observation_revisions,
  public.financial_observation_occurrences,
  public.financial_event_observation_links,
  public.financial_event_fact_resolutions,
  public.financial_identity_claims,
  public.financial_documents,
  public.financial_document_revisions,
  public.financial_relationships,
  public.financial_relationship_endpoints,
  public.financial_allocations,
  public.financial_merge_operations,
  public.financial_event_aliases,
  public.legacy_record_mappings,
  public.canonical_audit_ledger
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.currency_definitions,
  public.financial_relationship_types,
  public.financial_identity_claim_kinds,
  public.legacy_record_types,
  public.practices,
  public.practice_memberships,
  public.client_entities,
  public.client_access,
  public.ledger_books,
  public.provider_connections,
  public.financial_accounts,
  public.import_artifacts,
  public.import_runs,
  public.financial_events,
  public.financial_event_revisions,
  public.financial_observations,
  public.financial_observation_revisions,
  public.financial_observation_occurrences,
  public.financial_event_observation_links,
  public.financial_event_fact_resolutions,
  public.financial_identity_claims,
  public.financial_documents,
  public.financial_document_revisions,
  public.financial_relationships,
  public.financial_relationship_endpoints,
  public.financial_allocations,
  public.financial_merge_operations,
  public.financial_event_aliases,
  public.legacy_record_mappings,
  public.canonical_audit_ledger
TO authenticated, service_role;

DO $acl$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'canonical_audit_metadata_allowed_v1', 'canonical_reject_update_delete_v1',
        'canonical_require_current_revision_v1', 'canonical_validate_relationship_v1',
        'canonical_validate_relationship_trigger_v1', 'canonical_mark_relationship_dirty_v1',
        'canonical_allocation_subject_v1',
        'canonical_guard_allocation_v1', 'canonical_guard_alias_v1',
        'canonical_jsonb_sha256_v1', 'canonical_assert_mutation_context_v1',
        'canonical_write_audit_v1', 'canonical_can_read_practice_v1',
        'canonical_accessible_client_ids_v1',
        'canonical_can_access_client_v1', 'resolve_canonical_event_root_v1',
        'create_financial_event_v1', 'append_financial_event_revision_v1',
        'create_financial_observation_v1', 'append_financial_observation_revision_v1',
        'create_financial_document_v1', 'append_financial_document_revision_v1',
        'ingest_import_artifact_v1', 'start_import_run_v1',
        'record_financial_observation_occurrence_v1', 'attach_financial_observation_v1',
        'create_financial_identity_claim_v1', 'ingest_financial_observation_v1',
        'create_financial_relationship_v1',
        'allocate_financial_relationship_v1', 'merge_financial_events_v1',
        'reverse_financial_merge_v1'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_function);
  END LOOP;
END;
$acl$;

GRANT EXECUTE ON FUNCTION public.canonical_can_read_practice_v1(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.canonical_accessible_client_ids_v1()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.canonical_can_access_client_v1(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_canonical_event_root_v1(uuid, uuid)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_financial_event_v1(uuid, text, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.append_financial_event_revision_v1(uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_financial_observation_v1(uuid, jsonb, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.append_financial_observation_revision_v1(uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_financial_document_v1(uuid, text, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.append_financial_document_revision_v1(uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_import_artifact_v1(uuid, text, text, bigint, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.start_import_run_v1(uuid, uuid, uuid, text, text, text, text, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_financial_observation_occurrence_v1(uuid, uuid, uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_financial_observation_v1(uuid, uuid, uuid, text, text, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_financial_identity_claim_v1(uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_financial_observation_v1(uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_financial_relationship_v1(uuid, jsonb, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.allocate_financial_relationship_v1(uuid, uuid, uuid, uuid, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_financial_events_v1(uuid, uuid, uuid, text, jsonb, text, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_financial_merge_v1(uuid, uuid, text, text, uuid, text, text)
  TO service_role;

CREATE CONSTRAINT TRIGGER financial_relationship_endpoints_semantic_check
AFTER INSERT OR UPDATE OR DELETE ON public.financial_relationship_endpoints
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.canonical_validate_relationship_trigger_v1();

COMMIT;
