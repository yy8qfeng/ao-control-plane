import type { AoCliAdapter } from "../adapters/ao.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export type BlockedTaskKind = "waiting_dependencies" | "manual_gate";

export interface PlanExecutionResult {
  sessions: Array<{
    taskId: string;
    aoRole: string;
    sessionId?: string;
  }>;
  blockedTasks: Array<{
    taskId: string;
    kind: BlockedTaskKind;
    reason: string;
  }>;
}

export async function executePlan(input: {
  plan: TaskPlan;
  ao: AoCliAdapter;
  releasedManualGateTaskIds?: string[];
}): Promise<PlanExecutionResult> {
  const releasedManualGateTaskIds = new Set(input.releasedManualGateTaskIds ?? []);
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

    const readiness = getTaskReadiness(task, completed, releasedManualGateTaskIds);

    if (!readiness.ready) {
      blockedTasks.push({
        taskId: task.taskId,
        kind: readiness.kind,
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
  completed: ReadonlySet<string>,
  releasedManualGateTaskIds: ReadonlySet<string>
): { ready: true } | { ready: false; kind: BlockedTaskKind; reason: string } {
  if (task.dependencyCondition === "manual_gate") {
    const dependenciesCompleted = task.dependencies.every((dependency) => completed.has(dependency));
    if (!dependenciesCompleted) {
      return {
        ready: false,
        kind: "waiting_dependencies",
        reason: `waiting for dependencies: ${task.dependencies.join(", ")}`
      };
    }
    return releasedManualGateTaskIds.has(task.taskId)
      ? { ready: true }
      : {
          ready: false,
          kind: "manual_gate",
          reason: "manual_gate requires human approval before dispatch"
        };
  }

  if (task.dependencies.length === 0) {
    return { ready: true };
  }

  if (task.dependencyCondition === "any_completed") {
    return task.dependencies.some((dependency) => completed.has(dependency))
      ? { ready: true }
      : {
          ready: false,
          kind: "waiting_dependencies",
          reason: `waiting for any dependency: ${task.dependencies.join(", ")}`
        };
  }

  const unresolved = task.dependencies.filter((dependency) => !completed.has(dependency));
  return unresolved.length === 0
    ? { ready: true }
    : {
        ready: false,
        kind: "waiting_dependencies",
        reason: `waiting for dependencies: ${unresolved.join(", ")}`
      };
}
