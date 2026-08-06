"use client";

import { useState } from "react";
import CompareUpload, { type DateRange } from "@/components/reconciliation/compare-upload";
import ComparisonResults from "@/components/reconciliation/comparison-results";
import { pageTitle, pageSubtitle, shellCard, shellColor } from "@/lib/shell-theme";
import type { ComparisonResult } from "@/lib/comparison-schema";

export default function CrossFileComparisonPage() {
  const [comparisonResult, setComparisonResult] = useState<ComparisonResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCompare(
    files: { bankFile: File; qbFile: File },
    dateRange: DateRange
  ) {
    setIsLoading(true);
    setError(null);
    setComparisonResult(null);

    try {
      const form = new FormData();
      form.append("bankFile", files.bankFile);
      form.append("qbFile", files.qbFile);
      if (dateRange.start) form.append("dateStart", dateRange.start);
      if (dateRange.end) form.append("dateEnd", dateRange.end);

      const res = await fetch("/api/reconciliation/compare", {
        method: "POST",
        body: form,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Comparison failed.");
        return;
      }

      setComparisonResult(data as ComparisonResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div>
      <h1 style={pageTitle}>Cross-File Comparison</h1>
      <p style={pageSubtitle}>
        Upload a bank statement and a QuickBooks export to compare transactions side-by-side
      </p>

      <CompareUpload onCompare={handleCompare} isLoading={isLoading} />

      {error && (
        <div style={{ ...shellCard({ padding: "12px 16px", marginTop: 20 }), color: shellColor.low }}>
          {error}
        </div>
      )}

      {comparisonResult && !isLoading && (
        <div style={{ marginTop: 28 }}>
          <ComparisonResults result={comparisonResult} />
        </div>
      )}
    </div>
  );
}