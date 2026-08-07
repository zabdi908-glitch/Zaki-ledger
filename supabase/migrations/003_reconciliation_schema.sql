-- Zaki Ledger — Migration 003: Reconciliation Schema (Fresh)
-- Creates every table referenced by lib/reconciliation-store.ts,
-- lib/store.ts, and lib/oauth-store.ts, with column names and types
-- extracted directly from the actual TypeScript insert/select calls.
-- Run this in Supabase SQL Editor.

-- =========================================================================
-- 1. bank_statements — one row per uploaded bank statement file
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.bank_statements (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name               TEXT,
  file_format             TEXT NOT NULL,              -- 'csv' | 'ofx' | 'pdf'
  statement_period_start  DATE,
  statement_period_end    DATE,
  currency                TEXT,                       -- 'GBP', 'USD', 'EUR', ...
  opening_balance         NUMERIC(12,2),
  closing_balance         NUMERIC(12,2),
  transaction_count       INTEGER,
  upload_date             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_statements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own bank_statements" ON public.bank_statements;
CREATE POLICY "Users can only access their own bank_statements"
  ON public.bank_statements FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_bank_statements_user
  ON public.bank_statements (user_id, upload_date DESC);

-- =========================================================================
-- 2. bank_transactions — parsed lines from an uploaded statement
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id      UUID NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_date  DATE NOT NULL,
  posted_date       DATE,                               -- may differ (pending clearing)
  merchant          TEXT,
  description       TEXT,
  amount            NUMERIC(12,2) NOT NULL,             -- signed: positive = debit, negative = credit
  currency          TEXT,
  transaction_id    TEXT,                               -- bank's own transaction id
  memo              TEXT
);

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own bank_transactions" ON public.bank_transactions;
CREATE POLICY "Users can only access their own bank_transactions"
  ON public.bank_transactions FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_statement
  ON public.bank_transactions (statement_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_user
  ON public.bank_transactions (user_id, transaction_date);

-- =========================================================================
-- 3. qb_transactions — QuickBooks / Xero transactions synced or imported
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.qb_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  qb_transaction_id  TEXT,                               -- QB/Xero's own id
  qb_account_id      TEXT,
  posted_date        DATE NOT NULL,
  amount             NUMERIC(12,2) NOT NULL,
  description        TEXT,
  account_name       TEXT,
  account_type       TEXT,                               -- 'bank', 'expense', etc.
  currency           TEXT,
  synced_from_qb_at  TIMESTAMPTZ
);

ALTER TABLE public.qb_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own qb_transactions" ON public.qb_transactions;
CREATE POLICY "Users can only access their own qb_transactions"
  ON public.qb_transactions FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_qb_transactions_user
  ON public.qb_transactions (user_id, posted_date);

-- =========================================================================
-- 4. reconciliation_matches — auto-scored or manually created match pairs
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_matches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  statement_id          UUID NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,
  bank_transaction_id   UUID NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  qb_transaction_id     UUID REFERENCES public.qb_transactions(id) ON DELETE SET NULL,
  confidence            NUMERIC(4,3),                    -- 0.000–1.000
  match_reason          TEXT,                            -- e.g. 'amount + date + merchant'
  flagged_level         TEXT NOT NULL
                        CHECK (flagged_level IN ('green', 'yellow', 'red')),
  matched_by            TEXT NOT NULL
                        CHECK (matched_by IN ('auto', 'manual')),
  matched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by           TEXT,                            -- free-text name/email of approver
  approved_at           TIMESTAMPTZ,
  audit_memo            JSONB,                           -- structured audit memo per match
  UNIQUE (bank_transaction_id, statement_id)
);

