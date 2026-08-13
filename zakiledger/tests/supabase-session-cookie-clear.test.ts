import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("clearSupabaseRouteHandlerSession", () => {
  it("expires the standard auth cookie, every discovered chunk, and no unrelated cookies", async () => {
    const set = vi.fn();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        getAll: () => [
          { name: "sb-test-auth-token", value: "session" },
          { name: "sb-test-auth-token.0", value: "chunk" },
          { name: "unrelated", value: "keep" },
        ],
        set,
      }),
    }));

    const { clearSupabaseRouteHandlerSession } = await import("@/lib/supabase-server");
    await clearSupabaseRouteHandlerSession();

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, "sb-test-auth-token", "", { maxAge: 0, path: "/" });
    expect(set).toHaveBeenNthCalledWith(2, "sb-test-auth-token.0", "", { maxAge: 0, path: "/" });
  });

  it("expires the base session name even when a just-written cookie is not yet listed", async () => {
    const set = vi.fn();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ getAll: () => [], set }),
    }));

    const { clearSupabaseRouteHandlerSession } = await import("@/lib/supabase-server");
    await clearSupabaseRouteHandlerSession();

    expect(set).toHaveBeenCalledWith("sb-test-auth-token", "", { maxAge: 0, path: "/" });
  });
});
