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

-- Receipt duplicate detection matches on merchant + date + total (a receipt
-- usually has no number), so index that path.
create index if not exists invoices_receipt_identity_idx
  on invoices (lower(supplier_name), invoice_date, total)
  where document_type = 'receipt';

-- =========================================================================
-- THE MOAT: the correction ledger.
-- Append-only. Every human edit to an AI-proposed value lands here.
-- This is BOTH the audit trail (compliance) AND the training data (flywheel).
-- Never UPDATE or DELETE rows here — corrections are historical facts.
-- =========================================================================
create table if not exists corrections (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid references invoices(id),
  supplier_name  text not null,         -- key for per-vendor learning
  field          text not null,         -- which field the human changed
  ai_value       text,                  -- what the AI predicted
  human_value    text,                  -- what the human corrected it to
  ai_confidence  numeric(4,3),          -- the AI's confidence when it was corrected
  created_at     timestamptz not null default now()
);

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
  supplier_name  text not null,         -- key for per-vendor calibration
  field          text not null,         -- which field was confirmed correct
  value          text,                  -- the confirmed value (audit/explainability)
  confidence     numeric(4,3),          -- calibrated confidence shown when confirmed (trust floor)
  created_at     timestamptz not null default now()
);

-- Fast per-supplier, per-field confirmation counts for confidence calibration.
create index if not exists confirmations_supplier_field_idx
  on confirmations (lower(supplier_name), field, created_at desc);

-- =========================================================================
-- Accounting-platform OAuth connections (Xero, QuickBooks).
-- One row per provider (single-tenant MVP). Access tokens are short-lived and
-- get overwritten on every refresh; the refresh token keeps the link alive.
-- Falls back to an in-memory store when Supabase isn't configured — see
-- lib/oauth-store.ts.
-- =========================================================================
create table if not exists oauth_connections (
  provider      text primary key,        -- 'xero' | 'quickbooks'
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,    -- when the access token expires
  org_id        text,                    -- Xero tenantId / QuickBooks realmId
  updated_at    timestamptz not null default now()
);
