"use client";

import { useMemo } from "react";
import type { MatchWithDetails } from "@/lib/dashboard-pipeline";
import { shellColor, shellButton } from "@/lib/shell-theme";
import MatchCard from "./match-card";

interface MatchListProps {
  matches: MatchWithDetails[];
  onApprove: (matchId: string) => void;
  onReject: (matchId: string) => void;
  onManualMatch: (match: MatchWithDetails) => void;
  emptyMessage: string;
  showBulkActions?: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (matchId: string) => void;
  onSelectAll: () => void;
  onBulkApprove?: () => void;
  isBulkProcessing?: boolean;
  bulkResults?: { approved: number; errors: number } | null;
}

export default function MatchList({
  matches,
  onApprove,
  onReject,
  onManualMatch,
  emptyMessage,
  showBulkActions = false,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onBulkApprove,
  isBulkProcessing = false,
  bulkResults,
}: MatchListProps) {
  const allSelected = matches.length > 0 && matches.every((m) => selectedIds.has(m.match.id));
  const someSelected = matches.some((m) => selectedIds.has(m.match.id));
  const selectedCount = selectedIds.size;

  // Only green matches can be bulk-approved
  const eligibleForBulk = useMemo(() => {
    return matches.filter((m) => m.match.flaggedLevel === "green" && m.qbTransaction !== null);
  }, [matches]);

  const canBulkApprove = showBulkActions && selectedCount > 0 && !isBulkProcessing;

  if (matches.length === 0) {
    return (
      <div
        style={{
          padding: 48,
          textAlign: "center",
          color: shellColor.inkFaint,
          fontSize: 14,
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Bulk action bar */}
      {showBulkActions && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            background: shellColor.highBg,
            borderRadius: 12,
            border: `1px solid ${shellColor.cardBorder}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected && !allSelected;
              }}
              onChange={onSelectAll}
              className="w-4 h-4 cursor-pointer"
              aria-label="Select all matches"
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.ink }}>
              {selectedCount > 0 ? `${selectedCount} selected` : "Select all"}
            </span>
          </div>

          {isBulkProcessing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 16,
                  border: `2px solid ${shellColor.high}`,
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <span style={{ fontSize: 13, color: shellColor.inkSoft }}>Processing…</span>
            </div>
          ) : bulkResults ? (
            <span style={{ fontSize: 13, color: shellColor.inkSoft }}>
              {bulkResults.errors > 0
                ? `${bulkResults.approved} approved, ${bulkResults.errors} failed`
                : `${bulkResults.approved} approved`}
            </span>
          ) : (
            <button
              onClick={onBulkApprove}
              disabled={!canBulkApprove}
              className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-white text-[13px] px-4 py-2 border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: shellColor.high,
                opacity: canBulkApprove ? 1 : 0.5,
                cursor: canBulkApprove ? "pointer" : "not-allowed",
              }}
            >
              Approve & Sync All
            </button>
          )}
        </div>
      )}

      {matches.map(({ match, bankTransaction, qbTransaction, auditMemo }) => (
        <MatchCard
          key={match.id}
          match={match}
          bankTransaction={bankTransaction}
          qbTransaction={qbTransaction}
          auditMemo={auditMemo}
          onApprove={() => onApprove(match.id)}
          onReject={() => onReject(match.id)}
          onManualMatch={() => onManualMatch({ match, bankTransaction, qbTransaction, auditMemo })}
          selected={selectedIds.has(match.id)}
          onSelect={() => onToggleSelect(match.id)}
          showCheckbox={showBulkActions}
        />
      ))}

      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}