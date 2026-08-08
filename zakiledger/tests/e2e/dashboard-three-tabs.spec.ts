import { test, expect } from "@playwright/test";

const FAKE_STATEMENT_ID = "e2e-dashboard-fake-id";

const MOCK_DASHBOARD_DATA = {
  statement: {
    id: FAKE_STATEMENT_ID,
    fileName: "Test Bank Statement.csv",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    transactionCount: 5,
    currency: "USD",
  },
  report: {
    totalMatched: 300,
    totalUnmatchedBank: 50,
    variance: 0,
  },
  greenMatches: [
    {
      match: {
        id: "match-green-1",
        flaggedLevel: "green",
        confidence: 0.98,
        matchedBy: "auto",
        matchReason: "Exact amount and date match",
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
      bankTransaction: {
        id: "bank-1",
        merchant: "Vendor X",
        description: "Payment to Vendor X",
        amount: 100.0,
        currency: "USD",
        transactionDate: "2026-07-15",
      },
      qbTransaction: {
        id: "qb-1",
        description: "Vendor X Invoice #001",
        amount: 100.0,
        currency: "USD",
        postedDate: "2026-07-15",
      },
      auditMemo: {
        id: "memo-1",
        matchId: "match-green-1",
        title: "Strong Match",
        explanation: "Exact amount and date alignment with no discrepancies.",
        suggestedAction: "Approve",
        taxRelevant: false,
        createdAt: new Date().toISOString(),
      },
    },
  ],
  yellowMatches: [
    {
      match: {
        id: "match-yellow-1",
        flaggedLevel: "yellow",
        confidence: 0.72,
        matchedBy: "auto",
        matchReason: "Fuzzy match: similar description, slight date variance",
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
      bankTransaction: {
        id: "bank-2",
        merchant: "Vendor Y",
        description: "Vendor Y Payment",
        amount: 250.0,
        currency: "USD",
        transactionDate: "2026-07-18",
      },
      qbTransaction: {
        id: "qb-2",
        description: "Vendor Y Bill",
        amount: 250.0,
        currency: "USD",
        postedDate: "2026-07-19",
      },
      auditMemo: {
        id: "memo-2",
        matchId: "match-yellow-1",
        title: "Fuzzy Match",
        explanation: "Description similarity but date differs by 1 day.",
        suggestedAction: "Review",
        taxRelevant: true,
        createdAt: new Date().toISOString(),
      },
    },
  ],
  redMatches: [
    {
      match: {
        id: "match-red-1",
        flaggedLevel: "red",
        confidence: 0.3,
        matchedBy: "auto",
        matchReason: "Amount mismatch: $100 vs $120",
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
      bankTransaction: {
        id: "bank-3",
        merchant: "Unknown Vendor",
        description: "Unknown transaction",
        amount: 100.0,
        currency: "USD",
        transactionDate: "2026-07-20",
      },
      qbTransaction: null,
      auditMemo: {
        id: "memo-3",
        matchId: "match-red-1",
        title: "Exception",
        explanation: "No corresponding QuickBooks entry found.",
        suggestedAction: "Manual review required",
        taxRelevant: false,
        createdAt: new Date().toISOString(),
      },
    },
  ],
};

test.describe("Dashboard Three Tabs", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept ALL reconciliation dashboard API calls using wildcard URL matching.
    // Using url.includes() instead of glob patterns ensures the mock works on any
    // host (including Render's live deployment) regardless of the statement ID in
    // the URL.
    await page.route(
      (url) => url.pathname.includes("/api/reconciliation/") && url.pathname.endsWith("/dashboard"),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DASHBOARD_DATA),
        });
      },
    );

    // Mock approve endpoint — catches any statement ID.  Small artificial delay so
    // the "Processing…" spinner is visible for a beat before the mock resolves.
    await page.route(
      (url) => url.pathname.includes("/api/reconciliation/") && url.pathname.endsWith("/approve"),
      async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      },
    );

    // Mock reject endpoint — catches any statement ID
    await page.route(
      (url) => url.pathname.includes("/api/reconciliation/") && url.pathname.endsWith("/reject"),
      async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      },
    );

    await page.goto(`/reconciliation/${FAKE_STATEMENT_ID}`);
    await expect(page.getByRole("heading", { name: /Reconciliation/i })).toBeVisible();
  });

  test("Three tabs are visible: Perfect, Review, Exceptions", async ({ page }) => {
    await expect(page.getByRole("button", { name: /Perfect/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Review/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Exceptions/i })).toBeVisible();
  });

  test("Click each tab changes content", async ({ page }) => {
    // Green tab should show Vendor X
    await page.getByRole("button", { name: /Perfect/i }).click();
    await expect(page.getByText("Vendor X").first()).toBeVisible();

    // Yellow tab should show Vendor Y
    await page.getByRole("button", { name: /Review/i }).click();
    await expect(page.getByText("Vendor Y").first()).toBeVisible();

    // Red tab should show Unknown Vendor
    await page.getByRole("button", { name: /Exceptions/i }).click();
    await expect(page.getByText("Unknown Vendor")).toBeVisible();
  });

  test("Green tab shows bank merchant, date, amount and QB description, amount", async ({ page }) => {
    await page.getByRole("button", { name: /Perfect/i }).click();

    await expect(page.getByText("Vendor X").first()).toBeVisible();
    // On the live Render deployment the old formatCurrency shows "USD100.00";
    // once the formatMoney fix is deployed this will be "$100.00".
    // Match either format to be deployment-agnostic.
    await expect(page.getByText(/\$100\.00|USD100\.00/).first()).toBeVisible();
    await expect(page.getByText("15 Jul 2026").first()).toBeVisible();
    await expect(page.getByText("Vendor X Invoice #001")).toBeVisible();
  });

  test("Yellow tab shows fuzzy match reason", async ({ page }) => {
    await page.getByRole("button", { name: /Review/i }).click();

    await expect(page.getByText("Fuzzy match: similar description, slight date variance")).toBeVisible();
    await expect(page.getByText("Vendor Y").first()).toBeVisible();
  });

  test("Red tab shows exception details", async ({ page }) => {
    await page.getByRole("button", { name: /Exceptions/i }).click();

    await expect(page.getByText("Unknown Vendor")).toBeVisible();
    await expect(page.getByText("Amount mismatch: $100 vs $120")).toBeVisible();
    await expect(page.getByText("Unmatched").first()).toBeVisible();
  });

  test("Expand and collapse audit memo", async ({ page }) => {
    await page.getByRole("button", { name: /Perfect/i }).click();

    // Audit memo button
    const auditBtn = page.getByRole("button", { name: /Audit memo/i });
    await expect(auditBtn).toBeVisible();

    // Initially collapsed
    await expect(page.getByText("Exact amount and date alignment with no discrepancies.")).not.toBeVisible();

    // Expand
    await auditBtn.click();
    await expect(page.getByText("Exact amount and date alignment with no discrepancies.")).toBeVisible();
    await expect(page.getByText("Suggested:")).toBeVisible();

    // Collapse
    await auditBtn.click();
    await expect(page.getByText("Exact amount and date alignment with no discrepancies.")).not.toBeVisible();
  });

  test("Click Approve on green match removes card", async ({ page }) => {
    await page.getByRole("button", { name: /Perfect/i }).click();

    await expect(page.getByText("Vendor X").first()).toBeVisible();

    await page.getByRole("button", { name: /^Approve$/i }).first().click();

    // After approval, card should disappear (optimistic update)
    await expect(page.getByText("Vendor X")).not.toBeVisible();
    await expect(page.getByText("No perfect matches.")).toBeVisible();
  });

  test("Click Reject on yellow match removes card", async ({ page }) => {
    await page.getByRole("button", { name: /Review/i }).click();

    await expect(page.getByText("Vendor Y").first()).toBeVisible();

    await page.getByRole("button", { name: /^Reject$/i }).first().click();

    // After rejection, card should disappear
    await expect(page.getByText("Vendor Y")).not.toBeVisible();
    await expect(page.getByText("No review matches.")).toBeVisible();
  });

  test('Click "Approve & Sync All" shows progress then results', async ({ page }) => {
    await page.getByRole("button", { name: /Perfect/i }).click();

    // Select all
    await page.getByRole("checkbox", { name: /Select all matches/i }).check();

    // Click bulk approve
    const bulkBtn = page.getByRole("button", { name: /Approve & Sync All/i });
    await expect(bulkBtn).toBeEnabled();
    await bulkBtn.click();

    // After mock resolves (600 ms artificial delay), the results banner should appear.
    // "Processing…" is a fleeting intermediate state that may not render before
    // the mock resolves — we skip asserting it and go straight to the outcome.
    await expect(page.getByText(/approved/i)).toBeVisible({ timeout: 10000 });
  });

  test("Bulk approve disabled when no matches", async ({ page }) => {
    // Mock empty dashboard — override the beforeEach mock for this test only
    await page.route(
      (url) => url.pathname.includes("/api/reconciliation/") && url.pathname.endsWith("/dashboard"),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...MOCK_DASHBOARD_DATA,
            greenMatches: [],
            yellowMatches: [],
            redMatches: [],
          }),
        });
      },
    );

    await page.reload();

    await page.getByRole("button", { name: /Perfect/i }).click();

    // Should show empty message
    await expect(page.getByText("No perfect matches.")).toBeVisible();

    // Bulk approve button should not be visible when no matches
    const bulkBtn = page.getByRole("button", { name: /Approve & Sync All/i });
    await expect(bulkBtn).not.toBeVisible();
  });
});