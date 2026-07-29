-- Zaki Ledger — database schema
-- Run against Postgres / Supabase. Everything here is Month-1 scope.

-- Uploaded source documents (invoices/receipts).
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  storage_key   text not null,          -- key in Supabase storage
  media_type    text not null,          -- e.g. application/pdf, image/png
  uploaded_at   timestamptz not null default now()
);

-- The AI's extraction + the human-approved final values.
-- Holds both invoices and receipts — one table, one pipeline. `document_type`
-- says which; `supplier_name` holds the supplier on an invoice and the merchant
-- on a receipt (same counterparty column, so per-party learning is shared).
create table if not exists invoices (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid references documents(id),
  document_type      text not null default 'invoice',  -- invoice | receipt
  user_id            uuid references auth.users(id),  -- who approved it; null = pre-auth data
  supplier_name      text,               -- supplier (invoice) / merchant (receipt)
  invoice_number     text,               -- optional on a receipt
  invoice_date       date,
  currency           text,
  subtotal           numeric(14,2),
  tax                numeric(14,2),
  total              numeric(14,2),
  overall_confidence numeric(4,3),      -- 0.000–1.000
  status             text not null default 'pending_review',  -- pending_review | approved
  approved_at        timestamptz,
  created_at         timestamptz not null default now()
);

-- Existing deployments: add the column without touching stored rows. Anything
-- already in the table predates receipts, so the 'invoice' default is correct.
alter table invoices add column if not exists document_type text not null default 'invoice';

-- Existing deployments: add the owner column. Nullable — rows written before
-- auth existed have no owner until the first-signup backfill (see
-- app/api/auth/signup/route.ts) assigns them one.
alter table invoices add column if not exists user_id uuid references auth.users(id);

-- Receipt duplicate detection matches on merchant + date + total (a receipt
-- usually has no number), so index that path.
create index if not exists invoices_receipt_identity_idx
  on invoices (lower(supplier_name), invoice_date, total)
  where document_type = 'receipt';

-- =========================================================================
-- The pending queue: documents read but not yet approved.
-- Holding the extraction verbatim is what gives a document an ID before it is
-- approved, which is what lets a client say "approve these five" (bulk approve)
-- instead of re-uploading the whole extraction per document.
--
-- A row leaves the queue (status 'resolved') only when it reached the `invoices`
-- ledger. Blocked/errored documents stay 'pending' with the reason attached, so
-- the human can fix and re-submit them — see lib/store.ts resolvePendingDocument.
-- =========================================================================
create table if not exists pending_documents (
  id            uuid primary key default gen_random_uuid(),
  extraction    jsonb not null,          -- the InvoiceExtraction, verbatim
  filename      text,
  status        text not null default 'pending',  -- pending | resolved
  last_outcome  text,                    -- approved | blocked | error
  last_reason   text,                    -- why it was blocked/errored
  invoice_id    uuid references invoices(id),
  user_id       uuid references auth.users(id),  -- who queued it; null = pre-auth data
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Converge an EXISTING pending_documents table onto the shape above.
--
-- This is not belt-and-braces, it is the repair path for a real incident:
-- `create table if not exists` is a no-op when a table of that name already
-- exists, *whatever columns it has*. A pending_documents table created by some
-- other definition therefore survives every re-run of this file untouched, while
-- the app inserts into columns that were never there — and because the queue
-- write is deliberately non-fatal, the only symptom is documents quietly never
-- reaching the queue. Adding each column idempotently is what actually converges
-- a divergent table, the same pattern used for invoices.document_type above.
--
-- `extraction` is added nullable here even though a fresh install declares it
-- NOT NULL: adding a NOT NULL column to a table that already holds rows fails
-- outright, and a repair step that errors is a repair step nobody completes.
alter table pending_documents add column if not exists extraction    jsonb;
alter table pending_documents add column if not exists filename      text;
alter table pending_documents add column if not exists status        text not null default 'pending';
alter table pending_documents add column if not exists last_outcome  text;
alter table pending_documents add column if not exists last_reason   text;
alter table pending_documents add column if not exists invoice_id    uuid references invoices(id);
alter table pending_documents add column if not exists user_id       uuid references auth.users(id);
alter table pending_documents add column if not exists created_at    timestamptz not null default now();
alter table pending_documents add column if not exists resolved_at   timestamptz;

-- Same divergence, second symptom: a pending_documents table from an earlier
-- multi-tenant definition could carry a NOT NULL `user_id`, which nothing
-- written before the first signup could ever satisfy.
--
-- Zaki Ledger now has Supabase Auth (see lib/auth.ts, app/api/auth/signup), but
-- `user_id` stays nullable here regardless: rows written before auth existed
-- have no real owner, and the first-signup backfill (app/api/auth/signup/route.ts)
-- is what assigns them one, not a schema constraint. Once that backfill has run,
-- every row genuinely has an owner in practice, but the column keeps its
-- nullability rather than a NOT NULL nobody enforces going forward.
--
-- Guarded and non-destructive: it touches nothing on a clean install, drops no
-- data, and is safe to re-run.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'pending_documents'
      and column_name  = 'user_id'
      and is_nullable  = 'NO'
  ) then
    alter table pending_documents alter column user_id drop not null;
    raise notice 'pending_documents.user_id: dropped NOT NULL (backfilled on first signup, not enforced by schema)';
  end if;
