"use client";

import { useState } from "react";
import type { ReconciliationMatch, BankTransaction, QbTransaction } from "@/lib/reconciliation-schema";
import type { AuditMemo } from "@/lib/audit-memo-schema";
import { shellColor, shellButton, pill, shellFigures, microLabel } from "@/lib/shell-theme";
import { formatMoney } from "@/lib/currency";

interface MatchCardProps {
  match: ReconciliationMatch;
  bankTransaction: BankTransaction;
  qbTransaction: QbTransaction | null;
  auditMemo: AuditMemo | null;
  onApprove: () => void;
  onReject: () => void;
  onManualMatch: () => void;
  selected?: boolean;
  onSelect?: () => void;
  showCheckbox?: boolean;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function levelColor(level: "green" | "yellow" | "red"): string {
  switch (level) {
    case "green":
      return shellColor.high;
    case "yellow":
      return shellColor.medium;
    case "red":
      return shellColor.low;
  }
}

function levelBg(level: "green" | "yellow" | "red"): string {
  switch (level) {
    case "green":
      return shellColor.highBg;
    case "yellow":
      return shellColor.mediumBg;
    case "red":
      return shellColor.lowBg;
  }
}

export default function MatchCard({
  match,
  bankTransaction,
  qbTransaction,
  auditMemo,
  onApprove,
  onReject,
  onManualMatch,
  selected = false,
  onSelect,
  showCheckbox = false,
}: MatchCardProps) {
  const [auditOpen, setAuditOpen] = useState(false);
  const isUnmatched = qbTransaction === null;
  const confidencePct = Math.round((match.confidence ?? 0) * 100);
  const borderColor = levelColor(match.flaggedLevel);
  const badgeBg = levelBg(match.flaggedLevel);
  const canApprove = !isUnmatched && (match.flaggedLevel === "green" || match.flaggedLevel === "yellow");

  return (
    <div
      className="relative flex overflow-hidden rounded-[14px] border bg-white"
      style={{ borderColor: shellColor.cardBorder }}
    >
      {/* Colored left border */}
      <div
        className="w-1 self-stretch flex-shrink-0"
        style={{ background: borderColor, borderRadius: "3px 0 0 3px" }}
      />

      <div className="flex-1 p-5">
        {/* Top: checkbox + confidence badge + match type */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {showCheckbox && onSelect && (
              <input
                type="checkbox"
                checked={selected}
                onChange={onSelect}
                className="w-4 h-4 cursor-pointer"
                aria-label="Select match"
              />
            )}
            <span style={pill(borderColor, badgeBg, "sm")}>{confidencePct}% confidence</span>
          </div>
          <span className="text-xs font-semibold" style={{ color: shellColor.inkFaint }}>
            {isUnmatched ? "Unmatched" : match.matchedBy === "auto" ? "Auto match" : "Manual match"}
          </span>
        </div>

        {/* Middle: two columns (Bank ↔ QB) */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start mb-3">
          {/* Bank */}
          <div className="flex flex-col gap-1">
            <span style={microLabel}>Bank</span>
            <span className="text-[13px] font-semibold" style={{ color: shellColor.ink }}>
              {bankTransaction.merchant ?? bankTransaction.description ?? "—"}
            </span>
            <span className="text-[11.5px]" style={{ color: shellColor.inkSoft }}>
              <span style={shellFigures}>{formatMoney(bankTransaction.amount, bankTransaction.currency)}</span>
              {" · "}
              {formatDate(bankTransaction.transactionDate)}
            </span>
          </div>

          {/* Arrow */}
          <div className="pt-5 text-lg" style={{ color: shellColor.inkFaint }}>
            ↔
          </div>

          {/* QB */}
          <div className="flex flex-col gap-1">
            <span style={microLabel}>QB</span>
            <span className="text-[13px] font-semibold" style={{ color: shellColor.ink }}>
              {qbTransaction?.description ?? "—"}
            </span>
            <span className="text-[11.5px]" style={{ color: shellColor.inkSoft }}>
              <span style={shellFigures}>
                {qbTransaction ? formatMoney(qbTransaction.amount, qbTransaction.currency) : "—"}
              </span>
              {" · "}
              {formatDate(qbTransaction?.postedDate)}
            </span>
          </div>
        </div>

        {/* Match reason line */}
        {match.matchReason && (
          <div className="text-[12px] mb-3" style={{ color: shellColor.inkSoft }}>
            {match.matchReason}
          </div>
        )}

        {/* Expandable audit memo section */}
        {auditMemo && (
          <div className="mb-3">
            <button
              onClick={() => setAuditOpen((v) => !v)}
              className="flex items-center gap-2 text-[12px] font-semibold bg-transparent border-none cursor-pointer"
              style={{ color: shellColor.inkSoft }}
            >
              <span
                className="text-[10px] transition-transform duration-150"
                style={{ transform: auditOpen ? "rotate(180deg)" : "none", color: shellColor.inkFaint }}
              >
                ▼
              </span>
              Audit memo
            </button>
            {auditOpen && (
              <div className="mt-2 p-3 rounded-lg" style={{ background: shellColor.trackBg }}>
                <div className="text-[13px] font-semibold mb-1" style={{ color: shellColor.ink }}>
                  {auditMemo.title}
                </div>
                <div className="text-[12px] mb-2" style={{ color: shellColor.inkSoft }}>
                  {auditMemo.explanation}
                </div>
                <div className="text-[12px] mb-2" style={{ color: shellColor.inkSoft }}>
                  <span className="font-semibold" style={{ color: shellColor.ink }}>
                    Suggested:
                  </span>{" "}
                  {auditMemo.suggestedAction}
                </div>
                {auditMemo.taxRelevant && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold"
                    style={{ background: shellColor.highBg, color: shellColor.high }}
                  >
                    Tax relevant
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-4">
          {canApprove && (
            <button
              onClick={onApprove}
              className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-white text-[13.5px] px-4 py-2 border-none cursor-pointer"
              style={{
                background: match.flaggedLevel === "green" ? shellColor.high : shellColor.medium,
              }}
            >
              Approve
            </button>
          )}
          <button
            onClick={onReject}
            className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-[13.5px] px-4 py-2 cursor-pointer"
            style={shellButton("dangerOutline")}
          >
            Reject
          </button>
          {isUnmatched && (
            <button
              onClick={onManualMatch}
              className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-[13.5px] px-4 py-2 cursor-pointer"
              style={shellButton("outline")}
            >
              Manual Match
            </button>
          )}
        </div>
      </div>
    </div>
  );
}