import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.hoisted(() => vi.fn());
const executeMock = vi.hoisted(() => vi.fn());
const createExecutorMock = vi.hoisted(() => vi.fn(() => ({ execute: executeMock })));

vi.mock("../lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("../lib/quickbooks-sandbox-pilot-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quickbooks-sandbox-pilot-executor")>();
  return { ...actual, createQuickBooksSandboxPilotExecutor: createExecutorMock };
});

const INPUT = {
  vendorOperationId: "aa100000-0000-4000-8000-000000000001",
  billOperationId: "aa100000-0000-4000-8000-000000000002",
  externalVendorId: "70",
};
let post: (request: Request) => Promise<Response>;

beforeAll(async () => {
  post = (await import("../app/api/quickbooks/sandbox-pilot/execute/route")).POST;
});

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ id: "actor-1" });
  executeMock.mockReset().mockResolvedValue({ verdict: "SUCCEEDED" });
  createExecutorMock.mockClear();
});

function request(body: unknown) {
  return new Request("http://test/api/quickbooks/sandbox-pilot/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/quickbooks/sandbox-pilot/execute", () => {
  it("requires an authenticated user before constructing the executor", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const response = await post(request(INPUT));
    expect(response.status).toBe(401);
    expect(createExecutorMock).not.toHaveBeenCalled();
  });

  it("accepts only explicit distinct operation IDs and one existing Vendor ID", async () => {
    const response = await post(request({ ...INPUT, billOperationId: INPUT.vendorOperationId }));
    expect(response.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("binds the authenticated actor and returns STOP as a conflict", async () => {
    executeMock.mockResolvedValueOnce({ verdict: "STOPPED", reasonCode: "REVIEW" });
    const response = await post(request(INPUT));
    expect(response.status).toBe(409);
    expect(executeMock).toHaveBeenCalledWith(INPUT, { kind: "USER", userId: "actor-1" });
  });

  it("does not expose internal failures or credentials", async () => {
    executeMock.mockRejectedValueOnce(new Error("Bearer secret-token"));
    const response = await post(request(INPUT));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret-token");
  });
});
