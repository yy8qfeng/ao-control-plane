import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export type BlockedTaskKind = "waiting_dependencies" | "manual_gate";

export interface ManualGateRelease {
  taskId: string;
  decision: "approved" | "requires_replan" | "blocked" | "review_dispatched";
  mode?: "manual_approve" | "ao_review";
  rationale?: string;
  releasedAt?: string;
  attempt?: number;
  generatedArtifacts?: string[];
  dispatchContextPath?: string;
  aoSessionId?: string;
  supersededAoSessionId?: string;
}

export interface RuntimeTaskStatusSource {
  getStatus(taskId: string): "pending" | "working" | "completed" | "blocked_for_human" | "failed" | "superseded" | undefined;
}

export interface TaskReadiness {
  ready: boolean;
  kind?: BlockedTaskKind;
  reason?: string;
}

export function getReleasedManualGateTaskIds(
  releases: ManualGateRelease[] | undefined
): Set<string> {
  return new Set(
    (releases ?? [])
      .map((release) => (release.decision === "approved" ? release.taskId : undefined))
      .filter((taskId): taskId is string => Boolean(taskId))
  );
}

export function getLegacyReleasedManualGateTaskIds(
  releases: Array<string | ManualGateRelease> | undefined
): Set<string> {
  return new Set(
    (releases ?? [])
      .map((release) => (typeof release === "string" ? release : release.decision === "approved" ? release.taskId : undefined))
      .filter((taskId): taskId is string => Boolean(taskId))
  );
}

export function getCompletedTaskIds(
  plan: TaskPlan,
  runtime?: RuntimeTaskStatusSource
): Set<string> {
  return new Set(
    plan.tasks
      .filter((task) => (runtime?.getStatus(task.taskId) ?? task.status) === "completed")
      .map((task) => task.taskId)
  );
}

export function getAlreadyWorkingTaskIds(
  plan: TaskPlan,
  runtime?: RuntimeTaskStatusSource
): Set<string> {
  return new Set(
    plan.tasks
      .filter((task) => {
        const runtimeStatus = runtime?.getStatus(task.taskId);
        return runtimeStatus === "working" || (!runtimeStatus && (task.status === "working" || Boolean(task.aoSessionId)));
      })
      .map((task) => task.taskId)
  );
}

export function getTaskReadiness(input: {
  task: ExecutionTask;
  completed: ReadonlySet<string>;
  releasedManualGateTaskIds?: ReadonlySet<string>;
}): { ready: true } | { ready: false; kind: BlockedTaskKind; reason: string } {
  const releasedManualGateTaskIds = input.releasedManualGateTaskIds ?? new Set<string>();
  const task = input.task;

  if (task.dependencyCondition === "manual_gate") {
    const dependenciesCompleted = task.dependencies.every((dependency) => input.completed.has(dependency));
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
    return task.dependencies.some((dependency) => input.completed.has(dependency))
      ? { ready: true }
      : {
          ready: false,
          kind: "waiting_dependencies",
          reason: `waiting for any dependency: ${task.dependencies.join(", ")}`
        };
  }

  const unresolved = task.dependencies.filter((dependency) => !input.completed.has(dependency));
  return unresolved.length === 0
    ? { ready: true }
    : {
        ready: false,
        kind: "waiting_dependencies",
        reason: `waiting for dependencies: ${unresolved.join(", ")}`
      };
}

export function findNextReadyTask(input: {
  plan: TaskPlan;
  completed: ReadonlySet<string>;
  releasedManualGateTaskIds?: ReadonlySet<string>;
  runtime?: RuntimeTaskStatusSource;
}): ExecutionTask | undefined {
  const alreadyWorking = getAlreadyWorkingTaskIds(input.plan, input.runtime);
  for (const task of input.plan.tasks) {
    const runtimeStatus = input.runtime?.getStatus(task.taskId);
    const status = runtimeStatus ?? task.status;
    if (status !== "pending" || alreadyWorking.has(task.taskId)) {
      continue;
    }

    if (getTaskReadiness({
      task,
      completed: input.completed,
      releasedManualGateTaskIds: input.releasedManualGateTaskIds
    }).ready) {
      return task;
    }
  }
  return undefined;
}
