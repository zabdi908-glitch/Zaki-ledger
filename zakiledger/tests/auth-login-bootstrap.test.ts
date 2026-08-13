import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  signIn: vi.fn(),
  bootstrap: vi.fn(),
  signOut: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("@/lib/supabase-server", () => ({
  createSupabaseRouteHandlerClient: async () => ({
    auth: {
      signInWithPassword: state.signIn,
      signOut: state.signOut,
    },
    rpc: state.bootstrap,
  }),
  clearSupabaseRouteHandlerSession: state.clearSession,
}));

import { POST } from "@/app/api/auth/login/route";

function loginRequest(): NextRequest {
  return new Request("http://test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@example.test", password: "correct-password" }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.signIn.mockResolvedValue({ error: null });
  state.bootstrap.mockResolvedValue({ error: null });
  state.signOut.mockResolvedValue({ error: null });
  state.clearSession.mockResolvedValue(undefined);
});

describe("POST /api/auth/login canonical bootstrap", () => {
  it("keeps the authenticated session on a successful bootstrap", async () => {
    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.signIn).toHaveBeenCalledWith({ email: "user@example.test", password: "correct-password" });
    expect(state.bootstrap).toHaveBeenCalledWith("ensure_default_tenant_for_self_v1");
    expect(state.signOut).not.toHaveBeenCalled();
    expect(state.clearSession).not.toHaveBeenCalled();
  });

  it("revokes and clears the session when bootstrap fails after authentication", async () => {
    state.bootstrap.mockResolvedValue({ error: { message: "temporary bootstrap failure" } });

    const response = await POST(loginRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Signed in, but account setup could not be completed. Please try again.",
    });
    expect(state.signOut).toHaveBeenCalledOnce();
    expect(state.clearSession).toHaveBeenCalledOnce();
  });

  it("still returns a safe failure and clears browser auth cookies when sign-out fails", async () => {
    state.bootstrap.mockResolvedValue({ error: { message: "temporary bootstrap failure" } });
    state.signOut.mockResolvedValue({ error: { message: "auth revocation unavailable" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(loginRequest());

    expect(response.status).toBe(503);
    expect(state.signOut).toHaveBeenCalledOnce();
    expect(state.clearSession).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "[auth] session revocation after bootstrap failure failed: auth revocation unavailable",
    );
  });

  it("is retry-safe after a transient bootstrap failure", async () => {
    state.bootstrap
      .mockResolvedValueOnce({ error: { message: "temporary bootstrap failure" } })
      .mockResolvedValueOnce({ error: null });

    expect((await POST(loginRequest())).status).toBe(503);
    expect((await POST(loginRequest())).status).toBe(200);
    expect(state.signIn).toHaveBeenCalledTimes(2);
    expect(state.bootstrap).toHaveBeenCalledTimes(2);
    expect(state.signOut).toHaveBeenCalledTimes(1);
    expect(state.clearSession).toHaveBeenCalledTimes(1);
  });
});
