import { test, expect } from "@playwright/test";

const MOCK_DOCUMENTS = [
  {
    id: "doc-review-1",
    documentType: "invoice",
    merchantName: "Test Merchant",
    invoiceNumber: "INV-101",
    invoiceDate: "2026-07-15",
    currency: "USD",
    total: 330.0,
    subtotal: 300.0,
    tax: 30.0,
    overallConfidence: 0.85,
    perFieldConfidence: { merchantName: 0.9, invoiceNumber: 0.8, total: 0.85, subtotal: 0.85, tax: 0.8 },
  },
  {
    id: "doc-review-2",
    documentType: "invoice",
    merchantName: "Mismatch Corp",
    invoiceNumber: "INV-102",
    invoiceDate: "2026-07-20",
    currency: "USD",
    total: 500.0,
    subtotal: 400.0,
    tax: 50.0,
    overallConfidence: 0.75,
    perFieldConfidence: { merchantName: 0.8, invoiceNumber: 0.7, total: 0.75, subtotal: 0.7, tax: 0.65 },
  },
];

const MOCK_EXTRACTION = {
  supplierName: { value: "Test Merchant", confidence: 0.9 },
  invoiceNumber: { value: "INV-101", confidence: 0.8 },
  invoiceDate: { value: "2026-07-15", confidence: 0.85 },
  currency: { value: "USD", confidence: 0.95 },
  subtotal: { value: 300, confidence: 0.85 },
  tax: { value: 30, confidence: 0.8 },
  total: { value: 330, confidence: 0.85 },
};

const MOCK_EXTRACTION_MISMATCH = {
  supplierName: { value: "Mismatch Corp", confidence: 0.8 },
  invoiceNumber: { value: "INV-102", confidence: 0.7 },
  invoiceDate: { value: "2026-07-20", confidence: 0.75 },
  currency: { value: "USD", confidence: 0.9 },
  subtotal: { value: 400, confidence: 0.7 },
  tax: { value: 50, confidence: 0.65 },
  total: { value: 500, confidence: 0.75 },
};

test.describe("Review & Edit", () => {
  test.beforeEach(async ({ page }) => {
    // Use function-based URL matchers (url.pathname) so the mocks work on
    // every deployment — "**/" glob prefixes often fail to match on Render.
    await page.route(
      (url) => url.pathname === "/api/pending",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ documents: MOCK_DOCUMENTS }),
        });
      },
    );

    await page.route(
      (url) => url.pathname === "/api/pending/doc-review-1",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ extraction: MOCK_EXTRACTION }),
        });
      },
    );

    await page.route(
      (url) => url.pathname === "/api/pending/doc-review-2",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ extraction: MOCK_EXTRACTION_MISMATCH }),
        });
      },
    );

    await page.route(
      (url) => url.pathname === "/api/approve",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "approved" }),
        });
      },
    );

    await page.goto("/review");
    await expect(page.getByRole("heading", { name: /Review & Edit/i })).toBeVisible();
  });

  test("Extracted documents are shown", async ({ page }) => {
    await expect(page.getByText("Test Merchant")).toBeVisible();
    await expect(page.getByText("Mismatch Corp")).toBeVisible();
  });

  test("Click a document expands fields", async ({ page }) => {
    // Click on the document card to expand
    await page.getByText("Test Merchant").first().click();

    // Panel should show extraction details
    await expect(page.getByText("Extraction check")).toBeVisible();
    await expect(page.getByText("Field confidence")).toBeVisible();
  });

  test("Edit a field and verify save works", async ({ page }) => {
    // Click on the document card
    await page.getByText("Test Merchant").first().click();
    await expect(page.getByText("Field confidence")).toBeVisible();

    // Find the merchant name input and edit it
    const input = page.locator('input[value="Test Merchant"]').first();
    await expect(input).toBeVisible();

    await input.fill("Updated Merchant");
    await input.blur();

    // Should show toast confirming save
    await expect(page.locator("div").filter({ hasText: /corrected|saved/i }).first()).toBeVisible({ timeout: 5000 });
  });

  test("Confidence badges visible per field", async ({ page }) => {
    await page.getByText("Test Merchant").first().click();
    await expect(page.getByText("Field confidence")).toBeVisible();

    // Check for percentage indicators — use .first() to avoid strict-mode
    // violations when text (e.g. "80%") also appears inside helper copy like
    // "Every critical field cleared 80%+ confidence..."
    await expect(page.getByText(/90%/).first()).toBeVisible();
    await expect(page.getByText(/80%/).first()).toBeVisible();
    await expect(page.getByText(/85%/).first()).toBeVisible();
  });

  test("Math mismatch warning visible when subtotal + tax != total", async ({ page }) => {
    // Navigate to the mismatch document
    await page.getByText("Mismatch Corp").first().click();

    await expect(page.getByText("Extraction check")).toBeVisible();

    // Should show mismatch warning (400 + 50 = 450, but total is 500)
    const warningText = page.locator("div").filter({ hasText: /doesn't match|Numbers don't add up|Subtotal \\+ tax/i });
    await expect(warningText.first()).toBeVisible();
  });
});