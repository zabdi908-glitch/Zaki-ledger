# Step 7 Day 3 — Policy Engine Implementation Contract

Date: 2026-09-05

Status: design only; no code, schema, production, provider, execution, or posting changes performed.

This contract uses the frozen Step 7 Day-1 policy contract and Day-2 initial profile bundle. It defines the minimum additive implementation required for immutable policy artifacts, deterministic evaluation, and append-only decisions. It does not alter the Step 5 execution boundary.

## Tables / Records

Minimum additive persistence consists of four new tables. All authoritative JSON is stored together with its canonicalization version and SHA-256 hash. Updates and deletes are prohibited; corrections create successor records.

### `autonomy_policy_bundles`

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `policy_version` | Unique immutable identifier, initially `step7-initial-profiles-v1` |
| `contract_version` | Frozen Day-1 contract version |
| `canonicalization_version` | Initially `step7-canonical-json-v1` |
| `evaluator_version` | Initially `step7-policy-evaluator-v1` |
| `bundle_json` | Complete reason registry, precedence, profiles, thresholds, reversibility registry, and risk registry |
| `bundle_sha256` | SHA-256 of canonical `bundle_json` |
| `published_at` | Audit metadata supplied by persistence, never read by evaluator |
| `published_by` | Human/service identity that published the bundle |
| `supersedes_bundle_id` | Optional predecessor; never mutates it |

Rules:

- Only validated, published bundles enter this table; drafts remain non-authoritative artifacts.
- `policy_version` and `bundle_sha256` are unique.
- Published rows cannot be updated or deleted.
- Every referenced profile, rule, reason code, severity, and ordering ordinal must exist inside the bundle.
- A replacement gets a new version, hash, and row.

### `client_policy_snapshots`

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `client_entity_id` | Exact canonical client |
| `policy_bundle_id` | Frozen bundle |
| `policy_bundle_sha256` | Redundant integrity binding |
| `snapshot_version` | Client-scoped monotonic version |
| `snapshot_json` | Enabled profiles, thresholds, aggregate limits, human-authorization requirements, and explicit overrides permitted by the bundle |
| `snapshot_sha256` | SHA-256 of canonical `snapshot_json` plus client and bundle binding |
| `supersedes_snapshot_id` | Optional prior snapshot |
| `recorded_at` / `recorded_by` | Persistence-only audit metadata |

Rules:

- Snapshot selection happens before evaluation; the evaluator never queries for “latest.”
- The snapshot cannot weaken a bundle hard-DENY rule or enable a profile that the bundle declares REVIEW-only.
- Missing configuration is represented explicitly and fails closed.
- Emergency suspension is a new deny-all successor snapshot, not an update.
- Unique `(client_entity_id, snapshot_version)` and unique `snapshot_sha256`.
- No update/delete.

### `normalized_policy_inputs`

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `policy_bundle_id` / `policy_bundle_sha256` | Exact bundle evaluated |
| `client_policy_snapshot_id` / `client_policy_snapshot_sha256` | Exact client policy |
| `client_entity_id` | Must equal snapshot ownership |
| `action_type` | One frozen profile identifier |
| `action_fingerprint_version` | Fingerprint contract used |
| `claimed_action_fingerprint` | Fingerprint supplied by caller |
| `computed_action_fingerprint` | Recomputed from the exact canonical action snapshot |
| `action_snapshot_json` | Immutable action semantics, including destination and treatment |
| `normalized_input_json` | Complete Day-1 input contract |
| `normalization_issues_json` | Deterministically ordered validation/unknown-input issues |
| `input_sha256` | Hash of the complete canonical semantic input envelope |
| `submitted_payload_sha256` | Audit hash of the submitted payload |
| `recorded_at` / `recorded_by` | Persistence-only metadata |

The normalized input contains, without external lookups:

- client and destination facts;
- action type and exact action snapshot;
- amount, currency, materiality band, and aggregate-limit facts;
- evidence identities, revisions, hashes, completeness, conflicts, and provenance;
- per-critical-fact confidence in integer basis points and its source;
- transaction type;
- account and tax selections, mapping snapshots, and certainty states;
- reversibility class;
- frozen history snapshot and its evidence;
- risk flags and severity;
- human authorization state, scope, fingerprint, and expiry facts;
- explicit `evaluation_as_of` when freshness rules require time comparison;
- provenance distinguishing model-supplied facts from deterministically verified facts.

