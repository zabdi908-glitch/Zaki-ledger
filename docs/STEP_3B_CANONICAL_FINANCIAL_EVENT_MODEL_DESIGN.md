# Step 3B — Canonical Financial Event Model Design

**Status:** Design complete — ready for schema review
**Scope:** Architecture and schema design only
**Date:** 10 August 2026

> This document is the approved Step 3B design input. It does not authorize a
> production migration, backfill, deployment, legacy-row rewrite, UUID change,
> or canonical consolidation.

## Executive summary

Zaki's canonical root will represent an **economic event**. Bank movements,
QuickBooks postings, Xero postings, OFX rows, CSV rows, and future bank-feed
records remain distinct **financial observations** of that event. Invoices and
receipts remain **documents, obligations, or evidence**; they are not bank
transactions.

Existing `bank_transactions.id` and `qb_transactions.id` values remain stable.
Every legacy financial row initially receives its own event and observation.
Approved reconciliation matches become relationship evidence, never automatic
identity equivalence. Later reviewed consolidation uses reversible event aliases
rather than physical row merges or foreign-key repointing.

The long-term model adds:

- practice, client, ledger, provider-connection, and financial-account tenancy;
- financial events and source observations;
- append-only event and observation revisions;
- strength-aware identity claims;
- typed many-to-many relationships and monetary allocations;
- import artifacts and idempotent import runs;
- immutable audit records;
- temporal legacy mappings; and
- reversible merge operations and aliases.

Migration 010 must be an additive foundation only. Historical backfill, read
migration, relationship conversion, cascade repair, and legacy retirement belong
in later independently reviewed migrations.

## Locked architecture decisions

1. The canonical root represents an economic event.
2. Bank movements and accounting postings remain separate observations.
3. Invoices and receipts remain documents, obligations, or evidence.
4. Approved reconciliation matches are relationship evidence, not identity equivalence.
5. Existing bank and accounting UUIDs remain stable.
6. Legacy records transition through mapping and alias rows.
7. Relationships support many-to-many cardinality and monetary allocations.
8. All historical production data is preserved exactly.
9. Canonical merges are reversible and auditable.
10. Fingerprints remain probabilistic evidence and are never unique canonical identity.

---

## 1. Domain ontology

### Financial event

A financial event is one economic occurrence from a client entity's perspective,
such as a payment, receipt, purchase, refund, fee, transfer, reversal, adjustment,
or batch.

It is not a bank-statement row, accounting posting, invoice, provider delivery,
or reconciliation decision.

- **Lifecycle:** `active → superseded/merged/archived`. A reversal is a separate event.
- **Mutability:** its UUID is immutable; facts change only through revisions.
- **Ownership:** exactly one client entity and therefore one practice.
- **Associations:** observations, revisions, relationships, aliases, and fact resolutions.

### Financial observation

A financial observation is a source-specific representation of an event, including
a bank movement, QuickBooks posting, Xero posting, provider Bill, OFX row, CSV row,
or future bank-feed transaction.

It is not the universal event or a document.

- **Lifecycle:** `pending/current → settled/corrected/superseded/voided/archived`.
- **Mutability:** stable UUID with append-only revisions.
- **Ownership:** exactly one client; optionally one ledger, account, provider connection,
  import artifact, and import run.
- **Associations:** at most one active event attachment, with attachment history retained.

### Identity claim

An identity claim records evidence identifying an observation in a source namespace.
It does not merge events by itself.

- **Lifecycle:** `active → superseded/invalidated/conflicted`.
- **Mutability:** append-only; promotion or demotion creates another claim.
- **Strength:** authoritative, strong, probabilistic, or weak.

### Document

A document is an invoice, receipt, credit note, statement, or similar obligation or
evidence record. It is not a cash movement or accounting posting.

- **Lifecycle:** `received → extracted → reviewed → approved/rejected/archived`.
- **Obligation state:** open, partially settled, settled, disputed, voided, or not applicable.
- **Associations:** source artifact and event-to-document settlement relationships.

### Relationship

