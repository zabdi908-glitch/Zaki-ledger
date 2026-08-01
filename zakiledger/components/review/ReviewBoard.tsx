"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ConfidenceRing from "./ConfidenceRing";
import { disabledOverride, microLabel, shellButton, shellColor, shellFigures, shellFont, shellRadius } from "@/lib/shell-theme";

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
}: ReviewBoardProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<ReviewSectionKey>>(new Set());
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<ReviewSectionKey>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [reducedMotion, setReducedMotion] = useState(false);
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
        if (e.key === "Escape") closePanel();
        return;
      }
      if (e.key === "Escape") {
        closePanel();
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
  }, [orderedVisibleIds, focusedIdx]);

  const transition = (value: string) => (reducedMotion ? "none" : value);

  return (
    <div>
      <style>{`
        @media (max-width: 980px) {
          .review-board-col-head { display: none; }
          .review-board-row-line1 { grid-template-columns: 24px 1fr auto !important; }
          .review-board-row-date { display: none; }
          .review-board-row-line2, .review-board-dupe-pair { padding-left: 0 !important; }
          .review-board-panel { position: fixed; inset: 0; z-index: 30; width: 100% !important; border-left: none; }
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
          }}
        >
          {openPanelRow && (
            <div style={{ width: PANEL_WIDTH, height: "100%", overflowY: "auto", padding: "22px 26px 60px" }}>
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
}) {
  const collapsed = collapsedSet.has(sec.key);
  const visible = expandedSections.has(sec.key) ? rows : rows.slice(0, READY_VISIBLE_CAP);
  const hidden = rows.length - visible.length;

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
        {sec.showBulkApproveAll && rows.length > 0 && (
          <button
            style={shellButton("success", "sm")}
            onClick={(e) => {
              e.stopPropagation();
              approve(rows.map((r) => r.id));
            }}
          >
            Approve all {rows.length}
          </button>
        )}
      </div>

      {!collapsed && (
        <div style={{ borderTop: `1px solid ${shellColor.cardBorder}` }}>
          {rows.length === 0 && <div style={{ padding: 40, textAlign: "center", color: shellColor.inkFainter, fontSize: 14 }}>Nothing here.</div>}
          {visible.length > 0 && (
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
              <span />
              <span>Date</span>
              <span>Description</span>
              <span style={{ textAlign: "right" }}>Amount</span>
              <span>Category</span>
              <span>Confidence</span>
              <span />
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
                setRef={(el) => {
                  if (el) rowRefs.current.set(row.id, el);
                  else rowRefs.current.delete(row.id);
                }}
              />
            ))}
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
  setRef,
}: {
  row: ReviewRow;
  selected: boolean;
  toggleSelected: () => void;
  onApprove: () => void;
  onFlag: () => void;
  onOpen: () => void;
  focused: boolean;
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

      {row.comparePair && (
        <div className="review-board-dupe-pair" style={{ paddingLeft: 126, marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
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

      <div className="review-board-row-line2" style={{ paddingLeft: 126, marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
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
