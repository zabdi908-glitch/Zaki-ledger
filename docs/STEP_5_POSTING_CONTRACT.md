# Step 5 Day 2 — Authoritative Posting Contract and State Machine

Date: 2026-08-22

Status: design complete; no runtime implementation and no production/provider access performed.

## Scope and Decision

Every external accounting mutation must enter through one application boundary:

```text
API routes / approval flows / workers
                 |
                 v
     AuthoritativePostingService
       |       |          |
       |       |          +-- durable operation, attempt, observation, and audit state
       |       +------------- deterministic validation + posting-permission interface
       +--------------------- provider posting adapters
                                  |
                                  +-- QuickBooks mutation/read-back client
                                  +-- Xero mutation/read-back client
```

`AuthoritativePostingService` owns operation identity, canonical target resolution, validation, authorization, permission, state transitions, execution leases, recovery, verification, and audit. A route, approval helper, or worker may propose or resume an operation, but may not call an external financial mutation directly.

The six Day-1 paths are contained by this one boundary. The existing single and bulk approval routes, `bulkApprove`, `approveOne`, and `postApprovedBill` become callers only. Existing `createQuickBooksBill`, `findOrCreateVendor`, `createXeroDraftBill`, and generic write-capable `qboPost` are not public posting entry points. Their mutation logic must either move behind narrow provider adapters or be made unreachable except through those adapters.

Only provider posting adapters invoked by `AuthoritativePostingService` may contact QuickBooks or Xero for a financial mutation. Read-back methods used for recovery and verification are also adapter methods controlled by the service. OAuth token refresh remains provider control-plane behaviour, not a financial mutation, but the adapter must use the exact validated canonical provider connection.

This design covers CREATE because that is the only current financial mutation. Future UPDATE, VOID, DELETE, PAYMENT, JOURNAL, TRANSFER, and other mutations must use the same boundary and define action-specific validation and recovery before they become supported.

## Step 5 Posting Intent

A posting proposal contains, at minimum:

| Area | Required durable fields |
|---|---|
| Operation identity | `operation_id`, service-validated `idempotency_key`, immutable scoped idempotency namespace, deterministic source/action claim identity, operation kind, object type, action, intent schema version, optional parent operation ID |
| Canonical destination | `client_entity_id`, `ledger_book_id`, `provider_connection_id`, provider, external organisation/realm/tenant identity snapshot |
| Requested financial object | canonical, provider-neutral requested object including supplier/contact identity, dates, reference, currency, amounts, lines, and action-specific fields |
| Evidence | durable source/evidence IDs, evidence type, revision/version, content hashes, provenance, and the facts each item supports |
| Account treatment | canonical posting-account mapping ID and immutable mapping snapshot for each line requiring an account, or an explicitly schema-permitted `NOT_APPLICABLE` disposition with reason |
| Tax treatment | canonical tax-treatment/mapping ID and immutable selection snapshot for each line or document requiring tax, or an explicitly schema-permitted `NOT_APPLICABLE` disposition with reason |
| Decision records | recommendations, deterministic validation result and rule-set version, human authorization record, posting-permission decision and evaluator version |
| Expected outcome | expected provider-neutral material state and its canonicalization version, without an external object ID before one is known |

Amounts use an exact decimal representation and currency uses a canonical currency code. The contract must reject malformed, missing, or internally inconsistent financial values; it may not coerce a missing or invalid amount to zero.

### Immutable authorized/requested-object fingerprint

`authorized_request_fingerprint` is a versioned cryptographic hash of a canonical serialization of all semantic and authorization-relevant intent, including:

- operation kind, external object type, and action;
- canonical client, ledger book, provider connection, provider, and external organisation identity;
- requested financial object and expected material outcome;
- evidence identities, revisions, content hashes, and relevant provenance;
- account and tax treatment IDs plus immutable mapping/selection snapshots;
- parent/child operation relationship and disclosed compound side effects;
- intent schema version and deterministic validation rule-set version.

