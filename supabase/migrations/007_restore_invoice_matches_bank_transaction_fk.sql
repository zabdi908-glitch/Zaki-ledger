-- Restore the historical invoice-match ownership relationship removed when
-- migration 003 recreated public.bank_transactions with DROP ... CASCADE.
ALTER TABLE public.invoice_matches
  ADD CONSTRAINT invoice_matches_bank_transaction_id_fkey
  FOREIGN KEY (bank_transaction_id)
  REFERENCES public.bank_transactions(id)
  ON DELETE CASCADE
  NOT DEFERRABLE
  INITIALLY IMMEDIATE;
