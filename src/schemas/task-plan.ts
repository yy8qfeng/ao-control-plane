import { z } from "zod";
import { aoRoleSchema } from "./ao-role.js";
import { executionPolicySchema, getExecutionPolicyForTaskType } from "./execution-policy.js";

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
    executionPolicy: executionPolicySchema.optional(),
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

    if (task.acceptanceCriteria.length > 7) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptanceCriteria"],
        message: "Execution tasks should be fine-grained; split tasks with more than 7 acceptance criteria"
      });
    }

    if (task.status === "working" && !task.aoSessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aoSessionId"],
        message: "Working tasks must include aoSessionId"
      });
    }

    if (task.aoSessionId && task.status !== "working" && task.status !== "completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aoSessionId"],
        message: "Tasks with aoSessionId must be working or completed"
      });
    }

    if ((task.type === "implementation" || task.type === "refactor") && task.executionPolicy) {
      const weakenedFields = [
        !task.executionPolicy.developerSelfTestRequired ? "developerSelfTestRequired" : undefined,
        !task.executionPolicy.qaRequired ? "qaRequired" : undefined,
        !task.executionPolicy.regressionRequired ? "regressionRequired" : undefined,
        !task.executionPolicy.reviewerRequired ? "reviewerRequired" : undefined,
        task.executionPolicy.maxQaRounds < 3 ? "maxQaRounds" : undefined,
        task.executionPolicy.maxReviewRounds < 3 ? "maxReviewRounds" : undefined,
        !task.executionPolicy.requirePrOrRp ? "requirePrOrRp" : undefined
      ].filter((field): field is string => Boolean(field));

      if (weakenedFields.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionPolicy"],
          message: `Implementation and refactor tasks must keep full execution policy; weakened fields: ${weakenedFields.join(", ")}`
        });
      }
    }
  })
  .transform((task) => ({
    ...task,
    executionPolicy: task.executionPolicy ?? getExecutionPolicyForTaskType(task.type)
  }));

export const taskPlanSchema = z
  .object({
    workflowId: z.string().min(1),
    title: z.string().min(1),
    tasks: z.array(executionTaskSchema).min(1)
  })
  .superRefine((plan, context) => {
    const taskIds = new Set<string>();
    let hasDuplicateTaskId = false;
    for (const [index, task] of plan.tasks.entries()) {
      if (task.workflowId !== plan.workflowId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "workflowId"],
          message: "Task workflowId must match task-plan workflowId"
        });
      }

      if (taskIds.has(task.taskId)) {
        hasDuplicateTaskId = true;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "taskId"],
          message: `Duplicate taskId: ${task.taskId}`
        });
      }
      taskIds.add(task.taskId);
    }

    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependencies) {
        if (!taskIds.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", index, "dependencies"],
            message: `Unknown dependency ${dependency} for task ${task.taskId}`
          });
        }

        if (dependency === task.taskId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tasks", index, "dependencies"],
            message: `Task ${task.taskId} must not depend on itself`
          });
        }
      }
    }

    if (hasDuplicateTaskId) {
      return;
    }

    const graph = new Map(plan.tasks.map((task) => [task.taskId, task.dependencies]));
    const cycle = findDependencyCycle(graph);
    if (cycle.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tasks"],
        message: `Task dependencies must not contain cycles: ${cycle.join(" -> ")}`
      });
    }
  });

export type ExecutionTask = z.output<typeof executionTaskSchema>;
export type TaskPlan = z.output<typeof taskPlanSchema>;

function findDependencyCycle(graph: Map<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (taskId: string): string[] => {
    if (visiting.has(taskId)) {
      return [...stack.slice(stack.indexOf(taskId)), taskId];
    }
    if (visited.has(taskId)) {
      return [];
    }

    visiting.add(taskId);
    stack.push(taskId);
    for (const dependency of graph.get(taskId) ?? []) {
      if (!graph.has(dependency)) {
        continue;
      }
      const cycle = visit(dependency);
      if (cycle.length > 0) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return [];
  };

  for (const taskId of graph.keys()) {
    const cycle = visit(taskId);
    if (cycle.length > 0) {
      return cycle;
    }
  }

  return [];
}