The operation's own ID, scoped idempotency key, approval record ID, timestamps, attempt count, OAuth secrets, provider response, provider object ID, and other transport/runtime fields are not hashed into its semantic requested object. They are durably bound to the resulting fingerprint separately. A parent compound intent is different: its semantic requested object includes the exact identities, keys, and fingerprints of its disclosed child operations. Human authorization and posting permission must name the exact parent or standalone fingerprint. Once the operation reaches `AUTHORIZED`, neither the fingerprint nor any input it covers may change. A changed input is a new intent requiring a new operation/idempotency key and new authorization.

### Provider-state fingerprint

`provider_state_fingerprint` is separate. It is a versioned hash of the normalized, material provider object observed after execution or during recovery/read-back, including the provider connection and organisation, external object type and ID, status, currency, amounts, lines, applied provider account/tax identities, and other action-specific material fields. Provider version/sync-token metadata and observation time are stored with the observation; canonicalization specifies whether each is material to the hash.

The provider-state fingerprint:

- is created only from provider state actually observed;
- never substitutes for the authorized-request fingerprint or an idempotency key;
- is retained for every material read-back, not overwritten;
- is compared with the expected material projection derived from the authorized request;
- cannot produce `SUCCEEDED` merely because an external ID exists.

## Canonical Binding Requirements

Before permission can be `ALLOW`, and again atomically immediately before dispatch, the service must prove all of the following from canonical records:

1. The actor is authorized for the exact `client_entity_id` and requested posting action.
2. The `ledger_book_id` belongs to that client and is the intended book.
3. The active `provider_connection_id` belongs to the same client and is bound to that ledger book.
4. The adapter provider and external organisation identity exactly match the validated provider connection.
5. Every account and tax mapping belongs to the same client, book, provider connection, and provider organisation and is active for the requested effective date.
6. The ledger book, connection, account/tax mappings, actor authority, and human authorization are still active and valid at dispatch; credential refresh must not change the canonical provider/organisation destination.

User ownership and `oauth_connections(user_id, provider)` are not sufficient destination bindings. A provider fallback such as “Xero if present, otherwise QuickBooks” is prohibited.

## Account Identity Finding

Verdict: **GAP**.

The current canonical `financial_accounts` model is not sufficient by itself to identify a provider posting/GL/nominal account:

- it has canonical client scope and optional ledger-book/provider-connection scope;
- `account_kind` is only constrained to non-empty text;
- `stable_account_key_canonical` is an opaque optional key with no repository-defined format that proves it is a QuickBooks/Xero Account object ID or Xero nominal code;
- the schema defines no postable/GL role, provider account type, active posting eligibility, or explicit mapping from a canonical account to the provider Account object used in a write;
- repository search found no population or posting lookup contract for `financial_accounts` and no separate chart-of-accounts mapping entity.

Therefore a bare `financial_account_id` must not authorize provider posting.

The minimum missing canonical construct is a provider posting-account mapping, with:

- its own immutable mapping ID;
- `financial_account_id`, `client_entity_id`, `ledger_book_id`, and `provider_connection_id` bound by composite ownership constraints;
- provider and external organisation identity;
- required explicit `provider_account_id`; optional provider account code and display snapshot;
- a typed posting/GL/nominal role distinct from source bank/card/control-account identity;
- provider account type/subtype snapshot, status, and deterministic postable/active eligibility;
- effective/observed/provider-updated version data sufficient to reject stale or archived mappings;
- uniqueness of provider account identity within a provider connection and prevention of conflicting active mappings.
- non-null, database-enforced three-way coherence: the mapping's financial account, ledger book, and provider connection all belong to the same client, and the provider connection is bound to that exact ledger book.

