"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ConfidenceRing from "./ConfidenceRing";
import { disabledOverride, microLabel, shellButton, shellCard, shellColor, shellFigures, shellFont, shellRadius } from "@/lib/shell-theme";

/**
 * Generic, presentational review UI — ported 1:1 from the client-approved
 * mockups (design_handoff_zaki_ledger/*.html): a hero "approve everything
 * high-confidence" banner, a sticky bulk-select bar, four collapsible
 * sections, and a docked side panel. Knows nothing about bank transactions
 * or invoices — callers shape their data into ReviewRow and supply the
 * panel's body via renderPanel. See lib/reconciliation-insights.ts and
 * lib/extraction-insights.ts for the two current callers.
 */

export type ReviewSectionKey =
  | "ready"
  | "review"
  | "duplicate"
  | "refund"
  | "reversal"
  | "split"
  | "transfer"
  | "recurring"
  | "issue";

/**
 * A named finding about a row — "this looks like a refund of that charge" —
 * with the figures behind it. Deliberately shaped as labelled lines rather
 * than typed fields so any caller can describe any kind of finding without
 * this component learning what a refund or an invoice is.
 */
export interface ReviewDetection {
  title: string;
  /** One plain sentence: why we think this. */
  summary: string;
  /** The figures being compared, in display order. */
  lines: { label: string; value: string }[];
  /** The bottom-line figure, if the finding has one (net effect, total). */
  footer?: { label: string; value: string };
  /** Short factual statements backing the finding. */
  evidence: string[];
  confidencePct: number;
  /** What the accountant should DO about this finding, not just what it is. */
  suggestedAction?: { text: string; kind: "approve" | "reject" | "review" };
  /** Which pattern this is, when it's one of the pure-detector findings —
   * lets a caller's ledger-impact preview branch on it without this
   * component knowing what a reversal or a refund is. */
  kind?: "reversal" | "refund" | "split" | "merchant";
}

export interface ReviewRow {
  id: string;
  section: ReviewSectionKey;
  date: string;
  title: string;
  subtitle: string;
  amountLabel: string;
  amountSubLabel: string;
  categoryLabel: string;
  confidencePct: number;
  confidenceLabel: string;
  confidenceColor: string;
  reason: string;
  badges: string[];
  comparePair?: { aLabel: string; a: string; bLabel: string; b: string };
  detection?: ReviewDetection;
  /**
   * Whether approving this row can actually do anything. Defaults to true.
   * Rows that set it false render a disabled approve control, so the reason
   * shows before the click rather than after — see `notApprovableReason`.
   */
  approvable?: boolean;
  /** Tooltip explaining why approve is unavailable. Ignored when approvable. */
  notApprovableReason?: string;
}

export interface ReviewSectionConfig {
  key: ReviewSectionKey;
  title: string;
  accentColor: string;
  description: string;
  showBulkApproveAll?: boolean;
  /** Section header shows an "Approve all N" button that opens a preview
   * modal (list + deselect) instead of approving immediately — see
   * `bulkApprovable` handling in SectionBlock. Takes precedence over
   * `showBulkApproveAll` when both are set on the same section. */
  bulkApprovable?: boolean;
}

export interface ReviewBoardProps {
  rows: ReviewRow[];
  sections: ReviewSectionConfig[];
  approvedIds: Set<string>;
  onApprove: (ids: string[]) => void;
  onFlag: (id: string) => void;
  renderPanel: (row: ReviewRow) => ReactNode;
  heroTitle: string;
  heroDescription: string;
  /** Deep-link support: when set, every section except this one starts
   * collapsed — arriving from the upload screen's breakdown ("Refunds: 3")
   * should land on just that section, not the whole board expanded. */
  initialFocusSection?: ReviewSectionKey;
}

const READY_VISIBLE_CAP = 8;
const PANEL_WIDTH = 440;

const BADGE_ICON: Record<string, string> = {
  Recurring: "🔁",
  Transfer: "🔗",
  Payroll: "👥",
  VAT: "🧾",
  Subscription: "📅",
  Duplicate: "⚠️",
  Reversal: "↩️",
  Refund: "💷",
  "Split payment": "🧩",
  "Related merchant": "🏷️",
};

