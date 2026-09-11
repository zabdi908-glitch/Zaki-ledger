import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";
import { sgmlToXml } from "./bank-parsers";
import { getValidQboAccess, quickBooksAccountingApiBase } from "./quickbooks";
import type {
  QuickBooksAuthenticatedAccessClient,
  QuickBooksHttpClient,
} from "./provider-adapters/quickbooks-authenticated-posting-transport";

export interface BalanceShadowScope {
  scopeId: string;
  clientEntityId: string;
  accountClass: "asset";
  currencyCode: string;
  minorUnitExponent: number;
  accountTimezone: string;
  sourceProvider: "ofx";
  sourceOrganisationId: string | null;
  sourceAccountId: string;
  sourceDateBasis: "posted_date";
  sourceBalanceSignMultiplier: 1 | -1;
  ledgerProvider: "quickbooks";
  ledgerProviderConnectionId: string;
  ledgerOrganisationId: string;
  ledgerAccountId: string;
  ledgerDateBasis: "accounting_date";
  ledgerBalanceSignMultiplier: 1 | -1;
}

export interface BalanceShadowRequest {
  actorUserId: string;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  openingArtifactId: string;
  closingArtifactId: string;
  openingOfx: string;
  closingOfx: string;
}

export interface BalanceEvidenceMember {
  identityCanonical: string;
  effectiveOn: string;
  rawAmountMinor: string;
  movementMinor: string;
  sourceStatus: "posted";
  evidenceHash: string;
}

export interface BalanceSideEvidence {
  side: "source" | "ledger";
  provider: "ofx" | "quickbooks";
  organisationId: string | null;
  accountId: string;
  currencyCode: string;
  minorUnitExponent: number;
  providerRequestId: string | null;
  opening: {
    localBoundaryDate: string;
    asOfExclusive: string;
    rawBalanceText: string;
    rawBalanceMinor: string;
    balanceMinor: string;
    origin: "artifact_reported" | "provider_reported";
    artifactId: string | null;
    rawPayloadHash: string | null;
    evidenceFingerprint: string;
  };
  closing: BalanceSideEvidence["opening"];
  dateBasis: "posted_date" | "accounting_date";
  paginationMode: "artifact_pages" | "not_applicable";
  pageCount: number;
  paginationComplete: boolean;
  terminalBoundarySeen: boolean;
  coverageComplete: boolean;
  resultTruncated: boolean;
  errorCount: number;
  returnedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  movementTotalMinor: string;
  completenessState: "complete" | "incomplete" | "conflicted";
  incompletenessReason: string | null;
  requestFingerprint: string;
  responseFingerprint: string;
  setFingerprint: string;
  retrievalStartedAt: string;
  retrievalCompletedAt: string;
  members: BalanceEvidenceMember[];
}

export interface BalanceShadowResult {
  mode: "SHADOW";
  state: "FAILED" | "REVIEW" | "RECONCILED";
  reasonCode: string;
  runId: string;
  revisionId: string;
  frozenInputFingerprint: string;
  sourceCompleteness: string;
  ledgerCompleteness: string;
  residualMinor: string;
}

export interface BalanceShadowStore {
  prepareScope(actorUserId: string, scopeId: string): Promise<BalanceShadowScope>;
  record(input: {
    actorUserId: string;
    scope: BalanceShadowScope;
    periodStart: string;
    periodEnd: string;
    requestFingerprint: string;
    source: BalanceSideEvidence;
    ledger: BalanceSideEvidence;
  }): Promise<BalanceShadowResult>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  return value;
}

function nextDate(value: string): string {
  const date = new Date(`${assertDate(value, "date")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function previousDate(value: string): string {
  const date = new Date(`${assertDate(value, "date")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function calendarYearStart(value: string): string {
  return `${assertDate(value, "cutoff").slice(0, 4)}-01-01`;
}

function utcBoundary(value: string, timezone: string): string {
  if (timezone !== "UTC") {
    throw new Error("The Day 6 narrow reader requires a UTC account timezone");
  }
  return `${value}T00:00:00.000Z`;
}

export function exactDecimalToMinor(raw: string, exponent: number): bigint {
  const match = raw.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error("Invalid exact monetary value");
  }
  const fraction = match[3] ?? "";
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    throw new Error("Monetary value has precision below the configured minor unit");
  }
  const padded = fraction.slice(0, exponent).padEnd(exponent, "0");
  const absolute = BigInt(match[2]) * 10n ** BigInt(exponent) + BigInt(padded || "0");
  return match[1] === "-" ? -absolute : absolute;
}

function signed(value: bigint, multiplier: 1 | -1): bigint {
  return value * BigInt(multiplier);
}

const ofxParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "STMTTRN",
});