No update/delete.

### `autonomy_policy_decisions`

| Field | Contract |
|---|---|
| `id` | UUID primary key |
| `decision_key` | Deterministic, globally unique content key |
| `policy_bundle_id` / hashes | Exact frozen policy identity |
| `client_policy_snapshot_id` / hashes | Exact frozen client policy |
| `normalized_policy_input_id` / `input_sha256` | Exact input evaluated |
| `action_fingerprint` | Must equal `computed_action_fingerprint` |
| `decision` | Check-constrained to `ALLOW`, `REVIEW`, or `DENY` |
| `reason_codes` | Ordered, duplicate-free reason-code array |
| `rule_trace_json` | Every triggered rule with outcome, ordinal, and relevant normalized input paths |
| `result_sha256` | Hash of decision, ordered reasons, trace, and all semantic bindings |
| `evaluator_version` | Must equal the bundle evaluator version |
| `recorded_at` | Persistence timestamp; excluded from evaluation and `decision_key` |
| `requested_by` / `correlation_id` | Audit metadata; excluded from the semantic result |

Rules:

- Append-only.
- Unique `decision_key`.
- No decision row may reference mutable or hash-mismatched records.
- Database constraints enforce client, bundle, snapshot, input, and fingerprint coherence.
- Audit timestamps do not affect outcomes.

## Pure Evaluator Contract

```text
evaluate(
  immutable_policy_bundle,
  immutable_client_policy_snapshot,
  immutable_normalized_input
) -> {
  decision: ALLOW | REVIEW | DENY,
  reason_codes: ordered reason code[],
  rule_trace: ordered rule result[],
  action_fingerprint,
  policy_version,
  evaluator_version,
  result_sha256
}
```

The evaluator:

- is synchronous and side-effect free;
- performs no database, provider, filesystem, network, environment, model, or system-clock access;
- receives all facts and explicit `evaluation_as_of` as input;
- cannot refresh evidence, authorization, mappings, history, or risk state;
- cannot execute or post;
- cannot accept AI output as authorization, risk clearance, mapping certainty, or policy configuration;
- evaluates every applicable rule without short-circuit-dependent output ordering;
- aggregates results as `DENY > REVIEW > ALLOW`;
- returns `ALLOW` only when an explicit enabled profile ALLOW rule is fully satisfied;
- uses REVIEW for recognized, correctable insufficiency or ambiguity;
- uses DENY for hard rules, unknown enums/fields, invalid bindings, unsupported actions, malformed values, invalid policy configuration, or model attempts to grant permission.

Profile behavior remains frozen from Day 2:

| Profile | Maximum v1 outcome |
|---|---|
| `ADOPT_EXISTING_VENDOR` | Narrow deterministic ALLOW |
| `CREATE_VENDOR` | REVIEW; never ALLOW in v1 |
| `CREATE_BILL` | Narrow ALLOW only with exact Day-2 conditions and exact human authorization |
| Journal, transfer, adjustment, refund, credit, payment, unknown action | DENY |

An evaluator `ALLOW` is a policy fact only. It does not transition a Step-5 posting operation and grants no provider capability.

## Canonicalization Contract

Use one new frozen specification: `step7-canonical-json-v1`.

1. Validate against the exact action-profile input schema.
2. Produce a typed normalized envelope.
3. Canonicalize using deterministic UTF-8 JSON:

   - object keys sorted according to the frozen canonicalizer;
   - no insignificant whitespace;
   - authoritative financial amounts encoded as signed integer minor units; raw/source decimal text may be retained only as non-authoritative provenance;
   - confidence encoded as integer basis points;
   - UUIDs, currency codes, hashes, enums, and timestamps normalized to their prescribed forms;
   - timestamps expressed as UTC RFC 3339 strings;
   - non-finite numbers and binary floating-point financial amounts prohibited;
   - strings normalized to Unicode NFC where the field contract permits free text;
   - absent and `null` are never treated as interchangeable;
   - set-like arrays sorted by schema-defined keys and rejected if duplicated;
   - order-sensitive arrays retain their order.