A relationship is a typed assertion between events, observations, or documents.
Examples include `reconciles_with`, `settles`, `batch_contains`, `split_into`,
`refunds`, `reverses`, `transfers_to`, `supersedes`, and `derived_from`.

- **Lifecycle:** `proposed → confirmed/rejected/revoked/superseded`.
- Rejection is preserved and never deleted.
- A relationship is evidence or business semantics, not identity equality.

### Allocation

An allocation records an amount applied from one relationship endpoint to another.
It supports partial payment, batch payment, split posting, many-to-many settlement,
and FX source/target amounts. Corrections revoke and replace allocations.

### Import artifact

An import artifact is immutable source material such as a CSV, OFX, PDF, provider
payload page, or webhook body. Its hash proves artifact equality, not event equality.

### Import run

An import run is one ingestion attempt with parser version, idempotency key, status,
counts, and error outcome. Repeated runs may reuse the same artifact and observations.

### Revision

A revision is an append-only version of an event, observation, or document. It records
the previous version, changed facts, provenance, actor, reason, and timestamp.

### Merge and alias

A merge is a reviewed assertion that several event UUIDs should resolve to one
presentation root. It creates temporal aliases and never deletes or repoints the
member events, observations, relationships, or legacy mappings. Reversal closes
the alias rows.

### Example resolution

| Scenario | Canonical representation |
|---|---|
| One bank payment ↔ one accounting posting | One event, two observations, and confirmed observation-level reconciliation evidence |
| One payment → multiple invoices | One payment event, multiple document endpoints, one allocation per invoice |
| Multiple payments → one invoice | Multiple payment events and one allocation from each payment to the document |
| Batch payment → multiple postings | Batch event plus child events/postings linked by `batch_contains` and allocations |
| Split accounting entry | Posting/line observations or child events linked by `split_into` |
| Transfer | Prefer one transfer event with outward and inward bank observations; model fees separately |
| Refund | New refund event linked to the original event or document |
| Reversal | New reversal event linked through `reverses`; original remains unchanged |
| Pending → settled | Same observation and event when provider identity is stable; append a revision |
| Provider correction | Same authoritative observation with a new revision and explicit conflict handling |
| Provider replaces ID | Superseding claim only with explicit provider evidence; otherwise a new observation and proposed relationship |
| FX plus fee | Conversion event with source/target currency observations; separate fee event |
| Duplicate-looking legitimate rows | Separate observations and initial events unless strong evidence proves reuse |

---

## 2. Ownership and tenant model

```text
Practice
  ├─ Practice memberships
  └─ Client entity
       ├─ Client access grants
       ├─ Ledger/book
       │    └─ Provider connection
       ├─ Financial accounts
       ├─ Events and observations
       ├─ Documents
       └─ Import artifacts and runs
```

- **Practice:** bookkeeping firm or account owner.
- **Client entity:** legal entity or bookkeeping client.
- **Ledger book:** QuickBooks realm, Xero tenant, or internal/manual ledger.
- **Provider connection:** connection to one external provider organisation.
- **Financial account:** bank, card, cash, clearing, expense, or ledger account.
- **Practice membership:** a user's firm-level role.
- **Client access:** optional restriction to selected clients.

A client can safely have both QuickBooks and Xero. They remain different ledger
books and provider namespaces. Every canonical financial table carries
`client_entity_id`, and composite foreign keys prevent cross-client attachment,
relationships, allocations, mappings, and aliases.

### Existing-user transition

A later deterministic tenancy migration creates, for each existing user:

1. one default practice;
2. one owner membership;
3. one default client entity;
4. one internal ledger; and
5. provider connections corresponding to existing `oauth_connections`.

The existing app continues using `user_id` until client-aware APIs are introduced.

---

## 3. Proposed schema

All domain identifiers are UUIDs. Unless stated otherwise, domain foreign keys use
`ON DELETE RESTRICT`, records are archived instead of deleted, and client-owned
tables have `UNIQUE (id, client_entity_id)` for composite ownership foreign keys.

### Tenancy

#### `practices`

