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
    // Provide dummy keys so modules that initialize at import time
    // (lib/openai.ts → new OpenAI(), lib/supabase-server.ts → requiredEnv())
    // don't throw before a test has a chance to mock them. Tests that need
    // real keys set them in beforeAll or via a .env.local.
    env: {
      OPENAI_API_KEY: "sk-test-dummy-key",
      ANTHROPIC_API_KEY: "sk-ant-test-dummy-key",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
  },
});
