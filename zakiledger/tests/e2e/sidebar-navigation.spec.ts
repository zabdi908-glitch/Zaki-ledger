import { test, expect } from "@playwright/test";

test.describe("Sidebar Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
  });

  test("Dashboard page shows Dashboard heading", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });

  test('Click "Upload & Extract" navigates to /upload', async ({ page }) => {
    await page.getByRole("link", { name: /Upload & Extract/i }).click();
    await expect(page).toHaveURL(/\/upload$/);
  });

  test('Click "Review & Edit" navigates to /review', async ({ page }) => {
    await page.getByRole("link", { name: /Review & Edit/i }).click();
    await expect(page).toHaveURL(/\/review$/);
  });

  test('Click "Batch Review" navigates to /batch', async ({ page }) => {
    await page.getByRole("link", { name: /^Batch Review$/i }).first().click();
    await expect(page).toHaveURL(/\/batch$/);
  });

  test('Click "Upload Statement" navigates to /reconciliation', async ({ page }) => {
    await page.getByRole("link", { name: /Upload Statement/i }).click();
    await expect(page).toHaveURL(/\/reconciliation$/);
  });

  test('Click "Review Matches" navigates to /reconciliation/review', async ({ page }) => {
    await page.getByRole("link", { name: /Review Matches/i }).click();
    await expect(page).toHaveURL(/\/reconciliation\/review$/);
  });

  test('Click "Batch Review" under Reconciliation navigates to /reconciliation/batch', async ({ page }) => {
    // Use the second Batch Review link (under Reconciliation group)
    await page.getByRole("link", { name: /^Batch Review$/i }).nth(1).click();
    await expect(page).toHaveURL(/\/reconciliation\/batch$/);
  });

  test('Click "Cross-File Compare" navigates to /reconciliation/compare', async ({ page }) => {
    await page.getByRole("link", { name: /Cross-File Compare/i }).click();
    await expect(page).toHaveURL(/\/reconciliation\/compare$/);
  });

  test('Click "Settings" navigates to /settings', async ({ page }) => {
    await page.getByRole("link", { name: /^Settings$/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('SOON badge items do NOT navigate', async ({ page }) => {
    const currentUrl = page.url();

    await page.getByText("Auto-Categorize").click();
    await expect(page).toHaveURL(currentUrl);

    await page.getByText("Document Portal").click();
    await expect(page).toHaveURL(currentUrl);

    await page.getByText("Reports & Analytics").click();
    await expect(page).toHaveURL(currentUrl);
  });

  test("Collapse and expand sidebar changes width", async ({ page }) => {
    const sidebar = page.locator("div").filter({ has: page.getByRole("link", { name: /Dashboard/i }) }).first();
    const toggle = page.locator('div[title="Toggle sidebar (Cmd/Ctrl+B)"]');

    // Get initial width (expanded ~240px)
    const expandedBox = await sidebar.boundingBox();
    expect(expandedBox?.width).toBeGreaterThan(200);

    // Collapse
    await toggle.click();
    await page.waitForTimeout(200);

    const collapsedBox = await sidebar.boundingBox();
    expect(collapsedBox?.width).toBeLessThan(100);

    // Expand
    await toggle.click();
    await page.waitForTimeout(200);

    const reexpandedBox = await sidebar.boundingBox();
    expect(reexpandedBox?.width).toBeGreaterThan(200);
  });
});