import { chromium } from "playwright";

/**
 * Precise tests:
 *  1) Does approving the foreign-currency Shinjuku row succeed or error?
 *  2) Does editing a single field on a blocked doc approve the whole doc?
 *  3) After an edit, does the row move sections without a manual reload?
 */
const BASE = "http://localhost:3000";
const EMAIL = process.env.ZL_EMAIL ?? "zabdi908@gmail.com";
const PASSWORD = process.env.ZL_PASS ?? "Zakaleno254";
const log = (...a) => console.log("[precise]", ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("response", (r) => {
  if (r.url().includes("/api/") && !r.url().includes("vitals")) log("API:", r.status(), r.url());
});

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

// flush + seed fresh
const pending = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
for (const d of pending.documents ?? []) await page.request.delete(`${BASE}/api/pending/${d.id}`);
await page.request.post(`${BASE}/api/pending/demo`);

// Get the queue ids so we can track who leaves.
const queued = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
const byMerchant = new Map(queued.documents.map((d) => [d.merchantName, d.id]));
log("Queue:", [...byMerchant.entries()].map(([m, id]) => `${m}=${id.slice(0, 8)}`).join(", "));

await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(12000);

// ---- Test 1: open Shinjuku panel, click ITS approve button precisely. ----
log("=== TEST 1: Shinjuku approve ===");
await page.locator("text=Shinjuku Station Kiosk").first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(3000);
// The panel's Approve is the button inside the side panel — find the one that is
// a direct sibling of Flag in the panel (i.e. the last 'Approve' before 'Flag').
const panelApprove = page.locator("button:has-text('Approve')").last();
log("Clicking panel Approve (text:", (await panelApprove.innerText().catch(() => "?")).trim(), ")");
await panelApprove.click({ timeout: 5000 }).catch((e) => log("click failed:", e.message));
await page.waitForTimeout(4000);

const after1 = (await page.locator("body").innerText().catch(() => "")) || "";
log("Toast/error visible:", (after1.match(/[^\n]*(approved|error|can't|duplicate|currency|posted)[^\n]*/gi) || []).slice(0, 4));
const queuedAfter1 = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
log("Shinjuku still pending after approve?", queuedAfter1.documents.some((d) => d.merchantName === "Shinjuku Station Kiosk"));
log("Queue now:", queuedAfter1.documents.map((d) => d.merchantName).join(", "));

// ---- Test 2: edit a field on the blocked Corner Cafe and see if it approves. ----
log("=== TEST 2: edit merchant on Corner Cafe ===");
// Ensure the panel is on Corner Cafe (reload review page to reset panel state).
await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(10000);
await page.locator("text=The Corner Cafe").first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(3000);
const cafeInputs = page.locator("input:not([type='checkbox'])");
const supplierInput = cafeInputs.first();
log("Supplier field value before edit:", await supplierInput.inputValue().catch(() => "?"));
await supplierInput.fill("The Corner Cafe (edited)");
await supplierInput.blur();
await page.waitForTimeout(5000);
const queuedAfter2 = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
log("Corner Cafe still pending after edit?", queuedAfter2.documents.some((d) => d.merchantName.includes("Corner Cafe")));
log("Queue now:", queuedAfter2.documents.map((d) => d.merchantName).join(", "));
log("(If Corner Cafe is gone → editing approved the whole doc.)");

await page.screenshot({ path: "scripts/shots/review-after-edit-approve.png", fullPage: true }).catch(() => {});
await browser.close();
console.log("RESULT:DONE");
