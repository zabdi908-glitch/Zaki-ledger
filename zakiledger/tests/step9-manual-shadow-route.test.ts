import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const runtimeMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("../lib/orchestration/manual-shadow-entrypoint", () => ({
  createManualShadowRuntime: runtimeMock,
  invokeManualShadow: invokeMock,
}));

let post: (request: Request) => Promise<Response>;

beforeAll(async () => {
  post = (await import("../app/api/orchestration/shadow/manual/route")).POST;
});

beforeEach(() => {
  requireUserMock.mockReset();
  runtimeMock.mockReset();
  invokeMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});

describe("POST /api/orchestration/shadow/manual", () => {
  it("is only a one-shot authenticated invocation seam", async () => {
    const request = new Request("http://test/api/orchestration/shadow/manual", { method: "POST" });
    const response = await post(request);
    expect(response.status).toBe(204);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(request, {
      authenticate: requireUserMock,
      runtime: runtimeMock,
    });
  });
});