The mapping may extend `financial_accounts` or be a separate entity, but these semantics and constraints are required. Implementation naming and provider synchronization are deferred. Account selection is explicit and evidence-backed; missing or ambiguous treatment is `REVIEW`, while a cross-scope, inactive, stale, or prohibited mapping is `DENY`. “First Expense account,” provider defaults, merchant preference, and AI category are recommendations at most, never posting account identity.

## Tax Treatment

Each operation schema declares whether tax treatment is required. When required, the intent must contain an explicit canonical treatment plus the exact provider tax mapping for the validated destination and effective date. The selection must explain how document tax, line tax, inclusive/exclusive treatment, exemptions, reverse charge, recoverability, and rounding are handled to the extent applicable to the action.

Missing, ambiguous, conflicting, stale, or unmapped tax treatment is never defaulted by Zaki or intentionally delegated to an undocumented provider default. Correctable ambiguity is `REVIEW`; a cross-scope, inactive, prohibited, or deterministically contradictory mapping is `DENY`. An operation may use `NOT_APPLICABLE` only where its action schema deterministically permits it, such as Vendor master-data creation.

## Evidence Contract

Evidence is durable and revision-bound. A mutable request body or an extraction confidence number alone is not evidence. The service requires:

- source objects that belong to the same canonical client and book context;
- immutable revision IDs/content hashes and provenance;
- enough evidence to support object identity, supplier/contact, amount, currency, dates, account treatment, and tax treatment as required by the action;
- deterministic arithmetic and currency validation;
- no unresolved material conflict, tamper indication, unsupported synthetic/live crossover, or source change after authorization.

Confidence expresses recommendation quality only. It neither proves evidence sufficiency nor grants permission. Any source revision after authorization invalidates the authorization and prevents submission.

## Decision Separation and Posting Permission

The following are distinct durable decisions:

1. **Recommendation** proposes account, tax, classification, or action. It may come from rules, user history, or AI. It has provenance and confidence but grants no write authority.
2. **Validation** deterministically checks schema, arithmetic, evidence, ownership, bindings, mappings, supported operation rules, and conflicts. It cannot supply missing human judgment.
3. **Human authorization** records an authorized actor's explicit approval of the exact authorized-request fingerprint, destination, external object/action, accounting/tax treatment, and disclosed compound side effects.
4. **Policy permission** is the final machine-enforced decision from a stable interface. It cannot repair invalid input or infer approval.

### Stable permission interface

Step 5 defines:

```text
PostingPermissionEvaluator.evaluate(validated_context)
  -> PermissionDecision {
       decision: ALLOW | REVIEW | DENY,
       reason_codes,
       authorized_request_fingerprint,
       evaluator_name,
       evaluator_version,
       decided_at
     }
```

The service permanently owns a non-replaceable `CorePostingSafetyGate` for deterministic schema, ownership, target, evidence, account/tax, idempotency, state, and dispatch-time checks. It then calls the stable permission extension:

```text
final decision = CorePostingSafetyGate AND PostingPermissionEvaluator
```

The Step-5 permission implementation is a conservative `Step5DeterministicPermissionGate`, not the future Step-7 Autonomy Policy Engine. For every currently supported external write it requires:

- all deterministic safety rules to pass;
- an authorized human with action permission to have approved the exact current fingerprint;
- no stale evidence, target, account, tax, connection, approval, or conflicting operation;
- no autonomous posting path.

Human approval is necessary but cannot override a hard deterministic `DENY`. A deterministic pass without exact human approval is `REVIEW`, not `ALLOW`.

Step 7 may later compose an additional decision through the same `PostingPermissionEvaluator` interface, but may not replace or bypass `CorePostingSafetyGate`. For current supported writes, the service also treats exact human authorization as a mandatory invariant outside the extension result, so an extension-provided `ALLOW` alone cannot dispatch. Removing that invariant for a future autonomous action is a separate Step-7 design, authorization, and rollout, not an implementation substitution inside Step 5. Adding Step 7 is not a Step-5 prerequisite and cannot bypass idempotency, state, verification, or audit invariants.

### Exact decision conditions

