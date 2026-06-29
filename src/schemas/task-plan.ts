import { z } from "zod";
import { aoRoleSchema } from "./ao-role.js";

const forbiddenExecutionFields = ["agent", "model", "provider", "codex", "claudeCode"] as const;

export const taskTypeSchema = z.enum([
  "analysis",
  "design",
  "development",
  "test",
  "review",
  "documentation",
  "release"
]);

export const dependencyConditionSchema = z.enum(["all_completed", "any_completed", "manual_gate"]);

export const executionTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    type: taskTypeSchema,
    aoRole: aoRoleSchema,
    prompt: z.string().min(1),
    dependencies: z.array(z.string().min(1)).default([]),
    dependencyCondition: dependencyConditionSchema.default("all_completed"),
    manualGate: z
      .object({
        required: z.boolean(),
        reason: z.string().min(1)
      })
      .optional()
  })
  .passthrough()
  .superRefine((task, context) => {
    for (const field of forbiddenExecutionFields) {
      if (field in task) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Execution tasks must use aoRole only; forbidden field: ${field}`
        });
      }
    }
  });

export const taskPlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  tasks: z.array(executionTaskSchema).min(1)
});

export type ExecutionTask = z.infer<typeof executionTaskSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
