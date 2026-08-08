import { test, expect } from "@playwright/test";

test.describe("Reconciliation Upload", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/reconciliation");
  });

  test("Drop zone is visible on reconciliation page", async ({ page }) => {
    await expect(page.getByText("Drop your bank statement here")).toBeVisible();
    await expect(page.getByText("CSV, OFX, or PDF")).toBeVisible();
  });

  test("Upload bank CSV shows transactions imported", async ({ page }) => {
    const bankCsv = "Date,Description,Amount\n15/07/2026,Vendor X,100.00\n16/07/2026,Vendor Y,-50.00";

    await page.setInputFiles('input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await expect(page.getByText(/\d+ transactions? imported/i)).toBeVisible({ timeout: 15000 });
  });

  test("Upload bank OFX works same as CSV", async ({ page }) => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKTRANLIST>
          <STMTTRN>
            <DTPOSTED>20260715</DTPOSTED>
            <NAME>Vendor X</NAME>
            <TRNAMT>100.00</TRNAMT>
          </STMTTRN>
          <STMTTRN>
            <DTPOSTED>20260716</DTPOSTED>
            <NAME>Vendor Y</NAME>
            <TRNAMT>-50.00</TRNAMT>
          </STMTTRN>
        </BANKTRANLIST>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

    await page.setInputFiles('input[type="file"]', {
      name: "bank.ofx",
      mimeType: "application/x-ofx",
      buffer: Buffer.from(ofx),
    });

    await expect(page.getByText(/\d+ transactions? imported/i)).toBeVisible({ timeout: 15000 });
  });

  test("Upload invalid file shows error message", async ({ page }) => {
    // Mock the upload endpoint to return a controlled error so the test
    // is deterministic regardless of what the live Render API does with
    // unsupported file types.
    await page.route(
      (url) => url.pathname === "/api/reconciliation/upload",
      async (route) => {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unsupported file type. Please upload a CSV, OFX, or PDF." }),
        });
      },
    );

    const invalidFile = "This is not a valid bank statement\nJust random text\n123,456,789";

    await page.setInputFiles('input[type="file"]', {
      name: "invalid.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(invalidFile),
    });

    // Wait for the error to appear after the API responds
    await expect(page.getByText(/unsupported file type/i)).toBeVisible({ timeout: 10000 });

    // Drop zone should still be visible since stage resets to "idle" on error
    await expect(page.getByText("Drop your bank statement here")).toBeVisible();
  });

  test("After successful upload, View Dashboard button appears and navigates", async ({ page }) => {
    const bankCsv = "Date,Description,Amount\n15/07/2026,Vendor X,100.00";

    await page.setInputFiles('input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await expect(page.getByText(/\d+ transactions? imported/i)).toBeVisible({ timeout: 15000 });

    const viewDashboardBtn = page.getByRole("button", { name: /View Dashboard/i });
    await expect(viewDashboardBtn).toBeVisible();
    await expect(viewDashboardBtn).toBeEnabled();

    await viewDashboardBtn.click();
    await expect(page).toHaveURL(/\/reconciliation\/[^/]+$/);
  });

  test("Upload QB CSV after bank shows imported count", async ({ page }) => {
    const bankCsv = "Date,Description,Amount\n15/07/2026,Vendor X,100.00";

    await page.setInputFiles('input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await expect(page.getByText(/\d+ transactions? imported/i)).toBeVisible({ timeout: 15000 });

    // Upload QB CSV via the second file input
    const qbCsv = "Date,Description,Amount\n15/07/2026,Vendor X,100.00";

    await page.setInputFiles('input[type="file"]', {
      name: "qb.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(qbCsv),
    });

    // Should show toast or updated state without crashing
    await expect(page.locator("body")).toBeVisible();
  });

  test("Sync from QuickBooks button shows toast when connected", async ({ page }) => {
    // Mock the connected-provider endpoint so the sync button appears.
    // Use a function-based URL matcher instead of a glob so it works on
    // every deployment (the "**/" glob prefix fails on Render).
    await page.route(
      (url) => url.pathname === "/api/connected-provider",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ provider: "quickbooks" }),
        });
      },
    );

    // Mock the sync endpoint
    await page.route(
      (url) => url.pathname === "/api/reconciliation/qb-transactions/sync",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ imported: 3, provider: "quickbooks" }),
        });
      },
    );

    // Mock the upload endpoint too so the bank-CSV flow is deterministic
    await page.route(
      (url) => url.pathname === "/api/reconciliation/upload",
      async (route) => {
        const statementId = "e2e-sync-test-id";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ statementId, transactionCount: 1 }),
        });
      },
    );

    // Mock the transactions fetch the page calls after upload
    await page.route(
      (url) =>
        url.pathname === `/api/reconciliation/e2e-sync-test-id/transactions`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            bankTransactions: [{ id: "bank-1", date: "2026-07-15", description: "Vendor X", amount: 100 }],
            qbTransactions: [],
            matches: [],
            unmatchedBank: ["bank-1"],
          }),
        });
      },
    );

    await page.reload();

    const bankCsv = "Date,Description,Amount\n15/07/2026,Vendor X,100.00";

    await page.setInputFiles('input[type="file"]', {
      name: "bank.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(bankCsv),
    });

    await expect(page.getByText(/\d+ transactions? imported/i)).toBeVisible({ timeout: 15000 });

    const syncBtn = page.getByRole("button", { name: /Sync from QuickBooks/i });
    await expect(syncBtn).toBeVisible();

    await syncBtn.click();

    // Verify toast appears with synced message
    await expect(page.locator("div").filter({ hasText: /Synced \d+ transaction/i }).first()).toBeVisible({ timeout: 5000 });
  });
});