`ALLOW` occurs only when every required field is present, deterministic validation passes, evidence is sufficient and current, all client/book/provider/account/tax bindings are exact and active, the action is supported, an authorized human approved the exact fingerprint, the Step-5 deterministic permission rules pass, and no idempotency conflict or active uncertain/conflicting operation exists.

`REVIEW` occurs for a correctable absence or ambiguity that requires human input or refreshed evidence without proving the requested action prohibited: missing/stale approval; insufficient or conflicting evidence; missing/ambiguous account or tax treatment; unaccepted recommendation; unresolved supplier/contact choice; or a reviewer-required supported decision. `REVIEW` cannot reach an adapter.

`DENY` occurs for a hard safety or authorization failure: cross-tenant/client/book/provider binding; unauthorized actor; idempotency-key reuse with different intent; inactive/prohibited destination or mapping; evidence ownership/tamper failure; unsupported action/currency/object; invalid arithmetic or amount; synthetic/demo evidence targeting a live provider; attempt to bypass the boundary; or an attempted new CREATE while the same operation is `SUBMITTING`, `UNCERTAIN`, or `SUCCEEDED`. `DENIED` cannot reach an adapter.

`REVIEW` and `DENIED` are explicit durable posting-operation states. They are not transient HTTP results.

## Vendor Creation

QuickBooks Vendor creation is a separate child posting operation, not a helper hidden inside Bill submission.

- The parent Bill intent discloses and authorizes the possible `ENSURE_VENDOR` side effect.
- The child has its own operation ID, scoped idempotency key, authorized-request fingerprint, state, attempts, provider object binding, verification, and audit, and references the parent.
- Before human approval, the parent fingerprint commits to the exact child operation ID, child scoped idempotency key, child authorized-request fingerprint, requested canonical supplier identity, and requested Vendor fields. A later child change invalidates parent authorization.
- Account and tax treatments are explicitly `NOT_APPLICABLE` under the Vendor action schema.
- Exact lookup of an existing Vendor is a read/verification phase. Display name alone is not durable idempotency or sufficient identity where it can be ambiguous. Reuse requires a durable canonical supplier-to-provider-object binding scoped to the same client, ledger book, provider connection, and external organisation, carrying the provider Vendor ID and a current verified observation. Missing or conflicting identity is `REVIEW`.
- If creation is needed, the child must be authorized under the disclosed parent approval and pass the same permission boundary.
- The Bill cannot submit until the Vendor child is `SUCCEEDED` with a verified provider Vendor ID.
- If the Vendor outcome is `UNCERTAIN`, the parent remains blocked; the service recovers the Vendor operation and never creates another Vendor blindly.

## Durable State

The minimum durable model is:

1. **Posting operation** — identity/scope, intent version, immutable requested object and fingerprint, evidence and treatment snapshots, current state, parent operation, expected state, authorization and permission references, timestamps, and row version.
2. **Posting authorization/decision records** — append-only recommendation, validation, human approval, and permission results, each bound to the fingerprint and version that it evaluated.
3. **Posting attempt** — append-only attempt ID/number, execution lease, adapter/provider operation, request fingerprint, dispatch timestamps, provider correlation/request identifiers when available, response/error classification, and proof supporting `FAILED_SAFE` or `UNCERTAIN`.
4. **Provider object binding and observations** — canonical operation-to-provider object identity, provider connection/organisation, external object ID, append-only normalized read-backs, provider-state fingerprints, comparison outcome, and observation time/version.
5. **Posting transition audit** — append-only actor/service, prior/new state, reason code, related decision/attempt/observation, and time for every transition and recovery action.
6. **Provider posting-account mapping** — the missing canonical construct specified above. Equivalent destination-bound tax mappings are required wherever tax applies.

The database must enforce the scoped idempotency uniqueness and ownership relationships. Logs alone, HTTP responses, `extracted_items.posted_to_qb_at`, `extracted_items.qb_txn_id`, and mutable pending-document state do not satisfy this model.

