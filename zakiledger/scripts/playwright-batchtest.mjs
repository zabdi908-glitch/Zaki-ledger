import { chromium } from "playwright";

/** Quick check of the /batch page: buttons, sections, reject behavior. */
const BASE = "http://localhost:3000";
const EMAIL = process.env.ZL_EMAIL ?? "zabdi908@gmail.com";
const PASSWORD = process.env.ZL_PASS ?? "Zakaleno254";
const log = (...a) => console.log("[batchtest]", ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("response", (r) => { if (r.url().includes("/api/") && !r.url().includes("vitals")) log("API:", r.status(), r.url()); });

await page.goto(`${BASE}/login`);
await page.waitForTimeout(1200);
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASSWORD);
await page.locator("button[type='submit']").click();
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const t = (await page.locator("body").innerText().catch(() => "")) || "";
  if (t.includes("Sign out")) break;
}
log("Logged in:", page.url());

// flush + seed
const pending = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
for (const d of pending.documents ?? []) await page.request.delete(`${BASE}/api/pending/${d.id}`);
await page.request.post(`${BASE}/api/pending/demo`);
log("Seeded");

await page.goto(`${BASE}/batch`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(12000);

const text = (await page.locator("body").innerText().catch(() => "")) || "";
log("H1/Batch text present:", /batch review|Batch Review/i.test(text));
const buttons = [...new Set((await page.locator("button").allInnerTexts().catch(() => [])) || [])];
log("Batch page buttons:", buttons.map((b) => b.trim().replace(/\s+/g, " ")).filter(Boolean));
log("Has Reject:", buttons.some((b) => /reject/i.test(b)));

// Click first row's Reject if present
const rejectBtn = page.locator("button:has-text('Reject')").first();
if (await rejectBtn.count()) {
  log("Clicking first Reject…");
  await rejectBtn.click({ timeout: 5000 }).catch((e) => log("reject click failed:", e.message));
  await page.waitForTimeout(3000);
  const after = (await page.locator("body").innerText().catch(() => "")) || "";
  log("After reject — still has rows? / removed?  Pending count text:", (after.match(/\d+ (documents?|items?)/i) || [])[0] ?? "(none)");
}
await page.screenshot({ path: "scripts/shots/batch-page.png", fullPage: true }).catch(() => {});
await browser.close();
console.log("RESULT:DONE");
