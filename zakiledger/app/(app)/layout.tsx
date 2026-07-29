import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { getSessionUser } from "@/lib/auth";

/**
 * Every authenticated screen (Dashboard, Upload/Review/Batch, Reconciliation,
 * Settings, the "coming soon" stubs) lives under this group and shares one
 * sidebar shell — see components/AppShell.tsx and design_handoff_zaki_ledger/.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  // Mirrors middleware.ts: when Supabase isn't configured (local/demo mode),
  // there's no session to have, and the middleware already lets the request
  // through rather than redirecting — this must not re-impose the gate the
  // middleware deliberately skipped, or demo mode stops working entirely.
  const authConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
  if (!user && authConfigured) redirect("/login");

  return <AppShell email={user?.email ?? "demo@zakiledger.com"}>{children}</AppShell>;
}
