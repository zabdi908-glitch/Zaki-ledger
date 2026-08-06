import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/vitals/route";

/**
 * /api/vitals is unauthenticated by design (beacons fire from any client),
 * so the body is untrusted. These tests cover the allowlist validation and
 * the log-injection guard: a malformed or hostile payload must be dropped
 * silently (204, no log line) rather than logged verbatim or echoed back.
 */
function post(body: unknown) {
  return POST(
    new Request("http://test/api/vitals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/vitals", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("logs a well-formed 'good' metric at info level", async () => {
    const res = await post({ name: "LCP", value: 1234.6, rating: "good", path: "/reconciliation/review" });
    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith("[vitals] /reconciliation/review LCP=1235 (good)");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a non-'good' metric at warn level", async () => {
    const res = await post({ name: "CLS", value: 0.4, rating: "poor", path: "/upload" });
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith("[vitals] /upload CLS=0 (poor)");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("strips injected newlines from path so a forged log line can't be smuggled in", async () => {
    const res = await post({
      name: "LCP",
      value: 1,
      rating: "good",
      path: "/foo\n[vitals] /admin FAKE=999 (good)",
    });
    expect(res.status).toBe(200);
    // Exactly one log call, and no newline inside it — so a line-oriented
    // scan of the log stream never sees a second "[vitals] /admin ..." line
    // that looks like it came from a real beacon.
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("\n");
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toBe("[vitals] /foo[vitals] /admin FAKE=999 (good) LCP=1 (good)");
  });

  it("caps an oversized path instead of logging it unbounded", async () => {
    const longPath = "/" + "a".repeat(500);
    await post({ name: "TTFB", value: 10, rating: "good", path: longPath });
    const line = logSpy.mock.calls[0][0] as string;
    // "[vitals] " (9) + 120-char path + " TTFB=10 (good)"
    expect(line.length).toBe(9 + 120 + " TTFB=10 (good)".length);
  });

  it("drops an unknown metric name with a bare 204 and no log line", async () => {
    const res = await post({ name: "Next.js-hydration", value: 5, rating: "good", path: "/" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops an unknown rating with a bare 204 and no log line", async () => {
    const res = await post({ name: "LCP", value: 5, rating: "excellent", path: "/" });
    expect(res.status).toBe(204);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops a non-finite value with a bare 204 and no log line", async () => {
    const res = await post({ name: "LCP", value: "not-a-number", rating: "good", path: "/" });
    expect(res.status).toBe(204);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("drops a malformed (non-JSON) body with a bare 204, not a 500", async () => {
    const res = await POST(
      new Request("http://test/api/vitals", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(204);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
