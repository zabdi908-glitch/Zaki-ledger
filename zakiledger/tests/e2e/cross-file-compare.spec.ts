import { test, expect } from "@playwright/test";

const MOCK_COMPARISON_RESULT = {
  summary: "2 transactions matched, 1 issue found",
  matches: [
    {
      bankTransaction: {
        id: "b1",
        merchant: "Vendor A",
        description: "Vendor A Payment",
        amount: 150.0,
        currency: "USD",
        transactionDate: "2026-07-10",
      },
      qbTransaction: {
        id: "q1",
        description: "Vendor A Invoice",
        amount: 150.0,
        currency: "USD",
        postedDate: "2026-07-10",
      },
      confidence: 0.95,
      matchType: "exact_amount_date",
    },
  ],
  missingInQb: [
    {
      source: "bank",
      entry: {
        id: "b2",
        merchant: "Vendor B",
        description: "Vendor B Payment",
        amount: 200.0,
        currency: "USD",
        transactionDate: "2026-07-12",
      },
    },
  ],
  missingInBank: [],
  duplicates: [],
  amountMismatches: [],
  unmatchedItems: [],
};

test.describe("Cross-File Compare", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/reconciliation/compare");
  });

  test("Two drop zones are visible", async ({ page }) => {
    await expect(page.getByText("Bank Statement (CSV/OFX)")).toBeVisible();
    await expect(page.getByText("QuickBooks Export (CSV)")).toBeVisible();
  });

  test('"Compare Files" button is disabled initially', async ({ page }) => {
    const compareBtn = page.getByRole("button", { name: /Compare Files/i });
    await expect(compareBtn).toBeVisible();
    await expect(compareBtn).toBeDisabled();
  });

  test("Select bank file only — button still disabled", async ({ page }) => {
    const bankCsv = "Date,Description,Amount\n10/07/2026,Vendor A,150.00";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    const compareBtn = page.getByRole("button", { name: /Compare Files/i });
    await expect(compareBtn).toBeDisabled();
  });

  test("Select both files — button enabled, click Compare shows results", async ({ page }) => {
    // Mock the compare API
    await page.route("**/api/reconciliation/compare", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_COMPARISON_RESULT),
      });
    });

    const bankCsv = "Date,Description,Amount\n10/07/2026,Vendor A,150.00";
    const qbCsv = "Date,Description,Amount\n10/07/2026,Vendor A Invoice,150.00";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await page.setInputFiles('label:has-text("QuickBooks Export") input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(qbCsv),
    });

    const compareBtn = page.getByRole("button", { name: /Compare Files/i });
    await expect(compareBtn).toBeEnabled();

    await compareBtn.click();

    // Results render
    await expect(page.getByText("Comparison Summary")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("2 transactions matched, 1 issue found")).toBeVisible();
  });

  test("Verify Matched section shows entries", async ({ page }) => {
    await page.route("**/api/reconciliation/compare", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_COMPARISON_RESULT),
      });
    });

    const bankCsv = "Date,Description,Amount\n10/07/2026,Vendor A,150.00";
    const qbCsv = "Date,Description,Amount\n10/07/2026,Vendor A Invoice,150.00";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await page.setInputFiles('label:has-text("QuickBooks Export") input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(qbCsv),
    });

    await page.getByRole("button", { name: /Compare Files/i }).click();
    await expect(page.getByText("Comparison Summary")).toBeVisible({ timeout: 10000 });

    // Matched section is open by default
    await expect(page.getByText("Vendor A")).toBeVisible();
    await expect(page.getByText("95%")).toBeVisible();
  });

  test("Collapsible sections expand and collapse", async ({ page }) => {
    await page.route("**/api/reconciliation/compare", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_COMPARISON_RESULT),
      });
    });

    const bankCsv = "Date,Description,Amount\n10/07/2026,Vendor A,150.00\n12/07/2026,Vendor B,200.00";
    const qbCsv = "Date,Description,Amount\n10/07/2026,Vendor A Invoice,150.00";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await page.setInputFiles('label:has-text("QuickBooks Export") input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(qbCsv),
    });

    await page.getByRole("button", { name: /Compare Files/i }).click();
    await expect(page.getByText("Comparison Summary")).toBeVisible({ timeout: 10000 });

    // "Missing in QB" section should be collapsed initially
    const missingSectionBtn = page.getByRole("button", { name: /Missing in QB/i });
    await expect(missingSectionBtn).toBeVisible();

    // Expand
    await missingSectionBtn.click();
    await expect(page.getByText("In bank only")).toBeVisible();

    // Collapse
    await missingSectionBtn.click();
    await expect(page.getByText("In bank only")).not.toBeVisible();
  });

  test("Upload invalid CSV shows error message", async ({ page }) => {
    await page.route("**/api/reconciliation/compare", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid CSV format — could not parse transactions." }),
      });
    });

    const invalidCsv = "Not,A,Valid,Format\nfoo,bar,baz,qux";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(invalidCsv),
    });

    await page.setInputFiles('label:has-text("QuickBooks Export") input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(invalidCsv),
    });

    await page.getByRole("button", { name: /Compare Files/i }).click();

    await expect(page.getByText(/error|failed|invalid/i)).toBeVisible({ timeout: 10000 });
  });

  test("Date filter: enter dates and verify results filtered", async ({ page }) => {
    await page.route("**/api/reconciliation/compare", async (route) => {
      const postData = route.request().postData() ?? "";
      // Verify date params are sent
      expect(postData).toContain("dateStart");
      expect(postData).toContain("dateEnd");

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...MOCK_COMPARISON_RESULT,
          summary: "Filtered comparison result",
        }),
      });
    });

    const bankCsv = "Date,Description,Amount\n10/07/2026,Vendor A,150.00";
    const qbCsv = "Date,Description,Amount\n10/07/2026,Vendor A Invoice,150.00";

    await page.setInputFiles('label:has-text("Bank Statement") input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await page.setInputFiles('label:has-text("QuickBooks Export") input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(qbCsv),
    });

    // Enter date range
    await page.locator('input[type="date"]').first().fill("2026-07-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-07-31");

    await page.getByRole("button", { name: /Compare Files/i }).click();

    await expect(page.getByText("Filtered comparison result")).toBeVisible({ timeout: 10000 });
  });
});