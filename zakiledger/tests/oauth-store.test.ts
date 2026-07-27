import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The cold-start retry in getConnection.
 *
 * Guards one specific observed failure: the first Supabase call from a freshly
 * started instance fails ("JWT issued at future" / "TypeError: fetch failed"),
 * and everything after it succeeds. Before the retry, that meant the first
 * visitor after an idle spin-down or a deploy got a 500 from /api/connections.
 */

const ROW = {
  provider: "xero",
  access_token: "at-123",
  refresh_token: "rt-456",
  expires_at: "2026-07-27T09:00:00.000Z",
  org_id: "tenant-1",
  updated_at: "2026-07-27T08:00:00.000Z",
};

/**
 * Stub Supabase whose `maybeSingle()` returns the queued results in order, so a
 * test can say "fail once, then succeed".
 */
function stubSupabase(results: { data: unknown; error: { message: string } | null }[]) {
  const maybeSingle = vi.fn(async () => results.shift() ?? { data: null, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle,
  };
  return { client: { from: () => chain }, maybeSingle };
}

async function loadStore(client: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/supabase", () => ({ getSupabase: () => client }));
  return import("@/lib/oauth-store");
}

afterEach(() => {
  vi.doUnmock("@/lib/supabase");
  vi.restoreAllMocks();
});

describe("getConnection cold-start retry", () => {
  it("recovers when the first call fails and the second succeeds", async () => {
    const { client, maybeSingle } = stubSupabase([
      { data: null, error: { message: "JWT issued at future" } },
      { data: ROW, error: null },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getConnection } = await loadStore(client);
    const conn = await getConnection("xero");

    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(conn?.accessToken).toBe("at-123");
    expect(conn?.refreshToken).toBe("rt-456");
    // The retry is logged, so a warm-instance failure is still visible.
    expect(warn).toHaveBeenCalledOnce();
  });

  it("also absorbs the 'fetch failed' wording of the same race", async () => {
    const { client, maybeSingle } = stubSupabase([
      { data: null, error: { message: "TypeError: fetch failed" } },
      { data: ROW, error: null },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getConnection } = await loadStore(client);
    expect((await getConnection("xero"))?.orgId).toBe("tenant-1");
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("still throws when BOTH attempts fail — it retries once, it does not paper over", async () => {
    const { client, maybeSingle } = stubSupabase([
      { data: null, error: { message: "JWT issued at future" } },
      { data: null, error: { message: "JWT issued at future" } },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getConnection } = await loadStore(client);
    await expect(getConnection("xero")).rejects.toThrow(
      "Failed to load xero connection: JWT issued at future",
    );
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("does not retry on success — no extra query on the happy path", async () => {
    const { client, maybeSingle } = stubSupabase([{ data: ROW, error: null }]);

    const { getConnection } = await loadStore(client);
    expect(await getConnection("xero")).not.toBeNull();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns null (not an error) when the provider was never connected", async () => {
    const { client, maybeSingle } = stubSupabase([{ data: null, error: null }]);

    const { getConnection } = await loadStore(client);
    expect(await getConnection("quickbooks")).toBeNull();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });
});
