"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useReconciliationProgress } from "@/hooks/use-reconciliation-progress";
import type { ProgressStage } from "@/lib/realtime-progress";
import {
  shellCard,
  shellColor,
  shellButton,
  progressTrack,
  progressFill,
} from "@/lib/shell-theme";

const STAGE_CONFIG: { key: Exclude<ProgressStage, "error">; label: string }[] =
  [
    { key: "uploading", label: "Uploading" },
    { key: "parsing", label: "Parsing" },
    { key: "extracting", label: "Extracting" },
    { key: "matching", label: "Matching" },
    { key: "generating_memos", label: "Generating memos" },
    { key: "complete", label: "Complete" },
  ];

interface ProgressStreamProps {
  userId: string | null;
  statementId: string | null;
  transactionCount: number;
  onRetry: () => void;
}

export default function ProgressStream({
  userId,
  statementId,
  transactionCount,
  onRetry,
}: ProgressStreamProps) {
  const router = useRouter();
  const { stage, details, progress } = useReconciliationProgress(
    userId,
    statementId,
  );
  const hasRedirected = useRef(false);

  // Auto-redirect to the statement dashboard after 2 seconds on complete
  useEffect(() => {
    if (stage === "complete" && statementId && !hasRedirected.current) {
      hasRedirected.current = true;
      const timer = setTimeout(() => {
        router.push(`/reconciliation/${statementId}`);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [stage, statementId, router]);

  // Error state
  if (stage === "error") {
    const errorMessage =
      typeof details?.error === "string"
        ? details.error
        : typeof details?.message === "string"
          ? details.message
          : "Something went wrong during processing.";

    return (
      <div style={shellCard({ padding: 48, textAlign: "center" })}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            marginBottom: 8,
            color: shellColor.low,
          }}
        >
          Processing failed
        </div>
        <p
          style={{
            fontSize: 14,
            color: shellColor.inkSoft,
            margin: "0 auto 28px",
            maxWidth: 360,
            lineHeight: 1.5,
          }}
        >
          {errorMessage}
        </p>
        <button style={shellButton("primary", "lg")} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const currentIndex = stage
    ? STAGE_CONFIG.findIndex((s) => s.key === stage)
    : -1;
  const isUploadingPhase =
    !statementId || stage === null || stage === "uploading";

  return (
    <div style={shellCard({ padding: 48, textAlign: "center" })}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        {stage === "complete"
          ? "All done!"
          : isUploadingPhase
            ? `Uploading ${transactionCount > 0 ? `${transactionCount} transactions` : "your statement"}…`
            : "Processing your statement…"}
      </div>

      {stage !== "complete" && (
        <p
          style={{
            fontSize: 13,
            color: shellColor.inkSoft,
            margin: "0 0 24px",
          }}
        >
          {stage ? STAGE_CONFIG[currentIndex]?.label : "Preparing…"}
        </p>
      )}

      {/* Animated progress bar */}
      <div
        style={{ ...progressTrack(), maxWidth: 420, margin: "0 auto 28px" }}
      >
        <div
          style={{
            ...progressFill(progress || (isUploadingPhase ? 10 : 0)),
            transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      </div>

      {/* Stage labels */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          flexWrap: "wrap",
          maxWidth: 560,
          margin: "0 auto",
        }}
      >
        {STAGE_CONFIG.map((s, i) => {
          const isCompleted = i < currentIndex;
          const isCurrent = i === currentIndex;
          const isPending = i > currentIndex;

          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                transition: "all 0.35s ease",
                background: isCompleted
                  ? shellColor.highBg
                  : isCurrent
                    ? shellColor.teal + "18"
                    : "transparent",
                color: isCompleted
                  ? shellColor.high
                  : isCurrent
                    ? shellColor.teal
                    : shellColor.inkFaint,
                opacity: isPending ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 700,
                  background: isCompleted
                    ? shellColor.high
                    : isCurrent
                      ? shellColor.teal
                      : shellColor.trackBg,
                  color:
                    isCompleted || isCurrent ? "white" : shellColor.inkFaint,
                  transition: "all 0.35s ease",
                }}
              >
                {isCompleted ? "✓" : i + 1}
              </span>
              {s.label}
            </div>
          );
        })}
      </div>

      {stage === "complete" && (
        <p
          style={{
            marginTop: 20,
            fontSize: 13,
            color: shellColor.inkSoft,
          }}
        >
          Redirecting to dashboard…
        </p>
      )}
    </div>
  );
}