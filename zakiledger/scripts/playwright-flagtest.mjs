import { chromium } from "playwright";

/**
 * Focused test: what does the Flag button actually do on the Review & Edit page?
 * Checks whether a "Flagged" section exists, whether the flagged row moves, and
 * whether any state is persisted.
 */
const BASE = "http://localhost:3000";
const EMAIL = process.env.ZL_EMAIL ?? "zabdi908@gmail.com";
const PASSWORD = process.env.ZL_PASS ?? "Zakaleno254";
const log = (...a) => console.log("[flagtest]", ...a);

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

// flush
const pending = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
for (const d of pending.documents ?? []) await page.request.delete(`${BASE}/api/pending/${d.id}`);
log("Flushed", (pending.documents ?? []).length);
await page.request.post(`${BASE}/api/pending/demo`);
log("Seeded demo batch");

await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(12000);

const bodyBefore = (await page.locator("body").innerText().catch(() => "")) || "";
log("Flagged section before click:", /flagged/i.test(bodyBefore));

// Click the first ⚑ button (flag).
const flagBtn = page.locator("button:has-text('⚑')").first();
log("Flag buttons present:", await flagBtn.count());
await flagBtn.click({ timeout: 5000 }).catch((e) => log("click failed:", e.message));
await page.waitForTimeout(3000);

const bodyAfter = (await page.locator("body").innerText().catch(() => "")) || "";
log("Flagged section after click:", /flagged/i.test(bodyAfter));
log("Flag-related text:", (bodyAfter.match(/[^\n]*flagged[^\n]*/gi) || []).slice(0, 5));
log("Row count in sections after flag (Ready/Needs/Dupe/Issue/Flagged):");
for (const s of ["Ready to Approve", "Needs Review", "Possible Duplicates", "Potential Issues", "Flagged"]) {
  const idx = bodyAfter.indexOf(s);
  if (idx !== -1) log("  -", s, "→", bodyAfter.slice(idx, idx + 200).replace(/\n+/g, " "));
}
await page.screenshot({ path: "scripts/shots/review-after-flag-test.png", fullPage: true }).catch(() => {});
await browser.close();
console.log("RESULT:DONE");