4. Unknown field, enum, profile, risk code, provenance type, certainty state, or reversibility class produces a canonical normalization issue and therefore DENY.
5. Canonicalization issues are ordered by issue code, JSON pointer, then canonical value digest.
6. No default may create a permission-granting fact. Only explicitly specified safe structural defaults may exist in the published schema.
7. Hashes are lowercase 64-character SHA-256 hex.

### Action fingerprint binding

The action snapshot is canonicalized under its declared fingerprint version and independently hashed.

```text
computed_action_fingerprint =
  SHA256(canonical(action_fingerprint_envelope))
```

For Step-5-backed actions, this must be the exact `authorized_request_fingerprint` contract already owned by Step 5—not a second approximation of the posting intent.

Required checks:

- claimed fingerprint equals recomputed fingerprint;
- authorization fingerprint equals recomputed fingerprint when authorization is required;
- client, destination, action, evidence, account/tax treatment, and disclosed child effects match the action snapshot;
- policy input and decision both bind the same computed fingerprint.

Any mismatch is hard DENY with `ACTION_FINGERPRINT_MISMATCH`. A corrected action produces a new fingerprint, normalized input, and decision key.

## Idempotency Contract

```text
decision_key = SHA256(canonical({
  namespace: "step7-policy-decision-v1",
  policy_bundle_sha256,
  client_policy_snapshot_sha256,
  normalized_input_sha256,
  computed_action_fingerprint
}))
```

Persistence uses one atomic insert-or-return-existing operation:

- No existing key: append the input and decision.
- Existing key with identical semantic hashes, outcome, ordered reasons, trace, and result hash: return the existing decision ID.
- Existing key with any mismatch: raise `DECISION_KEY_INTEGRITY_CONFLICT`; never update or append an alternative result under that key.
- Concurrent identical evaluations converge on one decision row through the unique constraint.
- Any semantic change—including evidence revision, confidence, history, authorization, risk, explicit evaluation time, client snapshot, policy version, or action fingerprint—creates a different input hash and decision key.
- Request IDs, timestamps, worker IDs, retry counts, and correlation IDs do not affect the key.

Thus:

```text
same bundle hash
+ same client snapshot hash
+ same canonical input hash
= same decision_key, decision, reasons, and result hash
```

## Audit Contract

Each decision must prove:

- which published policy bundle and client snapshot applied;
- the exact normalized input and action fingerprint;
- the source and verification state of every material fact;
- which facts were model-supplied;
- all triggered DENY, REVIEW, and ALLOW rules;
- the winning precedence;
- deterministic reason ordering;
- evaluator and canonicalization versions;
- input, bundle, snapshot, result, and submitted-payload hashes;
- requester/service identity and persistence time.

Reason ordering is independent of code traversal:

1. Outcome rank: DENY, then REVIEW, then ALLOW.
2. Frozen `reason_ordinal` from the policy bundle.
3. Reason code in ascending ASCII order as a final tie-break.
4. Duplicate reason codes collapse to one, while every matching rule remains in `rule_trace_json`.

The first reason is the primary reason. A DENY decision may retain lower-precedence REVIEW findings after all DENY reasons so the audit remains complete.

Database privileges must permit insertion through narrow functions while denying ordinary update/delete access. Immutability triggers provide defense in depth.

Step 5 remains unchanged:

```text
CorePostingSafetyGate
AND existing Step-5 human-authorization invariant
AND PostingPermissionEvaluator
```

Day 3 adds records and a pure evaluator only. It does not wire policy ALLOW to dispatch, weaken human authorization, change posting states, or import provider adapters.

## Minimum Files / Migrations

Proposed additive implementation set:

