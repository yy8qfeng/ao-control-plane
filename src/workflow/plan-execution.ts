import type { AoCliAdapter } from "../adapters/ao.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import {
  getAlreadyWorkingTaskIds,
  getCompletedTaskIds,
  getLegacyReleasedManualGateTaskIds,
  getTaskReadiness,
  type BlockedTaskKind,
  type ManualGateRelease
} from "./task-readiness.js";

export type { BlockedTaskKind, ManualGateRelease } from "./task-readiness.js";

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
  releasedManualGateTaskIds?: Array<string | ManualGateRelease>;
}): Promise<PlanExecutionResult> {
  const releasedManualGateTaskIds = getLegacyReleasedManualGateTaskIds(input.releasedManualGateTaskIds);
  const completed = getCompletedTaskIds(input.plan);
  const alreadyWorking = getAlreadyWorkingTaskIds(input.plan);
  const sessions: PlanExecutionResult["sessions"] = [];
  const blockedTasks: PlanExecutionResult["blockedTasks"] = [];

  // TODO: Dispatch independent ready tasks with Promise.all after AO spawn concurrency limits are defined.
  for (const task of input.plan.tasks) {
    if (task.status !== "pending" || alreadyWorking.has(task.taskId)) {
      continue;
    }

    const readiness = getTaskReadiness({ task, completed, releasedManualGateTaskIds });

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
