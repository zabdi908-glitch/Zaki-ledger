STEP_5_EXECUTION_PLAN.md

Purpose

This is the living execution plan for Step 5 — Accounting-Safe Posting.

Update this file after every meaningful gate. Do not mark work complete merely because code exists.

Lifecycle:

DESIGN → IMPLEMENTATION → LOCAL VALIDATION → ADVERSARIAL STAGING → PRODUCTION PREFLIGHT → PRODUCTION APPLICATION → POST-PRODUCTION VERIFICATION

Current State

Completed roadmap

Step 1 — Security hardening

Step 2 — Idempotent ingestion / source identity

Step 3 — Canonical financial model / identity

Step 4 — Unified reconciliation engine

Historical production repair complete

Migration 013 applied

C1–C5/C2b pass

Duplicate live-auto endpoints = 0

Freeze removed

Controlled production smoke passed

Post-production verification passed

Current production reconciliation baseline

Total matches: 575

Superseded: 252

Live: 323

Duplicate live-auto endpoints: 0

Repair audits: 252

Migration 013: present and verified

Freeze: OFF

Render commit: f6a5dd5cc952f8fd318aca44ccb4569bba794bbb

Current frontier

STEP 5 — ACCOUNTING-SAFE POSTING

Step 5 Objective

Zaki may perform a financial write only when:

tenant/client/book/provider target is deterministic,

accounting treatment is adequately evidenced,

account and tax treatment are safe,

operation is idempotent,

retries cannot duplicate entries,

external provider state can be verified,

uncertain outcomes are explicit,

recommendation is separate from permission,

ambiguity becomes REVIEW,

the whole operation is auditable.

Step 5 is not complete merely because Zaki can call a QuickBooks or Xero write endpoint.

Operating Rules

Never silently guess account, tax, category, tracking, or accounting treatment.

Reconciliation confidence is not posting permission.

AI confidence is not posting permission.

All external financial writes must pass one authoritative posting boundary.

Production writes must be idempotent.

Unknown provider outcome becomes UNCERTAIN, never blind retry.

Every operation is tenant/client/book/provider scoped.

Human correction preserves history.

Contain unsafe legacy paths before adding new capability.

Insufficient evidence becomes an exception.

Session Format

Each day is a 3-hour focused session:

00:00–00:10 — read current state and exact gate

00:10–02:30 — one focused objective

02:30–03:00 — validation, evidence, update this file, STOP

Preferred loop:

investigate → report → decide → implement → test → update

Day 1 — External Write-Path Inventory

Goal

Answer:

How many ways can Zaki currently change a client's accounting system?

Inventory every path capable of writing to QuickBooks, Xero, or another financial provider.

Search for:

create/update/delete/void

bills/invoices

expenses/purchases

payments

journals

transfers

account/category selection

tax-code selection

provider SDK calls

API routes

workers/jobs

retry logic

webhook-triggered writes

Explicitly inspect legacy areas:

extracted_items.posted_to_qb_at

extracted_items.qb_txn_id

user_merchant_preferences

merchant_ai_categories

oauth_connections

approval/posting routes

direct QuickBooks/Xero client methods

For every write path record:

provider

route/file/function

operation type

financial object

client binding

ledger-book binding

provider-connection binding

account-selection logic

tax-selection logic

evidence

approval requirement

idempotency

retry behaviour

timeout-after-success behaviour

external verification

audit behaviour

risk

Risk:

SAFE / NEEDS_HARDENING / UNSAFE / DEAD_LEGACY / UNKNOWN

Exit condition

All external write paths inventoried

Independent hidden-write search complete

Risk classification complete

No implementation performed

Day 1 Result

Status: COMPLETE
Authoritative write-path count: 6 end-to-end route/object paths (3 unique external mutation primitives)
Risk classification: SAFE 0 / NEEDS_HARDENING 0 / UNSAFE 6 / DEAD_LEGACY 0 / UNKNOWN 0
Inventory: docs/STEP_5_WRITE_PATH_INVENTORY.md
Independent hidden/direct-write search: COMPLETE — no omitted provider financial writer found
Critical findings: posting bypasses canonical client/book/provider/account binding; no durable idempotency, provider-ID retention, UNCERTAIN handling, external verification, or posting audit; QuickBooks silently selects the first Expense account and ignores tax/currency; Xero supplies no account or tax type; single approval accepts caller-supplied evidence; QuickBooks bill approval may create an unaudited Vendor.
Blockers: None

