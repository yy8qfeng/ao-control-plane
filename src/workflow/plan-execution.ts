import type { AoCliAdapter } from "../adapters/ao.js";
import type { TaskPlan } from "../schemas/task-plan.js";

export interface PlanExecutionResult {
  sessions: Array<{
    taskId: string;
    aoRole: string;
    sessionId?: string;
  }>;
}

export async function executePlan(input: {
  plan: TaskPlan;
  ao: AoCliAdapter;
}): Promise<PlanExecutionResult> {
  const completed = new Set<string>();
  const sessions: PlanExecutionResult["sessions"] = [];

  for (const task of input.plan.tasks) {
    const ready =
      task.dependencyCondition === "manual_gate"
        ? Boolean(task.manualGate?.required)
        : task.dependencies.every((dependency) => completed.has(dependency));

    if (!ready) {
      throw new Error(`Task ${task.id} is not ready; unresolved dependencies: ${task.dependencies.join(", ")}`);
    }

    const result = await input.ao.spawnTask(task);
    sessions.push({
      taskId: task.id,
      aoRole: task.aoRole,
      sessionId: result.sessionId
    });
    completed.add(task.id);
  }

  return { sessions };
}