## Idempotency and Retry Contract

The idempotency namespace is at least `(client_entity_id, ledger_book_id, provider_connection_id, external_object_type, action, idempotency_key)`, protected by a database unique constraint. Creation/lookup is atomic. Callers may propose a key, but the service validates or derives it; routes may not mint arbitrary replacement keys to bypass an existing operation.

CREATE also requires an atomic durable source/action claim independent of the caller key. For a source-backed Bill this claim binds the canonical client, book, provider connection, external object/action, immutable source identity and revision, and action-specific posting subject. For `ENSURE_VENDOR` it binds the canonical supplier identity and destination. A second idempotency key claiming the same business effect returns the existing operation or an explicit conflict; it cannot create another operation. Legitimate repeat posting requires a separately authorized, append-only override/generation identity that makes the new business effect explicit and cannot be inferred by a route or retry.

- Exact same scoped idempotency key plus the same authorized-request fingerprint returns the existing operation and either returns its outcome or resumes only the state-appropriate workflow.
- The same scoped key with different semantic intent/fingerprint is rejected as `IDEMPOTENCY_CONFLICT`. It never mutates the existing intent and never creates a second operation.
- `SUCCEEDED` retries return the existing verified object/outcome without a mutation call.
- `SUBMITTING` retries enter recovery. They do not issue another CREATE. A stale execution lease, process loss, or absent response is not proof that the provider did nothing.
- `UNCERTAIN` retries enter verification/recovery only. They do not issue another CREATE.
- `FAILED_SAFE` is permitted only with durable, provider/action-specific proof that the write was not accepted or did not take effect. Retrying the same operation requires a fresh validation/permission pass and explicit retry authorization, then creates a new append-only attempt under the same operation.

Where a provider offers a provider-side idempotency token or stable request identifier, the adapter must use and persist it, but provider support is defense in depth and does not replace the local operation contract.

## Final State Machine

This table is the authoritative transition definition:

| From | To | Required guard | Permitted provider activity |
|---|---|---|---|
| `PROPOSED` | `VALIDATED` | Immutable intent passes deterministic validation | None |
| `PROPOSED` | `REVIEW` | Correctable ambiguity or missing human decision | None |
| `PROPOSED` | `DENIED` | Hard safety/authority failure | None |
| `REVIEW` | `VALIDATED` | Non-semantic review input, including approval of the unchanged exact fingerprint, is supplied and deterministic validation is rerun | None |
| `REVIEW` | new `PROPOSED` operation/revision | A semantic intent field changes; prior operation/revision is preserved and superseded | None |
| `REVIEW` | `DENIED` | Hard failure is established | None |
| `VALIDATED` | `AUTHORIZED` | Exact human authorization exists, core safety passes, permission evaluator returns `ALLOW` | None |
| `VALIDATED` | `REVIEW` | Correctable/approval input remains missing or ambiguous | None |
| `VALIDATED` | `DENIED` | Core safety or permission returns hard denial | None |
| `AUTHORIZED` | `SUBMITTING` | Atomic dispatch-time revalidation passes; execution lease and attempt are durably committed | Exact authorized mutation only, after transition commit |
| `AUTHORIZED` | `REVIEW` | Dispatch-time revalidation finds a correctable stale input or revoked/stale approval | None |
| `AUTHORIZED` | `DENIED` | Dispatch-time revalidation finds a hard safety or authority failure | None |
| `SUBMITTING` | `VERIFYING` | Provider acknowledgement/outcome or recovery evidence is available | Read/query only |
| `SUBMITTING` | `FAILED_SAFE` | Durable action-specific proof establishes request was not accepted/took no effect | None |
| `SUBMITTING` | `UNCERTAIN` | Timeout, crash, lost/malformed response, or any ambiguous outcome | None |
| `VERIFYING` | `SUCCEEDED` | Read-back exists and normalized material state matches authorized expected state | Read/query only |
| `VERIFYING` | `FAILED_SAFE` | Conclusive provider/action-specific evidence proves no write took effect | Read/query only |
| `VERIFYING` | `UNCERTAIN` | Unavailable/ambiguous result, multiple candidates, inconclusive absence, or material mismatch | Read/query only |
| `UNCERTAIN` | `VERIFYING` | Recovery starts using original operation/attempt identity | Read/query only; never CREATE |
| `FAILED_SAFE` | `VALIDATED` | Explicit retry authorization recorded and unchanged intent is revalidated | None; a later authorized submission creates a new attempt under the same operation |