end $$;

-- The queue view: pending only, oldest first.
create index if not exists pending_documents_queue_idx
  on pending_documents (created_at)
  where status = 'pending';

-- PostgREST (what supabase-js talks to) answers from a cached schema and will
-- keep reporting a just-added column as missing until it reloads. Supabase
-- normally reloads on DDL, but this makes the file self-sufficient: after running
-- it, the new columns are usable immediately rather than "in a minute or two".
notify pgrst, 'reload schema';

-- =========================================================================
-- THE MOAT: the correction ledger.
-- Append-only. Every human edit to an AI-proposed value lands here.
-- This is BOTH the audit trail (compliance) AND the training data (flywheel).
-- Never UPDATE or DELETE rows here — corrections are historical facts.
-- =========================================================================
create table if not exists corrections (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid references invoices(id),
  user_id        uuid references auth.users(id),  -- who made the correction; null = pre-auth data
  supplier_name  text not null,         -- key for per-vendor learning
  field          text not null,         -- which field the human changed
  ai_value       text,                  -- what the AI predicted
  human_value    text,                  -- what the human corrected it to
  ai_confidence  numeric(4,3),          -- the AI's confidence when it was corrected
  created_at     timestamptz not null default now()
);

-- Existing deployments: add the owner column without touching stored rows.
alter table corrections add column if not exists user_id uuid references auth.users(id);

-- Fast lookups when building few-shot hints for the next extraction.
create index if not exists corrections_supplier_idx
  on corrections (lower(supplier_name), created_at desc);

-- =========================================================================
-- THE OTHER HALF OF THE MOAT: the confirmation ledger.
-- Append-only. Every field the human APPROVED UNCHANGED lands here — the
-- signal that a read was correct. Corrections teach us where we were wrong;
-- confirmations teach us where we're reliably right, per supplier + field, so
-- confidence can trend up on a proven track record instead of being re-guessed
-- from scratch on every read. Never UPDATE or DELETE — these are historical facts.
-- =========================================================================
create table if not exists confirmations (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid references invoices(id),
  user_id        uuid references auth.users(id),  -- who confirmed it; null = pre-auth data
  supplier_name  text not null,         -- key for per-vendor calibration
  field          text not null,         -- which field was confirmed correct
  value          text,                  -- the confirmed value (audit/explainability)
  confidence     numeric(4,3),          -- calibrated confidence shown when confirmed (trust floor)
  created_at     timestamptz not null default now()
);

-- Existing deployments: add the owner column without touching stored rows.
alter table confirmations add column if not exists user_id uuid references auth.users(id);

-- Fast per-supplier, per-field confirmation counts for confidence calibration.
create index if not exists confirmations_supplier_field_idx
  on confirmations (lower(supplier_name), field, created_at desc);

