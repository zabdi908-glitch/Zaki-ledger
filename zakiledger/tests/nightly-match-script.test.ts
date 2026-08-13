import { beforeAll, describe, expect, it, vi } from "vitest";

// Force clean env so the script's DB check and freeze flag behave
// deterministically in tests.
beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
});

vi.mock("../lib/nightly-match", () => ({
  runNightlyMatch: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({
  getSupabase: vi.fn(),
}));

// Dynamic import after mocks are registered and env is cleared.
const { runNightlyMatch } = await import("../lib/nightly-match");
const { getSupabase } = await import("../lib/supabase");
const { main } = await import("../scripts/nightly-match");

describe("scripts/nightly-match freeze entrypoint", () => {
  it("freeze=1 exits before any DB or reconciliation writer is touched", async () => {
    process.env.ZAKI_RECONCILIATION_WRITE_FREEZE = "1";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(main()).rejects.toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Reconciliation writes are frozen/),
      );
      // Guard fires BEFORE any DB access or reconciliation writer call.
      expect(getSupabase).not.toHaveBeenCalled();
      expect(runNightlyMatch).not.toHaveBeenCalled();
    } finally {
      delete process.env.ZAKI_RECONCILIATION_WRITE_FREEZE;
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("freeze=0 still reaches the DB layer and runs the nightly job per user", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fakeDb = {
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [{ id: "user-a" }, { id: "user-b" }] },
            error: null,
          }),
        },
      },
    };
    vi.mocked(getSupabase).mockReturnValue(fakeDb as never);
    vi.mocked(runNightlyMatch).mockResolvedValue({
      statementsProcessed: 1,
      matchesFound: 2,
      greenCount: 1,
      yellowCount: 1,
      redCount: 0,
      errors: [],
    });

    try {
      await expect(main()).rejects.toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(getSupabase).toHaveBeenCalledTimes(1);
      expect(runNightlyMatch).toHaveBeenCalledTimes(2);
      expect(runNightlyMatch).toHaveBeenCalledWith("user-a");
      expect(runNightlyMatch).toHaveBeenCalledWith("user-b");
      expect(logSpy).toHaveBeenCalledWith(
        "Nightly match complete: 2 users, 2 statements, 4 matches",
      );
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});