"use client";

import { useEffect, useState } from "react";
import PendingDocuments from "@/components/PendingDocuments";
import { color, font } from "@/lib/theme";

/**
 * The approval queue as its own screen. Kept separate from the upload/review page
 * because the two are different jobs: that page is for reading ONE document
 * closely, this one is for clearing a stack. Putting a batch approve control next
 * to a single-document review form invites approving the wrong thing.
 */
export default function PendingPage() {
  // Only used to decide whether to offer the demo seed — the queue itself works
  // identically either way.
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    fetch("/api/connections")
      .then((r) => r.json())
      .then((d) => setDemo(Boolean(d.demo)))
      .catch(() => {
        /* best-effort: the queue works regardless */
      });
  }, []);

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "48px 22px 72px" }}>
      <a href="/" style={{ color: color.inkSoft, fontSize: 14, fontWeight: 600 }}>
        ← Back
      </a>
      <h1
        style={{
          marginBottom: 6,
          marginTop: 14,
          color: color.ink,
          fontFamily: font.display,
          fontWeight: 600,
          fontSize: 30,
        }}
      >
        Pending documents
      </h1>
      <p style={{ color: color.inkSoft, marginTop: 0, marginBottom: 32, lineHeight: 1.6 }}>
        Everything read but not yet approved. Approve one at a time, or tick several and approve
        them as a batch — each document is judged on its own, so one problem document never blocks
        the rest.
      </p>

      <PendingDocuments demo={demo} />
    </main>
  );
}
