import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { getSessionUser } from "@/lib/auth";

/**
 * Every authenticated screen (Dashboard, Upload/Review/Batch, Reconciliation,
 * Settings, the "coming soon" stubs) lives under this group and shares one
 * sidebar shell — see components/AppShell.tsx and design_handoff_zaki_ledger/.
 *
 * Forced dynamic: every page here reads the logged-in user's own data, so it
 * must never be statically generated at build time. Without this, Next.js
 * tried to prerender /dashboard during `next build` — getSessionUser()'s
 * try/catch around the cookies()-dependent Supabase call swallows the signal
 * Next normally uses to bail out of static rendering, so it looked
 * static-eligible, ran with no real request, and crashed the whole build the
 * moment its Supabase query hit a table that isn't relevant at build time
 * anyway (see the same reasoning for the per-source try/catch in
 * lib/dashboard.ts).
 */
export const dynamic = "force-dynamic";
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
