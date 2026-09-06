import { createHash } from "node:crypto";

function canonicalString(value: string): string {
  return JSON.stringify(value);
}

/** Deterministic JSON used only for audit and correction identity material. */
export function canonicalAuditJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return canonicalString(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("audit canonical numbers must be finite safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalAuditJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`unsupported audit canonical value: ${typeof value}`);
}

export function auditSha256(value: unknown): string {
  return createHash("sha256").update(canonicalAuditJson(value), "utf8").digest("hex");
}
