import { z } from "zod";
import { reviewFindingSeveritySchema, reviewFindingStatusSchema } from "./design-review.js";

export const taskPlanReviewDecisionSchema = z.enum(["approved", "changes_requested"]);

export const taskPlanReviewFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: reviewFindingSeveritySchema,
  status: reviewFindingStatusSchema.default("unresolved"),
  rationale: z.string().optional()
});

export const taskPlanReviewSchema = z
  .object({
    workflowId: z.string().min(1),
    round: z.number().int().positive(),
    planner: z.literal("codex").default("codex"),
    reviewer: z.literal("claude-code").default("claude-code"),
    planVersion: z.string().min(1),
    reviewDecision: taskPlanReviewDecisionSchema,
    findings: z.array(taskPlanReviewFindingSchema)
  })
  .superRefine((review, context) => {
    const hasUnresolvedFinding = review.findings.some((finding) => finding.status === "unresolved");

    if (review.reviewDecision === "approved" && hasUnresolvedFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDecision"],
        message: "approved task plan reviews cannot contain unresolved findings"
      });
    }

    if (review.reviewDecision === "changes_requested" && !hasUnresolvedFinding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDecision"],
        message: "changes_requested task plan reviews must leave at least one finding unresolved"
      });
    }
  });

export type TaskPlanReview = z.infer<typeof taskPlanReviewSchema>;