- `id uuid PK NOT NULL`
- `name text NOT NULL`
- `status text NOT NULL CHECK (active|archived)`
- `created_by_user_id uuid NOT NULL FK auth.users RESTRICT`
- `created_at timestamptz NOT NULL`
- `archived_at timestamptz NULL`

#### `practice_memberships`

- `practice_id uuid NOT NULL FK practices RESTRICT`
- `user_id uuid NOT NULL FK auth.users RESTRICT`
- `role text NOT NULL CHECK (owner|admin|bookkeeper|reviewer|viewer)`
- `status text NOT NULL CHECK (active|suspended|revoked)`
- `created_at timestamptz NOT NULL`
- `revoked_at timestamptz NULL`
- PK `(practice_id, user_id)`

#### `client_entities`

- `id uuid PK NOT NULL`
- `practice_id uuid NOT NULL FK practices RESTRICT`
- `legal_name text NOT NULL`
- `display_name text NOT NULL`
- `jurisdiction text NULL`
- `base_currency char(3) NULL`
- `status text NOT NULL CHECK (active|archived)`
- `legacy_owner_user_id uuid NULL FK auth.users RESTRICT`
- `created_at timestamptz NOT NULL`
- `archived_at timestamptz NULL`

#### `client_access`

- `client_entity_id uuid NOT NULL FK client_entities RESTRICT`
- `user_id uuid NOT NULL FK auth.users RESTRICT`
- `role text NOT NULL`
- `status text NOT NULL`
- timestamps
- PK `(client_entity_id, user_id)`

#### `ledger_books`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `book_kind text NOT NULL CHECK (internal|quickbooks|xero|other)`
- `display_name text NOT NULL`
- `functional_currency char(3) NULL`
- `status text NOT NULL CHECK (active|disconnected|archived)`
- timestamps

#### `provider_connections`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `ledger_book_id uuid NOT NULL`
- `provider text NOT NULL`
- `external_organisation_id text NULL`
- `legacy_oauth_connection_id uuid NULL FK oauth_connections RESTRICT`
- `status text NOT NULL CHECK (active|expired|disconnected|archived)`
- `provider_metadata jsonb NOT NULL DEFAULT '{}'`
- timestamps

Active complete provider identities are unique by client, provider, and external
organisation. Tokens remain in a dedicated encrypted secret store or current OAuth
table, never in canonical transaction tables.

#### `financial_accounts`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `ledger_book_id uuid NULL`
- `provider_connection_id uuid NULL`
- `account_kind text NOT NULL`
- `stable_account_key_hash bytea NULL`
- `display_name text NULL`
- `masked_identifier text NULL`
- `currency_code char(3) NULL`
- `status text NOT NULL CHECK (active|closed|unknown|archived)`
- timestamps

Complete account keys are unique inside their client/provider namespace.

### Imports

#### `import_artifacts`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `provider_connection_id uuid NULL`
- `financial_account_id uuid NULL`
- `artifact_kind text NOT NULL`
- `content_sha256 bytea NOT NULL`
- `content_length bigint NULL CHECK >= 0`
- `storage_locator text NULL`
- `storage_state text NOT NULL CHECK (retained|quarantined|purged|unavailable)`
- `source_filename text NULL`
- `mime_type text NULL`
- `source_created_at timestamptz NULL`
- `received_at timestamptz NOT NULL`
- `metadata jsonb NOT NULL DEFAULT '{}'`
- `archived_at timestamptz NULL`

Unique by client, artifact kind, provider/account namespace, and content hash.

#### `import_runs`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `artifact_id uuid NULL`
- `provider_connection_id uuid NULL`
- `requested_by_user_id uuid NULL`
- `idempotency_key text NULL`
- `parser_name text NOT NULL`
- `parser_version text NOT NULL`
- `status text NOT NULL CHECK (started|completed|partially_completed|failed|reused)`
- `started_at`, `completed_at`
- inserted/reused/updated/rejected counts, non-negative integers
- `error_summary jsonb NULL`
- `request_hash bytea NULL`

