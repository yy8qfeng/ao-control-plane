import { z } from "zod";

export const defaultExecutionPolicy = {
  developerSelfTestRequired: true,
  qaRequired: true,
  regressionRequired: true,
  reviewerRequired: true,
  maxQaRounds: 3,
  maxReviewRounds: 3,
  requirePrOrRp: true
} as const;

export interface ExecutionPolicy {
  developerSelfTestRequired: boolean;
  qaRequired: boolean;
  regressionRequired: boolean;
  reviewerRequired: boolean;
  maxQaRounds: 1 | 2 | 3;
  maxReviewRounds: 1 | 2 | 3;
  requirePrOrRp: boolean;
}

export const executionPolicyByTaskType = {
  implementation: defaultExecutionPolicy,
  test: {
    developerSelfTestRequired: true,
    qaRequired: true,
    regressionRequired: true,
    reviewerRequired: true,
    maxQaRounds: 3,
    maxReviewRounds: 2,
    requirePrOrRp: true
  },
  verification: {
    developerSelfTestRequired: false,
    qaRequired: true,
    regressionRequired: true,
    reviewerRequired: true,
    maxQaRounds: 3,
    maxReviewRounds: 2,
    requirePrOrRp: true
  },
  design: {
    developerSelfTestRequired: true,
    qaRequired: false,
    regressionRequired: false,
    reviewerRequired: true,
    maxQaRounds: 1,
    maxReviewRounds: 3,
    requirePrOrRp: true
  },
  review: {
    developerSelfTestRequired: false,
    qaRequired: false,
    regressionRequired: false,
    reviewerRequired: true,
    maxQaRounds: 1,
    maxReviewRounds: 3,
    requirePrOrRp: true
  },
  docs: {
    developerSelfTestRequired: true,
    qaRequired: true,
    regressionRequired: false,
    reviewerRequired: true,
    maxQaRounds: 2,
    maxReviewRounds: 2,
    requirePrOrRp: true
  },
  refactor: defaultExecutionPolicy
} satisfies Record<string, ExecutionPolicy>;

const executionPolicyShape = {
  developerSelfTestRequired: z.boolean(),
  qaRequired: z.boolean(),
  regressionRequired: z.boolean(),
  reviewerRequired: z.boolean(),
  maxQaRounds: z.number().int().min(1).max(3),
  maxReviewRounds: z.number().int().min(1).max(3),
  requirePrOrRp: z.boolean()
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
      message: `executionPolicy must be complete and valid; invalid or missing fields: ${formatPolicyIssueFields(
        result.error.issues
      ).join(", ")}`
    });
  })
  .transform(parseExecutionPolicy);

export function formatExecutionPolicyTemplate(): string {
  return JSON.stringify(executionPolicyByTaskType, null, 6);
}

export function getExecutionPolicyForTaskType(type: keyof typeof executionPolicyByTaskType): ExecutionPolicy {
  return executionPolicyByTaskType[type];
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

function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  if (value === undefined) {
    return defaultExecutionPolicy;
  }

  const result = executionPolicyObjectSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid executionPolicy reached transform after schema refinement");
  }

  return result.data as ExecutionPolicy;
}
