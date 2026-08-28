import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const createServiceMock = vi.hoisted(() => vi.fn(() => ({ refresh: refreshMock })));

vi.mock("../lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("../lib/posting-authorization-refresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/posting-authorization-refresh")>();
  return { ...actual, createPostingAuthorizationRefreshService: createServiceMock };
});

const ACTOR_ID = "f1000000-0000-4000-8000-000000000001";
const VENDOR_ID = "f1000000-0000-4000-8000-000000000002";
const BILL_ID = "f1000000-0000-4000-8000-000000000003";
const REQUEST_ID = "f1000000-0000-4000-8000-000000000004";
const url = "http://test/api/posting/operations/refresh-authorization";
let route: (request: Request) => Promise<Response>;

function request(body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  route = (await import("../app/api/posting/operations/refresh-authorization/route")).POST;
});

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ id: ACTOR_ID });
  refreshMock.mockReset().mockResolvedValue({ kind: "REFRESHED", authorizations: [] });
  createServiceMock.mockClear();
});

describe("POST /api/posting/operations/refresh-authorization", () => {
  it("requires an authenticated user before constructing the service", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const response = await route(request({ operationIds: [VENDOR_ID], refreshRequestId: REQUEST_ID }));
    expect(response.status).toBe(401);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { operationIds: [], refreshRequestId: REQUEST_ID },
    { operationIds: ["not-a-uuid"], refreshRequestId: REQUEST_ID },
    { operationIds: [VENDOR_ID, VENDOR_ID], refreshRequestId: REQUEST_ID },
    { operationIds: [VENDOR_ID], refreshRequestId: "not-a-uuid" },
  ])("rejects malformed or duplicate operation scope", async (body) => {
    const response = await route(request(body));
    expect(response.status).toBe(400);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("binds refresh authority to the authenticated user", async () => {
    const response = await route(request({
      operationIds: [VENDOR_ID, BILL_ID],
      refreshRequestId: REQUEST_ID,
    }));
    expect(response.status).toBe(200);
    expect(refreshMock).toHaveBeenCalledWith({
      actorUserId: ACTOR_ID,
      operationIds: [VENDOR_ID, BILL_ID],
      refreshRequestId: REQUEST_ID,
    });
  });

  it("returns actor rejection as forbidden and other stale state as conflict", async () => {
    refreshMock.mockResolvedValueOnce({ kind: "BLOCKED", reasonCode: "ACTOR_UNAUTHORIZED" });
    expect((await route(request({ operationIds: [VENDOR_ID], refreshRequestId: REQUEST_ID }))).status)
      .toBe(403);
    refreshMock.mockResolvedValueOnce({ kind: "BLOCKED", reasonCode: "DISPATCH_EVIDENCE_STALE" });
    expect((await route(request({ operationIds: [VENDOR_ID], refreshRequestId: REQUEST_ID }))).status)
      .toBe(409);
  });

  it("sanitizes unexpected failures", async () => {
    refreshMock.mockRejectedValueOnce(new Error("service-role-secret"));
    const response = await route(request({ operationIds: [VENDOR_ID], refreshRequestId: REQUEST_ID }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("service-role-secret");
  });
});