-- =========================================================================
-- Accounting-platform OAuth connections (Xero, QuickBooks).
-- One row per (user, provider) — each bookkeeper connects their own Xero or
-- QuickBooks; Francisco's tokens never answer for anyone else's approval.
-- Access tokens are short-lived and get overwritten on every refresh; the
-- refresh token keeps the link alive. Falls back to an in-memory store when
-- Supabase isn't configured — see lib/oauth-store.ts.
-- =========================================================================
create table if not exists oauth_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id),  -- owner; null = pre-auth data
  provider      text not null,           -- 'xero' | 'quickbooks'
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,    -- when the access token expires
  org_id        text,                    -- Xero tenantId / QuickBooks realmId
  updated_at    timestamptz not null default now()
);

-- Converge an EXISTING table from the old single-tenant shape (`provider` was
-- the primary key — exactly one row per provider, globally) onto the per-user
-- shape above. Same reasoning as the pending_documents convergence block:
-- `create table if not exists` is a no-op against a table that already exists
-- with the old columns, so a real deployment needs this repair path.
alter table oauth_connections add column if not exists id uuid default gen_random_uuid();
alter table oauth_connections add column if not exists user_id uuid references auth.users(id);
update oauth_connections set id = gen_random_uuid() where id is null;
alter table oauth_connections alter column id set not null;

-- Swap the primary key from (provider) to (id), only if it hasn't been swapped
-- already — safe to re-run, no-op on a fresh install or an already-migrated one.
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'oauth_connections'
      and constraint_name = 'oauth_connections_pkey'
  ) and not exists (
    select 1 from information_schema.key_column_usage
    where table_schema = 'public' and table_name = 'oauth_connections'
      and constraint_name = 'oauth_connections_pkey' and column_name = 'id'
  ) then
    alter table oauth_connections drop constraint oauth_connections_pkey;
    alter table oauth_connections add constraint oauth_connections_pkey primary key (id);
  end if;
end $$;

-- One connection per user per provider — replaces the old global "one row per
-- provider" uniqueness now that `provider` alone is no longer the key.
create unique index if not exists oauth_connections_user_provider_idx
  on oauth_connections (user_id, provider);

-- Second reload: covers the user_id/oauth_connections changes made after the
-- first notify above, same reasoning.
notify pgrst, 'reload schema';

-- =========================================================================
-- PHASE 3: BANK RECONCILIATION ENGINE
--
-- Auto-reconciles bank statements (CSV/OFX today, PDF tomorrow) against
-- QuickBooks/Xero posted transactions. Unlike `invoices`/`corrections`/
-- `pending_documents` above, every table here is created AFTER multi-user
-- auth already existed in this app, so `user_id` is `not null` from the
-- start — there is no pre-auth data to adopt and no orphan-backfill dance
-- needed for this feature.
-- =========================================================================

-- One row per uploaded bank statement file.
create table if not exists bank_statements (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id),
  file_name               text,
  file_format             text not null,          -- 'csv' | 'ofx' | 'pdf'
  upload_date             timestamptz not null default now(),
  statement_period_start  date,
  statement_period_end    date,
  currency                text,                   -- 'GBP', 'USD', 'EUR', ...
  opening_balance         numeric(12,2),
  closing_balance         numeric(12,2),
  transaction_count       int,
  created_at              timestamptz not null default now()
);

create index if not exists bank_statements_user_idx
  on bank_statements (user_id, upload_date desc);

-- Transactions extracted from a bank statement.
create table if not exists bank_transactions (
  id                uuid primary key default gen_random_uuid(),
  statement_id      uuid not null references bank_statements(id),
  user_id           uuid not null references auth.users(id),
  transaction_date  date not null,
  posted_date       date,             -- may differ from transaction_date (pending clearing)
  merchant          text,
  description       text,
  amount            numeric(12,2) not null,  -- signed: positive = debit, negative = credit
  currency          text,
  transaction_id    text,             -- the bank's own transaction id, if present
  memo              text,
  created_at        timestamptz not null default now()
);

create index if not exists bank_transactions_statement_idx
  on bank_transactions (statement_id);
create index if not exists bank_transactions_user_idx
  on bank_transactions (user_id, transaction_date);