Partial unique idempotency key per client and parser.

### Events and observations

#### `financial_events`

Stable identity only:

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `created_by_kind text NOT NULL CHECK (import|provider|manual|backfill|merge)`
- `current_revision_id uuid NULL`
- `created_at timestamptz NOT NULL`
- `archived_at timestamptz NULL`

Merchant, description, accounting date, account, and provider IDs do not belong here.

#### `financial_event_revisions`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `event_id uuid NOT NULL`
- `revision_number integer NOT NULL CHECK > 0`
- `event_kind text NOT NULL`
- `lifecycle_status text NOT NULL CHECK (active|superseded|merged|archived)`
- `resolution_status text NOT NULL CHECK (resolved|incomplete|conflicted)`
- `occurred_at timestamptz NULL`
- `amount_minor bigint NULL CHECK >= 0`
- `currency_code char(3) NULL`
- `minor_unit_exponent smallint NULL CHECK 0..6`
- `direction text NULL CHECK (inflow|outflow|neutral|mixed|unknown)`
- `display_label text NULL`
- `change_reason text NOT NULL`
- `provenance jsonb NOT NULL`
- `created_by_user_id uuid NULL`
- `created_at timestamptz NOT NULL`

Amount, currency, and exponent are either all present or all null. Unique
`(event_id, revision_number)`.

#### `financial_observations`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `observation_kind text NOT NULL`
- `ledger_book_id uuid NULL`
- `financial_account_id uuid NULL`
- `provider_connection_id uuid NULL`
- `import_artifact_id uuid NULL`
- `first_import_run_id uuid NULL`
- `current_revision_id uuid NULL`
- `created_at timestamptz NOT NULL`
- `archived_at timestamptz NULL`

#### `financial_observation_revisions`

- stable revision identity and number;
- `source_status`: pending, posted, settled, corrected, voided, superseded, unknown;
- normalized non-negative minor amount, ISO currency, exponent, and explicit direction;
- raw amount and currency text;
- source transaction, authorization, posting, value, and accounting times/dates;
- source timezone;
- description, counterparty, and reference text;
- raw payload or payload hash;
- provider update and Zaki observation times;
- change reason and creation timestamp.

Unique `(observation_id, revision_number)`. Raw values remain even when normalization fails.

#### `financial_event_observation_links`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `event_id uuid NOT NULL`
- `observation_id uuid NOT NULL`
- `role text NOT NULL CHECK (primary|supporting|component|counter_leg)`
- `attachment_basis text NOT NULL`
- `attached_by_user_id uuid NULL`
- `valid_from timestamptz NOT NULL`
- `valid_to timestamptz NULL`
- `replaced_by_link_id uuid NULL`
- `created_at timestamptz NOT NULL`

Partial unique active link on `observation_id`, allowing one active event attachment
while retaining full history.

#### `financial_event_fact_resolutions`

Versioned resolution rows store event, fact name, resolved/unresolved/conflicted state,
selected observation revision, evidence value, deterministic/provider/manual/merge
method, reason, reviewer, and validity period. Only one active resolution exists per
event/fact. JSON evidence is not used for monetary arithmetic.

### Identity

#### `financial_identity_claims`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `observation_id uuid NOT NULL`
- `claim_kind text NOT NULL`
- `strength text NOT NULL CHECK (authoritative|strong|probabilistic|weak)`
- `canonicalisation_version integer NOT NULL`
- `namespace_hash bytea NOT NULL`
- `claim_key_hash bytea NOT NULL`
- `components jsonb NOT NULL`
- source artifact and observation revision FKs, nullable
- `status text NOT NULL CHECK (active|superseded|invalidated|conflicted)`
- superseding claim, reviewer, review reason, and validity timestamps

Active authoritative/strong claims are unique by client, claim kind, namespace,
and key. Probabilistic/weak claims receive non-unique candidate indexes only.

### Documents

#### `financial_documents`

