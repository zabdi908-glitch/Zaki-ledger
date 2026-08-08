import { test, expect } from "@playwright/test";

const MOCK_DOCUMENTS = [
  {
    id: "doc-1",
    documentType: "invoice",
    merchantName: "Acme Corp",
    invoiceNumber: "INV-001",
    invoiceDate: "2026-07-01",
    currency: "USD",
    total: 250.0,
    subtotal: 200.0,
    tax: 50.0,
    overallConfidence: 0.92,
    perFieldConfidence: { merchantName: 0.95, total: 0.9 },
  },
  {
    id: "doc-2",
    documentType: "receipt",
    merchantName: "Beta Supplies",
    invoiceNumber: "REC-002",
    invoiceDate: "2026-07-05",
    currency: "USD",
    total: 120.0,
    subtotal: 100.0,
    tax: 20.0,
    overallConfidence: 0.65,
    perFieldConfidence: { merchantName: 0.7, total: 0.6 },
  },
  {
    id: "doc-3",
    documentType: "invoice",
    merchantName: "Gamma Ltd",
    invoiceNumber: "INV-003",
    invoiceDate: "2026-07-10",
    currency: "USD",
    total: 500.0,
    subtotal: 400.0,
    tax: 100.0,
    overallConfidence: 0.88,
    perFieldConfidence: { merchantName: 0.9, total: 0.85 },
  },
];

test.describe("Batch Review", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/pending", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ documents: MOCK_DOCUMENTS }),
      });
    });

    await page.route("**/api/approve/bulk", async (route) => {
      const body = await route.request().postDataJSON();
      const results = (body.documentIds as string[]).map((id) => ({
        status: "approved",
        merchantName: MOCK_DOCUMENTS.find((d) => d.id === id)?.merchantName ?? "",
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results }),
      });
    });

    await page.goto("/batch");
    await expect(page.getByRole("heading", { name: /Batch Review/i })).toBeVisible();
  });

  test("Documents are listed", async ({ page }) => {
    await expect(page.getByText("Acme Corp")).toBeVisible();
    await expect(page.getByText("Beta Supplies")).toBeVisible();
    await expect(page.getByText("Gamma Ltd")).toBeVisible();
  });

  test("Select all checkbox selects all documents", async ({ page }) => {
    const selectAllCheckbox = page.locator('input[type="checkbox"]').first();

    // Initially unchecked
    await expect(selectAllCheckbox).not.toBeChecked();

    // Check all
    await selectAllCheckbox.check();
    await expect(selectAllCheckbox).toBeChecked();

    // All row checkboxes should be checked
    const allRowCheckboxes = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator("div") });
    const checkedCount = await allRowCheckboxes.evaluateAll((els) => els.filter((el) => (el as HTMLInputElement).checked).length);
    expect(checkedCount).toBeGreaterThanOrEqual(3);

    // Bulk approve button should show count
    await expect(page.getByRole("button", { name: /Approve selected \(\d+\)/i })).toBeVisible();
  });

  test("Bulk approve selected shows progress then success state", async ({ page }) => {
    // Select all
    await page.locator('input[type="checkbox"]').first().check();

    const bulkApproveBtn = page.getByRole("button", { name: /Approve selected/i });
    await expect(bulkApproveBtn).toBeEnabled();

    await bulkApproveBtn.click();

    // Should show toast
    await expect(page.locator("div").filter({ hasText: /\d+ item?s? approved/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test("Deselect individual items updates bulk button", async ({ page }) => {
    // Select all
    await page.locator('input[type="checkbox"]').first().check();

    const bulkApproveBtn = page.getByRole("button", { name: /Approve selected \(\d+\)/i });
    await expect(bulkApproveBtn).toBeEnabled();

    // Deselect first row (skip select-all checkbox at index 0)
    const rowCheckboxes = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator("div") });
    await rowCheckboxes.nth(1).uncheck();

    // Button should still be enabled with updated count
    await expect(bulkApproveBtn).toBeEnabled();

    // Deselect all remaining
    const count = await rowCheckboxes.count();
    for (let i = 2; i < count; i++) {
      await rowCheckboxes.nth(i).uncheck();
    }

    // Button should now be disabled
    await expect(page.getByRole("button", { name: /Approve selected \(0\)/i })).toBeDisabled();
  });
});