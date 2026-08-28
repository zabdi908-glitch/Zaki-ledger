import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.hoisted(() => vi.fn());
const lookupMock = vi.hoisted(() => vi.fn());
const createServiceMock = vi.hoisted(() => vi.fn(() => ({ lookup: lookupMock })));
const CLIENT_ID = "c1200000-0000-4000-8000-000000000001";
const CONNECTION_ID = "c1200000-0000-4000-8000-000000000002";

vi.mock("../lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("../lib/quickbooks-vendor-lookup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/quickbooks-vendor-lookup")>();
  return { ...actual, createQuickBooksVendorLookupService: createServiceMock };
});

let lookupRoute: (request: Request) => Promise<Response>;
const base = "http://test/api/quickbooks/vendors/lookup";
const validUrl = `${base}?clientEntityId=${CLIENT_ID}&providerConnectionId=${CONNECTION_ID}` +
  `&realm=9341457595863196&displayName=${encodeURIComponent("Zaki Sandbox Test Vendor")}`;

beforeAll(async () => {
  lookupRoute = (await import("../app/api/quickbooks/vendors/lookup/route")).GET;
});

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ id: "user-1" });
  lookupMock.mockReset().mockResolvedValue({
    providerVendorId: "vendor-42",
    active: true,
    realm: "9341457595863196",
    exactMatch: true,
  });
  createServiceMock.mockClear();
});

describe("GET /api/quickbooks/vendors/lookup", () => {
  it("requires an authenticated user before constructing the lookup service", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const response = await lookupRoute(new Request(validUrl));
    expect(response.status).toBe(401);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("requires the exact client, provider connection, realm, and DisplayName scope", async () => {
    const response = await lookupRoute(new Request(`${base}?displayName=Vendor`));
    expect(response.status).toBe(400);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("returns only the verified Vendor fields", async () => {
    const response = await lookupRoute(new Request(validUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerVendorId: "vendor-42",
      active: true,
      realm: "9341457595863196",
      exactMatch: true,
    });
    expect(lookupMock).toHaveBeenCalledWith({
      userId: "user-1",
      clientEntityId: CLIENT_ID,
      providerConnectionId: CONNECTION_ID,
      realm: "9341457595863196",
      displayName: "Zaki Sandbox Test Vendor",
    });
  });

  it("does not expose provider or credential error details", async () => {
    lookupMock.mockRejectedValueOnce(new Error("Bearer secret-access-token"));
    const response = await lookupRoute(new Request(validUrl));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret-access-token");
  });
});
