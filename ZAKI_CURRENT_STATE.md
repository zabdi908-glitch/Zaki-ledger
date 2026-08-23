# ZAKI_CURRENT_STATE.md

## Purpose

Compact operational checkpoint for Zaki Ledger. Read `AGENTS.MD` first, then this file. Continue only from the exact current gate.

## Roadmap

Security hardening — COMPLETE

Idempotent ingestion/source identity — COMPLETE

Canonical financial model/identity — COMPLETE

Unified reconciliation engine (Step 4) — COMPLETE and post-production verified

Accounting-safe posting (Step 5) — Days 1–5 COMPLETE locally; Day 6 production preflight pending

True balance reconciliation

Autonomy Policy Engine

Audit + reversibility

Autonomous orchestration/nightly worker

Live autonomous bookkeeping

## Production identity

Supabase production project: `fqvekbzwghjurkcawpgg`

Legacy project — MUST NOT be targeted: `gzwtxebgevgapchoslmp`

Production app: `https://zaki-ledger.onrender.com`

Render branch: `main`

Render auto-deploy: OFF

Production reconciliation write freeze: OFF

## Reconciliation production baseline

Migration 013 is verified.

- Total reconciliation matches: 575
- Superseded: 252
- Live: 323
- Duplicate live-auto endpoints: 0

Step 4 is complete and post-production verification has passed.

## Step 5 — accounting-safe posting

Days 1–5 are COMPLETE locally, including adversarial staging for the narrow QuickBooks Bill path.

Local migrations `014`–`018` exist. They are **not production-applied**.

No provider execution, production migration, production write, or live provider mutation is authorized by this checkpoint.

## EXACT CURRENT GATE

**Step 5 production preflight** for the narrow QuickBooks Bill path.

Day 6 is blocked only on that preflight. Before any controlled pilot, verify:

- exact production project, app artifact/commit, and migration state;
- explicit pilot tenant/client/book/provider destination;
- eligible destination-bound posting-account and tax mappings;
- scoped idempotency identity and duplicate CREATE claim protection;
- approved evidence, intent hash, and human approval;
- expected QuickBooks Bill external object and expected database effects;
- read-only UNCERTAIN recovery path and all stop conditions.

Do not apply migrations to production, perform provider writes, deploy, or begin a pilot without separate explicit authorization after a successful preflight.

## Hard STOP rules

STOP if:

- the production project is not `fqvekbzwghjurkcawpgg`;
- the legacy project is targeted;
- artifact, migration, pilot destination, account/tax mapping, approval, evidence, or idempotency identity is missing or inconsistent;
- recovery cannot be proven read-only before any retry;
- any outcome is UNCERTAIN without a verified recovery plan;
- any proposed action exceeds the separately authorized controlled-pilot scope.

Never guess through a failed gate.

## Resume instruction

Say:

> Read `AGENTS.MD`, `ZAKI_CURRENT_STATE.md`, and the Step 5 execution-plan/contract documents. Continue only from the Step 5 production-preflight gate.
