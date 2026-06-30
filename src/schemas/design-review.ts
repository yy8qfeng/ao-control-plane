import { z } from "zod";

export const reviewFindingSeveritySchema = z.enum([
  "blocking",
  "major",
  "minor",
  "warning",
  "observation"
]);
export const reviewFindingStatusSchema = z.enum(["addressed", "accepted_as_is", "unresolved"]);
export const designReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "defer_to_implementation"
]);

export const designReviewFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: reviewFindingSeveritySchema,
  status: reviewFindingStatusSchema.default("unresolved"),
  rationale: z.string().optional()
});

export const designReviewSchema = z
  .object({
    workflowId: z.string().min(1),
    round: z.number().int().positive(),
    designer: z.literal("codex").default("codex"),
    reviewer: z.literal("claude-code").default("claude-code"),
    designVersion: z.string().min(1),
    reviewDecision: designReviewDecisionSchema,
    findings: z.array(designReviewFindingSchema)
  })
  .superRefine((review, context) => {
    const hasUnresolvedFinding = review.findings.some((finding) => finding.status === "unresolved");

    if (review.reviewDecision === "approved" && hasUnresolvedFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDecision"],
        message: "approved reviews cannot contain unresolved findings"
      });
    }

    if (review.reviewDecision === "changes_requested" && !hasUnresolvedFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDecision"],
        message: "changes_requested reviews must leave at least one finding unresolved"
      });
    }

    if (review.reviewDecision === "defer_to_implementation" && !hasUnresolvedFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDecision"],
        message: "defer_to_implementation reviews must leave at least one finding unresolved"
      });
    }
  });

export type DesignReview = z.infer<typeof designReviewSchema>;