function ofxStatement(raw: string): Record<string, unknown> {
  const root = record(ofxParser.parse(sgmlToXml(raw)).OFX);
  const bank = record(record(record(root.BANKMSGSRSV1).STMTTRNRS).STMTRS);
  const card = record(record(record(root.CREDITCARDMSGSRSV1).CCSTMTTRNRS).CCSTMTRS);
  const statement = Object.keys(bank).length ? bank : card;
  if (!Object.keys(statement).length) throw new Error("OFX statement response is required");
  return statement;
}

function ofxDate(value: unknown): string {
  const raw = text(value);
  if (!/^\d{8}/.test(raw)) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function ofxAccountId(statement: Record<string, unknown>): string {
  const account = record(statement.BANKACCTFROM ?? statement.CCACCTFROM);
  const bankId = text(account.BANKID);
  const accountId = text(account.ACCTID);
  return bankId ? `${bankId}:${accountId}` : accountId;
}

/** Read-only paired OFX source: prior closing is the current period opening. */
export class PairedOfxBalanceEvidenceReader {
  async read(request: BalanceShadowRequest, scope: BalanceShadowScope): Promise<BalanceSideEvidence> {
    if (scope.accountClass !== "asset" || scope.sourceProvider !== "ofx" ||
        scope.sourceDateBasis !== "posted_date") {
      throw new Error("OFX shadow reader requires the frozen asset/OFX/posted-date scope");
    }
    const started = new Date().toISOString();
    const prior = ofxStatement(request.openingOfx);
    const current = ofxStatement(request.closingOfx);
    const priorList = record(prior.BANKTRANLIST ?? prior.CCTRANLIST);
    const currentList = record(current.BANKTRANLIST ?? current.CCTRANLIST);
    const priorBalance = record(prior.LEDGERBAL);
    const currentBalance = record(current.LEDGERBAL);
    const currency = text(current.CURDEF);
    const rawOpening = text(priorBalance.BALAMT);
    const rawClosing = text(currentBalance.BALAMT);
    const responseFingerprint = sha256(`${request.openingOfx}\n--CURRENT--\n${request.closingOfx}`);
    const reasons: string[] = [];

    if (ofxAccountId(prior) !== scope.sourceAccountId || ofxAccountId(current) !== scope.sourceAccountId) {
      throw new Error("OFX account does not match the frozen source account");
    }
    if (text(prior.CURDEF) !== scope.currencyCode || currency !== scope.currencyCode) {
      throw new Error("OFX currency does not match the frozen scope");
    }
    if (ofxDate(priorList.DTEND) !== previousDate(request.periodStart) ||
        ofxDate(priorBalance.DTASOF) !== previousDate(request.periodStart)) {
      reasons.push("OFX_OPENING_CUTOFF_UNPROVEN");
    }
    if (ofxDate(currentList.DTSTART) !== request.periodStart ||
        ofxDate(currentList.DTEND) !== request.periodEnd ||
        ofxDate(currentBalance.DTASOF) !== request.periodEnd) {
      reasons.push("OFX_PERIOD_CUTOFF_UNPROVEN");
    }

    const openingMinor = signed(exactDecimalToMinor(rawOpening, scope.minorUnitExponent), scope.sourceBalanceSignMultiplier);
    const closingMinor = signed(exactDecimalToMinor(rawClosing, scope.minorUnitExponent), scope.sourceBalanceSignMultiplier);
    const rawRows = currentList.STMTTRN === undefined
      ? [] : Array.isArray(currentList.STMTTRN) ? currentList.STMTTRN : [currentList.STMTTRN];
    const members: BalanceEvidenceMember[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    let duplicates = 0;

    for (const rawRow of rawRows) {
      const row = record(rawRow);
      const fitId = text(row.FITID);
      const effectiveOn = ofxDate(row.DTPOSTED);
      const amountText = text(row.TRNAMT);
      if (!fitId || !effectiveOn || !amountText || effectiveOn < request.periodStart || effectiveOn > request.periodEnd) {
        rejected++;
        continue;
      }
      const identity = `ofx|${scope.sourceAccountId}|${fitId}`;
      if (seen.has(identity)) {
        duplicates++;
        continue;
      }
      seen.add(identity);
      try {
        const rawMinor = exactDecimalToMinor(amountText, scope.minorUnitExponent);
        const movementMinor = signed(rawMinor, scope.sourceBalanceSignMultiplier);
        members.push({
          identityCanonical: identity,
          effectiveOn,
          rawAmountMinor: rawMinor.toString(),
          movementMinor: movementMinor.toString(),
          sourceStatus: "posted",
          evidenceHash: sha256(JSON.stringify(row)),
        });
      } catch {
        rejected++;
      }
    }
    const movementTotal = members.reduce((sum, member) => sum + BigInt(member.movementMinor), 0n);
    if (rejected || duplicates) reasons.push("OFX_ROWS_INCOMPLETE");
    const rollforwardOkay = openingMinor + movementTotal === closingMinor;
    if (!rollforwardOkay) reasons.push("OFX_BALANCE_ROLLFORWARD_BROKEN");
    const complete = reasons.length === 0;
    const conflicted = !rollforwardOkay && rejected === 0 && duplicates === 0;
    const requestFingerprint = sha256(JSON.stringify({
      provider: "ofx", account: scope.sourceAccountId,
      periodStart: request.periodStart, periodEnd: request.periodEnd,
      openingArtifactId: request.openingArtifactId, closingArtifactId: request.closingArtifactId,
    }));
    const finished = new Date().toISOString();
    const openingHash = sha256(request.openingOfx);
    const closingHash = sha256(request.closingOfx);
    return {
      side: "source",
      provider: "ofx",
      organisationId: scope.sourceOrganisationId,
      accountId: scope.sourceAccountId,
      currencyCode: scope.currencyCode,
      minorUnitExponent: scope.minorUnitExponent,
      providerRequestId: null,
      opening: {
        localBoundaryDate: request.periodStart,
        asOfExclusive: utcBoundary(request.periodStart, scope.accountTimezone),
        rawBalanceText: rawOpening,
        rawBalanceMinor: exactDecimalToMinor(rawOpening, scope.minorUnitExponent).toString(),
        balanceMinor: openingMinor.toString(),
        origin: "artifact_reported",
        artifactId: request.openingArtifactId,
        rawPayloadHash: openingHash,
        evidenceFingerprint: sha256(`ofx-opening|${request.openingArtifactId}|${openingHash}|${openingMinor}`),
      },
      closing: {
        localBoundaryDate: nextDate(request.periodEnd),
        asOfExclusive: utcBoundary(nextDate(request.periodEnd), scope.accountTimezone),
        rawBalanceText: rawClosing,
        rawBalanceMinor: exactDecimalToMinor(rawClosing, scope.minorUnitExponent).toString(),
        balanceMinor: closingMinor.toString(),
        origin: "artifact_reported",
        artifactId: request.closingArtifactId,
        rawPayloadHash: closingHash,
        evidenceFingerprint: sha256(`ofx-closing|${request.closingArtifactId}|${closingHash}|${closingMinor}`),
      },
      dateBasis: "posted_date",
      paginationMode: "artifact_pages",
      pageCount: 1,
      paginationComplete: true,
      terminalBoundarySeen: !reasons.some((reason) => reason.includes("CUTOFF")),
      coverageComplete: complete || conflicted,
      resultTruncated: false,
      errorCount: rejected,
      returnedCount: rawRows.length,
      acceptedCount: members.length,
      rejectedCount: rejected,
      duplicateCount: duplicates,
      movementTotalMinor: movementTotal.toString(),
      completenessState: complete ? "complete" : conflicted ? "conflicted" : "incomplete",
      incompletenessReason: complete ? null : reasons.join(","),
      requestFingerprint,
      responseFingerprint,
      setFingerprint: sha256(`${requestFingerprint}|${responseFingerprint}|${members.map((m) => m.evidenceHash).join(",")}`),
      retrievalStartedAt: started,
      retrievalCompletedAt: finished,
      members,
    };
  }
}

interface QuickBooksReaderScope {
  actorUserId: string;
  providerConnectionId: string;
  realmId: string;
}

const defaultAccess: QuickBooksAuthenticatedAccessClient = { getAccess: getValidQboAccess };

/** Strict read-only QBO General Ledger adapter; it exposes no HTTP mutation method. */
export class QuickBooksGeneralLedgerBalanceReader {
  constructor(
    private readonly bound: QuickBooksReaderScope,
    private readonly access: QuickBooksAuthenticatedAccessClient = defaultAccess,
    private readonly http: QuickBooksHttpClient = fetch,
  ) {}

  private async get(path: string): Promise<{ body: Record<string, unknown>; requestId: string | null }> {
    const credential = await this.access.getAccess(this.bound.actorUserId);
    if (!credential || credential.realmId !== this.bound.realmId || !credential.accessToken.trim()) {
      throw new Error("QuickBooks credential does not match the frozen ledger realm");
    }
    const response = await this.http(
      `${quickBooksAccountingApiBase()}/v3/company/${encodeURIComponent(this.bound.realmId)}/${path}`,
      { method: "GET", headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`QuickBooks read failed (${response.status})`);
    return { body: record(await response.json()), requestId: response.headers.get("intuit_tid") };
  }

  async read(request: BalanceShadowRequest, scope: BalanceShadowScope): Promise<BalanceSideEvidence> {
    if (scope.accountClass !== "asset" || scope.ledgerProvider !== "quickbooks" ||
        scope.ledgerDateBasis !== "accounting_date" ||
        scope.ledgerProviderConnectionId !== this.bound.providerConnectionId ||
        scope.ledgerOrganisationId !== this.bound.realmId) {
      throw new Error("QuickBooks reader scope does not match the frozen account ownership contract");
    }
    if (scope.ledgerBalanceSignMultiplier !== 1 && scope.ledgerBalanceSignMultiplier !== -1) {
      throw new Error("QuickBooks reader does not support the configured ledger balance sign convention");
    }
    const started = new Date().toISOString();
    const accountResponse = await this.get(`account/${encodeURIComponent(scope.ledgerAccountId)}?minorversion=65`);
    const account = record(accountResponse.body.Account);
    if (text(account.Id) !== scope.ledgerAccountId || account.Active !== true) {
      throw new Error("QuickBooks account identity is not active and exact");
    }
    const accountCurrency = text(record(account.CurrencyRef).value);
    if (accountCurrency !== scope.currencyCode) throw new Error("QuickBooks account currency mismatch");

    const generalLedgerQuery = new URLSearchParams({
      start_date: request.periodStart,
      end_date: request.periodEnd,
      accounting_method: "Accrual",
      account: scope.ledgerAccountId,
      minorversion: "65",
    });
    const openingCutoff = previousDate(request.periodStart);
    const closingCutoff = request.periodEnd;
    const trialBalanceQuery = (cutoff: string) => new URLSearchParams({
      start_date: calendarYearStart(cutoff),
      end_date: cutoff,
      accounting_method: "Accrual",
      minorversion: "65",
    });
    const generalLedgerResponse = await this.get(`reports/GeneralLedger?${generalLedgerQuery.toString()}`);
    const openingTrialBalanceResponse = await this.get(
      `reports/TrialBalance?${trialBalanceQuery(openingCutoff).toString()}`,
    );
    const closingTrialBalanceResponse = await this.get(
      `reports/TrialBalance?${trialBalanceQuery(closingCutoff).toString()}`,
    );
    const generalLedger = generalLedgerResponse.body;
    const header = record(generalLedger.Header);
    const reasons: string[] = [];
    if (text(header.ReportName).toLowerCase().replace(/\s+/g, "") !== "generalledger" ||
        text(header.ReportBasis).toLowerCase() !== "accrual" ||
        text(header.StartPeriod) !== request.periodStart || text(header.EndPeriod) !== request.periodEnd ||
        text(header.Currency) !== scope.currencyCode) {
      reasons.push("QUICKBOOKS_REPORT_HEADER_UNPROVEN");
    }

    const columns = Array.isArray(record(generalLedger.Columns).Column)
      ? record(generalLedger.Columns).Column as unknown[] : [];
    const keys = columns.map((column) => {
      const metadata = record(column).MetaData;
      const values = Array.isArray(metadata) ? metadata : metadata ? [metadata] : [];
      return text(record(values.find((item) => text(record(item).Name) === "ColKey")).Value);
    });
    const dateIndex = keys.indexOf("tx_date");
    const amountIndex = keys.findIndex((key) => key === "subt_nat_amount" || key === "amount");
    const balanceIndex = keys.findIndex((key) => key === "rbal_nat_amount" || key === "balance");
    if (dateIndex < 0 || amountIndex < 0 || balanceIndex < 0) reasons.push("QUICKBOOKS_REPORT_COLUMNS_UNPROVEN");

    const topRows = Array.isArray(record(generalLedger.Rows).Row)
      ? record(generalLedger.Rows).Row as unknown[] : [];
    const accountSections = topRows.filter((row) => {
      const values = Array.isArray(record(record(row).Header).ColData)
        ? record(record(row).Header).ColData as unknown[] : [];
      return values.some((cell) => text(record(cell).id) === scope.ledgerAccountId);
    });
    if (accountSections.length !== 1) reasons.push("QUICKBOOKS_ACCOUNT_SECTION_UNPROVEN");
    const section = record(accountSections[0]);
    const rows = Array.isArray(record(section.Rows).Row) ? record(section.Rows).Row as unknown[] : [];
    const members: BalanceEvidenceMember[] = [];
    let rejected = 0;
    let considered = 0;
    for (const [index, rawRow] of rows.entries()) {
      const cells = Array.isArray(record(rawRow).ColData) ? record(rawRow).ColData as unknown[] : [];
      const values = cells.map((cell) => text(record(cell).value));
      if (values.some((value) => value.toLowerCase() === "beginning balance")) {
        continue;
      }
      if (!values.some(Boolean)) continue;
      considered++;
      const effectiveOn = dateIndex >= 0 ? values[dateIndex] ?? "" : "";
      const rawAmount = amountIndex >= 0 ? values[amountIndex] ?? "" : "";
      try {
        assertDate(effectiveOn, "QuickBooks accounting date");
        if (effectiveOn < request.periodStart || effectiveOn > request.periodEnd || !rawAmount) throw new Error("outside period");
        const rawMinor = exactDecimalToMinor(rawAmount.replace(/,/g, ""), scope.minorUnitExponent);
        const movement = signed(rawMinor, scope.ledgerBalanceSignMultiplier);
        const evidenceHash = sha256(JSON.stringify(rawRow));
        members.push({
          identityCanonical: `quickbooks-report|${scope.ledgerOrganisationId}|${scope.ledgerAccountId}|${index}|${evidenceHash}`,
          effectiveOn,
          rawAmountMinor: rawMinor.toString(),
          movementMinor: movement.toString(),
          sourceStatus: "posted",
          evidenceHash,
        });
      } catch {
        rejected++;
      }
    }

    const trialBalanceAmount = (
      response: { body: Record<string, unknown> },
      cutoff: string,
      boundary: "opening" | "closing",
    ): string => {
      const trialBalance = response.body;
      const trialHeader = record(trialBalance.Header);
      if (text(trialHeader.ReportName).toLowerCase().replace(/\s+/g, "") !== "trialbalance" ||
          text(trialHeader.ReportBasis).toLowerCase() !== "accrual" ||
          text(trialHeader.StartPeriod) !== calendarYearStart(cutoff) ||
          text(trialHeader.EndPeriod) !== cutoff ||
          text(trialHeader.Currency) !== scope.currencyCode) {
        throw new Error(`QuickBooks ${boundary} Trial Balance header does not prove the exact cutoff`);
      }

      const matches: unknown[][] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
          return;
        }
        const row = record(value);
        if (!Object.keys(row).length) return;
        const cells = Array.isArray(row.ColData) ? row.ColData as unknown[] : [];
        if (cells.some((cell) => text(record(cell).id) === scope.ledgerAccountId)) matches.push(cells);
        for (const child of Object.values(row)) visit(child);
      };
      visit(record(trialBalance.Rows));
      if (matches.length !== 1) {
        throw new Error(`QuickBooks ${boundary} Trial Balance did not provide one exact account row`);
      }
      const cells = matches[0];
      if (!cells || text(record(cells[0]).id) !== scope.ledgerAccountId || cells.length < 3) {
        throw new Error(`QuickBooks ${boundary} Trial Balance account identity is not exact`);
      }
      const debit = text(record(cells[1]).value);
      const credit = text(record(cells[2]).value);
      if (debit && credit) {
        throw new Error(`QuickBooks ${boundary} Trial Balance has conflicting debit and credit balances`);
      }
      const rawAmount = credit ? `-${credit}` : debit || "0";
      exactDecimalToMinor(rawAmount.replace(/,/g, ""), scope.minorUnitExponent);
      return rawAmount;
    };

    const rawOpening = trialBalanceAmount(openingTrialBalanceResponse, openingCutoff, "opening");
    const rawClosing = trialBalanceAmount(closingTrialBalanceResponse, closingCutoff, "closing");
    const openingRawMinor = exactDecimalToMinor(rawOpening.replace(/,/g, ""), scope.minorUnitExponent);
    const closingRawMinor = exactDecimalToMinor(rawClosing.replace(/,/g, ""), scope.minorUnitExponent);
    const openingMinor = signed(openingRawMinor, scope.ledgerBalanceSignMultiplier);
    const closingMinor = signed(closingRawMinor, scope.ledgerBalanceSignMultiplier);
    const movementTotal = members.reduce((sum, member) => sum + BigInt(member.movementMinor), 0n);
    if (rejected) reasons.push("QUICKBOOKS_REPORT_ROWS_INCOMPLETE");
    const rollforwardOkay = openingMinor + movementTotal === closingMinor;
    if (!rollforwardOkay) reasons.push("QUICKBOOKS_BALANCE_ROLLFORWARD_BROKEN");
    const complete = reasons.length === 0;
    const conflicted = !rollforwardOkay && rejected === 0 && !reasons.some((reason) => reason.includes("UNPROVEN"));
    const responseText = JSON.stringify({
      account,
      generalLedger,
      openingTrialBalance: openingTrialBalanceResponse.body,
      closingTrialBalance: closingTrialBalanceResponse.body,
    });
    const responseFingerprint = sha256(responseText);
    const openingPayloadHash = sha256(JSON.stringify({
      account, generalLedger, openingTrialBalance: openingTrialBalanceResponse.body,
    }));
    const closingPayloadHash = sha256(JSON.stringify({
      account, generalLedger, closingTrialBalance: closingTrialBalanceResponse.body,
    }));
    const requestFingerprint = sha256(JSON.stringify({
      provider: "quickbooks", realm: scope.ledgerOrganisationId,
      account: scope.ledgerAccountId, periodStart: request.periodStart,
      periodEnd: request.periodEnd, basis: "Accrual", balanceReports: "TrialBalance",
      openingCutoff, closingCutoff,
    }));
    const finished = new Date().toISOString();
    return {
      side: "ledger",
      provider: "quickbooks",
      organisationId: scope.ledgerOrganisationId,
      accountId: scope.ledgerAccountId,
      currencyCode: scope.currencyCode,
      minorUnitExponent: scope.minorUnitExponent,
      providerRequestId: [
        accountResponse.requestId, generalLedgerResponse.requestId,
        openingTrialBalanceResponse.requestId, closingTrialBalanceResponse.requestId,
      ].filter(Boolean).join(",") || null,
      opening: {
        localBoundaryDate: request.periodStart,
        asOfExclusive: utcBoundary(request.periodStart, scope.accountTimezone),
        rawBalanceText: rawOpening,
        rawBalanceMinor: openingRawMinor.toString(),
        balanceMinor: openingMinor.toString(),
        origin: "provider_reported",
        artifactId: null,
        rawPayloadHash: openingPayloadHash,
        evidenceFingerprint: sha256(
          `qbo-opening|${requestFingerprint}|${responseFingerprint}|${openingPayloadHash}|${openingMinor}`,
        ),
      },
      closing: {
        localBoundaryDate: nextDate(request.periodEnd),
        asOfExclusive: utcBoundary(nextDate(request.periodEnd), scope.accountTimezone),
        rawBalanceText: rawClosing,
        rawBalanceMinor: closingRawMinor.toString(),
        balanceMinor: closingMinor.toString(),
        origin: "provider_reported",
        artifactId: null,
        rawPayloadHash: closingPayloadHash,
        evidenceFingerprint: sha256(
          `qbo-closing|${requestFingerprint}|${responseFingerprint}|${closingPayloadHash}|${closingMinor}`,
        ),
      },
      dateBasis: "accounting_date",
      paginationMode: "not_applicable",
      pageCount: 1,
      paginationComplete: true,
      terminalBoundarySeen: !reasons.some((reason) => reason.includes("HEADER")),
      coverageComplete: complete || conflicted,
      resultTruncated: false,
      errorCount: rejected,
      returnedCount: considered,
      acceptedCount: members.length,
      rejectedCount: rejected,
      duplicateCount: 0,
      movementTotalMinor: movementTotal.toString(),
      completenessState: complete ? "complete" : conflicted ? "conflicted" : "incomplete",
      incompletenessReason: complete ? null : reasons.join(","),
      requestFingerprint,
      responseFingerprint,
      setFingerprint: sha256(`${requestFingerprint}|${responseFingerprint}|${members.map((m) => m.evidenceHash).join(",")}`),
      retrievalStartedAt: started,
      retrievalCompletedAt: finished,
      members,
    };
  }
}

function payload<T>(data: unknown, label: string): T {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") throw new Error(`${label} returned no payload`);
  return value as T;
}

export class SupabaseBalanceShadowStore implements BalanceShadowStore {
  constructor(private readonly db: SupabaseClient) {}

  async prepareScope(actorUserId: string, scopeId: string): Promise<BalanceShadowScope> {
    const { data, error } = await this.db.rpc("prepare_balance_reconciliation_shadow_scope_v1", {
      p_actor_user_id: actorUserId,
      p_scope_id: scopeId,
    });
    if (error) throw new Error(`Balance shadow scope rejected: ${error.message}`);
    const row = payload<Record<string, unknown>>(data, "prepare_balance_reconciliation_shadow_scope_v1");
    if (row.outcome !== "READY") throw new Error(text(row.reason_code) || "BALANCE_SHADOW_SCOPE_REVIEW");
    return row.scope as unknown as BalanceShadowScope;
  }

  async record(input: Parameters<BalanceShadowStore["record"]>[0]): Promise<BalanceShadowResult> {
    const { data, error } = await this.db.rpc("record_balance_reconciliation_shadow_v1", {
      p_actor_user_id: input.actorUserId,
      p_scope_id: input.scope.scopeId,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_request_fingerprint_hex: input.requestFingerprint,
      p_source_evidence: input.source,
      p_ledger_evidence: input.ledger,
    });
    if (error) throw new Error(`Balance shadow evidence write failed: ${error.message}`);
    const row = payload<Record<string, unknown>>(data, "record_balance_reconciliation_shadow_v1");
    return {
      mode: "SHADOW",
      state: row.state as BalanceShadowResult["state"],
      reasonCode: text(row.reasonCode),
      runId: text(row.runId),
      revisionId: text(row.revisionId),
      frozenInputFingerprint: text(row.frozenInputFingerprint),
      sourceCompleteness: text(row.sourceCompleteness),
      ledgerCompleteness: text(row.ledgerCompleteness),
      residualMinor: text(row.residualMinor),
    };
  }
}

/** One read-only evidence acquisition followed by an immutable SHADOW proof write. */
export class BalanceReconciliationShadowExecutor {
  constructor(
    private readonly store: BalanceShadowStore,
    private readonly source: PairedOfxBalanceEvidenceReader,
    private readonly ledger: Pick<QuickBooksGeneralLedgerBalanceReader, "read">,
  ) {}

  async execute(request: BalanceShadowRequest): Promise<BalanceShadowResult> {
    assertDate(request.periodStart, "period start");
    assertDate(request.periodEnd, "period end");
    if (request.periodEnd < request.periodStart) throw new Error("period end precedes period start");
    const scope = await this.store.prepareScope(request.actorUserId, request.scopeId);
    if (scope.scopeId !== request.scopeId) throw new Error("Prepared scope identity mismatch");
    const [source, ledger] = await Promise.all([
      this.source.read(request, scope),
      this.ledger.read(request, scope),
    ]);
    const requestFingerprint = sha256([
      "balance-shadow-v1", scope.scopeId, request.periodStart, request.periodEnd,
      source.setFingerprint, ledger.setFingerprint,
    ].join("|"));
    return this.store.record({
      actorUserId: request.actorUserId,
      scope,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      requestFingerprint,
      source,
      ledger,
    });
  }
}