Day 2 — Posting Contract and State Machine

Goal

Define the one contract every external financial write must obey.

Required posting intent fields:

operation ID

idempotency key

client

ledger book

provider connection

source event/evidence

provider object type

amount/currency

account treatment

tax treatment

evidence/confidence

policy result

expected external state

Required states should consider:

PROPOSED → VALIDATED → AUTHORIZED → SUBMITTING → SUCCEEDED

and:

REVIEW / DENIED / FAILED_SAFE / UNCERTAIN

Critical case:

provider CREATE succeeds
→ network response is lost
→ Zaki cannot prove whether write succeeded

Required behaviour:

enter UNCERTAIN, verify external state, never blindly create again.

Exit condition

Posting contract written

State machine written

UNCERTAIN semantics written

Recommendation vs permission separated

Account/tax ambiguity rules written

Independent critique complete

Day 2 Result

Status: COMPLETE
Design artifact: docs/STEP_5_POSTING_CONTRACT.md
Authoritative boundary: AuthoritativePostingService; existing approval routes/helpers become callers only; only service-controlled provider posting adapters may mutate or verify QuickBooks/Xero financial objects.
Posting permission: permanent deterministic CorePostingSafetyGate composed with Step5DeterministicPermissionGate; exact human approval is mandatory for all current supported writes; future Step-7 policy may plug into the permission interface but cannot replace core safety.
Account identity: GAP — financial_account_id alone does not prove a provider posting/GL/nominal account; a destination-bound provider posting-account mapping with explicit provider account identity, postability, status/version, and database-enforced client/book/connection coherence is required.
State machine: PROPOSED / REVIEW / VALIDATED / AUTHORIZED / SUBMITTING / VERIFYING / FAILED_SAFE / UNCERTAIN / DENIED / SUCCEEDED.
Retry/recovery: exact key plus exact intent returns/resumes the operation; changed intent under the same scoped key is rejected; a separate source/action claim blocks the same CREATE under a different key; SUBMITTING and UNCERTAIN use read-only recovery and never blind CREATE.
Fingerprints: immutable authorized-request fingerprint is separate from append-only observed provider-state fingerprints.
Independent critique: COMPLETE — initial blocking/high findings corrected; fresh post-correction read-only review returned PASS with no completion-blocking finding.
Runtime implementation: None
Production/provider access: None
Blockers: None

Day 3 — Containment and Safety Foundation

Goal

Prevent legacy/direct writes from bypassing the authoritative posting boundary.

Target shape:

all callers
    ↓
Authoritative Posting Service
    ↓
Safety / Validation Contract
    ↓
Provider Adapter

Priorities:

contain unsafe direct writes,

route valid callers through one service,

hard ownership/provider/accounting gates,

operation identity/idempotency,

structured outcome storage,

audit evidence.

Exit condition

Unsafe bypasses contained

Operation identity implemented

Tenant/client/book/provider gates implemented

Local tests pass

No production deployment yet

Day 3 Result

Status: COMPLETE — implementation and local validation only; not deployed
Implementation: migrations 014/015; destination-bound posting-account mappings; durable operations, attempts, bindings, and events; AuthoritativePostingService core; explicit approval-route callers; non-executing provider-adapter boundary.
Containment: all six inventoried approval-to-provider write paths now terminate at AuthoritativePostingService. The legacy QuickBooks/Xero bill writers, generic QBO financial POST, implicit Vendor creation, first-Expense-account selection, and implicit provider fallback are unreachable from runtime callers.
Tests: local SQL contracts for migrations 014/015 pass; both scoped-claim concurrency harnesses pass; authoritative service tests pass (17); focused approval/bulk/boundary containment tests pass (31); TypeScript typecheck passes.
Production/provider access: None. Migration 014/015 not applied to production. No provider financial write or deployment performed.
Blockers: None

