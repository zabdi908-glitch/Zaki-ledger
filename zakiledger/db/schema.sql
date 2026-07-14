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
create table if not exists invoices (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid references documents(id),
  supplier_name      text,
  invoice_number     text,
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