- `id uuid PK NOT NULL`
- `client_entity_id uuid NOT NULL`
- `artifact_id uuid NULL`
- `document_kind text NOT NULL CHECK (invoice|receipt|credit_note|statement|other)`
- `obligation_status text NOT NULL`
- issuer, document number, document date, and due date
- normalized minor amount, ISO currency, and exponent, all nullable as a group
- current revision, approval, creation, and archival metadata

Document identity remains separate from financial identity claims.

### Relationships and allocations

#### `financial_relationships`

Stores client, relationship type, proposed/confirmed/rejected/revoked/superseded
status, evidence strength, optional confidence basis points, source kind, legacy
source ID, reason, creator/reviewer, timestamps, and superseded relationship.

#### `financial_relationship_endpoints`

Stores relationship, endpoint role and ordinal, and exactly one of `event_id`,
`observation_id`, or `document_id`. Composite client foreign keys prevent cross-client
relationships.

#### `financial_allocations`

Stores relationship and from/to endpoints plus:

- non-negative source amount, currency, and exponent;
- non-negative target amount, currency, and exponent;
- proposed/confirmed/revoked/superseded status;
- optional exact FX basis;
- creator, timestamps, and superseded allocation.

Same-currency allocations require identical source/target amounts and exponents.

### Merge, mapping, and audit

#### `financial_merge_operations`

Stores client, survivor event, proposed/approved/applied/reversed/failed status,
requester, distinct approver, evidence, reason, timestamps, and reversal operation.

#### `financial_event_aliases`

Stores alias event, survivor event, merge operation, validity period, and reversal.
Only one active alias is permitted for an alias event. Self-aliases and cycles are forbidden.

#### `legacy_record_mappings`

Stores client, legacy table/UUID, mapping kind, exactly one canonical target,
mapping version, active/superseded/reversed status, validity period, creation
operation, and timestamp. Active `(legacy_table, legacy_id, mapping_kind)` is unique.

#### `canonical_audit_ledger`

Append-only practice/client audit entries containing actor, action, entity, operation,
before/after hashes, metadata, and timestamp. Direct update/delete privileges do not exist.

### RLS and ACL expectations

- Every client-owned read requires active practice membership and client access.
- Composite FKs provide an independent cross-client boundary.
- `anon` and ordinary authenticated roles do not directly mutate canonical tables.
- Controlled RPCs perform mutations and validate ownership.
- Service-role access does not substitute for explicit client validation.
- Membership and client-access lookup columns must be indexed for lightweight RLS checks.

---

## 4. Money and date policy

### Money

- Never use floating-point canonical money.
- Store `amount_minor bigint >= 0`.
- Store explicit direction: inflow, outflow, neutral, mixed, or unknown.
- Store uppercase ISO `currency_code char(3)`.
- Store the minor-unit exponent used at normalization time.
- Preserve raw amount and currency text.
- Parse decimal strings directly to integer minor units; never through JavaScript `number`.
- Unknown currency leaves normalized money null.
- Zero-, three-, four-, and other supported exponents are explicit.
- Cross-currency allocations store both source and target amounts.
- Fees are separate events rather than hidden differences.

### Dates and times

Keep separate source transaction, authorization, posting, value, accounting,
provider-update, receipt, and observation times. Preserve the source timezone when
known. Never invent midnight timestamps or timezones for historical date-only data.
Accounting date does not overwrite bank posted date.

---

## 5. Identity-claim model

### Strength

- **Authoritative:** provider-contract identity such as QuickBooks or Xero.
- **Strong:** exact source evidence such as account-scoped OFX FITID or artifact row.
- **Probabilistic:** versioned deterministic fingerprint.
- **Weak:** incomplete IDs, fuzzy text, or date/amount candidates.

### Namespaces

- QuickBooks: client + provider + realm + object type + external ID.
- Xero: client + provider + tenant + object type + external ID.
- OFX: client + provider + source account + FITID.
- Artifact row: client + artifact + record locator.
- Fingerprint: client + source/account context + version + digest.

### Rules

