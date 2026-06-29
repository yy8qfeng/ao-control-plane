import { z } from "zod";

export const workflowStatusSchema = z.enum([
  "draft",
  "designing",
  "design_reviewing",
  "design_revising",
  "ready_for_planning",
  "planning",
  "executing",
  "blocked_for_human",
  "completed",
  "failed"
]);

export const workflowSchema = z.object({
  workflowId: z.string().min(1),
  title: z.string().min(1),
  rawRequirement: z.string().min(1),
  status: workflowStatusSchema,
  designRounds: z.number().int().nonnegative().default(0),
  maxDesignReviewRounds: z.number().int().positive().default(3),
  approvedDesignVersion: z.string().min(1).optional(),
  tasks: z.array(z.string().min(1)).default([])
});

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