`DENIED` is terminal for that immutable intent. `SUCCEEDED` is terminal for that immutable CREATE intent.

Approval of an unchanged fingerprint is non-semantic decision input and may move `REVIEW -> VALIDATED` under the same operation and key. A semantic correction from `REVIEW` is preserved and superseded by a new immutable intent revision with a new key. Reuse of the old scoped key for changed intent is rejected. A denied intent is never changed in place.

### Transition invariants

1. Only `AuthoritativePostingService` changes operation state; adapters return typed observations/outcomes and cannot authorize or transition operations.
2. Only `AUTHORIZED` may enter `SUBMITTING`. In the same transaction that acquires the execution lease and records the attempt, the service locks/rechecks the operation and all mutable authorization predicates: current actor/action authority, human-authorization validity, ledger-book and provider-connection status/binding, external organisation identity, evidence revisions, account/tax mapping status/eligibility, source/action claim, and absence of conflicting operations. Any failure transitions to `REVIEW` or `DENIED` without a provider call.
3. The adapter may mutate only the exact validated provider connection/organisation and object/action carried by its execution grant.
4. All authorization-covered fields are immutable from `AUTHORIZED` onward: idempotency scope/key, client, book, provider connection/organisation, object/action, parent/child structure, requested object, evidence revisions/hashes, account treatment/mapping snapshot, tax treatment/mapping snapshot, expected material state, authorized-request fingerprint, human approval, validation rule version, and permission decision/version.
5. Concurrent exact submissions serialize on the posting operation. At most one execution lease and mutation attempt may be active.
6. The database-enforced source/action claim serializes semantically duplicate CREATE proposals even when callers present different idempotency keys.
7. `SUBMITTING` or `UNCERTAIN` never transitions to a new CREATE attempt without conclusive action-specific proof of non-creation and the `FAILED_SAFE` reauthorization path.
8. A process crash, database failure after possible external success, connection loss, timeout, malformed response, or missing response that cannot prove non-acceptance produces `UNCERTAIN`.
9. `SUCCEEDED` requires a durable provider object binding and a provider read-back whose normalized material state matches the authorized expected state. A create-response ID alone is insufficient.
10. A read-back material mismatch is `UNCERTAIN` with a mismatch reason, never silently normalized to success. It requires controlled recovery/review; it must not trigger a duplicate CREATE.
11. `FAILED_SAFE` requires stored evidence sufficient to prove no external mutation occurred. Provider 5xx, timeout, transport error after dispatch, or “not found” alone when provider search is not conclusive is not sufficient.
12. Every decision, transition, dispatch, provider response, read-back, recovery query, and manual intervention is append-only audited with the canonical target and actor/service identity.
13. Vendor creation and every other compound side effect obey the same state machine as distinct parent-linked operations. The parent fingerprint commits to every required child fingerprint and identity, and a parent cannot succeed while a required child is unresolved.
14. Direct provider mutation outside this boundary is denied by code structure and, where possible, import/module and runtime capability controls; discovery of an uncontained writer blocks promotion.

## UNCERTAIN Recovery

Recovery uses the original operation, original authorized-request fingerprint, exact provider destination, persisted attempt metadata, and adapter-specific non-mutating lookup/read-back strategies. It first tries a known external ID/provider request identifier and then only action-specific deterministic correlation that is strong enough to avoid confusing a pre-existing object with this operation.

