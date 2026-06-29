import { z } from "zod";
import { requirementSchema, type Requirement } from "./requirement.js";

export const requirementInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  source: z.string().min(1).default("cli"),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  maxDesignReviewRounds: z.number().int().positive().default(3)
});

export type RequirementInput = z.infer<typeof requirementInputSchema>;

export function buildRequirementFromInput(input: RequirementInput): Requirement {
  return requirementSchema.parse({
    id: input.id ?? createWorkflowId(),
    title: input.title,
    source: input.source,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints
  });
}

function createWorkflowId(): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `WF-${timestamp}`;
}