Day 4 — First Narrow Safe Posting Path

Goal

Implement one narrow, high-value posting action selected from Day 1 evidence.

Required scenarios:

normal success

exact retry → no duplicate

timeout before request → safe retry

timeout after provider success → UNCERTAIN

verification resolves UNCERTAIN

provider rejection → FAILED_SAFE

wrong client → DENY

wrong book → DENY

missing account treatment → REVIEW

ambiguous tax treatment → REVIEW

expired/disconnected connection → safe failure

Exit condition

One narrow posting path works locally

Retry/idempotency tests pass

Uncertainty recovery demonstrated

No broad autonomy enabled

Day 4 Result

Status: COMPLETE — implementation and local validation only; not deployed
Posting path: QuickBooksPostingAdapter for CREATE BILL only, invoked through AuthoritativePostingService with a fake in-memory transport. Xero remains non-executing.
Durability: migration 016 adds destination-bound provider tax-treatment mappings plus service-role-only atomic dispatch, acknowledgement, recovery, failure, observation, verified binding, and terminal-state RPCs. Migration 016 was applied only to the local Supabase instance.
Safety: dispatch requires an AUTHORIZED operation, current canonical destination and approval, one eligible destination-bound posting-account mapping, one exact active tax mapping/code/fingerprint, and a SUCCEEDED/verified ENSURE_VENDOR child. The submit attempt and AUTHORIZED -> SUBMITTING transition commit before adapter I/O. SUBMITTING/VERIFYING/UNCERTAIN retries are read-only recovery and never receive another CREATE grant.
Verification: a create acknowledgement durably retains the external Bill ID and transitions to VERIFYING; SUCCEEDED requires normalized read-back material to match the authorized account, tax, vendor, amount, currency, date, document number, lines, and expected status. Mismatch or inconclusive recovery remains UNCERTAIN.
Adversarial fixes: migration 017 revalidates retained evidence fingerprints and financial-document revision freshness immediately before an AUTHORIZED Bill dispatch. It also permits a Bill to claim/use only the exact preallocated ENSURE_VENDOR child-operation ID committed in its authorized parent intent.
Tests: final focused adversarial validation passes 61/61 Vitest tests, including 22 adversarial QuickBooks Bill probes; 22/22 SQL contract assertions pass across posting SQL 014–016; concurrency harnesses 014–016 pass, including 12-way Bill dispatch (one submit attempt and 11 recovery-only outcomes); TypeScript typecheck passes.
Production/provider access: None. No live or sandbox QuickBooks organisation was called, no production migration was applied, and no deployment occurred.
Blockers: None

Day 5 — Adversarial Staging

Attack:

double-click approval

two concurrent workers

duplicate webhook

timeout

provider 500

rate limit

DB failure after external success

app crash after external success

stale/archived account

wrong client/book

expired OAuth

duplicate document

source changes during posting

refund/negative amount

currency mismatch

tax mismatch

human correction race

cross-tenant attempt

No known path may:

duplicate financial entries,

silently guess treatment,

cross tenants/clients/books,

bypass permission,

lose provider outcome provenance.

Day 5 Result

Status: NOT STARTED
Adversarial result: TBD
Blockers: TBD

Day 6 — Production Preflight

Verify:

exact production project/environment

exact artifact/SHA

exact migration state

provider target

exact posting path

autonomy/feature controls

pilot client/book

expected external object

expected DB mutations

idempotency key

recovery/correction method

writers/locks

backup/recovery where relevant

stop conditions

Do not enable broad autonomous posting.

Exit condition

Production preflight complete

Exact pilot identified

Recovery defined

Explicit production authorization required

Day 6 Result

Status: NOT STARTED
Pilot: TBD
Artifact/SHA: TBD
Blockers: TBD

Production Application — Separate Gate

After explicit authorization, verify:

provider object exists exactly once

amount/currency correct

account correct

tax correct

client/book/provider correct

external ID retained

operation reaches valid terminal state

audit complete

exact retry is no-op or verified recovery

no unrelated financial mutations

Step 5 Completion Criteria

Do not mark Step 5 COMPLETE until:

one authoritative posting boundary exists