Recovery outcomes are:

- matching object found and verified: `VERIFYING -> SUCCEEDED`;
- conclusive provider evidence that the request was not accepted and no object exists: `VERIFYING -> FAILED_SAFE`, after which reauthorization is required before a new attempt;
- object found but material state differs, multiple candidates, provider unavailable, or absence not conclusive: return/remain `UNCERTAIN` and require further recovery or human investigation.

No age threshold converts uncertainty into permission to create again.

## Legacy Paths That Must Be Blocked

The following may not retain a direct financial-write capability:

- `POST /api/approve` calling `postApprovedBill` as a direct writer;
- `POST /api/approve/bulk`, `bulkApprove`, or `approveOne` calling `postApprovedBill` as a direct writer;
- `postApprovedBill` selecting a provider or calling QuickBooks/Xero mutation helpers;
- `createQuickBooksBill` and `findOrCreateVendor` acting as callable service-layer posting APIs;
- `createXeroDraftBill` acting as a callable service-layer posting API;
- generic `qboPost` exposure to application callers;
- any future route, worker, webhook, script, retry handler, or reconciliation/approval flow that holds provider financial-mutation capability outside the adapter boundary.

The legacy `oauth_connections` user/provider lookup cannot be used as the posting destination contract. The unused `extracted_items.posted_to_qb_at` and `extracted_items.qb_txn_id` fields cannot be revived as operation identity, idempotency, or proof of verified success.

## Independent Adversarial Critique

A separate read-only architecture review attacked the draft against the Day-2 exit conditions and current canonical table definitions. It initially returned `BLOCKED`. Its findings were resolved in this artifact as follows:

| Finding | Resolution |
|---|---|
| Missing approval trapped an unchanged operation in `REVIEW` | Added non-semantic `REVIEW -> VALIDATED` reevaluation under the same operation/key; semantic corrections still create preserved successor revisions |
| A future Step-7 evaluator could replace the safety gate | Made `CorePostingSafetyGate` permanent and non-replaceable; permission is composed, and current human authorization is a service invariant |
| Authorization could become stale before dispatch | Added an atomic pre-dispatch recheck of actor authority, approval, book, connection, organisation, evidence, mappings, and duplicate claims |
| Different caller keys could represent the same CREATE | Added a database-enforced source/action business-effect claim independent of idempotency key |
| Parent approval did not exactly bind Vendor child intent | Parent fingerprint now commits to the child operation identity, key, fingerprint, supplier identity, and requested Vendor fields |
| Existing Vendor reuse identity was underspecified | Required a current, destination-scoped canonical supplier-to-provider Vendor binding; ambiguous identity is `REVIEW` |
| State diagram omitted `VERIFYING -> FAILED_SAFE` | Replaced the diagram with one authoritative guarded transition table including permitted provider activity |
| Account mapping needed three-way coherence | Required non-null database-enforced client/book/connection/account coherence |

The independent reviewer did not modify files or access a provider, production system, or internet resource. A fresh post-correction read-only review returned `PASS` with no `BLOCKER` or `HIGH` finding preventing Day-2 completion.

## Day 2 Exit Review

- Posting contract written: **YES**
- One authoritative boundary and allowed direct provider contact defined: **YES**
- State machine and transition invariants written: **YES**
- `UNCERTAIN` recovery and no-blind-retry semantics written: **YES**
- Recommendation, validation, human approval, and policy permission separated: **YES**
- Conservative Step-5 permission gate independent of Step 7 defined: **YES**
- Account and tax ambiguity rules written: **YES**
- Current canonical account identity verified and minimum gap specified: **YES**
- Authorized-request and provider-state fingerprints separated: **YES**
- Same-key retry/conflict semantics defined: **YES**
- Independent critique and post-correction verification: **COMPLETE — PASS**
- Runtime implementation or production/provider access: **NO**
