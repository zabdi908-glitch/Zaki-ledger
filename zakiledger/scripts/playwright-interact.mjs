import { chromium } from "playwright";

/**
 * Focused interaction test of the Review & Edit and Batch pages with a fresh
 * single seed of the demo batch (5 distinct documents: 3 clean, 1 smudged, 1
 * foreign-currency) — so sections/approve/flag/edit can genuinely be exercised.
 *
 * Start `npm run dev` first (fresh store), then:  node scripts/playwright-interact.mjs
 */
const BASE = "http://localhost:3000";
const { mkdirSync } = await import("fs");
mkdirSync("scripts/shots", { recursive: true });

const EMAIL = process.env.ZL_EMAIL ?? "zabdi908@gmail.com";
const PASSWORD = process.env.ZL_PASS ?? "Zakaleno254";

function log(...args) {
  console.log("[interact]", ...args);
}

// Keep the browser visible so screenshots are meaningful.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("response", (resp) => {
  if (resp.url().includes("/api/") && !resp.url().includes("/api/vitals")) {
    log("API:", resp.status(), resp.url());
  }
});
page.on("requestfailed", (req) => log("FAILED:", req.url(), req.failure()?.errorText));

// --- Login ---
log(`Logging in as ${EMAIL}`);
await page.goto(`${BASE}/login`);
await page.waitForTimeout(1500);
await page.locator('input[type="email"]').fill(EMAIL);
await page.locator('input[type="password"]').fill(PASSWORD);
await page.locator("button[type='submit']").click();

// Poll until we're in the app shell or timeout, to absorb the slow redirect.
let inApp = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  let bodyTxt = "";
  try { bodyTxt = await page.locator("body").innerText({ timeout: 1000 }); } catch {}
  if ((bodyTxt || "").includes("Sign out") || page.url().includes("/dashboard") || page.url().includes("/review")) {
    inApp = true;
    break;
  }
  if (page.url().startsWith("http://localhost:3000/dashboard") || page.url().includes("/review")) { inApp = true; break; }
}
const finalText = (await page.locator("body").innerText().catch(() => "")) || "";
if (!inApp) {
  log("Login didn't land in the app. URL:", page.url());
  log("body:", finalText.split("\n").filter((l) => l.trim()).slice(0, 20).join(" | "));
await browser.close();
  process.exit(0);
}
log("Logged in. URL:", page.url());

// --- Flush the pending queue to guarantee a single clean seed. ---
log("Flushing pending queue to start from a clean slate.");
const pendingRes = await page.request.get(`${BASE}/api/pending`);
const pendingJson = await pendingRes.json().catch(() => ({ documents: [] }));
for (const d of pendingJson.documents ?? []) {
  await page.request.delete(`${BASE}/api/pending/${d.id}`);
  log("Deleted pending:", d.merchantName);
}
const afterFlush = await page.request.get(`${BASE}/api/pending`).then((r) => r.json());
log("Pending count after flush:", afterFlush.documents?.length ?? 0);

// --- Seed once (fresh queue) ---
const seed = await page.request.post(`${BASE}/api/pending/demo`);
log("Seed:", seed.status(), (await seed.text()).slice(0, 100));

async function dumpSections(page, label) {
  log(`===== ${label} =====`);
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  log("PAGE TEXT:");
  log(text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("$") && !l.startsWith("self.__next")).join("\n"));
  await page.screenshot({ path: `scripts/shots/${label}.png`, fullPage: true }).catch(() => {});
}

// --- Review page ---
log("Going to /review (waiting generously for the slow session-refresh fetch)");
await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(12000);
await dumpSections(page, "review-seeded");

const bodyTxt2 = (await page.locator("body").innerText().catch(() => "")) || "";
log("Sections found:", (bodyTxt2.match(/Ready to Approve|Needs Review|Possible Duplicates|Potential Issues/g) || []));

// --- Is there a Reject/Delete on the review page? ---
const reviewButtons = (await page.locator("button").allInnerTexts().catch(() => [])) || [];
log("Review page buttons:", [...new Set(reviewButtons.map((b) => b.trim()).filter(Boolean))]);
log("Has Reject/Delete/Discard:", reviewButtons.some((b) => /reject|delete|discard|remove/i.test(b)));

// --- Click the Shinjuku (foreign currency) row to open its panel, then Approve. ---
log("Opening Shinjuku row panel…");
const shinjukuRow = page.locator("text=Shinjuku Station Kiosk").first();
await shinjukuRow.click({ timeout: 5000 }).catch(() => log("Couldn't click Shinjuku row"));
await page.waitForTimeout(3000);
await page.screenshot({ path: "scripts/shots/review-shinjuku-panel.png", fullPage: true }).catch(() => {});

// Try approving the Shinjuku row (the unpostable currency — should error).
log("Trying to approve Shinjuku…");
const approveButtons = page.locator("button:has-text('Approve')");
const approveBtn = approveButtons.last();
if (await approveBtn.count()) {
  await approveBtn.click().catch(() => log("Couldn't click Approve"));
  await page.waitForTimeout(5000);
  const afterApprove = (await page.locator("body").innerText().catch(() => "")) || "";
  log("After Shinjuku approve — page contains error:", /error|can't|cannot|unpostable|currency|fail/i.test(afterApprove));
  log("Error snippet:", (afterApprove.match(/[^\n]*(error|can't|cannot|currency)[^\n]*/gi) || []).slice(0, 3));
  await page.screenshot({ path: "scripts/shots/review-shinjuku-after-approve.png", fullPage: true }).catch(() => {});
} else {
  log("No Approve button found in panel.");
}

// --- Edit a field on the Corner Cafe row (the blocked one) and confirm. ---
log("Opening Corner Cafe row panel…");
const cafeRow = page.locator("text=The Corner Cafe").first();
await cafeRow.click({ timeout: 5000 }).catch(() => log("Couldn't click Corner Cafe row"));
await page.waitForTimeout(3000);
await page.screenshot({ path: "scripts/shots/review-cafe-panel.png", fullPage: true }).catch(() => {});

const inputs = page.locator("input[type='text'], input:not([type='checkbox'])");
const inputCount = await inputs.count();
log("Panel inputs:", inputCount);
if (inputCount > 0) {
  const firstInput = inputs.first();
  const currentVal = await firstInput.inputValue().catch(() => "");
  log("First input value:", currentVal);
  // Change it (append a space or change merchant) then blur to trigger onBlur save.
  await firstInput.fill(String(currentVal) + "!");
  await firstInput.blur();
  await page.waitForTimeout(5000);
  const afterEdit = (await page.locator("body").innerText().catch(() => "")) || "";
  log("After edit, saved toast/error:", /saved|corrected|error|can't|fail/i.test(afterEdit));
  await page.screenshot({ path: "scripts/shots/review-cafe-after-edit.png", fullPage: true }).catch(() => {});
}

// --- Flag button behavior ---
log("Testing Flag…");
const flagBtn = page.locator("button:has-text('Flag')").first();
if (await flagBtn.count()) {
  await flagBtn.click().catch(() => {});
  await page.waitForTimeout(2500);
  const afterFlag = (await page.locator("body").innerText().catch(() => "")) || "";
  log("After Flag — any flagged section?", /flagged|Flagged/i.test(afterFlag));
  log("Flag toast text:", (afterFlag.match(/[^\n]*flagged[^\n]*/gi) || []).slice(0, 3));
  await page.screenshot({ path: "scripts/shots/review-after-flag.png", fullPage: true }).catch(() => {});
}

await browser.close();
console.log("RESULT:DONE");

