"use client";

import Link from "next/link";
import { useState } from "react";
import { shellButton, shellCard, shellColor, progressFill, progressTrack } from "@/lib/shell-theme";

type Stage = "idle" | "processing" | "done";

type FileResult = { filename: string; confidence: number; status: "success" | "error" };

/**
 * Upload & Extract. Real NDJSON-streamed extraction (see
 * app/api/extract-batch/route.ts) drives the progress bar instead of the
 * mockup's fake 9%/140ms timer — same visual states (idle/processing/done),
 * real numbers.
 */
export default function UploadPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setStage("processing");
    setResults([]);
    setError(null);
    setTotal(files.length);

    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/extract-batch", { method: "POST", body: form });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Upload failed.");
        setStage("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collected: FileResult[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "result") {
            collected.push({
              filename: evt.filename,
              confidence: evt.confidence ?? 0,
              status: evt.status,
            });
            setResults([...collected]);
          }
        }
      }
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setStage("idle");
    }
  }

  const pct = total > 0 ? Math.round((results.length / total) * 100) : 0;
  const succeeded = results.filter((r) => r.status === "success");
  const highCount = succeeded.filter((r) => r.confidence * 100 >= 95).length;
  const mediumCount = succeeded.filter((r) => r.confidence * 100 >= 70 && r.confidence * 100 < 95).length;
  const lowCount = succeeded.filter((r) => r.confidence * 100 < 70).length;

  return (
    <div>
      <h1 style={{ fontSize: 32, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" }}>Upload &amp; Extract</h1>
      <p style={{ fontSize: 15, color: shellColor.inkSoft, margin: "0 0 32px" }}>
        Drop invoices or receipts to extract data automatically
      </p>

      {stage === "idle" && (
        <div>
          <label
            style={{
              display: "block",
              border: `2px dashed ${shellColor.cardBorder}`,
              borderRadius: 14,
              padding: "64px 24px",
              textAlign: "center",
              cursor: "pointer",
              background: shellColor.paper,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Drag &amp; drop files here</div>
            <div style={{ fontSize: 14, color: shellColor.inkSoft, marginBottom: 20 }}>
              or click to browse — PDF or images, up to 25MB each
            </div>
            <span style={shellButton("primary", "lg")}>Choose files</span>
            <input type="file" accept="application/pdf,image/*" multiple onChange={onPick} hidden />
          </label>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <FileChip label="PDF" bg="oklch(94% 0.06 25)" color="oklch(52% 0.18 25)" text="Invoices & receipts" />
            <FileChip label="CSV" bg="oklch(94% 0.05 155)" color="oklch(50% 0.14 155)" text="Bank statements" />
            <FileChip label="OFX" bg="oklch(94% 0.07 80)" color="oklch(52% 0.15 80)" text="Bank exports" />
          </div>
          {error && <p style={{ ...shellCard({ padding: "12px 16px", marginTop: 16 }), color: shellColor.low }}>{error}</p>}
        </div>
      )}

      {stage === "processing" && (
        <div style={shellCard({ padding: 48, textAlign: "center" })}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
            Extracting data from {total} file{total === 1 ? "" : "s"}…
          </div>
          <div style={{ ...progressTrack(), maxWidth: 420, margin: "0 auto" }}>
            <div style={progressFill(pct)} />
          </div>
          <div style={{ fontSize: 13, color: shellColor.inkSoft, marginTop: 12, fontFamily: "var(--font-mono)" }}>{pct}% complete</div>
        </div>
      )}

      {stage === "done" && (
        <div>
          <div style={shellCard({ padding: 32, marginBottom: 20 })}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              {succeeded.length} item{succeeded.length === 1 ? "" : "s"} extracted
            </div>
            <div style={{ fontSize: 14, color: shellColor.inkSoft, marginBottom: 24 }}>
              Review flagged items before posting to QuickBooks
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
              <SummaryTile count={highCount} label="Auto-approved (95%+)" bg="oklch(96% 0.03 155)" color="oklch(45% 0.14 155)" subColor="oklch(40% 0.1 155)" />
              <SummaryTile count={mediumCount} label="Needs review (70–95%)" bg="oklch(96% 0.04 80)" color="oklch(48% 0.15 80)" subColor="oklch(42% 0.11 80)" />
              <SummaryTile count={lowCount} label="Flagged (below 70%)" bg="oklch(96% 0.04 25)" color="oklch(48% 0.18 25)" subColor="oklch(42% 0.13 25)" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <Link href="/review" style={{ ...shellButton("primary", "lg"), textDecoration: "none" }}>
              Review flagged items ({mediumCount + lowCount})
            </Link>
            <Link href="/dashboard" style={{ ...shellButton("outline", "lg"), textDecoration: "none" }}>
              Back to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function FileChip({ label, bg, color, text }: { label: string; bg: string; color: string; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: shellColor.inkSoft }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: bg,
          color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10.5,
          fontWeight: 700,
          fontFamily: "var(--font-mono)",
        }}
      >
        {label}
      </div>
      {text}
    </div>
  );
}

function SummaryTile({ count, label, bg, color, subColor }: { count: number; label: string; bg: string; color: string; subColor: string }) {
  return (
    <div style={{ background: bg, borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: 13, color: subColor }}>{label}</div>
    </div>
  );
}