ALTER TABLE public.reconciliation_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own reconciliation_matches" ON public.reconciliation_matches;
CREATE POLICY "Users can only access their own reconciliation_matches"
  ON public.reconciliation_matches FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_statement
  ON public.reconciliation_matches (statement_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_bank_txn
  ON public.reconciliation_matches (bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_qb_txn
  ON public.reconciliation_matches (qb_transaction_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_matches_user
  ON public.reconciliation_matches (user_id);

-- =========================================================================
-- 5. reconciliation_reports — per-statement reconciliation summary
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_reports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  statement_id             UUID NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,
  period_start             DATE,
  period_end               DATE,
  bank_opening_balance     NUMERIC(12,2),
  bank_closing_balance     NUMERIC(12,2),
  qb_opening_balance       NUMERIC(12,2),
  qb_closing_balance       NUMERIC(12,2),
  total_matched            NUMERIC(12,2),
  total_unmatched_bank     NUMERIC(12,2),
  total_unmatched_qb       NUMERIC(12,2),
  variance                 NUMERIC(12,2),
  is_reconciled            BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled_at            TIMESTAMPTZ,
  UNIQUE (statement_id)
);

ALTER TABLE public.reconciliation_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own reconciliation_reports" ON public.reconciliation_reports;
CREATE POLICY "Users can only access their own reconciliation_reports"
  ON public.reconciliation_reports FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_user
  ON public.reconciliation_reports (user_id);

-- =========================================================================
-- 6. reconciliation_audit_log — immutable audit trail for match lifecycle
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_audit_log (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_match_id   UUID NOT NULL REFERENCES public.reconciliation_matches(id) ON DELETE CASCADE,
  action                    TEXT NOT NULL,              -- 'match_approved' | 'match_unapproved'
  action_by                 TEXT,                       -- free-text name/email
  action_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_confidence            NUMERIC(4,3),
  new_confidence            NUMERIC(4,3)
);

ALTER TABLE public.reconciliation_audit_log ENABLE ROW LEVEL SECURITY;
-- Audit log is scoped by the match, which is already scoped by user_id;
-- RLS on this table is defensive belt-and-suspenders.
DROP POLICY IF EXISTS "Users can only access their own audit log" ON public.reconciliation_audit_log;
CREATE POLICY "Users can only access their own audit log"
  ON public.reconciliation_audit_log FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.reconciliation_matches
      WHERE reconciliation_matches.id = reconciliation_audit_log.reconciliation_match_id
        AND reconciliation_matches.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_reconciliation_audit_log_match
  ON public.reconciliation_audit_log (reconciliation_match_id);

-- =========================================================================
-- 7. pending_documents — extraction queue before approval
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.pending_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  extraction    JSONB NOT NULL,                         -- InvoiceExtraction verbatim
  filename      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'resolved'
  last_outcome  TEXT,                                   -- 'approved' | 'blocked' | 'error'
  last_reason   TEXT,                                   -- why blocked/errored
  invoice_id    UUID,                                   -- links to the approved invoice
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

ALTER TABLE public.pending_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own pending_documents" ON public.pending_documents;
CREATE POLICY "Users can only access their own pending_documents"
  ON public.pending_documents FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_pending_documents_user
  ON public.pending_documents (user_id);
CREATE INDEX IF NOT EXISTS idx_pending_documents_queue
  ON public.pending_documents (created_at)
  WHERE status = 'pending';

-- =========================================================================
-- 8. invoices — human-approved invoices and receipts in the ledger
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type      TEXT NOT NULL DEFAULT 'invoice',   -- 'invoice' | 'receipt'
  supplier_name      TEXT,                               -- supplier (invoice) / merchant (receipt)
  invoice_number     TEXT,
  invoice_date       DATE,
  currency           TEXT,
  subtotal           NUMERIC(14,2),
  tax                NUMERIC(14,2),
  total              NUMERIC(14,2),
  overall_confidence NUMERIC(4,3),                      -- 0.000–1.000
  status             TEXT NOT NULL DEFAULT 'approved',   -- 'pending_review' | 'approved'
  approved_by        TEXT,                               -- free-text name/email of approver
  approved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own invoices" ON public.invoices;
CREATE POLICY "Users can only access their own invoices"
  ON public.invoices FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_user
  ON public.invoices (user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON public.invoices (user_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_receipt_identity
  ON public.invoices (LOWER(supplier_name), invoice_date, total)
  WHERE document_type = 'receipt';

-- =========================================================================
-- 9. corrections — the correction ledger (append-only audit trail)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.corrections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_name  TEXT NOT NULL,                         -- key for per-vendor learning
  field          TEXT NOT NULL,                         -- which field the human changed
  ai_value       TEXT,                                  -- what the AI predicted
  human_value    TEXT,                                  -- what the human corrected it to
  ai_confidence  NUMERIC(4,3),                          -- AI's confidence when corrected
  corrected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own corrections" ON public.corrections;
CREATE POLICY "Users can only access their own corrections"
  ON public.corrections FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_corrections_supplier
  ON public.corrections (LOWER(supplier_name), corrected_at DESC);
CREATE INDEX IF NOT EXISTS idx_corrections_invoice
  ON public.corrections (invoice_id);
CREATE INDEX IF NOT EXISTS idx_corrections_user
  ON public.corrections (user_id);

-- =========================================================================
-- 10. confirmations — the confirmation ledger (append-only trust record)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.confirmations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_name   TEXT NOT NULL,                        -- key for per-vendor calibration
  field           TEXT NOT NULL,                        -- which field was confirmed correct
  confirmed_value TEXT,                                 -- the confirmed value
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.confirmations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own confirmations" ON public.confirmations;
CREATE POLICY "Users can only access their own confirmations"
  ON public.confirmations FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_confirmations_supplier_field
  ON public.confirmations (LOWER(supplier_name), field, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmations_invoice
  ON public.confirmations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_user
  ON public.confirmations (user_id);

-- =========================================================================
-- 11. oauth_connections — accounting-platform OAuth tokens
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL
                CHECK (provider IN ('quickbooks', 'xero')),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  org_id        TEXT,                                   -- Xero tenantId / QuickBooks realmId
  expires_at    TIMESTAMPTZ NOT NULL,                   -- when the access token expires
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE public.oauth_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can only access their own oauth_connections" ON public.oauth_connections;
CREATE POLICY "Users can only access their own oauth_connections"
  ON public.oauth_connections FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_connections_user
  ON public.oauth_connections (user_id);

-- =========================================================================
-- PostgREST schema reload — makes new columns visible immediately
-- =========================================================================
NOTIFY pgrst, 'reload schema';