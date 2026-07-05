import { randomUUID } from "node:crypto";
import type { AoCliAdapter, AoSpawnResult } from "../adapters/ao.js";
import { normalizeAoSessions, type AoSessionSnapshot } from "./ao-status.js";
import {
  type ExecutionErrorKind,
  type ExecutionFailure,
  type ExecutionState,
  type ExecutionStateStore,
  type ExecutionTaskState,
  summarizeExecutionState
} from "./execution-state-store.js";
import { findNextReadyTask, getCompletedTaskIds, getReleasedManualGateTaskIds, getTaskReadiness } from "./task-readiness.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export interface ContinuousExecutionRunnerOptions {
  workflowId: string;
  store: ExecutionStateStore;
  ao: Pick<AoCliAdapter, "spawnTask" | "listSessions">;
  pollIntervalMs?: number;
  failureConfirmationCount?: number;
  maxAoStatusFailures?: number;
  maxTicks?: number;
}

export interface ContinuousExecutionTickResult {
  action:
    | "dispatched"
    | "sleep"
    | "completed"
    | "failed"
    | "waiting_manual_gate"
    | "paused"
    | "stopped";
  taskId?: string;
}

type DispatchDecision =
  | { action: "dispatch"; task: ExecutionTask; dispatchId: string }
  | { action: "waiting_manual_gate" | "failed" | "paused"; taskId?: string };

const terminalSuccessStatuses = new Set(["completed", "mergeable", "merged", "done"]);
const terminalFailureStatusKinds: Record<string, ExecutionErrorKind> = {
  failed: "ao_task_failed",
  stuck: "ao_task_stuck",
  ci_failed: "ao_task_failed",
  needs_input: "ao_task_needs_input"
};

export class ContinuousExecutionRunner {
  private stopped = false;
  private running = false;
  private statusFailureCount = 0;

