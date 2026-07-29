import AccountBar from "@/components/AccountBar";
import { getSessionUser } from "@/lib/auth";
import { body, display, mono } from "@/lib/fonts";
import "./globals.css";

export const metadata = {
  title: "Zaki Ledger",
  description: "AI copilot that kills manual accounting data entry — and learns from every correction.",
};

/**
 * Async so it can read the session server-side and show who's logged in.
 * Only renders the account bar when there IS a session — /login and /signup
 * are reached exactly because there isn't one, and showing a logout button
 * there would be nonsensical.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body style={{ fontFamily: "var(--font-body)" }}>
        {user && <AccountBar email={user.email ?? ""} />}
        {children}
      </body>
    </html>
  );
}
