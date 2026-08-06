"use client";

import { useState } from "react";
import type {
  ComparisonResult,
  ComparisonMatch,
  MissingTransaction,
  DuplicateTransaction,
  AmountMismatch,
  UnmatchedItem,
} from "@/lib/comparison-schema";
import { shellCard, shellColor, shellFigures, microLabel } from "@/lib/shell-theme";

type SectionKey = "matched" | "missingInQb" | "missingInBank" | "duplicates" | "amountMismatches" | "unmatchedItems";

interface SectionDef {
  key: SectionKey;
  title: string;
  count: number;
  color: string;
  bg: string;
}

function useCollapsibleSections(initial: SectionKey[] = []): {
  open: Set<SectionKey>;
  toggle: (key: SectionKey) => void;
} {
  const [open, setOpen] = useState<Set<SectionKey>>(new Set(initial));

  function toggle(key: SectionKey) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return { open, toggle };
}

function formatCurrency(amount: number, currency?: string | null): string {
  return `${currency ?? "$"}${Math.abs(amount).toFixed(2)}`;
}

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function CollapsibleSection({
  title,
  count,
  color,
  bg,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  color: string;
  bg: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={shellCard({ overflow: "hidden" })}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 600,
          color: shellColor.ink,
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 24,
              height: 24,
              padding: "0 8px",
              borderRadius: 12,
              background: bg,
              color,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {count}
          </span>
          {title}
        </span>
        <span style={{ color: shellColor.inkFaint, fontSize: 12, transition: "transform 0.15s", transform: isOpen ? "rotate(180deg)" : "none" }}>
          ▼
        </span>
      </button>
      {isOpen && <div style={{ padding: "0 20px 16px" }}>{children}</div>}
    </div>
  );
}

function MatchedRow({ match }: { match: ComparisonMatch }) {
  const bank = match.bankTransaction;
  const qb = match.qbTransaction;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.ink }}>{bank.merchant ?? bank.description ?? "—"}</span>
        <span style={{ fontSize: 11.5, color: shellColor.inkSoft }}>{formatDate(bank.transactionDate)} · {formatCurrency(bank.amount, bank.currency)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11.5, color: shellColor.inkFaint }}>{match.matchType.replace("_", " ")}</span>
        <span style={{ ...shellFigures, fontSize: 12, fontWeight: 600, color: shellColor.high }}>{Math.round(match.confidence * 100)}%</span>
      </div>
    </div>
  );
}

function MissingRow({ item }: { item: MissingTransaction }) {
  const tx = item.entry;
  const isBank = item.source === "bank";
  const amount = "amount" in tx ? tx.amount : 0;
  const currency = "currency" in tx ? tx.currency : null;
  const date = "transactionDate" in tx ? tx.transactionDate : "postedDate" in tx ? tx.postedDate : null;
  const name = "merchant" in tx && tx.merchant ? tx.merchant : "description" in tx && tx.description ? tx.description : "—";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.ink }}>{name}</span>
        <span style={{ fontSize: 11.5, color: shellColor.inkSoft }}>{formatDate(date)} · {formatCurrency(amount, currency)}</span>
      </div>
      <span style={{ fontSize: 11.5, color: shellColor.inkFaint }}>{isBank ? "In bank only" : "In QB only"}</span>
    </div>
  );
}

function DuplicateRow({ dup }: { dup: DuplicateTransaction }) {
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: shellColor.dupe, marginBottom: 4 }}>{dup.entries.length} entries · {dup.source}</div>
      {dup.entries.map((entry, i) => {
        const amount = "amount" in entry ? entry.amount : 0;
        const currency = "currency" in entry ? entry.currency : null;
        const date = "transactionDate" in entry ? entry.transactionDate : "postedDate" in entry ? entry.postedDate : null;
        const name = "merchant" in entry && entry.merchant ? entry.merchant : "description" in entry && entry.description ? entry.description : "—";
        return (
          <div key={i} style={{ fontSize: 12.5, color: shellColor.inkSoft, paddingLeft: 8 }}>
            {name} · {formatDate(date)} · {formatCurrency(amount, currency)}
          </div>
        );
      })}
    </div>
  );
}

function MismatchRow({ mm }: { mm: AmountMismatch }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.ink }}>{mm.bankTransaction.merchant ?? mm.bankTransaction.description ?? "—"}</span>
        <span style={{ fontSize: 11.5, color: shellColor.inkSoft }}>
          Bank: {formatCurrency(mm.bankAmount, mm.bankTransaction.currency)} · QB: {formatCurrency(mm.qbAmount, mm.qbTransaction.currency)}
        </span>
      </div>
      <span style={{ ...shellFigures, fontSize: 12, fontWeight: 600, color: shellColor.low }}>Δ {formatCurrency(mm.difference, mm.bankTransaction.currency)}</span>
    </div>
  );
}