every supported write path uses it

unsafe legacy bypasses removed/disabled

account selection cannot silently guess

tax treatment cannot silently guess

idempotency enforced

external state verification works

UNCERTAIN handled safely

tenant/client/book/provider isolation enforced

recommendation separated from permission

every write audited

local validation passed

adversarial staging passed

production preflight passed

controlled production application passed

post-production verification passed

Progress Log

2026-08-22 — Step 5 opened

Step 4 closed and post-production verified.

Reconciliation freeze removed.

Controlled reconciliation production smoke passed.

Step 5 execution plan created.

Next task: Day 1 — External Write-Path Inventory.

2026-08-22 — Day 1 external write-path inventory complete

Authoritative count: 6 end-to-end route/object paths backed by 3 external mutation primitives.

Risk result: 6 UNSAFE; 0 SAFE / NEEDS_HARDENING / DEAD_LEGACY / UNKNOWN.

Independent source, compiled-output, dependency, SQL/script, worker, and Git-ref search found no additional provider financial writer.

Artifact: docs/STEP_5_WRITE_PATH_INVENTORY.md.

No implementation or production/provider access performed.

2026-08-22 — Day 2 posting contract and state machine complete

Artifact: docs/STEP_5_POSTING_CONTRACT.md.

Defined the single AuthoritativePostingService boundary, conservative human-mandatory Step-5 permission gate, canonical binding/evidence contract, durable operation model, separate request/provider fingerprints, explicit Vendor child operation, and guarded retry/recovery state machine.

Verified that financial_account_id is insufficient by itself and specified the minimum provider posting-account mapping gap.

Independent adversarial critique found approval-lifecycle, dispatch revalidation, duplicate-claim, Vendor binding, and transition gaps; all were corrected. Fresh post-correction review: PASS.

No runtime implementation or production/provider access performed.

2026-08-22 — Day 3 containment and safety foundation complete

Implemented the durable posting schema and authoritative non-executing service core, including scoped idempotency, duplicate CREATE claims, ownership/destination/account/evidence/approval gates, append-only histories, and permitted state transitions.

Converted single and bulk approval to explicit posting-intent callers. Removed the legacy QuickBooks/Xero financial mutation primitives and implicit provider/account selection. Added non-executing provider-adapter stubs and an enforceable runtime source/import boundary test.

Local migration contracts, concurrency harnesses, focused service/containment tests, and TypeScript typecheck pass. No production access, migration, deployment, or provider financial write occurred.

2026-08-22 — Day 4 first narrow safe posting path complete locally

Implemented QuickBooks CREATE BILL behind AuthoritativePostingService with a fake, network-free transport and explicit provider Bill payload construction.

Added migration 016 for destination-bound tax mappings and atomic dispatch/recovery/verification persistence. Local SQL contract and 12-way concurrent dispatch harness pass; exactly one caller receives a CREATE grant and all others are recovery-only.

Read-back verification covers the authorized provider account, tax code, verified Vendor child, amount, currency, date, document number, lines, and expected state. Unknown delivery or mismatched/inconclusive read-back remains UNCERTAIN; exact success retry returns the existing verified binding.

No production access, production migration, deployment, Xero implementation, or real QuickBooks call occurred.

2026-08-22 — Day 4 adversarial remediation complete locally

Fixed immediate pre-dispatch revalidation of evidence/revision freshness, preventing an AUTHORIZED Bill from dispatching after its retained evidence changes or its financial-document revision becomes stale.

Fixed exact ENSURE_VENDOR child identity binding: a Bill can claim/use only the preallocated child-operation ID committed in its authorized parent intent.

Final evidence: 61/61 focused Vitest tests, 22/22 SQL contract assertions, and concurrency harnesses 014–016 passed; TypeScript typecheck passed. No production access, deployment, production migration, or live provider call occurred.

Update Protocol

After each session update:

day's Status

findings/results

exact commit/artifact/SHA where relevant

test evidence

blockers

Progress Log

Current Next Task

Never erase failed attempts or corrections. Preserve history.

Current Next Task

Day 5 — Adversarial Staging

Day 4 exit conditions are satisfied locally. Day 5 has not started.