-- QB/Xero transactions already posted. Populated by `saveQbTransactions` in
-- lib/reconciliation-store.ts — today via the /api/reconciliation/qb-transactions
-- import route (a Session-1 stand-in), tomorrow by the live QB/Xero sync calling
-- the same store function directly. Either way this table is the single write
-- path, so the matching algorithm never cares which one populated a given row.
create table if not exists qb_transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id),
  qb_transaction_id  text,            -- QB/Xero's own id for this transaction
  qb_account_id      text,
  posted_date        date not null,
  amount             numeric(12,2) not null,
  description        text,
  account_name       text,
  account_type       text,            -- 'bank', 'expense', etc.
  currency           text,
  synced_from_qb_at  timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists qb_transactions_user_idx
  on qb_transactions (user_id, posted_date);

-- Matches between a bank transaction and a QB/Xero transaction, auto-scored
-- or manually created. `unique(bank_transaction_id, statement_id)` is what
-- makes "can't match the same bank transaction twice" a database guarantee
-- rather than an application-level promise.
create table if not exists reconciliation_matches (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id),
  statement_id          uuid not null references bank_statements(id),
  bank_transaction_id   uuid not null references bank_transactions(id),
  qb_transaction_id     uuid references qb_transactions(id),  -- null on an unmatched red-flag row
  confidence            numeric(4,3),        -- 0.000-1.000
  match_reason          text,                -- e.g. 'amount + date + merchant'
  flagged_level         text not null,       -- 'green' | 'yellow' | 'red'
  matched_by            text not null,       -- 'auto' | 'manual'
  matched_at            timestamptz not null default now(),
  approved_by           uuid references auth.users(id),
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  unique (bank_transaction_id, statement_id)
);

create index if not exists reconciliation_matches_statement_idx
  on reconciliation_matches (statement_id);

-- Bank transactions that didn't clear the matching threshold at all (as
-- opposed to a 'red' flagged_level match, which still has a best-guess
-- candidate). Recorded so a statement's unmatched items survive independent
-- of whatever the matching algorithm's current thresholds are.
create table if not exists unmatched_transactions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id),
  statement_id         uuid not null references bank_statements(id),
  bank_transaction_id  uuid not null references bank_transactions(id),
  unmatched_reason     text,        -- 'no qb entry', 'low confidence', etc.
  created_at           timestamptz not null default now()
);

create index if not exists unmatched_transactions_statement_idx
  on unmatched_transactions (statement_id);

-- One row per completed reconciliation approval — the summary a bookkeeper
-- signs off on.
create table if not exists reconciliation_reports (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id),
  statement_id             uuid not null references bank_statements(id),
  period_start             date,
  period_end               date,
  bank_opening_balance     numeric(12,2),
  bank_closing_balance     numeric(12,2),
  qb_opening_balance       numeric(12,2),
  qb_closing_balance       numeric(12,2),
  total_matched            numeric(12,2),
  total_unmatched_bank     numeric(12,2),
  total_unmatched_qb       numeric(12,2),
  variance                 numeric(12,2),
  is_reconciled            boolean not null default false,
  reconciled_at            timestamptz,
  created_at               timestamptz not null default now()
);

-- One report per statement — approving matches regenerates it in place
-- (see lib/reconciliation-store.ts generateReport, which upserts on this).
create unique index if not exists reconciliation_reports_statement_idx
  on reconciliation_reports (statement_id);

-- Append-only audit trail for match lifecycle events (created/approved/
-- rejected). Same "never UPDATE or DELETE" rule as `corrections`/
-- `confirmations` above — this is the compliance record the brief calls
-- immutable.
create table if not exists reconciliation_audit_log (
  id                        uuid primary key default gen_random_uuid(),
  reconciliation_match_id   uuid not null references reconciliation_matches(id),
  action                    text not null,   -- 'match_created' | 'match_approved' | 'match_rejected'
  action_by                 uuid references auth.users(id),
  action_at                 timestamptz not null default now(),
  old_confidence            numeric(4,3),
  new_confidence            numeric(4,3),
  notes                     text,
  created_at                timestamptz not null default now()
);

create index if not exists reconciliation_audit_log_match_idx
  on reconciliation_audit_log (reconciliation_match_id);

-- Third reload: covers every Phase 3 table added above.
notify pgrst, 'reload schema';
