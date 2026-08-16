import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: [
      "tests/migration-012-contract.test.ts",
      "tests/migration-012-tenant-isolation.test.ts",
      "tests/migration-013-contract.test.ts",
      "tests/reconciliation-approval-control.test.ts",
      "tests/reconciliation-defect-regression.test.ts",
      "tests/reconciliation-manual-override-attacks.test.ts",
      "tests/reconciliation-schema-compat-staging.test.ts",
    ],
    exclude: ["node_modules", ".claude/**"],
    isolate: true,
    fileParallelism: false,
    env: {
      OPENAI_API_KEY: "sk-test-dummy-key",
      ANTHROPIC_API_KEY: "sk-ant-test-dummy-key",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      ZAKI_STAGING_SCHEMA: "012",
      ZAKI_RECONCILIATION_WRITE_FREEZE: "",
    },
  },
});
