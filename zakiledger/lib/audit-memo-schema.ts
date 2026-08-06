import { z } from "zod/v4";

export const AuditCategorySchema = z.enum([
  "PERFECT_MATCH",
  "FUZZY_MERCHANT",
  "FUZZY_AMOUNT",
  "FUZZY_DATE",
  "TAX_MISMATCH",
  "DUPLICATE_WARNING",
  "UNMATCHED",
]);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

export const AuditSeveritySchema = z.enum(["info", "warning", "critical"]);
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>;

export const AuditMemoSchema = z.object({
  matchId: z.string(),
  category: AuditCategorySchema,
  severity: AuditSeveritySchema,
  title: z.string(),
  explanation: z.string(),
  suggestedAction: z.string(),
  taxRelevant: z.boolean(),
  ruleReference: z.string(),
  matchedFields: z.array(z.string()),
  mismatchedFields: z.array(z.string()),
});
export type AuditMemo = z.infer<typeof AuditMemoSchema>;

export const AuditMemoBatchSchema = z.array(AuditMemoSchema);
export type AuditMemoBatch = z.infer<typeof AuditMemoBatchSchema>;