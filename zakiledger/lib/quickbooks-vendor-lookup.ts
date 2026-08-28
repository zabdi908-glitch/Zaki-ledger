import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidQboAccess, quickBooksAccountingApiBase } from "./quickbooks";
import { getSupabase } from "./supabase";

export interface QuickBooksVendorLookupInput {
  userId: string;
  clientEntityId: string;
  providerConnectionId: string;
  realm: string;
  displayName: string;
}

export interface QuickBooksVendorLookupResult {
  providerVendorId: string | null;
  active: boolean | null;
  realm: string;
  exactMatch: boolean;
}

export type QuickBooksVendorLookupErrorCode =
  | "FORBIDDEN"
  | "DESTINATION_NOT_FOUND"
  | "OAUTH_NOT_CONNECTED"
  | "OAUTH_REALM_MISMATCH"
  | "AMBIGUOUS_EXACT_MATCH"
  | "PROVIDER_READ_FAILED";

export class QuickBooksVendorLookupError extends Error {
  constructor(readonly code: QuickBooksVendorLookupErrorCode) {
    super(code);
    this.name = "QuickBooksVendorLookupError";
  }
}

export interface QuickBooksVendorLookupScopeStore {
  authorizeExactScope(input: QuickBooksVendorLookupInput): Promise<
    "AUTHORIZED" | "FORBIDDEN" | "DESTINATION_NOT_FOUND"
  >;
}

export interface QuickBooksVendorLookupTransport {
  findByExactDisplayName(
    userId: string,
    realm: string,
    displayName: string,
  ): Promise<Array<{ id: string; displayName: string; active: boolean }>>;
}

function isCurrentlyActive(row: { valid_from?: string | null; valid_to?: string | null }): boolean {
  const now = Date.now();
  return (!row.valid_from || Date.parse(row.valid_from) <= now) &&
    (!row.valid_to || Date.parse(row.valid_to) > now);
}

/** Service-role reads are always constrained by the authenticated user and exact client scope. */
export class SupabaseQuickBooksVendorLookupScopeStore
  implements QuickBooksVendorLookupScopeStore {
  constructor(private readonly db: SupabaseClient) {}

  async authorizeExactScope(input: QuickBooksVendorLookupInput) {
    const { data: client, error: clientError } = await this.db
      .from("client_entities")
      .select("id,practice_id,status")
      .eq("id", input.clientEntityId)
      .eq("status", "active")
      .maybeSingle();
    if (clientError) throw new Error("QuickBooks Vendor client scope lookup failed");
    if (!client) return "DESTINATION_NOT_FOUND" as const;

    const { data: memberships, error: membershipError } = await this.db
      .from("practice_memberships")
      .select("id,role,valid_from,valid_to")
      .eq("practice_id", client.practice_id)
      .eq("user_id", input.userId)
      .eq("status", "active");
    if (membershipError) throw new Error("QuickBooks Vendor authority lookup failed");
    const activeMemberships = (memberships ?? []).filter(isCurrentlyActive);
    let authorized = activeMemberships.some((row) => row.role === "owner" || row.role === "admin");

    if (!authorized && activeMemberships.length > 0) {
      const { data: grants, error: grantError } = await this.db
        .from("client_access")
        .select("role,valid_from,valid_to")
        .eq("practice_id", client.practice_id)
        .eq("client_entity_id", input.clientEntityId)
        .eq("user_id", input.userId)
        .in("membership_id", activeMemberships.map((row) => row.id))
        .eq("status", "active");
      if (grantError) throw new Error("QuickBooks Vendor client authority lookup failed");
      authorized = (grants ?? []).some(isCurrentlyActive);
    }
    if (!authorized) return "FORBIDDEN" as const;

    const { data: connection, error: connectionError } = await this.db
      .from("provider_connections")
      .select("id,ledger_book_id")
      .eq("id", input.providerConnectionId)
      .eq("client_entity_id", input.clientEntityId)
      .eq("provider", "quickbooks")
      .eq("external_organisation_id", input.realm)
      .eq("status", "active")
      .maybeSingle();
    if (connectionError) throw new Error("QuickBooks Vendor destination lookup failed");
    if (!connection?.ledger_book_id) return "DESTINATION_NOT_FOUND" as const;

    const { data: book, error: bookError } = await this.db
      .from("ledger_books")
      .select("id")
      .eq("id", connection.ledger_book_id)
      .eq("client_entity_id", input.clientEntityId)
      .eq("status", "active")
      .maybeSingle();
    if (bookError) throw new Error("QuickBooks Vendor ledger scope lookup failed");
    return book ? "AUTHORIZED" as const : "DESTINATION_NOT_FOUND" as const;
  }
}

type ReadResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type QuickBooksVendorLookupHttpClient = (
  input: string,
  init: RequestInit,
) => Promise<ReadResponse>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function escapeQuickBooksQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Authenticated QBO transport with one capability: a GET query for Vendor. */
export class AuthenticatedQuickBooksVendorLookupTransport
  implements QuickBooksVendorLookupTransport {
  constructor(
    private readonly access = getValidQboAccess,
    private readonly http: QuickBooksVendorLookupHttpClient = fetch,
  ) {}

  async findByExactDisplayName(userId: string, realm: string, displayName: string) {
    const credential = await this.access(userId);
    if (!credential) throw new QuickBooksVendorLookupError("OAUTH_NOT_CONNECTED");
    if (credential.realmId !== realm) {
      throw new QuickBooksVendorLookupError("OAUTH_REALM_MISMATCH");
    }
    const query = `select * from Vendor where DisplayName = '${escapeQuickBooksQueryLiteral(displayName)}'`;
    let response: ReadResponse;
    try {
      response = await this.http(
        `${quickBooksAccountingApiBase()}/v3/company/${encodeURIComponent(realm)}` +
          `/query?query=${encodeURIComponent(query)}&minorversion=65`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            Accept: "application/json",
          },
        },
      );
    } catch {
      throw new QuickBooksVendorLookupError("PROVIDER_READ_FAILED");
    }
    if (!response.ok) throw new QuickBooksVendorLookupError("PROVIDER_READ_FAILED");
    const body = record(await response.json());
    const vendors = record(body.QueryResponse).Vendor;
    if (!Array.isArray(vendors)) return [];
    return vendors.map(record).flatMap((vendor) => {
      const id = typeof vendor.Id === "string" ? vendor.Id.trim() : "";
      const name = typeof vendor.DisplayName === "string" ? vendor.DisplayName : "";
      if (!id || name !== displayName || typeof vendor.Active !== "boolean") return [];
      return [{ id, displayName: name, active: vendor.Active }];
    });
  }
}

export class QuickBooksVendorLookupService {
  constructor(
    private readonly scopeStore: QuickBooksVendorLookupScopeStore,
    private readonly transport: QuickBooksVendorLookupTransport,
  ) {}

  async lookup(input: QuickBooksVendorLookupInput): Promise<QuickBooksVendorLookupResult> {
    const scope = await this.scopeStore.authorizeExactScope(input);
    if (scope === "FORBIDDEN") throw new QuickBooksVendorLookupError("FORBIDDEN");
    if (scope === "DESTINATION_NOT_FOUND") {
      throw new QuickBooksVendorLookupError("DESTINATION_NOT_FOUND");
    }
    const matches = await this.transport.findByExactDisplayName(
      input.userId,
      input.realm,
      input.displayName,
    );
    if (matches.length > 1) throw new QuickBooksVendorLookupError("AMBIGUOUS_EXACT_MATCH");
    const match = matches[0];
    return {
      providerVendorId: match?.id ?? null,
      active: match?.active ?? null,
      realm: input.realm,
      exactMatch: Boolean(match && match.displayName === input.displayName),
    };
  }
}

export function createQuickBooksVendorLookupService(): QuickBooksVendorLookupService {
  const db = getSupabase();
  if (!db) throw new Error("QuickBooks Vendor lookup requires a configured database");
  return new QuickBooksVendorLookupService(
    new SupabaseQuickBooksVendorLookupScopeStore(db),
    new AuthenticatedQuickBooksVendorLookupTransport(),
  );
}

export const __quickBooksVendorLookupTestUtils = { escapeQuickBooksQueryLiteral };