- Active authoritative/strong claims are unique.
- Conflicts stop ingestion or become explicit conflict records.
- Stored components verify hash conflicts.
- Fingerprints are never unique.
- Provider correction under the same ID appends a revision.
- Explicit provider ID replacement supersedes the old claim.
- Without explicit replacement evidence, create a new observation and proposed relationship.
- Reviewer promotion creates a manual-adjudication claim; it does not mutate a fingerprint.
- Invalidating a claim never deletes it.

---

## 6. Event and observation rules

1. Provider identity controls observation continuity, not universal factual precedence.
2. Bank posted time is authoritative only for the bank representation.
3. Accounting date is authoritative only for the ledger representation.
4. Description and counterparty text remain observation-specific.
5. Event amount is resolved only for a singular economic amount with known currency
   and exact agreement or explicit review.
6. Splits, batches, fees, and FX differences use relationships and allocations.
7. Provider corrections append revisions and recalculate fact resolution.
8. Pending→settled retains observation/event identity when provider identity is stable.
9. Conflicting authoritative sources produce an explicit conflicted state.
10. Unknown historical facts stay null.

Canonical current state derives from the active event, current observation revisions,
active fact resolutions, and active alias root.

---

## 7. Relationship and allocation model

Relationship endpoint combinations include:

| Type | Endpoints |
|---|---|
| `reconciles_with` | observation ↔ observation |
| `settles` / `partially_settles` | event ↔ document |
| `batch_contains` | event ↔ event |
| `split_into` | event/observation ↔ child event/observation |
| `refunds` | event ↔ event/document |
| `reverses` | event ↔ event |
| `transfers_to` | transfer or account-leg event ↔ counterpart |
| `supersedes` | event ↔ event or observation ↔ observation |
| `derived_from` | event/observation/document provenance |

### Allocation examples

```text
£1,000 payment event
  → £600 Invoice A
  → £400 Invoice B
```

```text
£1,000 invoice document
  ← £400 Payment A
  ← £600 Payment B
```

Confirmed allocations cannot silently exceed available amounts. Overpayment requires
an explicit credit/overpayment relationship. Changes revoke and replace allocations.

---

## 8. Legacy compatibility

| Legacy table | Initial canonical treatment |
|---|---|
| `bank_transactions` | One observation and one event per legacy row |
| `qb_transactions` | One observation and one event per legacy row |
| `bank_statement_transaction_observations` | Artifact/run provenance attached to mapped bank observation |
| `reconciliation_matches` | Proposed or confirmed observation relationship; never identity merge |
| `invoice_matches` | Event-to-document settlement relationship without invented allocation |
| `invoices` | One canonical document; no transaction event |
| `bank_statements` | Legacy import artifact and import-run mapping |
| `oauth_connections` | Provider-connection mapping |

Legacy UUIDs and `statement_id` remain unchanged. Legacy tables remain the initial UI/API
source. New mappings are additive and temporal. Canonical evidence never cascades from
a legacy table. Shadow read models compare counts, amounts, mappings, and totals before cutover.

---

## 9. Historical backfill policy

Every legacy bank/accounting row receives its own event initially:

- 618 historical bank rows → 618 observations + 618 events.
- 412 historical accounting rows → 412 observations + 412 events.

No fingerprint group is consolidated. No fuzzy or approved reconciliation match is
identity proof. Collision groups enter review. Later consolidation activates aliases
without moving observations, relationships, mappings, or UUIDs. Synthetic-looking
production history is preserved exactly.

---

## 10. Deletion and immutable audit

- Canonical evidence uses restrictive FKs and soft archive.
- Source artifact payloads may be purged under policy, but their UUID, hash, metadata,
  purge decision, and mappings remain.
- Rejected relationships, revoked allocations, prior revisions, merge operations,
  and reversals are retained.
- Legacy statement deletion remains disabled until its cascade FK is repaired later.
- Mutations append audit entries in the same database transaction.
- Merge reversal closes alias rows and recomputes read roots; nothing is restored because
  nothing was physically moved.

---

## 11. Concurrency and RPC model

Database uniqueness enforces artifact identity, import idempotency, strong claims,
one active event attachment, one active alias, active fact resolution, and active
legacy mapping.

