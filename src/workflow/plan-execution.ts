import type { AoCliAdapter } from "../adapters/ao.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export interface PlanExecutionResult {
  sessions: Array<{
    taskId: string;
    aoRole: string;
    sessionId?: string;
  }>;
  blockedTasks: Array<{
    taskId: string;
    reason: string;
  }>;
}

export async function executePlan(input: {
  plan: TaskPlan;
  ao: AoCliAdapter;
}): Promise<PlanExecutionResult> {
  const completed = new Set(
    input.plan.tasks.filter((task) => task.status === "completed").map((task) => task.taskId)
  );
  const alreadyWorking = new Set(
    input.plan.tasks
      .filter((task) => task.status === "working" || Boolean(task.aoSessionId))
      .map((task) => task.taskId)
  );
  const sessions: PlanExecutionResult["sessions"] = [];
  const blockedTasks: PlanExecutionResult["blockedTasks"] = [];

  // TODO: Dispatch independent ready tasks with Promise.all after AO spawn concurrency limits are defined.
  for (const task of input.plan.tasks) {
    if (task.status !== "pending" || alreadyWorking.has(task.taskId)) {
      continue;
    }

    const readiness = getTaskReadiness(task, completed);

    if (!readiness.ready) {
      blockedTasks.push({
        taskId: task.taskId,
        reason: readiness.reason
      });
      continue;
    }

    const result = await input.ao.spawnTask(task);
    sessions.push({
      taskId: task.taskId,
      aoRole: task.aoRole,
      sessionId: result.sessionId
    });
    alreadyWorking.add(task.taskId);
  }

  return { sessions, blockedTasks };
}

function getTaskReadiness(
  task: ExecutionTask,
  completed: ReadonlySet<string>
): { ready: true } | { ready: false; reason: string } {
  if (task.dependencyCondition === "manual_gate") {
    const dependenciesCompleted = task.dependencies.every((dependency) => completed.has(dependency));
    // TODO: Add a CLI/API approval mechanism so completed manual gates can be released explicitly.
    return dependenciesCompleted
      ? { ready: false, reason: "manual_gate requires human approval before dispatch" }
      : { ready: false, reason: `waiting for dependencies: ${task.dependencies.join(", ")}` };
  }

  if (task.dependencies.length === 0) {
    return { ready: true };
  }

  if (task.dependencyCondition === "any_completed") {
    return task.dependencies.some((dependency) => completed.has(dependency))
      ? { ready: true }
      : { ready: false, reason: `waiting for any dependency: ${task.dependencies.join(", ")}` };
  }

  const unresolved = task.dependencies.filter((dependency) => !completed.has(dependency));
  return unresolved.length === 0
    ? { ready: true }
    : { ready: false, reason: `waiting for dependencies: ${unresolved.join(", ")}` };
}
