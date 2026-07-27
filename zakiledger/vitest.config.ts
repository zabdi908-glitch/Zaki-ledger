import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mirror the "@/*" -> "./*" alias from tsconfig.json so tests import the
    // same specifiers the app does.
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Route-level tests share a process-wide in-memory store, so each file gets
    // its own worker and a clean module registry. Without this, one file's
    // approved documents leak into another's duplicate checks.
    isolate: true,
    fileParallelism: false,
  },
});
