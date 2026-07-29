"use client";

import { useEffect, useState } from "react";
import BatchUpload from "@/components/BatchUpload";
import {
  REVIEWABLE_FIELDS,
  type DocumentType,
  type InvoiceExtraction,
  type ReviewableField,
} from "@/lib/schema";
import {
  checkTotals,
  effectiveConfidence,
  fieldLabels,
  gateApproval,
  reasonText,
} from "@/lib/validation";
import ApprovalStamp from "@/components/ApprovalStamp";
import {
  banner,
  button,
  card,
  chip as chipStyle,
  color,
  disabledOverride,
  eyebrow,
  figures,
  font,
  input as inputStyleFor,
  radius,
  seal,
  typeBadge,
} from "@/lib/theme";

type ConfiguredStatus = { xero: { configured: boolean }; quickbooks: { configured: boolean }; demo?: boolean };
/** A provider's live connection status: null while the check is in flight. */
type LiveStatus = { connected: boolean; accountName?: string } | null;
type AccountingProvider = "xero" | "quickbooks";

/** Parse a review-field string into a number, or null when it isn't one. */
function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Effective confidence per field for the approval gate: a field the human has
 * corrected counts as verified (100%), which is what lets a blocked form unlock
 * live as the accountant fixes a flagged field — no re-submit needed.
 *
 * A field edited to blank is NOT verified — an empty Critical/Important value is
 * clearly not real data (and can happen by accident) — so it keeps its original
 * AI confidence and still gates approval.
 */
function effectiveConfidences(
  extraction: InvoiceExtraction,
  edited: Record<string, string>,
  affirmed: Record<string, boolean>,
): Record<ReviewableField, number> {
  const out = {} as Record<ReviewableField, number>;
  for (const f of REVIEWABLE_FIELDS) {
    const original = String((extraction as any)[f].value);
    out[f] = effectiveConfidence((extraction as any)[f].confidence, original, edited[f], affirmed[f] === true);
  }
  return out;
}

type ExtractResponse = {
  /** The queue row this upload created — sent back on approve so it's cleared. */
  documentId?: string | null;
  /**
   * Set when the document was read fine but couldn't be added to the approval
   * queue. Surfaced rather than swallowed: an empty queue after a successful
   * upload looks like lost data, and the human deserves to know it's a
   * configuration problem and that this document is still approvable here.
   */
  queueError?: string | null;
  extraction: InvoiceExtraction;
  arithmeticMismatch: boolean;
  demo?: boolean;
  refinedForSupplier?: string | null;
  /** Reviewable fields whose confidence was lifted by this supplier's track record. */
  calibratedFields?: string[];
  /** Per-field track record for this supplier: how many prior confirmed reads + their confidence. */
  supplierMemory?: Record<string, { count: number; confidence: number }>;
  /** Set when a matching document was already processed (see the store's identity rules). */
  duplicate?: {
    documentType?: DocumentType;
    supplierName: string;
    invoiceNumber: string;
    processedOn: string; // ISO timestamp of the earlier document
    existingId: string;
  } | null;
};

/** Below this, a field is "low confidence" and gets flagged for the human. */
const CONFIDENCE_THRESHOLD = 0.85;