Required transactional operations:

- `ingest_financial_artifact_v1`
- `ingest_financial_observation_v1`
- `create_financial_relationship_v1`
- `allocate_relationship_v1`
- `supersede_observation_v1`
- `merge_financial_events_v1`
- `reverse_financial_merge_v1`

Ordinary ingestion uses `READ COMMITTED` plus uniqueness and row locks. Allocation
balance checks use serializable execution or explicit `FOR UPDATE`. Merge operations
lock sorted event UUIDs and may use transaction-scoped advisory locks for coordination.
Advisory locks never replace constraints. All RPCs use a fixed search path, explicit
role/client checks, least privilege, and atomic audit writes.

---

## 12. Read migration strategy

1. **Legacy reads:** existing tables remain the UI/API source.
2. **Compatibility service:** resolve legacy UUIDs to canonical mappings without UI change.
3. **Shadow comparison:** run legacy and canonical reads side by side and compare scoped
   hashes, counts, amounts, mappings, match classifications, and reports.
4. **Selected API cutover:** feature-flag low-risk reads with legacy fallback.
5. **Reconciliation migration:** matcher consumes canonical observations and emits proposed
   relationships; legacy matches remain a compatibility projection until retirement.

Avoid independent dual writes. When canonical writes begin, legacy and canonical output
must be produced by one transaction/RPC or a durable transactional outbox.

---

## 13. Hard invariants

1. Events, observations, documents, relationships, allocations, aliases, and mappings belong to one client.
2. No cross-client relationship, allocation, attachment, or merge is possible.
3. One observation has at most one active event attachment.
4. One event may have many observations and each observation may have many revisions.
5. An active authoritative/strong identity resolves to at most one observation.
6. Provider IDs are invalid without provider organisation/object namespace.
7. OFX FITID is invalid without account namespace.
8. Artifact hash proves artifact equality only; artifact row proves observation identity only.
9. Fingerprints and fuzzy matches never cause automatic merge.
10. Reconciliation approval never means identity equivalence.
11. Document identity never equals transaction identity.
12. Every historical bank/accounting row initially owns a separate event.
13. Legacy mappings and UUIDs remain stable and temporal.
14. Revisions are monotonic, append-only, and undeletable.
15. Rejected relationships and revoked allocations remain auditable.
16. Source evidence survives statement archival or deletion.
17. Canonical evidence never cascades from legacy tables.
18. Money uses non-negative integer minor units plus explicit direction.
19. Normalized money requires currency and exponent.
20. Same-currency allocations have equal source/target values.
21. Confirmed allocations cannot silently oversubscribe an amount.
22. Overpayment requires explicit credit semantics.
23. Reversal is a separate event.
24. Provider correction preserves previous observation revisions.
25. Stable provider identity preserves pending→settled continuity.
26. Conflicting authoritative facts remain explicitly conflicted.
27. Every merge is audited, alias-based, cycle-free, and reversible.
28. Retries are idempotent and concurrent ingestion cannot duplicate strong identity.
29. Concurrent allocation cannot oversubscribe the same endpoint.
30. RLS and composite FKs independently enforce tenant boundaries.
31. Service-role routes explicitly validate the client; they do not rely on RLS bypass.
32. Shadow reads preserve legacy UUID traceability.
33. Backfill and migrations are rerunnable and idempotent.
34. No process invents unavailable client, account, provider, currency, timestamp, or identity facts.

---

## 14. Migration 010 proposed scope

### Migration 010 — additive canonical foundation

Migration 010 should create only:

- tenancy, ledger, provider, and account tables;
- import artifact/run tables;
- event, observation, attachment, and revision tables;
- fact-resolution and identity-claim tables;
- document registry;
- relationship endpoint and allocation tables;
- merge, alias, legacy mapping, and canonical audit tables;
- composite ownership constraints, partial unique indexes, RLS, ACLs, and approved
  foundational RPC contracts.

It must not:

