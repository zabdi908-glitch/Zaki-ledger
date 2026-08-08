import { chromium, type FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const { baseURL } = config.projects[0].use;
  if (!baseURL || baseURL.includes("localhost")) return;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // "networkidle" hangs on Supabase-backed apps (WebSocket/heartbeat).
  // Use "load" and wait for the React-hydrated email input explicitly.
  page.setDefaultTimeout(90_000);

  await page.goto(`${baseURL}/login`, { waitUntil: "load", timeout: 90_000 });

  // Wait for React to hydrate and render the email input.
  const emailInput = page.locator("input[type='email']");
  await emailInput.waitFor({ state: "visible", timeout: 30_000 });
  await emailInput.fill("zabdi908@gmail.com");

  const passwordInput = page.locator("input[type='password']");
  await passwordInput.fill("Zakaleno254");

  await page.getByRole("button", { name: "Log in" }).click();

  // After login the app sets window.location.href to redirect — a full
  // page load.  Wait until the URL is no longer /login.
  await page.waitForFunction(
    (loginPath) => !window.location.pathname.startsWith(loginPath),
    "/login",
    { timeout: 60_000 },
  );

  await page.context().storageState({ path: "playwright/.auth/user.json" });
  await browser.close();
}
