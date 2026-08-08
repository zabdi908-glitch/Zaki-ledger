import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: require.resolve("./tests/e2e/global-setup"),
  use: {
    baseURL: "https://zaki-ledger.onrender.com",
    headless: true,
    storageState: "playwright/.auth/user.json",
  },
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
});