- backfill production rows;
- modify legacy tables or FKs;
- change existing ingestion RPCs;
- create event aliases or merges;
- convert reconciliation or invoice matches;
- switch application reads;
- infer missing identity data; or
- repair/retire legacy tables.

### Later migrations

- **011:** deterministic default practice/client bootstrap.
- **012:** one-event-per-legacy-row backfill and mapping.
- **013:** statement/artifact/observation provenance backfill.
- **014:** reconciliation and invoice relationship conversion.
- **015:** compatibility views, shadow reads, and transactional dual-output support.
- Later: legacy cascade repair, selected API cutover, and eventual legacy retirement.

---

## 15. Explicitly deferred work

- Production migration creation or execution.
- Default-client and historical financial backfill.
- Reconciliation/invoice relationship conversion.
- Legacy statement cascade repair.
- API/UI read switching.
- Changes to Step 2 RPCs.
- Provider webhooks and synchronization cursors.
- Artifact storage/retention implementation.
- FX-rate sourcing.
- Merge/collision review UI.
- Materialized reporting models.
- Legacy retirement and live nightly scheduling.

---

## 16. Risks

### Critical

- Incorrect event granularity could hide splits/batches or double-count transfers.
- Unvalidated polymorphic relationships would undermine tenant isolation.
- Physical merge/repoint logic would destroy reversibility.
- Uncontrolled service-role writes could bypass ownership checks.

### High

- Incorrect default-client assignment could mis-scope legacy rows.
- Missing historical accounts/currencies limit financial interpretation.
- Allocation validation is concurrency-sensitive.
- Provider identity guarantees vary by object type.
- Raw payload retention creates privacy/security obligations.
- Alias-aware reporting must avoid double-counting member events.

### Medium/low

- The additive model increases conceptual complexity.
- RLS membership joins require careful indexes.
- Shadow reads may expose legacy inconsistencies.
- FX/overpayment accounting policy still needs product decisions.
- Names and lookup strategy may evolve during schema review.

---

## 17. Open questions for schema review

1. Should transfer legs ever be separately reportable events?
2. Is a provider batch an economic event or only a relationship container?
3. Which roles may manually resolve event facts?
4. Must all historical merges require two distinct reviewers?
5. Which QuickBooks and Xero object types have authoritative identity contracts?
6. Which raw payloads may be retained, encrypted, or purged?
7. Does client access default to all practice members or explicit grants?
8. What monetary magnitude and exponent limits are required?
9. How should overpayments and credits appear in reporting?
10. What shadow discrepancies block API cutover?
11. Should a provider Bill created from an invoice immediately create an observation,
    or only after provider read-back?
12. Should inactive aliases and revoked relationships remain queryable indefinitely?
    The recommended answer is yes.

---

## 18. Recommendation

Approve this architecture for schema review with these commitments:

- economic event as the stable root;
- separate source observations;
- one initial event per legacy financial row;
- reconciliation as relationship evidence;
- documents remaining documents;
- typed many-to-many endpoints and allocations;
- strength-aware append-only identity claims;
- non-unique fingerprints;
- logical, reversible event aliases;
- restrictive deletion and immutable audit;
- additive-only Migration 010; and
- separately reviewed backfill and read cutover.

## Review handoff

### Proposed future file

After schema approval only:

`supabase/migrations/010_additive_canonical_financial_foundation.sql`

### Review sequence

1. Approve terminology and domain boundaries.
2. Approve tenancy and RLS design.
3. Approve event/observation granularity.
4. Approve identity-key canonicalization.
5. Approve relationship and allocation constraints.
6. Approve merge/reversal mechanics.
7. Freeze the Migration 010 scope.
8. Draft and validate Migration 010 separately.

### Future critical verification

```powershell
npx supabase db reset
Set-Location zakiledger
npm test
npm run build
```

Additional SQL contract tests must prove RLS isolation, cross-client rejection,
identity concurrency, alias-cycle prevention, revision immutability, allocation
serialization, and absence of legacy-table mutation.

---

**STEP 3B DESIGN COMPLETE — READY FOR SCHEMA REVIEW**
