import { describe, expect, it, vi } from "vitest";
import {
  AuthenticatedQuickBooksVendorLookupTransport,
  QuickBooksVendorLookupError,
  QuickBooksVendorLookupService,
  SupabaseQuickBooksVendorLookupScopeStore,
  type QuickBooksVendorLookupInput,
  type QuickBooksVendorLookupScopeStore,
  type QuickBooksVendorLookupTransport,
} from "../lib/quickbooks-vendor-lookup";

const INPUT: QuickBooksVendorLookupInput = {
  userId: "user-1",
  clientEntityId: "client-1",
  providerConnectionId: "connection-1",
  realm: "9341457595863196",
  displayName: "Zaki Sandbox Test Vendor",
};

function service(
  scope: Awaited<ReturnType<QuickBooksVendorLookupScopeStore["authorizeExactScope"]>> = "AUTHORIZED",
  matches: Awaited<ReturnType<QuickBooksVendorLookupTransport["findByExactDisplayName"]>> = [],
) {
  const authorizeExactScope = vi.fn().mockResolvedValue(scope);
  const findByExactDisplayName = vi.fn().mockResolvedValue(matches);
  return {
    lookup: new QuickBooksVendorLookupService(
      { authorizeExactScope },
      { findByExactDisplayName },
    ),
    authorizeExactScope,
    findByExactDisplayName,
  };
}

describe("read-only QuickBooks Vendor lookup", () => {
  it("checks user authority before the exact active provider connection and ledger scope", async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const responses: Record<string, unknown> = {
      client_entities: { data: { id: "client-1", practice_id: "practice-1", status: "active" }, error: null },
      practice_memberships: { data: [{
        id: "membership-1", role: "owner", valid_from: "2020-01-01T00:00:00Z", valid_to: null,
      }], error: null },
      provider_connections: { data: { id: "connection-1", ledger_book_id: "book-1" }, error: null },
      ledger_books: { data: { id: "book-1" }, error: null },
    };
    const db = {
      from(table: string) {
        const call = { table, filters: [] as Array<[string, unknown]> };
        calls.push(call);
        const query = {
          select() { return query; },
          eq(column: string, value: unknown) { call.filters.push([column, value]); return query; },
          in(column: string, value: unknown) { call.filters.push([column, value]); return query; },
          maybeSingle: async () => responses[table],
          then(resolve: (value: unknown) => unknown) { return Promise.resolve(responses[table]).then(resolve); },
        };
        return query;
      },
    };
    const store = new SupabaseQuickBooksVendorLookupScopeStore(db as never);
    await expect(store.authorizeExactScope(INPUT)).resolves.toBe("AUTHORIZED");
    expect(calls.map((call) => call.table)).toEqual([
      "client_entities", "practice_memberships", "provider_connections", "ledger_books",
    ]);
    expect(calls.find((call) => call.table === "practice_memberships")?.filters)
      .toEqual(expect.arrayContaining([["user_id", INPUT.userId], ["practice_id", "practice-1"]]));
    expect(calls.find((call) => call.table === "provider_connections")?.filters)
      .toEqual(expect.arrayContaining([
        ["id", INPUT.providerConnectionId],
        ["client_entity_id", INPUT.clientEntityId],
        ["provider", "quickbooks"],
        ["external_organisation_id", INPUT.realm],
        ["status", "active"],
      ]));
  });

  it("returns the unique exact DisplayName match with provider identity and active state", async () => {
    const fixture = service("AUTHORIZED", [{
      id: "vendor-42",
      displayName: INPUT.displayName,
      active: true,
    }]);
    await expect(fixture.lookup.lookup(INPUT)).resolves.toEqual({
      providerVendorId: "vendor-42",
      active: true,
      realm: INPUT.realm,
      exactMatch: true,
    });
    expect(fixture.authorizeExactScope).toHaveBeenCalledWith(INPUT);
    expect(fixture.findByExactDisplayName).toHaveBeenCalledWith(
      INPUT.userId,
      INPUT.realm,
      INPUT.displayName,
    );
  });

  it("returns an explicit non-match without guessing a Vendor ID", async () => {
    const fixture = service();
    await expect(fixture.lookup.lookup(INPUT)).resolves.toEqual({
      providerVendorId: null,
      active: null,
      realm: INPUT.realm,
      exactMatch: false,
    });
  });

  it.each(["FORBIDDEN", "DESTINATION_NOT_FOUND"] as const)(
    "blocks %s scope before calling QuickBooks",
    async (scope) => {
      const fixture = service(scope);
      await expect(fixture.lookup.lookup(INPUT)).rejects.toMatchObject({ code: scope });
      expect(fixture.findByExactDisplayName).not.toHaveBeenCalled();
    },
  );

  it("fails closed when an exact name query is ambiguous", async () => {
    const fixture = service("AUTHORIZED", [
      { id: "vendor-1", displayName: INPUT.displayName, active: true },
      { id: "vendor-2", displayName: INPUT.displayName, active: false },
    ]);
    await expect(fixture.lookup.lookup(INPUT)).rejects.toMatchObject({
      code: "AMBIGUOUS_EXACT_MATCH",
    });
  });

  it("uses only GET, filters the provider response to exact DisplayName, and escapes literals", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ QueryResponse: { Vendor: [
        { Id: "exact-id", DisplayName: "O'Brien Vendor", Active: true },
        { Id: "near-id", DisplayName: "O'Brien Vendor Ltd", Active: true },
      ] } }),
    });
    const transport = new AuthenticatedQuickBooksVendorLookupTransport(
      async () => ({ accessToken: "secret-access-token", realmId: INPUT.realm }),
      http,
    );
    await expect(transport.findByExactDisplayName("user-1", INPUT.realm, "O'Brien Vendor"))
      .resolves.toEqual([{ id: "exact-id", displayName: "O'Brien Vendor", active: true }]);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(new URL(url).searchParams.get("query")).toContain("O\\'Brien Vendor");
    expect(init.body).toBeUndefined();
  });

  it("rejects an OAuth realm mismatch before any provider request", async () => {
    const http = vi.fn();
    const transport = new AuthenticatedQuickBooksVendorLookupTransport(
      async () => ({ accessToken: "secret-access-token", realmId: "wrong-realm" }),
      http,
    );
    await expect(transport.findByExactDisplayName("user-1", INPUT.realm, INPUT.displayName))
      .rejects.toEqual(new QuickBooksVendorLookupError("OAUTH_REALM_MISMATCH"));
    expect(http).not.toHaveBeenCalled();
  });
});
