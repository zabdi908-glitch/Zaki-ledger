import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "lib", "orchestration");

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const target = join(path, name);
    return statSync(target).isDirectory() ? files(target) : target.endsWith(".ts") ? [target] : [];
  });
}

describe("Step 9 static posting boundary", () => {
  it("contains no posting/execution/provider runtime dependency or network mutation verb", () => {
    const violations: string[] = [];
    for (const file of files(root)) {
      const source = readFileSync(file, "utf8");
      const banned = [
        /from\s+["'][^"']*(?:authoritative-posting-service|posting-store|quickbooks-execution-store|quickbooks-vendor-execution-store)["']/,
        /from\s+["'][^"']*provider-adapters\//,
        /\b(?:postApprovedBill|executeQuickBooksBill|executeQuickBooksVendor|PostingActor)\b/,
        /\.from\(\s*["'](?:posting_operations|posting_attempts|provider_posting_bindings)["']\s*\)/,
        /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/,
      ];
      for (const pattern of banned) if (pattern.test(source)) {
        violations.push(`${relative(process.cwd(), file)}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
