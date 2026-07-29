import type { CSSProperties } from "react";

/**
 * Design tokens for the app-shell visual system: the dark-navy collapsible
 * sidebar + Dashboard/Upload/Review/Batch/Reconciliation/Settings screens,
 * rebuilt pixel-for-pixel from design_handoff_zaki_ledger/. Kept separate
 * from lib/theme.ts (the "paper-white" system, still used by /login and
 * /signup) — different design language, different owner screens, nothing
 * shared worth merging.
 *
 * Values are copied directly from the handoff's inline styles/README, not
 * reinterpreted — this file is the single place they live so every screen
 * reads the same oklch string instead of re-typing it.
 */
export const shellColor = {
  page: "oklch(98% 0.004 240)",
  paper: "#ffffff",
  cardBorder: "oklch(90% 0.008 240)",
  trackBg: "oklch(94% 0.006 240)",

  ink: "oklch(20% 0.02 240)",
  inkSoft: "oklch(48% 0.02 240)",
  inkFaint: "oklch(60% 0.01 240)",
  inkFainter: "oklch(55% 0.02 240)",

  teal: "oklch(62% 0.11 195)",
  tealBright: "oklch(70% 0.12 195)",

  sidebarBg: "oklch(24% 0.05 260)",
  sidebarActive: "oklch(32% 0.07 260)",
  sidebarBtn: "oklch(30% 0.08 260)",
  sidebarText: "oklch(78% 0.02 260)",
  sidebarTextDim: "oklch(52% 0.02 260)",
  sidebarGroupLabel: "oklch(50% 0.02 260)",
  sidebarBorder: "oklch(38% 0.05 260)",
  sidebarSoonBorder: "oklch(42% 0.03 260)",
  sidebarFooterText: "oklch(70% 0.02 260)",

  high: "oklch(45% 0.14 155)",
  highBg: "oklch(94% 0.05 155)",
  medium: "oklch(48% 0.15 80)",
  mediumBg: "oklch(94% 0.06 80)",
  low: "oklch(48% 0.18 25)",
  lowBg: "oklch(94% 0.06 25)",
} as const;

export const shellFont = {
  body: "var(--font-shell)",
  mono: "var(--font-mono)",
} as const;

export const shellRadius = { sm: 7, md: 12, lg: 14, pill: 999 } as const;

export type Tier = "high" | "medium" | "low";

/**
 * Confidence tiers — thresholds and copy are final per the handoff's design
 * tokens: High >=95%, Medium 70-94%, Low <70%. Used for every confidence
 * badge in the app (extraction items, reconciliation matches).
 */
export function tierFor(confidencePct: number): {
  tier: Tier;
  label: string;
  color: string;
  bg: string;
  icon: string;
} {
  if (confidencePct >= 95) {
    return { tier: "high", label: "High confidence", color: shellColor.high, bg: shellColor.highBg, icon: "✓" };
  }
  if (confidencePct >= 70) {
    return { tier: "medium", label: "Medium confidence", color: shellColor.medium, bg: shellColor.mediumBg, icon: "!" };
  }
  return { tier: "low", label: "Low confidence", color: shellColor.low, bg: shellColor.lowBg, icon: "✕" };
}

/** The rounded confidence/status pill used on item cards, match cards, and table rows. */
export function pill(color: string, bg: string, size: "md" | "sm" = "md"): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: size === "md" ? 6 : 5,
    padding: size === "md" ? "5px 12px" : "4px 10px",
    borderRadius: shellRadius.pill,
    background: bg,
    color,
    fontSize: size === "md" ? 13 : 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

export function shellCard(overrides: CSSProperties = {}): CSSProperties {
  return {
    background: shellColor.paper,
    border: `1px solid ${shellColor.cardBorder}`,
    borderRadius: shellRadius.lg,
    ...overrides,
  };
}

type ShellButtonVariant = "primary" | "success" | "outline" | "dangerOutline";
type ShellButtonSize = "lg" | "md" | "sm";

/**
 * primary = navy CTA (uploads, "review matches", nav-forward actions).
 * success = green, reserved for Approve verbs, same rule as lib/theme's button().
 * outline = neutral secondary action. dangerOutline = Reject actions.
 */
export function shellButton(variant: ShellButtonVariant, size: ShellButtonSize = "md"): CSSProperties {
  const sized: CSSProperties =
    size === "lg"
      ? { padding: "12px 20px", borderRadius: 8, fontSize: 14 }
      : size === "md"
        ? { padding: "9px 16px", borderRadius: shellRadius.sm, fontSize: 13.5 }
        : { padding: "5px 12px", borderRadius: 6, fontSize: 12.5 };

  const base: CSSProperties = {
    ...sized,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    fontFamily: shellFont.body,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    lineHeight: 1.2,
  };

  switch (variant) {
    case "primary":
      return { ...base, background: shellColor.sidebarBtn, color: "white" };
    case "success":
      return { ...base, background: shellColor.high, color: "white" };
    case "outline":
      return { ...base, background: shellColor.paper, color: shellColor.ink, border: `1px solid ${shellColor.cardBorder}` };
    case "dangerOutline":
      return { ...base, background: shellColor.paper, color: shellColor.low, border: `1px solid ${shellColor.cardBorder}` };
  }
}

export function disabledOverride(): CSSProperties {
  return { opacity: 0.5, cursor: "not-allowed" };
}

/** Tabular figures — money, dates, percentages — so columns line up. */
export const shellFigures: CSSProperties = {
  fontFamily: shellFont.mono,
  fontVariantNumeric: "tabular-nums",
};

/** Uppercase micro-label — table headers, "Bank transaction" / "QuickBooks entry" captions. */
export const microLabel: CSSProperties = {
  fontSize: 11.5,
  color: shellColor.inkFaint,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};

/** The thin teal progress bar used on Upload, Batch Review, and both reconciliation review/batch screens. */
export function progressTrack(): CSSProperties {
  return { height: 6, borderRadius: 3, background: shellColor.trackBg, overflow: "hidden" };
}
export function progressFill(pct: number): CSSProperties {
  return { height: "100%", borderRadius: 3, background: shellColor.teal, width: `${pct}%` };
}

/** Page title + subtitle, identical across every full-width screen. */
export const pageTitle: CSSProperties = { fontSize: 32, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" };
export const pageSubtitle: CSSProperties = { fontSize: 15, color: shellColor.inkSoft, margin: "0 0 32px" };
