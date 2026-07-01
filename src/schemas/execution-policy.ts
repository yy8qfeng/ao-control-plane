import { z } from "zod";

// Keep literal value types so the schema can enforce that policy fields equal these defaults.
export const defaultExecutionPolicy = {
  developerSelfTestRequired: true,
  qaRequired: true,
  regressionRequired: true,
  reviewerRequired: true,
  maxQaRounds: 3,
  maxReviewRounds: 3,
  requirePrOrRp: true
} as const;

const executionPolicyShape = {
  developerSelfTestRequired: z.literal(defaultExecutionPolicy.developerSelfTestRequired),
  qaRequired: z.literal(defaultExecutionPolicy.qaRequired),
  regressionRequired: z.literal(defaultExecutionPolicy.regressionRequired),
  reviewerRequired: z.literal(defaultExecutionPolicy.reviewerRequired),
  maxQaRounds: z.literal(defaultExecutionPolicy.maxQaRounds),
  maxReviewRounds: z.literal(defaultExecutionPolicy.maxReviewRounds),
  requirePrOrRp: z.literal(defaultExecutionPolicy.requirePrOrRp)
} satisfies z.ZodRawShape;

const executionPolicyObjectSchema = z.object(executionPolicyShape).strict();

// Use a custom refinement instead of plain z.object(...).strict() so callers get one actionable message
// listing all invalid or missing policy fields instead of many literal errors.
export const executionPolicySchema = z
  .unknown()
  .optional()
  .superRefine((value, context) => {
    if (value === undefined) {
      return;
    }
    const result = executionPolicyObjectSchema.safeParse(value);
    if (result.success) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executionPolicy"],
      message: `executionPolicy must equal defaultExecutionPolicy; invalid or missing fields: ${formatPolicyIssueFields(
        result.error.issues
      ).join(", ")}`
    });
  })
  .transform((value) => (value === undefined ? defaultExecutionPolicy : (value as typeof defaultExecutionPolicy)));

export function formatExecutionPolicyTemplate(): string {
  return JSON.stringify(defaultExecutionPolicy, null, 6);
}

function formatPolicyIssueFields(issues: z.ZodIssue[]): string[] {
  const fields = issues.flatMap((issue) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return issue.keys;
    }
    return typeof issue.path[0] === "string" ? [issue.path[0]] : [];
  });
  return fields.length > 0 ? [...new Set(fields)] : ["executionPolicy"];
}