export default function ReviewBoard({
  rows,
  sections,
  approvedIds,
  onApprove,
  onFlag,
  renderPanel,
  heroTitle,
  heroDescription,
  initialFocusSection,
}: ReviewBoardProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<ReviewSectionKey>>(() =>
    initialFocusSection ? new Set(sections.map((s) => s.key).filter((k) => k !== initialFocusSection)) : new Set(),
  );
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<ReviewSectionKey>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [bulkPreview, setBulkPreview] = useState<{ section: ReviewSectionConfig; deselected: Set<string> } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const openRows = useMemo(() => rows.filter((r) => !approvedIds.has(r.id)), [rows, approvedIds]);
  const rowsBySection = useMemo(() => {
    const map = new Map<ReviewSectionKey, ReviewRow[]>();
    for (const sec of sections) map.set(sec.key, openRows.filter((r) => r.section === sec.key));
    return map;
  }, [openRows, sections]);

  /** A section with nothing in it is scroll an accountant has to do to reach
   * one that does, so it isn't rendered at all. */
  const visibleSections = useMemo(
    () => sections.filter((sec) => (rowsBySection.get(sec.key) ?? []).length > 0),
    [sections, rowsBySection],
  );

  const orderedVisibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const sec of sections) {
      if (collapsed.has(sec.key)) continue;
      const secRows = rowsBySection.get(sec.key) ?? [];
      const visible = expandedSections.has(sec.key) ? secRows : secRows.slice(0, READY_VISIBLE_CAP);
      for (const r of visible) ids.push(r.id);
    }
    return ids;
  }, [sections, collapsed, rowsBySection, expandedSections]);

  const readyOpen = rowsBySection.get("ready") ?? [];
  const openPanelRow = openPanelId ? rows.find((r) => r.id === openPanelId) ?? null : null;

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Section-scoped select-all, so an accountant can select every row in
   * "Ready to Approve" (or any other section) in one click instead of
   * checking rows one at a time, then use the sticky bar's "Approve
   * selected"/"Clear" once they're happy with the set. */
  function setSelectionForIds(ids: string[], select: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function approve(ids: string[]) {
    onApprove(ids);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    if (openPanelId && ids.includes(openPanelId)) setOpenPanelId(null);
  }

  function closePanel() {
    setOpenPanelId(null);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        if (e.key === "Escape") {
          if (bulkPreview) setBulkPreview(null);
          else closePanel();
        }
        return;
      }
      if (e.key === "Escape") {
        if (bulkPreview) setBulkPreview(null);
        else closePanel();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIdx((i) => {
          const next = Math.min(i + 1, orderedVisibleIds.length - 1);
          rowRefs.current.get(orderedVisibleIds[next])?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIdx((i) => {
          const next = Math.max(i - 1, 0);
          rowRefs.current.get(orderedVisibleIds[next])?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (e.key === "Enter") {
        const id = orderedVisibleIds[focusedIdx];
        if (id) setOpenPanelId(id);
      } else if (e.key.toLowerCase() === "a") {
        const id = orderedVisibleIds[focusedIdx];
        if (id) approve([id]);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedVisibleIds, focusedIdx, bulkPreview]);

  const transition = (value: string) => (reducedMotion ? "none" : value);

  /**
   * The row grid's fixed-width columns need ~900px (date/amount/category/
   * confidence/action columns are all px-sized). The docked detail panel
   * (PANEL_WIDTH, 440px) plus the app's nav sidebar can leave the row list
   * with less room than that on a laptop-width window — the grid used to
   * overflow its box with no scrollbar, which visually painted the category,
   * confidence, and approve/reject controls underneath the panel instead of
   * showing them. Rather than reusing the mobile breakpoint's CSS (which
   * reuses one grid template across two wrapped rows and clips the category
   * pill into the 24px checkbox column), SectionBlock/RowView switch to a
   * purpose-built compact layout whenever a panel is open, independent of
   * viewport width.
   */
  const compactRows = !!openPanelRow;

  return (
    <div>
      <style>{`
        @media (max-width: 980px) {
          .review-board-col-head { display: none; }
          .review-board-row-line1 { grid-template-columns: 24px 1fr auto !important; }
          .review-board-row-date { display: none; }
          .review-board-row-line2, .review-board-dupe-pair { padding-left: 0 !important; }
          .review-board-panel { position: fixed !important; inset: 0; z-index: 30; width: 100% !important; border-left: none; }
          .review-board-hero { flex-direction: column; align-items: flex-start; }
        }
      `}</style>

      {readyOpen.length > 0 && (
        <div
          className="review-board-hero"
          style={{
            background: `linear-gradient(135deg, ${shellColor.highBg}, ${shellColor.paper} 65%)`,
            border: `1px solid ${shellColor.cardBorder}`,
            borderRadius: shellRadius.lg,
            padding: "26px 28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
            marginBottom: 28,
          }}
        >
          <div>
            <div style={{ fontSize: 40, fontWeight: 700, fontFamily: shellFont.mono, lineHeight: 1, color: shellColor.ink }}>
              {readyOpen.length}
            </div>
            <div style={{ fontSize: 14.5, color: shellColor.inkSoft, marginTop: 6, maxWidth: "48ch" }}>{heroDescription}</div>
            <div style={{ fontSize: 12.5, color: shellColor.inkFaint, marginTop: 4 }}>
              Nothing here needs a click. Approve the batch, then spend your time on the sections below.
            </div>
          </div>
          <button style={shellButton("success", "lg")} onClick={() => approve(readyOpen.map((r) => r.id))}>
            {heroTitle}: approve all {readyOpen.length}
          </button>
        </div>
      )}

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: selected.size > 0 ? "flex" : "none",
          alignItems: "center",
          justifyContent: "space-between",
          background: shellColor.sidebarBg,
          color: "white",
          borderRadius: shellRadius.md,
          padding: "12px 18px",
          marginBottom: 22,
          fontSize: 13.5,
        }}
      >
        <span>
          <b style={shellFigures}>{selected.size}</b> selected
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={{ ...shellButton("outline", "sm"), background: "transparent", color: "white", borderColor: shellColor.sidebarBorder }}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <button style={shellButton("success", "sm")} onClick={() => approve([...selected])}>
            Approve selected
          </button>
        </div>
      </div>

      <div style={{ display: "flex", minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {visibleSections.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>
              Nothing left to review.
            </div>
          )}
          {visibleSections.map((sec) => (
            <SectionBlock
              key={sec.key}
              sec={sec}
              rows={rowsBySection.get(sec.key) ?? []}
              collapsedSet={collapsed}
              setCollapsed={setCollapsed}
              expandedSections={expandedSections}
              setExpandedSections={setExpandedSections}
              selected={selected}
              toggleSelected={toggleSelected}
              approve={approve}
              onFlag={onFlag}
              openPanelId={openPanelId}
              setOpenPanelId={setOpenPanelId}
              focusedId={orderedVisibleIds[focusedIdx]}
              rowRefs={rowRefs}
              onOpenBulkPreview={() => setBulkPreview({ section: sec, deselected: new Set() })}
              onSelectAll={setSelectionForIds}
              compact={compactRows}
            />
          ))}
        </div>

        <aside
          className="review-board-panel"
          style={{
            width: openPanelRow ? PANEL_WIDTH : 0,
            flexShrink: 0,
            overflow: "hidden",
            background: shellColor.paper,
            borderLeft: openPanelRow ? `1px solid ${shellColor.cardBorder}` : "none",
            transition: transition("width .22s ease"),
            position: "sticky",
            top: 0,
            alignSelf: "flex-start",
            maxHeight: "100vh",
          }}
        >
          {openPanelRow && (
            /*
             * maxHeight (not height: "100%") is deliberate: the aside only
             * constrains its own box via maxHeight: 100vh, not a definite
             * height, so a percentage height here resolved against the
             * panel's natural (unclamped) content height instead of the
             * viewport — this div never actually overflowed itself, so its
             * overflowY: auto never had anything to scroll, and everything
             * past the fold (including the Approve/Reject footer) was
             * simply clipped by the aside's own overflow: hidden with no
             * way for a mouse wheel to reach it. A vh-based maxHeight
             * doesn't depend on the parent's ambiguous height and forces
             * real, scrollable overflow.
             */
            <div style={{ width: PANEL_WIDTH, maxHeight: "100vh", overflowY: "auto", padding: "22px 26px 60px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: shellColor.inkFaint, marginBottom: 5 }}>
                    {sections.find((s) => s.key === openPanelRow.section)?.title}
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 700 }}>{openPanelRow.title}</div>
                  <div style={{ fontFamily: shellFont.mono, fontSize: 15, color: shellColor.inkSoft, marginTop: 4 }}>
                    {openPanelRow.amountLabel} · {openPanelRow.date}
                  </div>
                </div>
                <button
                  onClick={closePanel}
                  aria-label="Close panel"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: `1px solid ${shellColor.cardBorder}`,
                    background: shellColor.paper,
                    cursor: "pointer",
                    fontSize: 14,
                    color: shellColor.inkSoft,
                    flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              </div>
              {renderPanel(openPanelRow)}
            </div>
          )}
        </aside>
      </div>

      {bulkPreview && (
        <BulkApprovalPreviewModal
          section={bulkPreview.section}
          rows={(rowsBySection.get(bulkPreview.section.key) ?? []).filter((r) => r.approvable !== false)}
          deselected={bulkPreview.deselected}
          onToggle={(id) =>
            setBulkPreview((prev) => {
              if (!prev) return prev;
              const next = new Set(prev.deselected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return { ...prev, deselected: next };
            })
          }
          onCancel={() => setBulkPreview(null)}
          onConfirm={(ids) => {
            approve(ids);
            setBulkPreview(null);
          }}
        />
      )}
    </div>
  );
}

function BulkApprovalPreviewModal({
  section,
  rows,
  deselected,
  onToggle,
  onCancel,
  onConfirm,
}: {
  section: ReviewSectionConfig;
  rows: ReviewRow[];
  deselected: Set<string>;
  onToggle: (id: string) => void;
  onCancel: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const selectedIds = rows.filter((r) => !deselected.has(r.id)).map((r) => r.id);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(15,23,42,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          ...shellCard(),
          width: "100%",
          maxWidth: 520,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Approve all — {section.title}</div>
          <div style={{ fontSize: 13, color: shellColor.inkSoft, marginTop: 4 }}>
            Deselect any transaction you want to review separately before approving the rest.
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "8px 22px" }}>
          {rows.map((row) => (
            <label
              key={row.id}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}`, cursor: "pointer" }}
            >
              <input type="checkbox" checked={!deselected.has(row.id)} onChange={() => onToggle(row.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.title}</div>
                <div style={{ fontSize: 12, color: shellColor.inkFaint }}>{row.date}</div>
              </div>
              <div style={{ fontFamily: shellFont.mono, fontSize: 13.5, fontWeight: 600 }}>{row.amountLabel}</div>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "16px 22px", borderTop: `1px solid ${shellColor.cardBorder}` }}>
          <button style={{ ...shellButton("outline", "md"), flex: 1 }} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={{ ...shellButton("success", "md"), flex: 1 }}
            onClick={() => onConfirm(selectedIds)}
            disabled={selectedIds.length === 0}
          >
            Approve {selectedIds.length} {selectedIds.length === 1 ? "transaction" : "transactions"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionBlock({
  sec,
  rows,
  collapsedSet,
  setCollapsed,
  expandedSections,
  setExpandedSections,
  selected,
  toggleSelected,
  approve,
  onFlag,
  openPanelId,
  setOpenPanelId,
  focusedId,
  rowRefs,
  onOpenBulkPreview,
  onSelectAll,
  compact,
}: {
  sec: ReviewSectionConfig;
  rows: ReviewRow[];
  collapsedSet: Set<ReviewSectionKey>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<ReviewSectionKey>>>;
  expandedSections: Set<ReviewSectionKey>;
  setExpandedSections: React.Dispatch<React.SetStateAction<Set<ReviewSectionKey>>>;
  selected: Set<string>;
  toggleSelected: (id: string) => void;
  approve: (ids: string[]) => void;
  onFlag: (id: string) => void;
  openPanelId: string | null;
  setOpenPanelId: (id: string | null) => void;
  focusedId: string | undefined;
  rowRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onOpenBulkPreview: () => void;
  onSelectAll: (ids: string[], select: boolean) => void;
  /** True while any row's detail panel is docked open — the row grid's
   * fixed-width columns no longer fit the space left over, so rows switch
   * to a two-line compact layout instead of overflowing. */
  compact: boolean;
}) {
  const collapsed = collapsedSet.has(sec.key);
  const visible = expandedSections.has(sec.key) ? rows : rows.slice(0, READY_VISIBLE_CAP);
  const hidden = rows.length - visible.length;
  const approvableCount = rows.filter((r) => r.approvable !== false).length;

  function toggle() {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sec.key)) next.delete(sec.key);
      else next.add(sec.key);
      return next;
    });
  }

  return (
    <div style={{ marginBottom: 30, border: `1px solid ${shellColor.cardBorder}`, borderRadius: shellRadius.lg, background: shellColor.paper, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 22px", cursor: "pointer" }} onClick={toggle}>
        <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, flexShrink: 0, background: sec.accentColor }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ display: "inline-block", transition: "transform .15s ease", transform: collapsed ? "rotate(-90deg)" : "none", color: shellColor.inkFaint, fontSize: 12 }}>
              ▾
            </span>
            {sec.title}
            <span style={{ fontFamily: shellFont.mono, color: sec.accentColor }}>{rows.length}</span>
          </div>
          <div style={{ fontSize: 13, color: shellColor.inkSoft, marginTop: 3 }}>{sec.description}</div>
        </div>
        {sec.bulkApprovable && approvableCount >= 2 ? (
          <button
            style={shellButton("success", "sm")}
            onClick={(e) => {
              e.stopPropagation();
              onOpenBulkPreview();
            }}
          >
            Approve all {approvableCount}
          </button>
        ) : (
          sec.showBulkApproveAll &&
          rows.length > 0 && (
            <button
              style={shellButton("success", "sm")}
              onClick={(e) => {
                e.stopPropagation();
                approve(rows.map((r) => r.id));
              }}
            >
              Approve all {rows.length}
            </button>
          )
        )}
      </div>

      {!collapsed && (
        <div style={{ borderTop: `1px solid ${shellColor.cardBorder}` }}>
          {rows.length === 0 && <div style={{ padding: 40, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>Nothing here.</div>}
          {/*
           * The row grid below has a fixed-width minimum (~900px: the date/
           * amount/category/confidence/action columns are all px-sized).
           * With the detail panel docked open (440px) plus the nav sidebar,
           * the space left for this column can drop well under that on a
           * laptop-width screen. Without this wrapper, the overflow used to
           * render past its box with no scrollbar — invisibly painted behind
           * the docked panel, which is exactly what made the category,
           * confidence, and approve/reject controls disappear for rows on
           * narrower windows. Scrolling this one wrapper (instead of the
           * page) keeps the header cells and row cells lined up.
           */}
          <div style={{ overflowX: "auto" }}>
            {visible.length > 0 && !compact && (
              <div
                className="review-board-col-head"
                style={{
                  display: "grid",
                  gridTemplateColumns: "30px 84px minmax(200px,1.4fr) 118px 156px 148px 92px",
                  gap: 12,
                  padding: "10px 22px",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: shellColor.inkFaint,
                  background: shellColor.page,
                }}
              >
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => onSelectAll(rows.map((r) => r.id), e.target.checked)}
                  aria-label={`Select all in ${sec.title}`}
                  title="Select all in this section"
                />
                <span>Date</span>
                <span>Description</span>
                <span style={{ textAlign: "right" }}>Amount</span>
                <span>Category</span>
                <span>Confidence</span>
                <span />
              </div>
            )}
            {compact && visible.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 22px" }}>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => onSelectAll(rows.map((r) => r.id), e.target.checked)}
                  aria-label={`Select all in ${sec.title}`}
                  title="Select all in this section"
                />
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: shellColor.inkFaint }}>
                  Select all
                </span>
              </div>
            )}
            <div>
              {visible.map((row) => (
                <RowView
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  toggleSelected={() => toggleSelected(row.id)}
                  onApprove={() => approve([row.id])}
                  onFlag={() => onFlag(row.id)}
                  onOpen={() => setOpenPanelId(row.id)}
                  focused={focusedId === row.id || openPanelId === row.id}
                  compact={compact}
                  setRef={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                />
              ))}
            </div>
          </div>
          {hidden > 0 && (
            <div style={{ padding: "16px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", background: shellColor.page, borderTop: `1px solid ${shellColor.cardBorder}`, fontSize: 13, color: shellColor.inkSoft }}>
              <span>+ {hidden} more, all high confidence, same review pattern</span>
              <button
                style={shellButton("outline", "sm")}
                onClick={() =>
                  setExpandedSections((prev) => {
                    const next = new Set(prev);
                    next.add(sec.key);
                    return next;
                  })
                }
              >
                Show all {rows.length}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowView({
  row,
  selected,
  toggleSelected,
  onApprove,
  onFlag,
  onOpen,
  focused,
  compact,
  setRef,
}: {
  row: ReviewRow;
  selected: boolean;
  toggleSelected: () => void;
  onApprove: () => void;
  onFlag: () => void;
  onOpen: () => void;
  focused: boolean;
  /** Two-line layout instead of the fixed-width grid — see the `compactRows`
   * doc comment in ReviewBoard for why. */
  compact: boolean;
  setRef: (el: HTMLDivElement | null) => void;
}) {
  const approvable = row.approvable !== false;
  const line1Style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "30px 84px minmax(200px,1.4fr) 118px 156px 148px 92px",
    gap: 12,
    alignItems: "center",
  };

  return (
    <div
      ref={setRef}
      tabIndex={0}
      onClick={onOpen}
      style={{ borderTop: `1px solid ${shellColor.cardBorder}`, padding: "13px 22px 12px", cursor: "pointer", background: focused ? shellColor.page : "transparent" }}
    >
      {compact && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => {
                e.stopPropagation();
                toggleSelected();
              }}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${row.title}`}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.title}</div>
              <div style={{ fontSize: 12, color: shellColor.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.subtitle || " "}</div>
            </div>
            <div style={{ textAlign: "right", fontFamily: shellFont.mono, fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
              {row.amountLabel}
              <span style={{ display: "block", fontFamily: shellFont.body, fontWeight: 500, fontSize: 10.5, color: shellColor.inkFaint, textAlign: "right" }}>
                {row.amountSubLabel}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingLeft: 36 }}>
            <span
              title={row.categoryLabel}
              style={{
                display: "inline-block",
                padding: "4px 10px",
                borderRadius: shellRadius.pill,
                background: shellColor.trackBg,
                color: shellColor.inkSoft,
                fontSize: 12,
                fontWeight: 600,
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.categoryLabel}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ConfidenceRing pct={row.confidencePct} size={30} stroke={4} color={row.confidenceColor} />
              <div style={{ fontSize: 12 }}>
                <b style={{ display: "block", fontFamily: shellFont.mono, fontSize: 13.5 }}>{row.confidencePct}%</b>
                <span style={{ color: row.confidenceColor }}>{row.confidenceLabel}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
              <button
                title={approvable ? "Approve" : row.notApprovableReason ?? "Can't be approved yet"}
                aria-label="Approve"
                disabled={!approvable}
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove();
                }}
                style={iconButtonStyle(!approvable)}
              >
                {"✓"}
              </button>
              <button
                title="Flag for review"
                aria-label="Flag"
                onClick={(e) => {
                  e.stopPropagation();
                  onFlag();
                }}
                style={iconButtonStyle()}
              >
                {"⚑"}
              </button>
            </div>
          </div>
        </div>
      )}
      {!compact && (
      <div className="review-board-row-line1" style={line1Style}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => {
            e.stopPropagation();
            toggleSelected();
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${row.title}`}
        />
        <div className="review-board-row-date" style={{ fontFamily: shellFont.mono, fontSize: 12.5, color: shellColor.inkSoft }}>
          {row.date}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: shellColor.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.title}</div>
          <div style={{ fontSize: 12, color: shellColor.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.subtitle || " "}</div>
        </div>
        <div style={{ textAlign: "right", fontFamily: shellFont.mono, fontSize: 14, fontWeight: 600 }}>
          {row.amountLabel}
          <span style={{ display: "block", fontFamily: shellFont.body, fontWeight: 500, fontSize: 10.5, color: shellColor.inkFaint, textAlign: "right" }}>
            {row.amountSubLabel}
          </span>
        </div>
        <div>
          <span
            title={row.categoryLabel}
            style={{
              display: "inline-block",
              padding: "4px 10px",
              borderRadius: shellRadius.pill,
              background: shellColor.trackBg,
              color: shellColor.inkSoft,
              fontSize: 12,
              fontWeight: 600,
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.categoryLabel}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ConfidenceRing pct={row.confidencePct} size={30} stroke={4} color={row.confidenceColor} />
          <div style={{ fontSize: 12 }}>
            <b style={{ display: "block", fontFamily: shellFont.mono, fontSize: 13.5 }}>{row.confidencePct}%</b>
            <span style={{ color: row.confidenceColor }}>{row.confidenceLabel}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          <button
            title={approvable ? "Approve" : row.notApprovableReason ?? "Can't be approved yet"}
            aria-label="Approve"
            disabled={!approvable}
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            style={iconButtonStyle(!approvable)}
          >
            ✓
          </button>
          <button
            title="Flag for review"
            aria-label="Flag"
            onClick={(e) => {
              e.stopPropagation();
              onFlag();
            }}
            style={iconButtonStyle()}
          >
            ⚑
          </button>
        </div>
      </div>
      )}

      {row.comparePair && (
        <div className="review-board-dupe-pair" style={{ paddingLeft: compact ? 0 : 126, marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 10, fontSize: 12.5, color: shellColor.inkSoft }}>
            <span style={{ fontWeight: 700, color: shellColor.dupe, width: 74, flexShrink: 0 }}>{row.comparePair.aLabel}</span>
            {row.comparePair.a}
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 12.5, color: shellColor.inkSoft }}>
            <span style={{ fontWeight: 700, color: shellColor.dupe, width: 74, flexShrink: 0 }}>{row.comparePair.bLabel}</span>
            {row.comparePair.b}
          </div>
        </div>
      )}

      <div className="review-board-row-line2" style={{ paddingLeft: compact ? 0 : 126, marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, color: shellColor.inkSoft }}>
          <span style={{ marginRight: 5 }}>✦</span>
          {row.reason}
        </span>
        {row.badges.map((b) => (
          <span
            key={b}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: shellRadius.pill,
              border: `1px solid ${shellColor.cardBorder}`,
              color: shellColor.inkFaint,
              background: shellColor.paper,
            }}
          >
            {BADGE_ICON[b] ?? ""} {b}
          </span>
        ))}
      </div>
    </div>
  );
}

function iconButtonStyle(disabled = false): CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: 7,
    border: `1px solid ${shellColor.cardBorder}`,
    background: shellColor.paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    color: disabled ? shellColor.inkFainter : shellColor.inkSoft,
    opacity: disabled ? 0.5 : 1,
  };
}

// Referenced to keep the disabledOverride/microLabel imports intentional for
// consumers that need the same "disabled" look this board's buttons use
// internally via shellButton — re-exported so callers don't need a second
// import from lib/shell-theme for the common panel-footer button pattern.
export { disabledOverride, microLabel };
