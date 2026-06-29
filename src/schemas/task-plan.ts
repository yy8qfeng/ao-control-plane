import { z } from "zod";
import { aoRoleSchema } from "./ao-role.js";

const forbiddenExecutionFields = ["agent", "model", "provider", "codex", "claudeCode"] as const;
const agentSelectionPromptPatterns = [
  /--agent\b/i,
  /\b(agent|model)\s*[:=]/i,
  /\b(use|switch\s+to|run\s+with|invoke)\s+(codex|claude[- ]?code|claudecode)\b/i,
  /(切换|使用|指定).*(codex|claude[- ]?code|claudecode|agent|model)/i
] as const;

export const taskTypeSchema = z.enum([
  "design",
  "implementation",
  "test",
  "refactor",
  "review",
  "docs",
  "verification"
]);

export const dependencyConditionSchema = z.enum(["all_completed", "any_completed", "manual_gate"]);

export const taskStatusSchema = z.enum([
  "pending",
  "working",
  "completed",
  "blocked_for_human",
  "failed"
]);

export const executionTaskSchema = z
  .object({
    taskId: z.string().min(1),
    workflowId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    type: taskTypeSchema,
    dependencies: z.array(z.string().min(1)).default([]),
    dependencyCondition: dependencyConditionSchema.default("all_completed"),
    aoRole: aoRoleSchema,
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    aoPrompt: z.string().min(1),
    status: taskStatusSchema.default("pending"),
    aoSessionId: z.string().min(1).optional()
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

    for (const pattern of agentSelectionPromptPatterns) {
      if (pattern.test(task.aoPrompt)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aoPrompt"],
          message: "aoPrompt must not ask AO workers to select or switch concrete agents or models"
        });
        break;
      }
    }
  });

export const taskPlanSchema = z.object({
  workflowId: z.string().min(1),
  title: z.string().min(1),
  tasks: z.array(executionTaskSchema).min(1)
});

export type ExecutionTask = z.infer<typeof executionTaskSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
