import { chromium } from "playwright";

/**
 * Drive the live review + batch pages and report exactly what the UI shows:
 * buttons present, edit boxes, sections, and the result of attempting an edit
 * and an approve — so we can see (not infer) the bugs the user described.
 *
 * Start `npm run dev` first, then:  node scripts/playwright-explore.mjs
 */
const BASE = "http://localhost:3000";
const { mkdirSync } = await import("fs");
mkdirSync("scripts/shots", { recursive: true });

const EMAIL = process.env.ZL_EMAIL ?? "zabdi908@gmail.com";
const PASSWORD = process.env.ZL_PASS ?? "Zakaleno254";

function log(...args) {
  console.log("[explore]", ...args);
}

const browser = await chromium.launch();
const page = await browser.newPage();

// Log all /api traffic so we can see what fires and how slow it is.
page.on("request", (req) => {
  if (req.url().includes("/api/")) log("API request:", req.url());
});
page.on("response", (resp) => {
  if (resp.url().includes("/api/")) log("API response:", resp.status(), resp.url());
});
page.on("requestfailed", (req) => log("Request FAILED:", req.url(), req.failure()?.errorText));

// --- Login (uses the user's real account — no new auth row). ---
log(`Logging in as ${EMAIL}`);
await page.goto(`${BASE}/login`);
await page.waitForTimeout(1500);
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASSWORD);
await page.locator("button[type='submit']").click();
await page.waitForTimeout(4000);
log("URL after login:", page.url());

let bodySnippetForCheck = "";
try { bodySnippetForCheck = await page.textContent("body", { timeout: 5000 }); } catch { /* ignore */ }
const bodyForCheck = bodySnippetForCheck || "";
const inApp = bodyForCheck.includes("Sign out") || page.url().includes("/dashboard") || page.url().includes("/review") || page.url().includes("/batch");
if (!inApp) {
  log("Did not land in the app. Body snippet:", bodyForCheck.slice(0, 300));
await browser.close();
  console.log("RESULT:LOGIN_FAILED");
  process.exit(0);
}
log("Logged in OK — app shell visible.");

// --- Seed the demo batch (only works in demo mode / no ANTHROPIC_API_KEY) ---
log("Seeding demo batch via POST /api/pending/demo");
const seedRes = await page.request.post(`${BASE}/api/pending/demo`);
let seedBody = "";
try { seedBody = await seedRes.text(); } catch {}
log("Seed status:", seedRes.status(), "body:", seedBody.slice(0, 200));
if (seedRes.status() !== 200) {
  log("Demo batch unavailable (probably real ANTHROPIC_API_KEY is set). Proceeding with empty queue.");
}

async function snapshot(page, label) {
  log(`--- ${label} ---`);
  log("URL:", page.url());
  try {
    const h1 = await page.locator("h1").first().textContent({ timeout: 5000 });
  log("H1:", (h1 || "").trim());
  } catch { log("H1: (none)"); }
  const buttons = await page.locator("button").allTextContents().catch(() => []);
  log("Buttons:", buttons.map((b) => b.trim().replace(/\s+/g, " ")).filter((b) => b));
  await page.screenshot({ path: `scripts/shots/${label}.png`, fullPage: true }).catch(() => {});
}

// --- Review page ---
log("Going to review page");
await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => log("review page: goto timed out"));
await page.waitForTimeout(15000);
await snapshot(page, "review");

// Capture section headers
const sectionTexts = await page.locator("text=Ready to Approve").or(page.locator("text=Needs Review")).or(page.locator("text=Possible Duplicates")).or(page.locator("text=Potential Issues")).allTextContents().catch(() => []);
log("Section headers:", sectionTexts.map((s) => s.trim()).filter(Boolean));

// Merchant card titles
const cards = await page.locator("h1 ~ * button").allTextContents().catch(() => []);
log("Card merchant names/buttons:", cards.map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 20));

await browser.close();
console.log("RESULT:DONE");
