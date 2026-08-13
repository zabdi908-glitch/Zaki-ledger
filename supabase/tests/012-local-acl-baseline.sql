-- ============================================================================
-- LOCAL TEST-ENV ACL BASELINE (NOT A MIGRATION)
--
-- Production materialized broad table ACLs when these tables were created
-- (visible in production-backup-pre-011-final/schema.sql). `supabase db reset`
-- does not reproduce those materialized grants for migration-created tables,
-- so the local gates would see "permission denied" instead of exercising RLS.
-- This file restores the production-equivalent baseline AFTER db reset so the
-- two-tenant isolation / audit gates run against the real RLS surface.
--
-- Bank tables keep the Migration 009 state (service_role SELECT/INSERT only).
-- Reconciliation tables get the pre-012 production grants; Migration 012's
-- audit-log REVOKEs (authenticated DML, anon ALL) are then what they are.
-- ============================================================================

GRANT ALL ON TABLE public.reconciliation_matches
  TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.reconciliation_reports
  TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.reconciliation_decisions
  TO anon, authenticated, service_role;

-- Audit log: production baseline was ALL for the three roles; Migration 012
-- revokes authenticated INSERT/UPDATE/DELETE and all anon access. service_role
-- retains ALL (trusted server path).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.reconciliation_audit_log
  TO service_role;

GRANT SELECT ON TABLE public.reconciliation_audit_log
  TO authenticated;