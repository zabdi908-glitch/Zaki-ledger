import { Fraunces, IBM_Plex_Mono, Public_Sans } from "next/font/google";

/**
 * Three faces, three jobs — mirrors how a real ledger uses type: a display
 * face for the masthead and moments that matter, a plain workhorse for
 * everything you read quickly, and a tabular mono for figures that need to
 * line up in a column (money, percentages, dates).
 *
 * next/font self-hosts these at build time (no runtime Google Fonts request),
 * and the CSS variables are wired up on <html> in app/layout.tsx.
 */
export const display = Fraunces({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

export const body = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});
