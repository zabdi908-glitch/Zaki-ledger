import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  use: { baseURL: "http://localhost:3000", headless: true },
  webServer: {
    command: "npm run dev",
    port: 3000,
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
    env: { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" },
  },
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
});
