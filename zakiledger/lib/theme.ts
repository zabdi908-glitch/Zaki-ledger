import type { CSSProperties } from "react";

/**
 * Zaki Ledger's design tokens — one source of truth for every color, radius
 * and reusable style shape in the app, replacing the ~60 near-duplicate
 * inline style objects that used to be redefined (slightly differently) in
 * every page and component.
 *
 * Palette concept: bright paper-white, not the cool gray-blue "SaaS card on
 * a gray page" that used to be here. Ink is warm near-black (like real
 * print, not #000). One brand color — a deep forest green — doubles as the
 * "approved" signal, since approving IS the product's central verb. A stamp
 * red is the one deliberate accent, reserved for the signature approval-stamp
 * moment and for danger states (a real ledger's danger color is red ink too).
 */
export const color = {
  paper: "#FFFFFF",
  paperAlt: "#F7F5EF", // subtle warm surface — cards-on-cards, table headers
  paperLine: "#E7E2D4", // hairline borders on the paper surfaces
  ink: "#17140F",
  inkSoft: "#5B5648",
  inkFaint: "#9C9584",

  forest: "#0B6B4C",
  forestDeep: "#084F3A",
  forestTint: "#E7F3EC",

  stamp: "#A83A2A",
  stampDeep: "#7E2A1E",
  stampTint: "#FBEAE7",

  gold: "#B8791E",
  goldDeep: "#8A5A14",
  goldTint: "#FBF0DE",

  violet: "#6E5BA6",
  violetTint: "#F1EEFA",

  indigo: "#33507A",
  indigoTint: "#EAF0F7",

  plum: "#7A3E82",
  plumTint: "#F6EAF7",
} as const;

export const font = {
  display: "var(--font-display)",
  body: "var(--font-body)",
  mono: "var(--font-mono)",
} as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

export const shadow = {
  card: "0 1px 2px rgba(23,20,15,0.05), 0 1px 0 rgba(23,20,15,0.03)",
} as const;

// --- Reusable shapes ---------------------------------------------------------

export function card(overrides: CSSProperties = {}): CSSProperties {
  return {
    padding: 26,
    background: color.paper,
    borderRadius: radius.lg,
    border: `1px solid ${color.paperLine}`,
    boxShadow: shadow.card,
    ...overrides,
  };
}

type ButtonVariant = "primary" | "success" | "outline" | "danger" | "ghost";
type ButtonSize = "md" | "sm";

/**
 * `primary` is ink-black, not the brand green — it's reserved for "go
 * forward" actions (upload, navigate to the queue). `success` is the forest
 * green, reserved specifically for the approve verb, so the color always
 * means the same thing everywhere it appears.
 */
export function button(variant: ButtonVariant, size: ButtonSize = "md"): CSSProperties {
  const sized: CSSProperties =
    size === "md"
      ? { padding: "13px 24px", fontSize: 15, borderRadius: radius.md }
      : { padding: "7px 14px", fontSize: 13, borderRadius: radius.sm };

  const base: CSSProperties = {
    ...sized,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    fontFamily: font.body,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    lineHeight: 1.2,
  };

  switch (variant) {
    case "primary":
      return { ...base, background: color.ink, color: color.paper };
    case "success":
      return { ...base, background: color.forest, color: color.paper };
    case "danger":
      return { ...base, background: color.stamp, color: color.paper };
    case "outline":
      return { ...base, background: color.paper, color: color.ink, border: `1px solid ${color.paperLine}` };
    case "ghost":
      return {
        ...base,
        background: "transparent",
        color: color.inkSoft,
        border: `1px solid ${color.paperLine}`,
      };
  }
}

export function disabledOverride(): CSSProperties {
  return { opacity: 0.45, cursor: "not-allowed" };
}

type Tone = "ok" | "warn" | "bad" | "muted" | "info" | "verified";

/** Small pill chips: confidence scores, statuses, "seen before" notes. */
export function chip(tone: Tone): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 9px",
    borderRadius: radius.pill,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: font.body,
    whiteSpace: "nowrap",
  };
  switch (tone) {
    case "ok":
      return { ...base, background: color.forestTint, color: color.forestDeep };
    case "warn":
      return { ...base, background: color.goldTint, color: color.goldDeep };
    case "bad":
      return { ...base, background: color.stampTint, color: color.stampDeep };
    case "muted":
      return { ...base, background: color.paperAlt, color: color.inkFaint };
    case "info":
      return { ...base, background: color.violetTint, color: color.violet };
    case "verified":
      return { ...base, background: color.forest, color: color.paper };
  }
}

/** Document-type badges (invoice / receipt) — a category label, not a status. */
export function typeBadge(kind: "invoice" | "receipt"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: radius.pill,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.2,
    fontFamily: font.body,
  };
  return kind === "invoice"
    ? { ...base, background: color.indigoTint, color: color.indigo }
    : { ...base, background: color.plumTint, color: color.plum };
}

/**
 * Full-width alert/note boxes: demo notices, learned-from-history notes,
 * gate warnings, error banners. One shape, five tones.
 */
export function banner(tone: Tone): CSSProperties {
  const base: CSSProperties = {
    padding: "12px 16px",
    borderRadius: radius.md,
    fontSize: 14,
    lineHeight: 1.5,
    fontFamily: font.body,
  };
  switch (tone) {
    case "ok":
      return { ...base, background: color.forestTint, border: `1px solid ${color.forest}33`, color: color.forestDeep };
    case "warn":
      return { ...base, background: color.goldTint, border: `1px solid ${color.gold}44`, color: color.goldDeep };
    case "bad":
      return { ...base, background: color.stampTint, border: `1px solid ${color.stamp}33`, color: color.stampDeep };
    case "info":
      return { ...base, background: color.violetTint, border: `1px solid ${color.violet}33`, color: color.violet };
    case "muted":
      return { ...base, background: color.paperAlt, border: `1px solid ${color.paperLine}`, color: color.inkSoft };
    case "verified":
      return { ...base, background: color.forest, color: color.paper };
  }
}

/** A text input, in its normal or attention-wanted state. */
export function input(state: "normal" | "low" = "normal"): CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "11px 13px",
    borderRadius: radius.sm,
    fontSize: 15,
    fontFamily: font.body,
    outline: "none",
    border: `1px solid ${state === "low" ? color.stamp + "66" : color.paperLine}`,
    background: state === "low" ? color.stampTint : color.paper,
    color: color.ink,
  };
}

/** The circular double-ring "seal" mark — the wordmark's monogram badge. */
export function seal(sizePx = 40): CSSProperties {
  return {
    width: sizePx,
    height: sizePx,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: color.ink,
    color: color.paper,
    fontFamily: font.display,
    fontWeight: 600,
    fontSize: sizePx * 0.36,
    boxShadow: `0 0 0 2px ${color.paper}, 0 0 0 3px ${color.ink}`,
    flexShrink: 0,
  };
}

/** A small eyebrow label — "REVIEW & APPROVE", "HOW IT WORKS", table headers. */
export const eyebrow: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: color.inkFaint,
  fontFamily: font.body,
};

/** Tabular figures — money, percentages, dates — so columns of numbers align. */
export const figures: CSSProperties = {
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
};