  constructor(private readonly options: ContinuousExecutionRunnerOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
    });
  }

  requestStop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    let ticks = 0;
    await this.activateState();
    await this.recoverPendingDispatch();
    while (!this.stopped) {
      const result = await this.tick();
      ticks += 1;
      if (result.action === "completed" || result.action === "failed" || result.action === "waiting_manual_gate" || result.action === "paused" || result.action === "stopped") {
        return;
      }
      if (this.options.maxTicks && ticks >= this.options.maxTicks) {
        return;
      }
      await sleep(this.options.pollIntervalMs ?? 5000);
    }
  }

  async tick(): Promise<ContinuousExecutionTickResult> {
    const state = await this.options.store.ensureState(this.options.workflowId);
    if (state.status === "stopped") {
      return { action: "stopped" };
    }
    if (state.status === "failed") {
      return { action: "failed", taskId: state.failure?.taskId };
    }
    if (state.status === "completed") {
      return { action: "completed" };
    }
    if (state.status === "waiting_manual_gate" || state.status === "paused_for_replan") {
      return { action: state.status === "waiting_manual_gate" ? "waiting_manual_gate" : "paused", taskId: state.currentTaskId ?? undefined };
    }

    const plan = await this.options.store.readActiveTaskPlan(state);
    await this.syncWorkingTasksWithAo(plan);

    const afterSync = await this.options.store.readState(this.options.workflowId);
    if (afterSync.status === "failed") {
      return { action: "failed", taskId: afterSync.failure?.taskId };
    }

    const terminal = await this.finishIfTerminal(plan);
    if (terminal) {
      return terminal;
    }

    const workingTask = Object.values(afterSync.taskStates).find((task) => task.status === "working");
    if (workingTask) {
      return { action: "sleep", taskId: workingTask.taskId };
    }

    const decision = await this.options.store.update<DispatchDecision>(this.options.workflowId, async (current) => {
      if (current.status !== "running") {
        return { state: current, value: { action: "paused" as const } };
      }
      const completed = getCompletedTaskIds(plan, { getStatus: (taskId) => current.taskStates[taskId]?.status });
      const released = getReleasedManualGateTaskIds(current.manualGateReleases);
      const nextTask = findNextReadyTask({
        plan,
        completed,
        releasedManualGateTaskIds: released,
        runtime: { getStatus: (taskId) => current.taskStates[taskId]?.status }
      });
      if (!nextTask) {
        const blockedManualGate = findBlockedManualGate(plan, current, completed, released);
        if (blockedManualGate) {
          return {
            state: {
              ...current,
              status: "waiting_manual_gate",
              currentTaskId: blockedManualGate.taskId
            },
            value: { action: "waiting_manual_gate" as const, taskId: blockedManualGate.taskId }
          };
        }
        return {
          state: failCurrentState(current, {
            kind: "dependency_deadlock",
            message: "No working task, no ready task, and no explainable manual gate wait"
          }),
          value: { action: "failed" as const }
        };
      }

      if (nextTask.dependencyCondition === "manual_gate" && !released.has(nextTask.taskId)) {
        return {
          state: {
            ...current,
            status: "waiting_manual_gate",
            currentTaskId: nextTask.taskId
          },
          value: { action: "waiting_manual_gate" as const, taskId: nextTask.taskId }
        };
      }

      const existingAttempt = current.taskStates[nextTask.taskId]?.attempt ?? 0;
      const attempt = Math.max(1, existingAttempt + 1);
      const dispatchId = `DISPATCH-${randomUUID()}`;
      return {
        state: {
          ...current,
          currentTaskId: nextTask.taskId,
          pendingDispatch: {
            dispatchId,
            taskId: nextTask.taskId,
            attempt,
            createdAt: new Date().toISOString()
          },
          taskStates: {
            ...current.taskStates,
            [nextTask.taskId]: {
              taskId: nextTask.taskId,
              status: "pending",
              aoRole: nextTask.aoRole,
              attempt,
              maxAttempts: current.taskStates[nextTask.taskId]?.maxAttempts ?? 3,
              completedAt: null,
              failureReason: null,
              statusObservations: []
            }
          }
        },
        value: { action: "dispatch" as const, task: nextTask, dispatchId }
      };
    }) as DispatchDecision;

    if (decision.action !== "dispatch") {
      await this.logDecision(decision.action, decision.taskId);
      return decision.action === "waiting_manual_gate"
        ? { action: "waiting_manual_gate", taskId: decision.taskId }
        : { action: decision.action };
    }

    await this.dispatchReservedTask(decision.task, decision.dispatchId);
    return { action: "dispatched", taskId: decision.task.taskId };
  }

  private async activateState(): Promise<void> {
    await this.options.store.update(this.options.workflowId, (state) => {
      if (state.status !== "idle" && state.status !== "stopped") {
        return state;
      }
      const now = new Date().toISOString();
      return {
        ...state,
        status: "running",
        startedAt: state.startedAt ?? now,
        stoppedAt: null,
        failure: null
      };
    });
  }

  private async recoverPendingDispatch(): Promise<void> {
    const state = await this.options.store.ensureState(this.options.workflowId);
    if (!state.pendingDispatch) {
      return;
    }
    const plan = await this.options.store.readActiveTaskPlan(state);
    const task = plan.tasks.find((item) => item.taskId === state.pendingDispatch?.taskId);
    if (!task) {
      await this.options.store.failState(this.options.workflowId, {
        kind: "state_corrupted",
        message: `pendingDispatch references unknown task ${state.pendingDispatch.taskId}`
      });
      return;
    }
    const sessions = await this.listAoSessions();
    const candidates = sessions.filter((session) => sessionMatchesTask(session, task));
    if (candidates.length === 1) {
      await this.options.store.update(this.options.workflowId, (current) => ({
        ...current,
        currentTaskId: task.taskId,
        pendingDispatch: null,
        taskStates: {
          ...current.taskStates,
          [task.taskId]: {
            ...(current.taskStates[task.taskId] ?? createTaskState(task, state.pendingDispatch?.attempt ?? 1)),
            status: "working",
            aoSessionId: candidates[0]?.id,
            startedAt: current.taskStates[task.taskId]?.startedAt ?? new Date().toISOString()
          }
        }
      }));
      return;
    }
    if (candidates.length > 1) {
      await this.options.store.update(this.options.workflowId, (current) =>
        failCurrentState({
          ...current,
          pendingDispatch: null
        }, {
          kind: "state_corrupted",
          message: `pendingDispatch matched multiple AO sessions for ${task.taskId}`,
          taskId: task.taskId,
          spawnCandidateSessionIds: candidates.map((candidate) => candidate.id)
        })
      );
      return;
    }
    await this.options.store.update(this.options.workflowId, (current) => ({
      ...current,
      pendingDispatch: null
    }));
  }

  private async dispatchReservedTask(task: ExecutionTask, dispatchId: string): Promise<void> {
    let spawnResult: AoSpawnResult;
    try {
      spawnResult = await this.options.ao.spawnTask(task);
    } catch (error) {
      await this.options.store.failState(this.options.workflowId, {
        kind: "ao_spawn_failed",
        taskId: task.taskId,
        message: error instanceof Error ? error.message : String(error)
      });
      await this.options.store.appendLog(this.options.workflowId, {
        type: "task_dispatch_failed",
        taskId: task.taskId,
        attempt: 0,
        actor: "runner",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const committed = await this.options.store.update<boolean>(this.options.workflowId, (current) => {
      if (current.pendingDispatch?.dispatchId !== dispatchId || current.pendingDispatch.taskId !== task.taskId || current.status !== "running") {
        return { state: current, value: false };
      }
      const attempt = current.pendingDispatch.attempt;
      return {
        state: {
          ...current,
          currentTaskId: task.taskId,
          pendingDispatch: null,
          taskStates: {
            ...current.taskStates,
            [task.taskId]: {
              ...(current.taskStates[task.taskId] ?? createTaskState(task, attempt)),
              status: "working",
              aoRole: task.aoRole,
              aoSessionId: spawnResult.sessionId,
              attempt,
              startedAt: new Date().toISOString(),
              completedAt: null,
              failureReason: null,
              statusObservations: []
            }
          }
        },
        value: true
      };
    }) as boolean;
    if (!committed) {
      await this.options.store.appendLog(this.options.workflowId, {
        type: "task_dispatch_orphaned",
        taskId: task.taskId,
        attempt: 0,
        actor: "runner",
        aoSessionId: spawnResult.sessionId,
        dispatchId
      });
      return;
    }
    await this.options.store.appendLog(this.options.workflowId, {
      type: "task_dispatched",
      taskId: task.taskId,
      attempt: 0,
      actor: "runner",
      aoSessionId: spawnResult.sessionId
    });
  }

  private async syncWorkingTasksWithAo(plan: TaskPlan): Promise<void> {
    const state = await this.options.store.readState(this.options.workflowId);
    const working = Object.values(state.taskStates).filter((task) => task.status === "working");
    if (working.length === 0) {
      return;
    }

    let sessions: AoSessionSnapshot[];
    try {
      sessions = await this.listAoSessions();
      this.statusFailureCount = 0;
    } catch (error) {
      this.statusFailureCount += 1;
      if (this.statusFailureCount >= (this.options.maxAoStatusFailures ?? 3)) {
        await this.options.store.failState(this.options.workflowId, {
          kind: "ao_status_failed",
          message: error instanceof Error ? error.message : String(error),
          taskId: state.currentTaskId ?? undefined
        });
      }
      return;
    }

    await this.options.store.update(this.options.workflowId, (current) => {
      let next = current;
      for (const taskState of working) {
        const planTask = plan.tasks.find((task) => task.taskId === taskState.taskId);
        if (!planTask) {
          continue;
        }
        const session = findSessionForTaskState(taskState, planTask, sessions);
        const status = session?.status;
        if (!status) {
          continue;
        }
        next = applyAoStatusObservation(next, taskState.taskId, status, this.options.failureConfirmationCount ?? 2);
      }
      return next;
    });
  }

  private async finishIfTerminal(plan: TaskPlan): Promise<ContinuousExecutionTickResult | undefined> {
    return this.options.store.update<ContinuousExecutionTickResult | undefined>(this.options.workflowId, (state) => {
      if (state.status !== "running") {
        return { state, value: undefined };
      }
      const summary = summarizeExecutionState(plan, state);
      if (summary.completed === plan.tasks.length) {
        const completed = {
          ...state,
          status: "completed" as const,
          currentTaskId: null,
          completedAt: new Date().toISOString(),
          failure: null,
          pendingDispatch: null
        };
        return { state: completed, value: { action: "completed" as const } };
      }
      return { state, value: undefined };
    }) as Promise<ContinuousExecutionTickResult | undefined>;
  }

  private async listAoSessions(): Promise<AoSessionSnapshot[]> {
    return normalizeAoSessions(await this.options.ao.listSessions());
  }

  private async logDecision(action: string, taskId?: string): Promise<void> {
    if (action === "waiting_manual_gate") {
      await this.options.store.appendLog(this.options.workflowId, {
        type: "manual_gate_waiting",
        taskId,
        attempt: 0,
        actor: "runner"
      });
    }
  }
}

export async function stopExecution(input: {
  store: ExecutionStateStore;
  workflowId: string;
  actor?: "user" | "cli";
}): Promise<ExecutionState> {
  const stopped = await input.store.update(input.workflowId, (state) => ({
    ...state,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    failure: null
  })) as ExecutionState;
  await input.store.appendLog(input.workflowId, {
    type: "dispatcher_stopped",
    taskId: stopped.currentTaskId ?? undefined,
    attempt: stopped.currentTaskId ? stopped.taskStates[stopped.currentTaskId]?.attempt ?? 0 : 0,
    actor: input.actor ?? "user"
  });
  return stopped;
}

export async function retryExecutionTask(input: {
  store: ExecutionStateStore;
  workflowId: string;
  taskId: string;
  actor?: "user" | "cli";
}): Promise<ExecutionState> {
  const state = await input.store.update(input.workflowId, (current) => {
    const task = current.taskStates[input.taskId];
    if (!task || (task.status !== "blocked_for_human" && task.status !== "failed")) {
      throw new Error(`Task ${input.taskId} is not retryable`);
    }
    if (task.attempt >= task.maxAttempts) {
      throw new Error(`Task ${input.taskId} exceeded maxAttempts ${task.maxAttempts}`);
    }
    return {
      ...current,
      status: "running",
      currentTaskId: null,
      failure: null,
      taskStates: {
        ...current.taskStates,
        [input.taskId]: {
          ...task,
          status: "pending",
          aoSessionId: undefined,
          failureReason: null,
          statusObservations: []
        }
      }
    };
  }) as ExecutionState;
  await input.store.appendLog(input.workflowId, {
    type: "task_retry_requested",
    taskId: input.taskId,
    attempt: state.taskStates[input.taskId]?.attempt ?? 0,
    actor: input.actor ?? "user"
  });
  return state;
}

export async function markExecutionTaskCompleted(input: {
  store: ExecutionStateStore;
  workflowId: string;
  taskId: string;
  rationale: string;
  actor?: "user" | "cli";
}): Promise<ExecutionState> {
  const rationale = input.rationale.trim();
  if (!rationale) {
    throw new Error("rationale is required");
  }
  const state = await input.store.update(input.workflowId, (current) => {
    const task = current.taskStates[input.taskId];
    if (!task) {
      throw new Error(`Unknown task ${input.taskId}`);
    }
    const at = new Date().toISOString();
    return {
      ...current,
      status: "running",
      currentTaskId: null,
      failure: null,
      taskStates: {
        ...current.taskStates,
        [input.taskId]: {
          ...task,
          status: "completed",
          completedAt: at,
          markedCompletedBy: {
            actor: input.actor ?? "user",
            rationale,
            at
          }
        }
      }
    };
  }) as ExecutionState;
  await input.store.appendLog(input.workflowId, {
    type: "task_marked_completed",
    taskId: input.taskId,
    attempt: state.taskStates[input.taskId]?.attempt ?? 0,
    actor: input.actor ?? "user",
    rationale
  });
  return state;
}

export async function decideManualGate(input: {
  store: ExecutionStateStore;
  workflowId: string;
  taskId: string;
  decision: "approved" | "requires_replan" | "blocked";
  rationale: string;
  actor?: "user" | "cli";
}): Promise<ExecutionState> {
  const rationale = input.rationale.trim();
  if (!rationale) {
    throw new Error("rationale is required");
  }
  const state = await input.store.update(input.workflowId, (current) => {
    const releases = current.manualGateReleases.filter((release) => release.taskId !== input.taskId);
    const release = {
      taskId: input.taskId,
      decision: input.decision,
      rationale,
      releasedAt: new Date().toISOString()
    };
    if (input.decision === "approved") {
      return {
        ...current,
        status: "running",
        currentTaskId: null,
        failure: null,
        manualGateReleases: [...releases, release]
      };
    }
    if (input.decision === "requires_replan") {
      return {
        ...current,
        status: "paused_for_replan",
        currentTaskId: input.taskId,
        failure: {
          taskId: input.taskId,
          kind: "manual_gate_requires_replan",
          message: rationale,
          occurredAt: new Date().toISOString()
        },
        manualGateReleases: [...releases, release]
      };
    }
    return failCurrentState({
      ...current,
      manualGateReleases: [...releases, release]
    }, {
      taskId: input.taskId,
      kind: "manual_gate_blocked",
      message: rationale
    });
  }) as ExecutionState;
  await input.store.appendLog(input.workflowId, {
    type: "manual_gate_decided",
    taskId: input.taskId,
    attempt: 0,
    actor: input.actor ?? "user",
    decision: input.decision,
    rationale
  });
  return state;
}

function applyAoStatusObservation(
  state: ExecutionState,
  taskId: string,
  status: string,
  failureConfirmationCount: number
): ExecutionState {
  const task = state.taskStates[taskId];
  if (!task || task.status !== "working") {
    return state;
  }
  const observedAt = new Date().toISOString();
  const observations = [
    ...(task.statusObservations ?? []),
    { attempt: task.attempt, status, observedAt }
  ].filter((observation) => observation.attempt === task.attempt).slice(-5);

  if (terminalSuccessStatuses.has(status)) {
    const nextTask = {
      ...task,
      status: "completed" as const,
      completedAt: observedAt,
      statusObservations: observations
    };
    return {
      ...state,
      currentTaskId: state.currentTaskId === taskId ? null : state.currentTaskId,
      taskStates: {
        ...state.taskStates,
        [taskId]: nextTask
      }
    };
  }

  const failureKind = terminalFailureStatusKinds[status];
  if (failureKind) {
    const confirmed = observations.slice(-failureConfirmationCount).filter((observation) => observation.status === status).length >= failureConfirmationCount;
    if (confirmed) {
      return failCurrentState({
        ...state,
        taskStates: {
          ...state.taskStates,
          [taskId]: {
            ...task,
            status: "blocked_for_human",
            failureReason: status,
            statusObservations: observations
          }
        }
      }, {
        taskId,
        kind: failureKind,
        message: `AO session reported terminal status: ${status}`
      });
    }
  }

  return {
    ...state,
    taskStates: {
      ...state.taskStates,
      [taskId]: {
        ...task,
        statusObservations: observations
      }
    }
  };
}

function findBlockedManualGate(
  plan: TaskPlan,
  state: ExecutionState,
  completed: ReadonlySet<string>,
  released: ReadonlySet<string>
): ExecutionTask | undefined {
  return plan.tasks.find((task) => {
    const runtimeStatus = state.taskStates[task.taskId]?.status ?? task.status;
    if (runtimeStatus !== "pending" || task.dependencyCondition !== "manual_gate") {
      return false;
    }
    const readiness = getTaskReadiness({ task, completed, releasedManualGateTaskIds: released });
    return !readiness.ready && readiness.kind === "manual_gate";
  });
}

function findSessionForTaskState(
  taskState: ExecutionTaskState,
  task: ExecutionTask,
  sessions: AoSessionSnapshot[]
): AoSessionSnapshot | undefined {
  if (taskState.aoSessionId) {
    return sessions.find((session) => session.id === taskState.aoSessionId);
  }
  return sessions.find((session) => sessionMatchesTask(session, task));
}

function sessionMatchesTask(session: AoSessionSnapshot, task: ExecutionTask): boolean {
  const prefix = `[${task.workflowId} / ${task.taskId}]`;
  return [session.prompt, session.displayName, session.branch].some((value) => value?.startsWith(prefix));
}

function createTaskState(task: ExecutionTask, attempt: number): ExecutionTaskState {
  return {
    taskId: task.taskId,
    status: "pending",
    aoRole: task.aoRole,
    attempt,
    maxAttempts: 3,
    completedAt: null,
    failureReason: null,
    statusObservations: []
  };
}

function failCurrentState(
  state: ExecutionState,
  failure: Omit<ExecutionFailure, "occurredAt">
): ExecutionState {
  return {
    ...state,
    status: "failed",
    failure: {
      ...failure,
      occurredAt: new Date().toISOString()
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
