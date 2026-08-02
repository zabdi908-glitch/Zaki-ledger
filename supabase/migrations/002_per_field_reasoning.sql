-- Zaki Ledger — Per-field confidence reasoning + critical-field review gate
-- Run this in Supabase SQL Editor after 001_initial_schema.sql

ALTER TABLE public.extracted_items
  ADD COLUMN IF NOT EXISTS merchant_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS date_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS amount_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS tax_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS category_confidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_extracted_items_needs_review
  ON public.extracted_items(user_id, needs_review);