| File | Purpose |
|---|---|
| `supabase/migrations/032_step7_autonomy_policy_engine.sql` | Four tables, constraints, indexes, RLS/grants, immutability triggers, and atomic decision-recording function |
| `zakiledger/lib/autonomy-policy-contract.ts` | Frozen types, enums, reason registry types, and pure interfaces |
| `zakiledger/lib/autonomy-policy-canonicalization.ts` | Strict normalization, canonical serialization, hashing, and action-fingerprint verification |
| `zakiledger/lib/autonomy-policy-evaluator.ts` | Pure precedence and profile evaluation |
| `zakiledger/lib/autonomy-policy-store.ts` | Persistence and atomic idempotent record-or-return behavior |
| `zakiledger/policies/step7-initial-profiles-v1.json` | Frozen Day-2 bundle artifact |
| `zakiledger/tests/autonomy-policy-canonicalization.test.ts` | Canonical/hash vectors |
| `zakiledger/tests/autonomy-policy-evaluator.test.ts` | Rule and precedence tests |
| `zakiledger/tests/autonomy-policy-idempotency.test.ts` | Retry/concurrency/integrity tests |
| `zakiledger/tests/migration-032-contract.test.ts` | Additive schema and immutability proof |
| `zakiledger/tests/autonomy-policy-boundary.test.ts` | No provider/model/clock/execution dependency and unchanged Step-5 boundary |

No existing Step-5 posting, adapter, route, or migration file needs modification for Day 3.

## Targeted Test Matrix

| Area | Required proof |
|---|---|
| Golden vectors | Same bundle, snapshot, and canonical input produce byte-identical hashes, decision, reasons, and trace |
| Key-order independence | Permuted object keys produce the same input hash |
| Set normalization | Permuted risk/evidence set order produces the same hash; duplicates fail closed |
| Semantic arrays | Bill-line reordering changes the action fingerprint where order is material |
| Minor-unit safety | Signed integer minor units remain exact beyond JavaScript's safe-number range; decimal strings/numbers are never used for policy arithmetic, and malformed or inapplicable amounts fail closed |
| Unknown input | Unknown field, enum, action, risk, profile, or certainty state yields DENY |
| Precedence | Any hard DENY defeats all REVIEW and ALLOW matches |
| Ambiguity | Missing/ambiguous evidence, account, or tax treatment yields REVIEW unless a hard DENY also exists |
| Model isolation | Model confidence cannot set authorization, mappings, risk clearance, or permission |
| Vendor adoption | Only exact, unique, current, verified binding reaches ALLOW |
| Vendor creation | Every otherwise valid `CREATE_VENDOR` remains REVIEW in v1 |
| Bill creation | Exact narrow Day-2 happy path reaches ALLOW; removal of each required condition independently prevents ALLOW |
| Unsupported actions | Journal, transfer, adjustment, refund, credit, payment, and unknown actions DENY |
| Materiality | Missing threshold, unknown amount, threshold exceedance, or aggregate exceedance never ALLOW |
| History | Required history missing, insufficient, conflicting, or containing corrections/reversals prevents bill ALLOW |
| Authorization | Missing, expired, revoked, wrong-scope, or wrong-fingerprint authorization prevents ALLOW |
| Fingerprint | Claimed/computed/authorization fingerprint mismatch hard DENYs |
| Time determinism | Changing only explicit `evaluation_as_of` may change the key/result; wall-clock changes do not |
| Reason ordering | Rule traversal permutations produce identical ordered reason arrays |
| Bundle immutability | Update/delete rejected; duplicate version with different hash rejected |
| Snapshot immutability | Update/delete rejected; cross-client or bundle-hash mismatch rejected |
| Decision append-only | Update/delete rejected |
| Idempotent retry | Identical retry returns the original decision ID |
| Concurrency | Parallel identical inserts produce exactly one decision |
| Integrity conflict | Same decision key with differing content raises a hard storage error |
| Tenant isolation | Cross-client bundle/snapshot/input relationships rejected |
| Boundary | Evaluator dependency graph contains no provider adapter, model client, clock, posting service, or execution transport |
| Step 5 regression | Existing CorePostingSafetyGate and exact-human-authorization tests remain unchanged and passing |

## Blocker

No blocker to implementing and locally validating this additive Day-3 contract.

Activation remains blocked until the policy bundle, canonicalization/hash vectors, client thresholds, exact vendor identifiers, reason registry, and authorization requirements are formally ratified. Day 3 authorizes no execution, posting, or Step-5 boundary change.

STOP.
