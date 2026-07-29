import { body, display, mono, shellBody } from "@/lib/fonts";
import "./globals.css";

export const metadata = {
  title: "Zaki Ledger",
  description: "AI copilot that kills manual accounting data entry — and learns from every correction.",
};

/**
 * Every authenticated screen now lives under the app/(app) route group,
 * which renders its own sidebar shell (with its own user email + sign-out,
 * see components/AppShell.tsx and app/settings). /login and /signup are the
 * only routes left outside that group, and they have no session chrome to
 * show — so the root layout is just font wiring, nothing session-aware.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${shellBody.variable}`}>
      <body style={{ fontFamily: "var(--font-body)" }}>{children}</body>
    </html>
  );
}