export default function Home() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The human explicitly chose to proceed past a duplicate warning.
  const [proceedDuplicate, setProceedDuplicate] = useState(false);
  // Fields the human affirmed as-is (correct despite low confidence) — clears the
  // gate without an edit, so approve records a confirmation, not a correction.
  const [affirmed, setAffirmed] = useState<Record<string, boolean>>({});
  // A duplicate discovered at approve time (on the final, human-approved values).
  const [approveDuplicate, setApproveDuplicate] = useState<ExtractResponse["duplicate"] | null>(null);
  // The human settled an uncertain invoice-vs-receipt classification. `typeOverride`
  // is set only when they picked the OTHER type; confirming the detected one just
  // clears the gate.
  const [typeConfirmed, setTypeConfirmed] = useState(false);
  const [typeOverride, setTypeOverride] = useState<DocumentType | null>(null);
  const [configured, setConfigured] = useState<ConfiguredStatus | null>(null);
  // Live status per platform — proven with a real API call, not just "a token is
  // stored". Null means the check hasn't landed yet.
  const [xeroStatus, setXeroStatus] = useState<LiveStatus>(null);
  const [qboStatus, setQboStatus] = useState<LiveStatus>(null);
  // The provider a disconnect is being confirmed for, and the one currently
  // disconnecting — the destructive click is never the first click.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<AccountingProvider | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = useState<AccountingProvider | null>(null);
  // Set to "xero"/"quickbooks" right after returning from a successful OAuth flow.
  const [justConnected, setJustConnected] = useState<string | null>(null);
  // How many documents are waiting for approval — just the count, to point at the
  // queue. The queue itself lives on /pending; see components/PendingDocuments.
  const [pendingCount, setPendingCount] = useState(0);
  // Set when 2+ files were picked — hands off to the parallel batch flow.
  const [batchFiles, setBatchFiles] = useState<File[] | null>(null);
  /**
   * Bumped on every batch selection, and used as BatchUpload's `key`.
   *
   * Without it, picking a second batch while the first one's results were still
   * on screen did nothing visible: React kept the same BatchUpload instance, its
   * `rows` state survived the prop change, and the component short-circuited
   * straight back to the old results — so the new files were never read and the
   * app looked like it only accepted one upload. A new selection is a new batch,
   * so it gets a new component rather than one carrying the last batch's state.
   */
  const [batchNonce, setBatchNonce] = useState(0);
  // True while a batch is actually being read, so a second pick can't abandon a
  // stream that is still delivering results.
  const [batchRunning, setBatchRunning] = useState(false);

  /** Which platforms have client credentials set, plus the demo-mode flag. */
  async function refreshConnections() {
    try {
      const res = await fetch("/api/connections");
      if (res.ok) setConfigured(await res.json());
    } catch {
      /* status is best-effort; the upload flow works regardless */
    }
  }

  /**
   * Live per-platform status — each endpoint refreshes an expired token and
   * proves it with a real API call, so "connected" here means "would actually
   * post a bill right now", not just "a token exists somewhere".
   *
   * A failed request (401, a 5xx, a network blip) means "couldn't verify right
   * now" — not "disconnected". The common cause is a session cookie that's
   * mid-refresh on the first request after a page load or a busy upload/approve
   * sequence, which is transient by nature. Collapsing that into `connected:
   * false` (the old behaviour) made the OAuth token look revoked every time a
   * check merely failed to land — the token itself is untouched (nothing here
   * ever deletes it; only an explicit Disconnect does, see disconnectAccounting
   * below). So a failed check leaves the displayed status as it was and retries
   * once shortly after, rather than flashing "Not Connected".
   */
  async function refreshAccountingStatus(isRetry = false) {
    const check = async (path: string): Promise<LiveStatus> => {
      try {
        const res = await fetch(path);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    };
    const [xero, qbo] = await Promise.all([
      check("/api/auth/xero/status"),
      check("/api/auth/quickbooks/status"),
    ]);
    if (xero) setXeroStatus(xero);
    if (qbo) setQboStatus(qbo);
    if (!isRetry && (!xero || !qbo)) {
      setTimeout(() => refreshAccountingStatus(true), 1500);
    }
  }

  /** Forget a platform's tokens and fall back to the connect-one-platform choice. */
  async function disconnectAccounting(provider: AccountingProvider) {
    setDisconnecting(provider);
    try {
      await fetch(`/api/${provider}/disconnect`, { method: "POST" });
    } finally {
      setDisconnecting(null);
      setConfirmingDisconnect(null);
      await refreshAccountingStatus();
    }
  }

  /** How many documents are waiting, so the queue link can carry a count. */
  async function refreshPending() {
    try {
      const res = await fetch("/api/pending");
      if (!res.ok) return;
      const data = (await res.json()) as { documents: unknown[] };
      setPendingCount(data.documents.length);
    } catch {
      /* the queue is additive to the single-document flow; never block on it */
    }
  }

  useEffect(() => {
    refreshConnections();
    refreshAccountingStatus();
    refreshPending();
    // Surface the ?connected=… flag the OAuth callback redirects back with.
    const connected = new URLSearchParams(window.location.search).get("connected");
    if (connected) {
      setJustConnected(connected);
      window.history.replaceState(null, "", window.location.pathname); // clean the URL
    }
  }, []);

  /** Reset back to the empty upload state (used by the duplicate "Discard"). */
  function discard() {
    setResult(null);
    setEdited({});
    setApproved(null);
    setError(null);
    setProceedDuplicate(false);
    setAffirmed({});
    setApproveDuplicate(null);
    setTypeConfirmed(false);
    setTypeOverride(null);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Let the same input be re-picked with the same file later — without this,
    // choosing the identical file twice fires no change event.
    e.target.value = "";
    if (picked.length === 0) return;

    // Two files or more is a different job: nobody reviews ten documents field by
    // field on one screen. It goes to the batch flow, which reads them in
    // parallel and hands them to the approval queue. One file keeps the close
    // review screen below, which is still the heart of the product.
    if (picked.length > 1) {
      setBatchFiles(picked);
      setBatchNonce((n) => n + 1); // a new selection is a new batch, not the old one
      setResult(null);
      setApproved(null);
      setError(null);
      return;
    }

    const file = picked[0];
    setBatchFiles(null);
    setLoading(true);
    setError(null);
    setResult(null);
    setApproved(null);
    setProceedDuplicate(false);
    setAffirmed({});
    setApproveDuplicate(null);
    setTypeConfirmed(false);
    setTypeOverride(null);

    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/extract", { method: "POST", body: form });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Something went wrong.");
      return;
    }
    setResult(data);
    const initial: Record<string, string> = {};
    for (const f of REVIEWABLE_FIELDS) initial[f] = String((data.extraction as any)[f].value);
    setEdited(initial);
    // The upload also queued the document, so the batch list needs to know.
    refreshPending();
  }

  async function onApprove(forceProceed = false) {
    if (!result) return;
    const proceed = forceProceed || proceedDuplicate;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // documentType is sent separately so a human override of a shaky
      // classification is what gets stored, posted and duplicate-matched on —
      // not the model's original guess.
      body: JSON.stringify({
        extraction: result.extraction,
        edited,
        proceedDuplicate: proceed,
        documentType,
        // Clears this document from the bulk queue once it's in the ledger.
        documentId: result.documentId,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Approve failed.");

    // Approve-time duplicate: the final (human-corrected) values matched an existing
    // invoice the raw extraction missed. Prompt, don't save — the human decides.
    if (data.status === "duplicate") {
      setApproveDuplicate(data.duplicate);
      return;
    }
    setApproveDuplicate(null);

    const base =
      data.correctionsRecorded > 0
        ? `Approved. ${data.correctionsRecorded} correction(s) recorded — the tool just got smarter.`
        : "Approved. No corrections needed — the AI got it all right.";

    // Surface where the invoice landed once an accounting platform is connected.
    let bill = "";
    if (data.billId) {
      const platform = data.billPlatform === "quickbooks" ? "QuickBooks" : "Xero";
      bill = ` Posted as a draft bill to ${platform} (ID ${data.billId}).`;
    } else if (data.billError) {
      bill = ` (Couldn't post to the accounting platform: ${data.billError})`;
    }
    setApproved(base + bill);
    refreshPending(); // it's in the ledger now — it must leave the batch list
  }

  // Document type drives labels and which fields the gate judges — a receipt's
  // missing number must not block it. Defaults to invoice for safety. The human
  // can override a shaky classification, which also confirms it.
  const detectedType: DocumentType = result?.extraction.documentType?.value ?? "invoice";
  const documentType: DocumentType = typeOverride ?? detectedType;
  const typeConfidence = result?.extraction.documentType?.confidence ?? 1;
  const taxItemized = result?.extraction.taxItemized ?? true;
  const labels = fieldLabels(documentType);
  const isReceipt = documentType === "receipt";
  /** A read is in flight — either the single-document one or a batch. */
  const busy = loading || batchRunning;

  // Recomputed every render, so editing a flagged field re-evaluates live —
  // both the gate below and the per-field confidence badges read from this map.
  const confidences = result ? effectiveConfidences(result.extraction, edited, affirmed) : null;
  const gate = confidences
    ? gateApproval(confidences, {
        documentType,
        taxItemized,
        documentTypeConfidence: typeConfidence,
        documentTypeConfirmed: typeConfirmed,
      })
    : null;

  return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "48px 22px 72px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
        <span style={seal(44)}>ZL</span>
        <div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              color: color.ink,
              lineHeight: 1.15,
              fontFamily: font.display,
            }}
          >
            Zaki Ledger
          </div>
          <div style={{ fontSize: 13, color: color.inkSoft }}>AI invoice entry for bookkeepers</div>
        </div>
      </header>

      <p style={{ color: color.inkSoft, marginTop: 0, marginBottom: 24, lineHeight: 1.6 }}>
        The AI drafts every field with a confidence score. You check and approve in one click —
        nothing is saved without you.{" "}
        <a href="/corrections" style={{ color: color.ink, fontWeight: 700 }}>
          View the correction ledger →
        </a>
      </p>

      {/* Accounting connection — where approved invoices post as draft bills.
          One platform at a time: connecting one hides the other, and posting
          only ever targets whichever is connected (lib/accounting.ts). */}
      <section style={connBarStyle}>
        <span style={eyebrow}>Accounting</span>
        <AccountingConnection
          configured={configured}
          xeroStatus={xeroStatus}
          qboStatus={qboStatus}
          confirmingDisconnect={confirmingDisconnect}
          disconnecting={disconnecting}
          onRequestDisconnect={setConfirmingDisconnect}
          onCancelDisconnect={() => setConfirmingDisconnect(null)}
          onDisconnect={disconnectAccounting}
        />
      </section>

      {justConnected && (
        <p style={banner("ok")}>
          Connected to <strong>{justConnected === "quickbooks" ? "QuickBooks" : "Xero"}</strong>.
          Approved invoices will now post there as draft bills.
        </p>
      )}

      {/* Busy during a single read OR a batch read. The batch case matters: a
          second pick mid-stream would replace the component still receiving
          results, so those documents would land in the queue having never
          appeared on screen. */}
      <label style={busy ? { ...button("primary"), ...disabledOverride() } : button("primary")}>
        {loading
          ? "Reading document…"
          : batchRunning
            ? "Reading documents…"
            : "＋ Upload invoices or receipts (PDF or images)"}
        <input
          type="file"
          accept="application/pdf,image/*"
          multiple
          onChange={onUpload}
          hidden
          disabled={busy}
        />
      </label>
      <p style={{ margin: "10px 0 0", fontSize: 13, color: color.inkSoft }}>
        Pick several at once to read them in parallel and send them straight to the approval queue.
      </p>

      {error && <p style={{ ...banner("bad"), marginTop: 16 }}>{error}</p>}

      {/* 2+ files: parallel read, live progress, per-file result. */}
      {batchFiles && (
        <BatchUpload
          key={batchNonce}
          files={batchFiles}
          onCancel={() => setBatchFiles(null)}
          onDone={refreshPending}
          onRunningChange={setBatchRunning}
        />
      )}

      {/* Read fine, but never made it to the queue. Say so plainly — and say what
          still works — instead of leaving an empty queue to look like data loss. */}
      {result?.queueError && (
        <p style={{ ...banner("warn"), marginTop: 20 }}>
          This document was read successfully but couldn&apos;t be added to the approval queue, so
          it won&apos;t appear on the{" "}
          <a href="/pending" style={{ color: color.goldDeep, fontWeight: 700 }}>
            pending documents
          </a>{" "}
          page. You can still review and approve it below. <br />
          <span style={{ fontSize: 12 }}>
            Usually the <code>pending_documents</code> table is missing or out of date — re-run{" "}
            <code>db/schema.sql</code>. ({result.queueError})
          </span>
        </p>
      )}

      {/* The queue lives on its own screen — this is just the pointer to it. */}
      {pendingCount > 0 && (
        <a href="/pending" style={queueLinkStyle}>
          <span>
            <strong>
              {pendingCount} document{pendingCount === 1 ? "" : "s"} waiting for approval
            </strong>
            <span style={{ display: "block", fontSize: 13, color: "#6b7a8f", marginTop: 2 }}>
              Approve them one at a time, or tick several and approve as a batch.
            </span>
          </span>
          <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>Review queue →</span>
        </a>
      )}

      {/* Cold-open explainer — helps a first-time visitor understand it instantly.
          Numbered because it genuinely is a sequence: you upload, then review,
          then approve — order carries real meaning here, not decoration. */}
      {!result && !loading && !error && !batchFiles && pendingCount === 0 && (
        <section style={card({ marginTop: 28 })}>
          <div style={eyebrow}>How it works</div>
          <ol style={{ margin: "14px 0 0", paddingLeft: 0, listStyle: "none" }}>
            {[
              ["01", "Upload", "Drop in an invoice or receipt — PDF or a photo."],
              ["02", "Review", "Each field is scored: green means sure, amber means check. Fix anything wrong."],
              ["03", "Approve & it learns", "One click. Every correction makes the next read sharper."],
            ].map(([n, t, d]) => (
              <li key={n} style={{ display: "flex", gap: 14, marginBottom: 14 }}>
                <span style={stepNumStyle}>{n}</span>
                <span style={{ fontSize: 14, color: color.inkSoft, paddingTop: 2 }}>
                  <strong style={{ color: color.ink, fontFamily: font.display, fontWeight: 600 }}>
                    {t}.
                  </strong>{" "}
                  {d}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {result?.demo && (
        <p style={{ ...banner("info"), marginTop: 20 }}>
          <strong>Demo mode</strong> — this is a sample {isReceipt ? "receipt" : "invoice"}. Add an
          API key to extract from your own uploads. (Name a file &ldquo;receipt&rdquo; or
          &ldquo;messy&rdquo; to preview the receipt samples.)
        </p>
      )}

      {result?.refinedForSupplier && (
        <p style={{ ...banner("ok"), marginTop: 20 }}>
          Refined using what we&apos;ve learned from past corrections for{" "}
          <strong>{result.refinedForSupplier}</strong>.
        </p>
      )}

      {result?.calibratedFields && result.calibratedFields.length > 0 && (
        <p style={{ ...banner("ok"), marginTop: 20 }}>
          Confidence raised on{" "}
          <strong>
            {result.calibratedFields.map((f) => labels[f as ReviewableField] ?? f).join(", ")}
          </strong>{" "}
          from this {isReceipt ? "merchant" : "supplier"}&apos;s confirmed-correct history.
        </p>
      )}

      {/* Duplicate warning — decide before reviewing. Never auto-resolved. */}
      {result?.duplicate && !proceedDuplicate && (
        <section style={{ ...card({ marginTop: 24, padding: 22 }), background: color.goldTint, border: `1px solid ${color.gold}44` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: color.goldDeep, marginBottom: 6 }}>
            Possible duplicate
          </div>
          <p style={{ margin: "0 0 16px", color: color.goldDeep, fontSize: 14, lineHeight: 1.5 }}>
            This looks like a duplicate of {isReceipt ? "a receipt" : "an invoice"} already processed
            on <strong>{new Date(result.duplicate.processedOn).toLocaleDateString()}</strong> —{" "}
            {isReceipt ? (
              <>
                same merchant (<strong>{result.duplicate.supplierName}</strong>), date and total.
              </>
            ) : (
              <>
                same supplier (<strong>{result.duplicate.supplierName}</strong>) and invoice number (
                <strong>{result.duplicate.invoiceNumber}</strong>).
              </>
            )}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={button("success")} onClick={() => setProceedDuplicate(true)}>
              Proceed anyway
            </button>
            <button style={button("outline")} onClick={discard}>
              Discard
            </button>
          </div>
        </section>
      )}

      {result && (!result.duplicate || proceedDuplicate) && (
        <section style={card({ marginTop: 28 })}>
          <div style={{ ...eyebrow, marginBottom: 18, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            Review &amp; approve
            {/* What the AI decided this document is — shown, with its confidence,
                because the type changes which fields are required. */}
            <span style={typeBadge(isReceipt ? "receipt" : "invoice")}>
              {isReceipt ? "Receipt" : "Invoice"}
              {typeOverride ? " · set by you" : typeConfirmed ? " · confirmed" : ` · ${(typeConfidence * 100).toFixed(0)}%`}
            </span>
          </div>

          {/* An uncertain classification blocks approval, because the type decides
              which fields are required, what they're called, and how duplicates
              are matched. The human settles it here — the type isn't an editable
              field, so without this the block would be a deadlock. */}
          {typeConfidence < 0.8 && !typeConfirmed && (
            <div style={{ ...banner("warn"), margin: "0 0 20px" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Is this an invoice or a receipt?
              </div>
              <p style={{ margin: "0 0 12px", fontSize: 13 }}>
                We read it as a <strong>{detectedType}</strong> but only at{" "}
                {(typeConfidence * 100).toFixed(0)}% confidence. This decides which fields are
                required, so please confirm.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                {(["invoice", "receipt"] as DocumentType[]).map((t) => (
                  <button
                    key={t}
                    style={t === detectedType ? button("success") : button("outline")}
                    onClick={() => {
                      setTypeOverride(t === detectedType ? null : t);
                      setTypeConfirmed(true);
                    }}
                  >
                    {t === "receipt" ? "Receipt" : "Invoice"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {REVIEWABLE_FIELDS.map((f) => {
            // After the Total field, show a live subtotal + tax = total check.
            // It recomputes from the edited values, so fixing a number clears it.
            // Skipped when the document states no tax — there's no split to
            // reconcile, so the check would fail on a perfectly good receipt.
            const totals =
              f === "total" && taxItemized
                ? checkTotals(parseNum(edited.subtotal), parseNum(edited.tax), parseNum(edited.total))
                : null;
            const mem = result.supplierMemory?.[f];
            const eff = confidences ? confidences[f] : (result.extraction as any)[f].confidence;
            const low = eff < CONFIDENCE_THRESHOLD; // still below the review bar
            const original = String((result.extraction as any)[f].value);
            const affirmedAsIs = affirmed[f] === true && (edited[f] ?? original) === original;
            // Fields the document genuinely doesn't carry: an absent receipt
            // number, and tax/subtotal on a receipt that shows only a gross total.
            // These are facts about the document, not failed reads — so they get a
            // plain note instead of a red "⚠ check" the human can never satisfy.
            const absentByDesign =
              (isReceipt && f === "invoiceNumber" && original.trim() === "") ||
              (!taxItemized && (f === "tax" || f === "subtotal") && eff === 0);
            return (
              <div key={f}>
                <Field
                  label={labels[f]}
                  confidence={eff}
                  value={edited[f] ?? ""}
                  onChange={(v) => setEdited((prev) => ({ ...prev, [f]: v }))}
                  muted={absentByDesign}
                />
                {absentByDesign && (
                  <p style={{ margin: "-8px 0 14px", color: color.inkFaint, fontSize: 12 }}>
                    {f === "invoiceNumber"
                      ? "No receipt number printed on this receipt — optional, leave blank."
                      : `Not itemised on this receipt — only a gross total is shown. Add it if you know it.`}
                  </p>
                )}
                {/* Confirm-as-is: affirm a correct-but-low read without editing it,
                    so it clears the gate AND records a confirmation (not a reset). */}
                {low && !absentByDesign && (
                  <button
                    style={{ ...button("outline", "sm"), color: color.forestDeep, border: `1px solid ${color.forest}`, margin: "-6px 0 14px" }}
                    onClick={() => setAffirmed((prev) => ({ ...prev, [f]: true }))}
                  >
                    ✓ Confirm this is correct
                  </button>
                )}
                {affirmedAsIs && !low && (
                  <p style={{ margin: "-6px 0 14px", color: color.forestDeep, fontSize: 12, fontWeight: 600 }}>
                    ✓ Confirmed correct as-is
                  </p>
                )}
                {mem && (
                  <p style={{ margin: "-8px 0 14px", color: color.violet, fontSize: 12, fontWeight: 600 }}>
                    Seen {mem.count}× before from this {isReceipt ? "merchant" : "supplier"} · confidence{" "}
                    {(mem.confidence * 100).toFixed(0)}%
                  </p>
                )}
                {totals &&
                  (totals.ok ? (
                    <p style={{ margin: "-6px 0 14px", color: color.forestDeep, fontSize: 13, fontWeight: 600 }}>
                      ✓ Totals check out
                    </p>
                  ) : (
                    <p style={{ ...banner("bad"), margin: "-6px 0 14px", padding: "8px 12px", fontSize: 13, fontWeight: 600 }}>
                      Totals don&apos;t add up — expected {totals.expected.toFixed(2)}, found{" "}
                      {totals.found.toFixed(2)}
                    </p>
                  ))}
              </div>
            );
          })}
          {/* Confidence gate — sits alongside the arithmetic check above. */}
          {gate && gate.status !== "ready" && (
            <div style={{ ...banner(gate.status === "blocked" ? "bad" : "warn"), margin: "4px 0 20px" }}>
              <div style={{ fontWeight: 700 }}>
                {gate.status === "blocked" ? "Human review required" : "Review required"}
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {gate.reasons.map((r) => (
                  <li key={r.field}>{reasonText(r.field, r.confidence, documentType)}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Approve-time duplicate: the corrected values matched an existing
              invoice the raw extraction missed. Decide before it's saved/posted. */}
          {approveDuplicate ? (
            <section style={{ ...card({ padding: 22 }), background: color.goldTint, border: `1px solid ${color.gold}44` }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: color.goldDeep, marginBottom: 6 }}>
                Possible duplicate
              </div>
              <p style={{ margin: "0 0 16px", color: color.goldDeep, fontSize: 14, lineHeight: 1.5 }}>
                After your corrections, this matches {isReceipt ? "a receipt" : "an invoice"} already
                processed on{" "}
                <strong>{new Date(approveDuplicate.processedOn).toLocaleDateString()}</strong> —{" "}
                {isReceipt ? (
                  <>
                    same merchant (<strong>{approveDuplicate.supplierName}</strong>), date and total.
                  </>
                ) : (
                  <>
                    same supplier (<strong>{approveDuplicate.supplierName}</strong>) and invoice number (
                    <strong>{approveDuplicate.invoiceNumber}</strong>).
                  </>
                )}
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={button("success")} onClick={() => { setApproveDuplicate(null); onApprove(true); }}>
                  Approve anyway
                </button>
                <button style={button("outline")} onClick={discard}>
                  Discard
                </button>
              </div>
            </section>
          ) : (
            /* Blocked hides the button entirely — a critical field must be fixed
               first. "review" still lets the human override ("Approve anyway"). */
            gate?.status !== "blocked" && (
              <button style={button("success")} onClick={() => onApprove()}>
                {gate?.status === "review" ? "Approve anyway" : "Approve"}
              </button>
            )
          )}
          {approved && (
            <div style={{ marginTop: 16 }}>
              <ApprovalStamp detail={approved} />
              {/* The form above stays mounted (nothing to re-review), so without
                  this the human's only way to do anything else is to scroll back
                  up to the file picker — there's no signal that they're done. */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
                <button style={button("success")} onClick={discard}>
                  ＋ Upload another
                </button>
                {pendingCount > 0 && (
                  <a
                    href="/pending"
                    style={{ ...button("outline"), textDecoration: "none" }}
                  >
                    View pending queue ({pendingCount})
                  </a>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

const PROVIDER_LABEL: Record<AccountingProvider, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};
const PROVIDER_CONNECT_PATH: Record<AccountingProvider, string> = {
  xero: "/api/xero/connect",
  quickbooks: "/api/quickbooks/connect",
};

/**
 * One accounting platform at a time. Bills only ever post to whichever is
 * connected (lib/accounting.ts prefers Xero, but only ever tries the other one
 * when the first isn't connected), so the UI mirrors that: pick one, and the
 * other disappears rather than sitting there as a second, confusing button.
 */
function AccountingConnection({
  configured,
  xeroStatus,
  qboStatus,
  confirmingDisconnect,
  disconnecting,
  onRequestDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  configured: ConfiguredStatus | null;
  xeroStatus: LiveStatus;
  qboStatus: LiveStatus;
  confirmingDisconnect: AccountingProvider | null;
  disconnecting: AccountingProvider | null;
  onRequestDisconnect: (provider: AccountingProvider) => void;
  onCancelDisconnect: () => void;
  onDisconnect: (provider: AccountingProvider) => void;
}) {
  if (!configured || !xeroStatus || !qboStatus) {
    return <span style={connMutedStyle}>Checking accounting connections…</span>;
  }

  const statusByProvider: Record<AccountingProvider, LiveStatus> = {
    xero: xeroStatus,
    quickbooks: qboStatus,
  };
  const connectedProviders = (["xero", "quickbooks"] as AccountingProvider[]).filter(
    (p) => statusByProvider[p]?.connected,
  );

  // One or both already connected: show a card per connected platform, each
  // with its own disconnect. (Both at once can only happen from a connection
  // made before this one-at-a-time UI existed — shown rather than hidden, so
  // it's obvious and fixable instead of silently picking one.)
  if (connectedProviders.length > 0) {
    return (
      <>
        {connectedProviders.map((provider) => {
          const label = PROVIDER_LABEL[provider];
          const accountName = statusByProvider[provider]?.accountName;

          if (confirmingDisconnect === provider) {
            return (
              <div key={provider} style={disconnectConfirmStyle}>
                <span style={{ flex: 1 }}>
                  Disconnect {label}? Approved invoices will stop posting there until you
                  reconnect.
                </span>
                <button
                  style={disconnecting === provider ? { ...dangerSmallStyle, opacity: 0.5 } : dangerSmallStyle}
                  onClick={() => onDisconnect(provider)}
                  disabled={disconnecting === provider}
                >
                  {disconnecting === provider ? "Disconnecting…" : "Yes, disconnect"}
                </button>
                <button style={connLinkBtnStyle} onClick={onCancelDisconnect}>
                  Cancel
                </button>
              </div>
            );
          }

          return (
            <span key={provider} style={connOkStyle}>
              ✅ {label} Connected{accountName ? ` (Account: ${accountName})` : ""}
              <button
                style={disconnectLinkStyle}
                onClick={() => onRequestDisconnect(provider)}
              >
                Disconnect
              </button>
            </span>
          );
        })}
      </>
    );
  }

  // Neither connected: pick one. Choosing a radio option starts that
  // platform's OAuth flow immediately — there's nothing to "confirm" locally
  // before that, since nothing is actually connected until OAuth completes.
  const anyConfigured = configured.xero.configured || configured.quickbooks.configured;
  if (!anyConfigured) {
    return <span style={connMutedStyle}>Accounting — not configured</span>;
  }

  return (
    <fieldset style={radioGroupStyle}>
      <legend style={radioLegendStyle}>Connect an accounting platform</legend>
      {(["xero", "quickbooks"] as AccountingProvider[]).map((provider) => {
        const isConfigured = configured[provider].configured;
        return (
          <label
            key={provider}
            style={isConfigured ? radioOptionStyle : { ...radioOptionStyle, opacity: 0.5 }}
          >
            <input
              type="radio"
              name="accountingPlatform"
              disabled={!isConfigured}
              onChange={() => {
                window.location.href = PROVIDER_CONNECT_PATH[provider];
              }}
            />
            {PROVIDER_LABEL[provider]}
            {!isConfigured && " — not configured"}
          </label>
        );
      })}
    </fieldset>
  );
}

function Field({
  label,
  value,
  confidence,
  onChange,
  muted = false,
}: {
  label: string;
  value: string;
  confidence: number;
  onChange: (v: string) => void;
  /** The document doesn't state this field — show it neutral, not as a failed read. */
  muted?: boolean;
}) {
  const low = !muted && confidence < CONFIDENCE_THRESHOLD;
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 13,
          color: color.inkSoft,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: color.ink }}>{label}</span>
        <span style={{ ...chipStyle(muted ? "muted" : low ? "bad" : "ok"), ...figures }}>
          {muted ? "— not stated" : `${low ? "check" : "✓"} ${(confidence * 100).toFixed(0)}%`}
        </span>
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyleFor(low ? "low" : "normal")}
      />
    </div>
  );
}

const stepNumStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: "50%",
  background: color.forestTint,
  color: color.forestDeep,
  fontWeight: 700,
  fontSize: 12,
  fontFamily: font.mono,
};
const connBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  marginBottom: 26,
};
const connOkStyle: React.CSSProperties = {
  ...chipStyle("ok"),
  gap: 8,
  padding: "7px 12px",
  fontSize: 13,
};
const connMutedStyle: React.CSSProperties = {
  ...chipStyle("muted"),
  padding: "7px 12px",
  fontSize: 13,
};
const disconnectLinkStyle: React.CSSProperties = {
  ...button("ghost", "sm"),
  padding: "2px 9px",
  color: color.forestDeep,
  border: `1px solid ${color.forest}55`,
  fontSize: 11,
};
const disconnectConfirmStyle: React.CSSProperties = {
  ...banner("bad"),
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  fontWeight: 600,
  fontSize: 13,
};
const dangerSmallStyle: React.CSSProperties = button("danger", "sm");
const connLinkBtnStyle: React.CSSProperties = button("ghost", "sm");
const radioGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 14,
  padding: "8px 14px",
  border: `1px solid ${color.paperLine}`,
  borderRadius: radius.sm,
  margin: 0,
};
const radioLegendStyle: React.CSSProperties = { ...eyebrow, padding: "0 4px" };
const radioOptionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: color.ink,
  cursor: "pointer",
};
const queueLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  marginTop: 20,
  padding: "16px 20px",
  background: color.forestTint,
  border: `1px solid ${color.forest}33`,
  borderRadius: radius.lg,
  color: color.forestDeep,
  fontSize: 15,
  textDecoration: "none",
};
