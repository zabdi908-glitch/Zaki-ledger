-- Zaki Ledger — Initial Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users profile (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  practice_name TEXT,
  plan_tier TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- OAuth connections (QB / Xero)
CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('quickbooks','xero')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  realm_id TEXT,
  expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ DEFAULT now(),
  last_synced_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(user_id, provider)
);

-- Documents (invoices, receipts, bank statements)
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('invoice','receipt','bank_statement')),
  storage_path TEXT,
  file_size INTEGER,
  mime_type TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Extracted items from documents
CREATE TABLE IF NOT EXISTS public.extracted_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  merchant TEXT,
  merchant_confidence INTEGER CHECK (merchant_confidence BETWEEN 0 AND 100),
  invoice_number TEXT,
  invoice_number_confidence INTEGER CHECK (invoice_number_confidence BETWEEN 0 AND 100),
  transaction_date DATE,
  date_confidence INTEGER CHECK (date_confidence BETWEEN 0 AND 100),
  amount DECIMAL(12,2),
  amount_confidence INTEGER CHECK (amount_confidence BETWEEN 0 AND 100),
  tax_amount DECIMAL(12,2),
  tax_confidence INTEGER CHECK (tax_confidence BETWEEN 0 AND 100),
  category TEXT,
  category_confidence INTEGER CHECK (category_confidence BETWEEN 0 AND 100),
  overall_confidence INTEGER CHECK (overall_confidence BETWEEN 0 AND 100),
  reason TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','posted')),
  posted_to_qb_at TIMESTAMPTZ,
  qb_txn_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Bank transactions (parsed from statements)
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  transaction_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  direction TEXT CHECK (direction IN ('debit','credit')),
  reference TEXT,
  parsed_merchant TEXT,
  status TEXT DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','flagged','approved')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Reconciliation matches (bank_txn ↔ extracted_item)
CREATE TABLE IF NOT EXISTS public.reconciliation_matches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  extracted_item_id UUID REFERENCES public.extracted_items(id) ON DELETE SET NULL,
  match_type TEXT CHECK (match_type IN ('exact','fuzzy','reference','manual')),
  confidence INTEGER CHECK (confidence BETWEEN 0 AND 100),
  detail TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  amount_diff DECIMAL(12,2),
  date_gap_days INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- User merchant preferences (learning engine)
CREATE TABLE IF NOT EXISTS public.user_merchant_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  category TEXT NOT NULL,
  time_window_start INTEGER,
  time_window_end INTEGER,
  amount_min DECIMAL(12,2),
  amount_max DECIMAL(12,2),
  day_of_week INTEGER,
  approval_count INTEGER DEFAULT 0,
  confidence_score INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, merchant_key, category)
);

-- Audit log
CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  change_summary TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Invoice matches (bank txn ↔ invoice by reference)
CREATE TABLE IF NOT EXISTS public.invoice_matches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  extracted_item_id UUID NOT NULL REFERENCES public.extracted_items(id) ON DELETE CASCADE,
  match_confidence INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extracted_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_merchant_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own profile"
  ON public.profiles FOR ALL USING (auth.uid() = id);

CREATE POLICY "Users can only access their own oauth_connections"
  ON public.oauth_connections FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own documents"
  ON public.documents FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own extracted_items"
  ON public.extracted_items FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own bank_transactions"
  ON public.bank_transactions FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own reconciliation_matches"
  ON public.reconciliation_matches FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own preferences"
  ON public.user_merchant_preferences FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own audit_log"
  ON public.audit_log FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can only access their own invoice_matches"
  ON public.invoice_matches FOR ALL USING (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX idx_extracted_items_user_status ON public.extracted_items(user_id, status);
CREATE INDEX idx_extracted_items_confidence ON public.extracted_items(user_id, overall_confidence);
CREATE INDEX idx_bank_txns_user_status ON public.bank_transactions(user_id, status);
CREATE INDEX idx_recon_matches_user ON public.reconciliation_matches(user_id, status);
CREATE INDEX idx_audit_log_user_created ON public.audit_log(user_id, created_at DESC);
CREATE INDEX idx_preferences_user_merchant ON public.user_merchant_preferences(user_id, merchant_key);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_extracted_items_updated_at
  BEFORE UPDATE ON public.extracted_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
