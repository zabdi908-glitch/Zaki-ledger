"use client";

import { useState, useCallback } from "react";
import { shellButton, shellCard, shellColor, disabledOverride } from "@/lib/shell-theme";

export interface DateRange {
  start?: string;
  end?: string;
}

interface CompareUploadProps {
  onCompare: (files: { bankFile: File; qbFile: File }, dateRange: DateRange) => void;
  isLoading?: boolean;
}

export default function CompareUpload({ onCompare, isLoading = false }: CompareUploadProps) {
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [qbFile, setQbFile] = useState<File | null>(null);
  const [bankDragOver, setBankDragOver] = useState(false);
  const [qbDragOver, setQbDragOver] = useState(false);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const handleDrop = useCallback(
    (e: React.DragEvent, type: "bank" | "qb") => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (type === "bank") {
        setBankFile(file);
        setBankDragOver(false);
      } else {
        setQbFile(file);
        setQbDragOver(false);
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent, type: "bank" | "qb") => {
    e.preventDefault();
    if (type === "bank") setBankDragOver(true);
    else setQbDragOver(true);
  }, []);

  const handleDragLeave = useCallback((type: "bank" | "qb") => {
    if (type === "bank") setBankDragOver(false);
    else setQbDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, type: "bank" | "qb") => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (type === "bank") setBankFile(file);
      else setQbFile(file);
      e.target.value = "";
    },
    []
  );

  const canCompare = bankFile !== null && qbFile !== null && !isLoading;

  const dropZoneBase: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "48px 24px",
    borderRadius: 14,
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
    gap: 8,
  };

  function dropZoneStyle(isActive: boolean, hasFile: boolean): React.CSSProperties {
    return {
      ...dropZoneBase,
      border: `2px dashed ${isActive ? shellColor.teal : hasFile ? shellColor.high : shellColor.cardBorder}`,
      background: isActive ? "oklch(96% 0.02 195)" : hasFile ? shellColor.highBg : shellColor.paper,
    };
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Bank Statement Drop Zone */}
        <label
          style={dropZoneStyle(bankDragOver, bankFile !== null)}
          onDragOver={(e) => handleDragOver(e, "bank")}
          onDragLeave={() => handleDragLeave("bank")}
          onDrop={(e) => handleDrop(e, "bank")}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: shellColor.ink }}>
            {bankFile ? bankFile.name : "Bank Statement (CSV/OFX)"}
          </div>
          <div style={{ fontSize: 13, color: shellColor.inkSoft }}>
            {bankFile ? `${(bankFile.size / 1024).toFixed(1)} KB` : "Drag & drop or click to choose"}
          </div>
          <input
            type="file"
            accept=".csv,.ofx,.qfx"
            onChange={(e) => handleFileInput(e, "bank")}
            hidden
          />
        </label>

        {/* QuickBooks Export Drop Zone */}
        <label
          style={dropZoneStyle(qbDragOver, qbFile !== null)}
          onDragOver={(e) => handleDragOver(e, "qb")}
          onDragLeave={() => handleDragLeave("qb")}
          onDrop={(e) => handleDrop(e, "qb")}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: shellColor.ink }}>
            {qbFile ? qbFile.name : "QuickBooks Export (CSV)"}
          </div>
          <div style={{ fontSize: 13, color: shellColor.inkSoft }}>
            {qbFile ? `${(qbFile.size / 1024).toFixed(1)} KB` : "Drag & drop or click to choose"}
          </div>
          <input
            type="file"
            accept=".csv,.ofx,.qfx"
            onChange={(e) => handleFileInput(e, "qb")}
            hidden
          />
        </label>
      </div>

      {/* Optional Date Range */}
      <div style={{ ...shellCard({ padding: "16px 20px" }), display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: shellColor.inkSoft }}>Optional date range:</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12.5, color: shellColor.inkFaint }}>Start</label>
          <input
            type="date"
            value={dateStart}
            onChange={(e) => setDateStart(e.target.value)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: `1px solid ${shellColor.cardBorder}`,
              fontSize: 13,
              fontFamily: "inherit",
              color: shellColor.ink,
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12.5, color: shellColor.inkFaint }}>End</label>
          <input
            type="date"
            value={dateEnd}
            onChange={(e) => setDateEnd(e.target.value)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: `1px solid ${shellColor.cardBorder}`,
              fontSize: 13,
              fontFamily: "inherit",
              color: shellColor.ink,
            }}
          />
        </div>
      </div>

      {/* Compare Button */}
      <button
        style={canCompare ? shellButton("primary", "lg") : { ...shellButton("primary", "lg"), ...disabledOverride() }}
        onClick={() => {
          if (bankFile && qbFile) {
            onCompare(
              { bankFile, qbFile },
              { start: dateStart || undefined, end: dateEnd || undefined }
            );
          }
        }}
        disabled={!canCompare}
      >
        {isLoading ? "Comparing…" : "Compare Files"}
      </button>
    </div>
  );
}