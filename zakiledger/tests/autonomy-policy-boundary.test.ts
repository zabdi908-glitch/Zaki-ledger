import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const policyFiles = [
  "lib/autonomy-policy-contract.ts",
  "lib/autonomy-policy-canonicalization.ts",
  "lib/autonomy-policy-evaluator.ts",
  "lib/autonomy-policy-store.ts",
];

describe("Step 7 foundation boundary", () => {
  it("keeps the evaluator pure and disconnected from providers, models, clocks, and execution", () => {
    const evaluator = readFileSync(join(root, "lib/autonomy-policy-evaluator.ts"), "utf8");
    expect(evaluator).not.toMatch(/Supabase|fetch\(|Date\.|new Date|provider-adapters|quickbooks|anthropic|openai|authoritative-posting|posting-store|dispatch|execute/i);
  });

  it("contains no provider, model, or posting integration in any policy foundation file", () => {
    const violations = policyFiles.flatMap((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return /from ["'][^"']*(?:provider-adapters|anthropic|openai|authoritative-posting-service|posting-gates|posting-store)["']/.test(source) ? [file] : [];
    });
    expect(violations).toEqual([]);
  });
});