function UnmatchedRow({ item }: { item: UnmatchedItem }) {
  const tx = item.transaction;
  const amount = "amount" in tx ? tx.amount : 0;
  const currency = "currency" in tx ? tx.currency : null;
  const date = "transactionDate" in tx ? tx.transactionDate : "postedDate" in tx ? tx.postedDate : null;
  const name = "merchant" in tx && tx.merchant ? tx.merchant : "description" in tx && tx.description ? tx.description : "—";
  const sevColor = item.severity === "critical" ? shellColor.low : item.severity === "warning" ? shellColor.medium : shellColor.inkFaint;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${shellColor.cardBorder}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.ink }}>{name}</span>
        <span style={{ fontSize: 11.5, color: shellColor.inkSoft }}>{formatDate(date)} · {formatCurrency(amount, currency)}</span>
      </div>
      <span style={{ fontSize: 11.5, color: sevColor, fontWeight: 600, textTransform: "capitalize" }}>{item.severity}</span>
    </div>
  );
}

export default function ComparisonResults({ result }: { result: ComparisonResult }) {
  const { open, toggle } = useCollapsibleSections(["matched"]);

  const sections: SectionDef[] = [
    { key: "matched", title: "Matched", count: result.matches.length, color: shellColor.high, bg: shellColor.highBg },
    { key: "missingInQb", title: "Missing in QB", count: result.missingInQb.length, color: shellColor.low, bg: shellColor.lowBg },
    { key: "missingInBank", title: "Missing in Bank", count: result.missingInBank.length, color: shellColor.medium, bg: shellColor.mediumBg },
    { key: "duplicates", title: "Duplicates", count: result.duplicates.length, color: shellColor.dupe, bg: shellColor.dupeBg },
    { key: "amountMismatches", title: "Amount Mismatches", count: result.amountMismatches.length, color: shellColor.low, bg: shellColor.lowBg },
    { key: "unmatchedItems", title: "Unmatched", count: result.unmatchedItems.length, color: shellColor.medium, bg: shellColor.mediumBg },
  ];

  const totalIssues =
    result.missingInQb.length +
    result.missingInBank.length +
    result.duplicates.length +
    result.amountMismatches.length +
    result.unmatchedItems.length;

  const matchRate = result.matches.length + totalIssues > 0
    ? Math.round((result.matches.length / (result.matches.length + totalIssues)) * 100)
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary Card */}
      <div style={shellCard({ padding: 24 })}>
        <div style={{ fontSize: 15, fontWeight: 600, color: shellColor.ink, marginBottom: 4 }}>Comparison Summary</div>
        <p style={{ margin: 0, fontSize: 13.5, color: shellColor.inkSoft, marginBottom: 16 }}>{result.summary}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ ...shellFigures, fontSize: 28, fontWeight: 700, color: shellColor.high }}>{result.matches.length}</div>
            <div style={{ fontSize: 11.5, color: shellColor.inkFaint, marginTop: 2 }}>Matched</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ ...shellFigures, fontSize: 28, fontWeight: 700, color: shellColor.low }}>{totalIssues}</div>
            <div style={{ fontSize: 11.5, color: shellColor.inkFaint, marginTop: 2 }}>Issues</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ ...shellFigures, fontSize: 28, fontWeight: 700, color: shellColor.teal }}>{matchRate}%</div>
            <div style={{ fontSize: 11.5, color: shellColor.inkFaint, marginTop: 2 }}>Match Rate</div>
          </div>
        </div>
      </div>

      {/* Sections */}
      {sections.map((section) => (
        <CollapsibleSection
          key={section.key}
          title={section.title}
          count={section.count}
          color={section.color}
          bg={section.bg}
          isOpen={open.has(section.key)}
          onToggle={() => toggle(section.key)}
        >
          {section.count === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: shellColor.inkFaint, padding: "8px 0" }}>No items</p>
          ) : (
            <div>
              {section.key === "matched" && result.matches.map((m, i) => <MatchedRow key={i} match={m} />)}
              {section.key === "missingInQb" && result.missingInQb.map((m, i) => <MissingRow key={i} item={m} />)}
              {section.key === "missingInBank" && result.missingInBank.map((m, i) => <MissingRow key={i} item={m} />)}
              {section.key === "duplicates" && result.duplicates.map((d, i) => <DuplicateRow key={i} dup={d} />)}
              {section.key === "amountMismatches" && result.amountMismatches.map((mm, i) => <MismatchRow key={i} mm={mm} />)}
              {section.key === "unmatchedItems" && result.unmatchedItems.map((u, i) => <UnmatchedRow key={i} item={u} />)}
            </div>
          )}
        </CollapsibleSection>
      ))}
    </div>
  );
}