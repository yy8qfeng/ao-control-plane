import { z } from "zod";

export const reviewFindingSeveritySchema = z.enum(["blocking", "major", "minor", "observation"]);
export const reviewFindingDecisionSchema = z.enum(["addressed", "accepted_as_is", "unresolved"]);
export const designReviewConclusionSchema = z.enum(["approved", "needs_revision"]);

export const designReviewFindingSchema = z.object({
  id: z.string().min(1),
  severity: reviewFindingSeveritySchema,
  title: z.string().min(1),
  recommendation: z.string().min(1),
  decision: reviewFindingDecisionSchema.default("unresolved"),
  rationale: z.string().optional()
});

export const designReviewSchema = z.object({
  requirementId: z.string().min(1),
  round: z.number().int().positive(),
  conclusion: designReviewConclusionSchema,
  findings: z.array(designReviewFindingSchema)
});

export type DesignReview = z.infer<typeof designReviewSchema>;
