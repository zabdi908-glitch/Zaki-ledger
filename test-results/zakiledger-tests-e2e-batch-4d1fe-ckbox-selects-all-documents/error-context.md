# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: zakiledger\tests\e2e\batch-review.spec.ts >> Batch Review >> Select all checkbox selects all documents
- Location: zakiledger\tests\e2e\batch-review.spec.ts:78:7

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/batch", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | 
  3   | const MOCK_DOCUMENTS = [
  4   |   {
  5   |     id: "doc-1",
  6   |     documentType: "invoice",
  7   |     merchantName: "Acme Corp",
  8   |     invoiceNumber: "INV-001",
  9   |     invoiceDate: "2026-07-01",
  10  |     currency: "USD",
  11  |     total: 250.0,
  12  |     subtotal: 200.0,
  13  |     tax: 50.0,
  14  |     overallConfidence: 0.92,
  15  |     perFieldConfidence: { merchantName: 0.95, total: 0.9 },
  16  |   },
  17  |   {
  18  |     id: "doc-2",
  19  |     documentType: "receipt",
  20  |     merchantName: "Beta Supplies",
  21  |     invoiceNumber: "REC-002",
  22  |     invoiceDate: "2026-07-05",
  23  |     currency: "USD",
  24  |     total: 120.0,
  25  |     subtotal: 100.0,
  26  |     tax: 20.0,
  27  |     overallConfidence: 0.65,
  28  |     perFieldConfidence: { merchantName: 0.7, total: 0.6 },
  29  |   },
  30  |   {
  31  |     id: "doc-3",
  32  |     documentType: "invoice",
  33  |     merchantName: "Gamma Ltd",
  34  |     invoiceNumber: "INV-003",
  35  |     invoiceDate: "2026-07-10",
  36  |     currency: "USD",
  37  |     total: 500.0,
  38  |     subtotal: 400.0,
  39  |     tax: 100.0,
  40  |     overallConfidence: 0.88,
  41  |     perFieldConfidence: { merchantName: 0.9, total: 0.85 },
  42  |   },
  43  | ];
  44  | 
  45  | test.describe("Batch Review", () => {
  46  |   test.beforeEach(async ({ page }) => {
  47  |     await page.route("**/api/pending", async (route) => {
  48  |       await route.fulfill({
  49  |         status: 200,
  50  |         contentType: "application/json",
  51  |         body: JSON.stringify({ documents: MOCK_DOCUMENTS }),
  52  |       });
  53  |     });
  54  | 
  55  |     await page.route("**/api/approve/bulk", async (route) => {
  56  |       const body = await route.request().postDataJSON();
  57  |       const results = (body.documentIds as string[]).map((id) => ({
  58  |         status: "approved",
  59  |         merchantName: MOCK_DOCUMENTS.find((d) => d.id === id)?.merchantName ?? "",
  60  |       }));
  61  |       await route.fulfill({
  62  |         status: 200,
  63  |         contentType: "application/json",
  64  |         body: JSON.stringify({ results }),
  65  |       });
  66  |     });
  67  | 
> 68  |     await page.goto("/batch");
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  69  |     await expect(page.getByRole("heading", { name: /Batch Review/i })).toBeVisible();
  70  |   });
  71  | 
  72  |   test("Documents are listed", async ({ page }) => {
  73  |     await expect(page.getByText("Acme Corp")).toBeVisible();
  74  |     await expect(page.getByText("Beta Supplies")).toBeVisible();
  75  |     await expect(page.getByText("Gamma Ltd")).toBeVisible();
  76  |   });
  77  | 
  78  |   test("Select all checkbox selects all documents", async ({ page }) => {
  79  |     const selectAllCheckbox = page.locator('input[type="checkbox"]').first();
  80  | 
  81  |     // Initially unchecked
  82  |     await expect(selectAllCheckbox).not.toBeChecked();
  83  | 
  84  |     // Check all
  85  |     await selectAllCheckbox.check();
  86  |     await expect(selectAllCheckbox).toBeChecked();
  87  | 
  88  |     // All row checkboxes should be checked
  89  |     const allRowCheckboxes = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator("div") });
  90  |     const checkedCount = await allRowCheckboxes.evaluateAll((els) => els.filter((el) => (el as HTMLInputElement).checked).length);
  91  |     expect(checkedCount).toBeGreaterThanOrEqual(3);
  92  | 
  93  |     // Bulk approve button should show count
  94  |     await expect(page.getByRole("button", { name: /Approve selected \(\d+\)/i })).toBeVisible();
  95  |   });
  96  | 
  97  |   test("Bulk approve selected shows progress then success state", async ({ page }) => {
  98  |     // Select all
  99  |     await page.locator('input[type="checkbox"]').first().check();
  100 | 
  101 |     const bulkApproveBtn = page.getByRole("button", { name: /Approve selected/i });
  102 |     await expect(bulkApproveBtn).toBeEnabled();
  103 | 
  104 |     await bulkApproveBtn.click();
  105 | 
  106 |     // Should show toast
  107 |     await expect(page.locator("div").filter({ hasText: /\d+ item?s? approved/i }).first()).toBeVisible({ timeout: 5000 });
  108 |   });
  109 | 
  110 |   test("Deselect individual items updates bulk button", async ({ page }) => {
  111 |     // Select all
  112 |     await page.locator('input[type="checkbox"]').first().check();
  113 | 
  114 |     const bulkApproveBtn = page.getByRole("button", { name: /Approve selected \(\d+\)/i });
  115 |     await expect(bulkApproveBtn).toBeEnabled();
  116 | 
  117 |     // Deselect first row
  118 |     const rowCheckboxes = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator("div") });
  119 |     await rowCheckboxes.nth(0).uncheck();
  120 | 
  121 |     // Button should still be enabled with updated count
  122 |     await expect(bulkApproveBtn).toBeEnabled();
  123 | 
  124 |     // Deselect all remaining
  125 |     const count = await rowCheckboxes.count();
  126 |     for (let i = 1; i < count; i++) {
  127 |       await rowCheckboxes.nth(i).uncheck();
  128 |     }
  129 | 
  130 |     // Button should now be disabled
  131 |     await expect(page.getByRole("button", { name: /Approve selected \(0\)/i })).toBeDisabled();
  132 |   });
  133 | });
```