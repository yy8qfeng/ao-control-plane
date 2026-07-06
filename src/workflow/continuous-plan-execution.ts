import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AoCliAdapter, AoSpawnResult } from "../adapters/ao.js";
import {
  buildAoDispatchContext,
  cleanupFiles,
  findMissingRequiredArtifacts,
  findExistingManualGateArtifacts,
  getDispatchContextPath,
  resolveInputArtifacts,
  resolveOutputArtifacts,
  synthesizeManualGateArtifacts,
  validateTaskOutputArtifacts,
  type ConflictArtifact,
  type MissingArtifact
} from "./ao-dispatch-context.js";
import { normalizeAoSessions, type AoSessionSnapshot } from "./ao-status.js";
import { isConditionalReworkTaskText, skipsOnApprovedPath, skipsOnPassPath } from "./conditional-task-conventions.js";
import {
  type ExecutionErrorKind,
  type ExecutionFailure,
  type ExecutionState,
  type ExecutionStateStore,
  type ExecutionTaskState,
  summarizeExecutionState
} from "./execution-state-store.js";
import { findNextReadyTask, getCompletedTaskIds, getTaskReadiness } from "./task-readiness.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export interface ContinuousExecutionRunnerOptions {
  workflowId: string;
  store: ExecutionStateStore;
  ao: Pick<AoCliAdapter, "spawnTask" | "listSessions">;
  projectRoot?: string;
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
    await this.skipInactiveConditionalTasks(plan);

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
      const nextTask = findNextReadyTask({
        plan,
        completed,
        releasedManualGateTaskIds: new Set<string>(),
        runtime: { getStatus: (taskId) => current.taskStates[taskId]?.status }
      });
      if (!nextTask) {
        const blockedManualGate = findBlockedManualGate(plan, current, completed, new Set<string>());
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

      if (nextTask.dependencyCondition === "manual_gate") {
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
      const dispatchContextPath = getDispatchContextPath(this.options.store.getWorkflowDir(this.options.workflowId), nextTask.taskId, attempt);
      return {
        state: {
          ...current,
          currentTaskId: nextTask.taskId,
          pendingDispatch: {
            dispatchId,
            taskId: nextTask.taskId,
            attempt,
            createdAt: new Date().toISOString(),
            dispatchContextPath
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
              dispatchContextPath,
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
            dispatchContextPath: state.pendingDispatch?.dispatchContextPath,
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
    let dispatchContextPath: string | undefined;
    try {
      const state = await this.options.store.readState(this.options.workflowId);
      const attempt = state.pendingDispatch?.attempt ?? state.taskStates[task.taskId]?.attempt ?? 1;
      const plan = await this.options.store.readActiveTaskPlan(state);
      const context = await buildAoDispatchContext({
        task,
        plan,
        state,
        projectRoot: this.options.projectRoot,
        artifactDir: this.options.store.getWorkflowDir(this.options.workflowId),
        attempt,
        dispatchId
      });
      dispatchContextPath = context.contextPath;
      await this.options.store.appendLog(this.options.workflowId, {
        type: "ao_dispatch_context_created",
        taskId: task.taskId,
        attempt,
        actor: "runner",
        dispatchContextPath
      });
      if (context.missingRequiredArtifacts.length > 0) {
        throw new ArtifactContextMissingError(context.missingRequiredArtifacts);
      }
      spawnResult = await this.options.ao.spawnTask({ ...task, aoPrompt: context.prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureKind = error instanceof ArtifactContextMissingError ? "artifact_context_missing" : "ao_spawn_failed";
      await this.options.store.update(this.options.workflowId, (current) => {
        const attempt = current.pendingDispatch?.attempt ?? current.taskStates[task.taskId]?.attempt ?? 1;
        return failCurrentState({
          ...current,
          currentTaskId: task.taskId,
          pendingDispatch: null,
          taskStates: {
            ...current.taskStates,
            [task.taskId]: {
              ...(current.taskStates[task.taskId] ?? createTaskState(task, attempt)),
              status: "blocked_for_human",
              aoRole: task.aoRole,
              attempt,
              startedAt: new Date().toISOString(),
              completedAt: null,
              failureReason: failureKind,
              dispatchContextPath,
              statusObservations: []
            }
          }
        }, {
          kind: failureKind,
          taskId: task.taskId,
          message
        });
      });
      await this.options.store.appendLog(this.options.workflowId, {
        type: failureKind === "artifact_context_missing" ? "artifact_context_missing" : "task_dispatch_failed",
        taskId: task.taskId,
        attempt: 0,
        actor: "runner",
        error: message
      });
      return;
    }

    if (!spawnResult.sessionId) {
      const committed = await this.options.store.update<boolean>(this.options.workflowId, (current) => {
        if (current.pendingDispatch?.dispatchId !== dispatchId || current.pendingDispatch.taskId !== task.taskId || current.status !== "running") {
          return { state: current, value: false };
        }
        const attempt = current.pendingDispatch.attempt;
        return {
          state: failCurrentState({
            ...current,
            currentTaskId: task.taskId,
            pendingDispatch: null,
            taskStates: {
              ...current.taskStates,
              [task.taskId]: {
                ...(current.taskStates[task.taskId] ?? createTaskState(task, attempt)),
                status: "blocked_for_human",
                aoRole: task.aoRole,
                attempt,
                startedAt: new Date().toISOString(),
                completedAt: null,
                failureReason: "ao_session_missing",
                statusObservations: []
              }
            }
          }, {
            kind: "ao_spawn_failed",
            taskId: task.taskId,
            message: "AO spawn did not return a sessionId; execution is interrupted for manual recovery"
          }),
          value: true
        };
      }) as boolean;
      await this.options.store.appendLog(this.options.workflowId, {
        type: committed ? "task_dispatch_missing_session" : "task_dispatch_orphaned",
        taskId: task.taskId,
        attempt: 0,
        actor: "runner",
        dispatchId,
        error: "AO spawn did not return a sessionId"
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
              dispatchContextPath,
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
      aoSessionId: spawnResult.sessionId,
      dispatchContextPath
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

    const missingSessionTaskIds: string[] = [];
    const outputMissingByTaskId = new Map<string, MissingArtifact[]>();
    const outputConflictsByTaskId = new Map<string, ConflictArtifact[]>();
    for (const taskState of working) {
      const planTask = plan.tasks.find((task) => task.taskId === taskState.taskId);
      if (!planTask || taskState.aoSessionId && state.supersededSessions?.includes(taskState.aoSessionId)) {
        continue;
      }
      const session = findSessionForTaskState(taskState, planTask, sessions);
      if (session?.status && terminalSuccessStatuses.has(session.status)) {
        const manualGateRelease = state.manualGateReleases.find((release) => release.taskId === taskState.taskId);
        const validation = await validateTaskOutputArtifacts({
          task: planTask,
          artifactDir: this.options.store.getWorkflowDir(this.options.workflowId),
          manualGateMode: manualGateRelease?.mode,
          aoSessionId: taskState.aoSessionId
        });
        if (validation.missingArtifacts.length > 0) {
          outputMissingByTaskId.set(taskState.taskId, validation.missingArtifacts);
        }
        if (validation.conflictArtifacts.length > 0) {
          outputConflictsByTaskId.set(taskState.taskId, validation.conflictArtifacts);
        }
      }
    }
    await this.options.store.update(this.options.workflowId, (current) => {
      let next = current;
      for (const taskState of working) {
        if (taskState.aoSessionId && current.supersededSessions?.includes(taskState.aoSessionId)) {
          continue;
        }
        const planTask = plan.tasks.find((task) => task.taskId === taskState.taskId);
        if (!planTask) {
          continue;
        }
        const session = findSessionForTaskState(taskState, planTask, sessions);
        if (!session && !taskState.aoSessionId) {
          missingSessionTaskIds.push(taskState.taskId);
          next = failCurrentState({
            ...next,
            currentTaskId: taskState.taskId,
            taskStates: {
              ...next.taskStates,
              [taskState.taskId]: {
                ...taskState,
                status: "blocked_for_human",
                failureReason: "ao_session_missing"
              }
            }
          }, {
            kind: "ao_spawn_failed",
            taskId: taskState.taskId,
            message: `Working task ${taskState.taskId} has no aoSessionId and no matching AO session; execution is interrupted for manual recovery`
          });
          break;
        }
        if (session?.id && !taskState.aoSessionId) {
          next = attachAoSessionId(next, taskState.taskId, session.id);
        }
        const status = session?.status;
        if (!status) {
          continue;
        }
        const missingOutputs = outputMissingByTaskId.get(taskState.taskId);
        const conflictOutputs = outputConflictsByTaskId.get(taskState.taskId);
        if (conflictOutputs?.length) {
          next = failCurrentState({
            ...next,
            taskStates: {
              ...next.taskStates,
              [taskState.taskId]: {
                ...taskState,
                status: "blocked_for_human",
                failureReason: "artifact_output_conflict"
              }
            }
          }, {
            taskId: taskState.taskId,
            kind: "artifact_output_conflict",
            message: formatConflictArtifacts(conflictOutputs)
          });
          break;
        }
        if (missingOutputs?.length) {
          next = failCurrentState({
            ...next,
            taskStates: {
              ...next.taskStates,
              [taskState.taskId]: {
                ...taskState,
                status: "blocked_for_human",
                failureReason: "artifact_output_missing"
              }
            }
          }, {
            taskId: taskState.taskId,
            kind: "artifact_output_missing",
            message: formatMissingArtifacts(missingOutputs)
          });
          break;
        }
        next = applyAoStatusObservation(next, taskState.taskId, status, this.options.failureConfirmationCount ?? 2);
      }
      return next;
    });
    for (const taskId of missingSessionTaskIds) {
      await this.options.store.appendLog(this.options.workflowId, {
        type: "task_execution_missing_session",
        taskId,
        attempt: state.taskStates[taskId]?.attempt ?? 0,
        actor: "runner",
        error: "Working task has no aoSessionId and no matching AO session"
      });
    }
    for (const [taskId, conflicts] of outputConflictsByTaskId.entries()) {
      await this.options.store.appendLog(this.options.workflowId, {
        type: "artifact_output_conflict",
        taskId,
        attempt: state.taskStates[taskId]?.attempt ?? 0,
        actor: "runner",
        conflicts
      });
    }
    for (const [taskId, missing] of outputMissingByTaskId.entries()) {
      await this.options.store.appendLog(this.options.workflowId, {
        type: "artifact_output_missing",
        taskId,
        attempt: state.taskStates[taskId]?.attempt ?? 0,
        actor: "runner",
        missing
      });
    }
  }

  private async finishIfTerminal(plan: TaskPlan): Promise<ContinuousExecutionTickResult | undefined> {
    return this.options.store.update<ContinuousExecutionTickResult | undefined>(this.options.workflowId, (state) => {
      if (state.status !== "running") {
        return { state, value: undefined };
      }
      const summary = summarizeExecutionState(plan, state);
      if (summary.completed + summary.superseded === plan.tasks.length) {
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

  private async skipInactiveConditionalTasks(plan: TaskPlan): Promise<void> {
    const state = await this.options.store.readState(this.options.workflowId);
    if (state.status !== "running") {
      return;
    }
    const completed = getCompletedTaskIds(plan, { getStatus: (taskId) => state.taskStates[taskId]?.status });
    const artifactDir = this.options.store.getWorkflowDir(this.options.workflowId);
    const skipped: Array<{ taskId: string; reason: string; dependencyTaskId?: string; outcome?: string }> = [];
    for (const task of plan.tasks) {
      const status = state.taskStates[task.taskId]?.status ?? task.status;
      if (status !== "pending" || !task.dependencies.every((dependency) => completed.has(dependency))) {
        continue;
      }
      const skip = await getConditionalSkipDecision({
        task,
        plan,
        state,
        artifactDir
      });
      if (skip) {
        skipped.push({ taskId: task.taskId, ...skip });
      }
    }
    if (skipped.length === 0) {
      return;
    }
    const updated = await this.options.store.update(this.options.workflowId, (current) => {
      const at = new Date().toISOString();
      const taskStates = { ...current.taskStates };
      for (const item of skipped) {
        const planTask = plan.tasks.find((task) => task.taskId === item.taskId);
        if (!planTask) {
          continue;
        }
        const currentTask = taskStates[item.taskId];
        if ((currentTask?.status ?? planTask.status) !== "pending") {
          continue;
        }
        taskStates[item.taskId] = {
          ...(currentTask ?? createTaskState(planTask, 0)),
          status: "superseded",
          aoRole: planTask.aoRole,
          completedAt: at,
          failureReason: item.reason
        };
      }
      return {
        ...current,
        currentTaskId: skipped.some((item) => item.taskId === current.currentTaskId) ? null : current.currentTaskId,
        taskStates
      };
    }) as ExecutionState;
    for (const item of skipped) {
      if (updated.taskStates[item.taskId]?.status !== "superseded") {
        continue;
      }
      await this.options.store.appendLog(this.options.workflowId, {
        type: "task_skipped",
        taskId: item.taskId,
        attempt: updated.taskStates[item.taskId]?.attempt ?? 0,
        actor: "runner",
        reason: item.reason,
        dependencyTaskId: item.dependencyTaskId,
        outcome: item.outcome
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
    const retryableFailedDispatch =
      current.status === "failed" &&
      current.failure?.taskId === input.taskId &&
      current.failure.kind === "ao_spawn_failed" &&
      task?.status === "pending";
    if (!task || (task.status !== "blocked_for_human" && task.status !== "failed" && !retryableFailedDispatch)) {
      throw new Error(`Task ${input.taskId} is not retryable`);
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

export async function approveManualGate(input: {
  store: ExecutionStateStore;
  workflowId: string;
  taskId: string;
  rationale: string;
  actor?: "user" | "cli";
  recovery?: boolean;
}): Promise<ExecutionState> {
  const rationale = input.rationale.trim();
  if (!rationale) {
    throw new Error("rationale is required");
  }
  const current = await input.store.readState(input.workflowId);
  if (current.status !== "waiting_manual_gate" && !(input.recovery && current.status === "running")) {
    throw new Error(`Workflow ${input.workflowId} is not waiting for manual gate approval`);
  }
  if (current.currentTaskId && current.currentTaskId !== input.taskId) {
    throw new Error(`Current manual gate is ${current.currentTaskId}, not ${input.taskId}`);
  }
  const plan = await input.store.readActiveTaskPlan(current);
  const task = plan.tasks.find((item) => item.taskId === input.taskId);
  if (!task) {
    throw new Error(`Unknown task ${input.taskId}`);
  }
  if (task.dependencyCondition !== "manual_gate") {
    throw new Error(`Task ${input.taskId} is not a manual_gate task`);
  }
  const artifactDir = input.store.getWorkflowDir(input.workflowId);
  const missing = await findMissingRequiredArtifacts(resolveInputArtifacts(task, plan, artifactDir));
  if (missing.length > 0) {
    const state = await input.store.update(input.workflowId, (state) =>
      failCurrentState(state, {
        taskId: input.taskId,
        kind: "artifact_context_missing",
        message: formatMissingArtifacts(missing)
      })
    ) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "artifact_context_missing",
      taskId: input.taskId,
      attempt: current.taskStates[input.taskId]?.attempt ?? 0,
      actor: input.actor ?? "user",
      missing
    });
    return state;
  }

  let generatedArtifacts: string[] = [];
  let writtenPaths: string[] = [];
  let synthesizedByThisRequest = false;
  try {
    const state = await input.store.update(input.workflowId, async (state) => {
      const existing = state.manualGateReleases.find((release) =>
        release.taskId === input.taskId && release.decision === "approved" && release.mode === "manual_approve"
      );
      if (existing && state.taskStates[input.taskId]?.status === "completed") {
        generatedArtifacts = existing.generatedArtifacts ?? [];
        return state;
      }
      if (state.status !== "waiting_manual_gate" && !(input.recovery && state.status === "running")) {
        throw new Error(`Workflow ${input.workflowId} is not waiting for manual gate approval`);
      }
      const artifacts = existing?.generatedArtifacts?.length
        ? {
          generatedArtifacts: existing.generatedArtifacts,
          writtenPaths: [] as string[]
        }
        : await findExistingManualGateArtifacts({ task, plan, artifactDir }) ?? await synthesizeManualGateArtifacts({
          task,
          plan,
          state,
          artifactDir,
          rationale,
          actor: input.actor ?? "user"
        });
      generatedArtifacts = artifacts.generatedArtifacts;
      writtenPaths = artifacts.writtenPaths;
      synthesizedByThisRequest = writtenPaths.length > 0 && !("reused" in artifacts);
      const taskState = state.taskStates[input.taskId];
      const attempt = taskState?.attempt ?? 0;
      const previousAoSessionId = taskState?.aoSessionId;
      const releases = state.manualGateReleases.filter((release) => release.taskId !== input.taskId);
      const at = new Date().toISOString();
      return {
        ...state,
        status: "running",
        currentTaskId: null,
        failure: null,
        supersededSessions: previousAoSessionId
          ? [...new Set([...(state.supersededSessions ?? []), previousAoSessionId])]
          : state.supersededSessions ?? [],
        manualGateReleases: [
          ...releases,
          {
            taskId: input.taskId,
            decision: "approved" as const,
            mode: "manual_approve" as const,
            rationale,
            releasedAt: at,
            attempt,
            generatedArtifacts,
            supersededAoSessionId: previousAoSessionId
          }
        ],
        taskStates: {
          ...state.taskStates,
          [input.taskId]: {
            ...(taskState ?? createTaskState(task, 0)),
            status: "completed" as const,
            aoRole: task.aoRole,
            aoSessionId: undefined,
            completedAt: at,
            failureReason: null
          }
        }
      };
    }) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "manual_gate_approved",
      taskId: input.taskId,
      attempt: state.taskStates[input.taskId]?.attempt ?? 0,
      actor: input.actor ?? "user",
      generatedArtifacts,
      rationale
    });
    return state;
  } catch (error) {
    if (synthesizedByThisRequest) {
      await cleanupFiles(writtenPaths);
    }
    const message = error instanceof Error ? error.message : String(error);
    const state = await input.store.update(input.workflowId, (state) =>
      failCurrentState(state, {
        taskId: input.taskId,
        kind: "manual_gate_artifact_write_failed",
        message
      })
    ) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "manual_gate_artifact_write_failed",
      taskId: input.taskId,
      attempt: current.taskStates[input.taskId]?.attempt ?? 0,
      actor: input.actor ?? "user",
      error: message
    });
    return state;
  }
}

export async function dispatchManualGateReview(input: {
  store: ExecutionStateStore;
  ao: Pick<AoCliAdapter, "spawnTask" | "listSessions">;
  workflowId: string;
  taskId: string;
  rationale: string;
  projectRoot?: string;
  actor?: "user" | "cli";
}): Promise<ExecutionState> {
  const rationale = input.rationale.trim();
  if (!rationale) {
    throw new Error("rationale is required");
  }
  const initial = await input.store.readState(input.workflowId);
  if (initial.status !== "waiting_manual_gate") {
    throw new Error(`Workflow ${input.workflowId} is not waiting for manual gate review dispatch`);
  }
  if (initial.currentTaskId !== input.taskId) {
    throw new Error(`Current manual gate is ${initial.currentTaskId ?? "none"}, not ${input.taskId}`);
  }
  const plan = await input.store.readActiveTaskPlan(initial);
  const task = plan.tasks.find((item) => item.taskId === input.taskId);
  if (!task) {
    throw new Error(`Unknown task ${input.taskId}`);
  }
  if (task.dependencyCondition !== "manual_gate") {
    throw new Error(`Task ${input.taskId} is not a manual_gate task`);
  }
  const existingRelease = initial.manualGateReleases.find((release) =>
    release.taskId === input.taskId &&
    release.decision === "review_dispatched" &&
    release.mode === "ao_review" &&
    release.aoSessionId
  );
  if (existingRelease && initial.taskStates[input.taskId]?.status === "working") {
    return initial;
  }

  await input.store.update(input.workflowId, (state) => {
    if (state.status !== "waiting_manual_gate" || state.currentTaskId !== input.taskId) {
      throw new Error(`Workflow ${input.workflowId} is not waiting for manual gate ${input.taskId}`);
    }
    const taskState = state.taskStates[input.taskId];
    const attempt = Math.max(1, (taskState?.attempt ?? 0) + 1);
    const dispatchId = `DISPATCH-${randomUUID()}`;
    const dispatchContextPath = getDispatchContextPath(input.store.getWorkflowDir(input.workflowId), input.taskId, attempt);
    return {
      ...state,
      status: "running",
      currentTaskId: input.taskId,
      failure: null,
      pendingDispatch: { dispatchId, taskId: input.taskId, attempt, createdAt: new Date().toISOString(), dispatchContextPath },
      taskStates: {
        ...state.taskStates,
        [input.taskId]: {
          ...(taskState ?? createTaskState(task, attempt)),
          status: "pending",
          aoRole: task.aoRole,
          attempt,
          dispatchContextPath,
          failureReason: null,
          statusObservations: []
        }
      }
    };
  });
  const state = await input.store.readState(input.workflowId);
  const pending = state.pendingDispatch;
  if (!pending) {
    return state;
  }
  const context = await buildAoDispatchContext({
    task,
    plan,
    state,
    projectRoot: input.projectRoot,
    artifactDir: input.store.getWorkflowDir(input.workflowId),
    attempt: pending.attempt,
    dispatchId: pending.dispatchId
  });
  await input.store.appendLog(input.workflowId, {
    type: "ao_dispatch_context_created",
    taskId: input.taskId,
    attempt: pending.attempt,
    actor: input.actor ?? "user",
    dispatchContextPath: context.contextPath
  });
  if (context.missingRequiredArtifacts.length > 0) {
    await cleanupFiles([context.contextPath]);
    const failed = await input.store.update(input.workflowId, (current) =>
      failCurrentState({
        ...current,
        pendingDispatch: null,
        taskStates: {
          ...current.taskStates,
          [input.taskId]: {
            ...(current.taskStates[input.taskId] ?? createTaskState(task, pending.attempt)),
            status: "blocked_for_human",
            aoRole: task.aoRole,
            failureReason: "artifact_context_missing",
            dispatchContextPath: context.contextPath
          }
        }
      }, {
        taskId: input.taskId,
        kind: "artifact_context_missing",
        message: formatMissingArtifacts(context.missingRequiredArtifacts)
      })
    ) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "artifact_context_missing",
      taskId: input.taskId,
      attempt: pending.attempt,
      actor: input.actor ?? "user",
      missing: context.missingRequiredArtifacts
    });
    return failed;
  }
  let spawnResult: AoSpawnResult;
  try {
    spawnResult = await input.ao.spawnTask({ ...task, aoPrompt: context.prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cleanupFiles([context.contextPath]);
    const failed = await input.store.update(input.workflowId, (current) =>
      failCurrentState({
        ...current,
        pendingDispatch: null,
        taskStates: {
          ...current.taskStates,
          [input.taskId]: {
            ...(current.taskStates[input.taskId] ?? createTaskState(task, pending.attempt)),
            status: "blocked_for_human",
            aoRole: task.aoRole,
            failureReason: "ao_spawn_failed",
            dispatchContextPath: context.contextPath
          }
        }
      }, {
        taskId: input.taskId,
        kind: "ao_spawn_failed",
        message
      })
    ) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "task_dispatch_failed",
      taskId: input.taskId,
      attempt: pending.attempt,
      actor: input.actor ?? "user",
      error: message
    });
    return failed;
  }
  if (!spawnResult.sessionId) {
    await cleanupFiles([context.contextPath]);
    const failed = await input.store.update(input.workflowId, (current) =>
      failCurrentState({
        ...current,
        pendingDispatch: null,
        taskStates: {
          ...current.taskStates,
          [input.taskId]: {
            ...(current.taskStates[input.taskId] ?? createTaskState(task, pending.attempt)),
            status: "blocked_for_human",
            aoRole: task.aoRole,
            failureReason: "ao_session_missing",
            dispatchContextPath: context.contextPath
          }
        }
      }, {
        taskId: input.taskId,
        kind: "ao_spawn_failed",
        message: "AO spawn did not return a sessionId; manual gate review dispatch is interrupted for manual recovery"
      })
    ) as ExecutionState;
    await input.store.appendLog(input.workflowId, {
      type: "task_dispatch_missing_session",
      taskId: input.taskId,
      attempt: pending.attempt,
      actor: input.actor ?? "user",
      error: "AO spawn did not return a sessionId"
    });
    return failed;
  }
  const updated = await input.store.update(input.workflowId, (current) => ({
    ...current,
    status: "running",
    currentTaskId: input.taskId,
    pendingDispatch: null,
    manualGateReleases: [
      ...current.manualGateReleases.filter((release) => release.taskId !== input.taskId),
      {
        taskId: input.taskId,
        decision: "review_dispatched" as const,
        mode: "ao_review" as const,
        rationale,
        releasedAt: new Date().toISOString(),
        attempt: pending.attempt,
        aoSessionId: spawnResult.sessionId,
        dispatchContextPath: context.contextPath
      }
    ],
    taskStates: {
      ...current.taskStates,
      [input.taskId]: {
        ...(current.taskStates[input.taskId] ?? createTaskState(task, pending.attempt)),
        status: "working" as const,
        aoRole: task.aoRole,
        aoSessionId: spawnResult.sessionId,
        attempt: pending.attempt,
        startedAt: new Date().toISOString(),
        completedAt: null,
        failureReason: null,
        dispatchContextPath: context.contextPath,
        statusObservations: []
      }
    }
  })) as ExecutionState;
  await input.store.appendLog(input.workflowId, {
    type: "manual_gate_review_dispatched",
    taskId: input.taskId,
    attempt: pending.attempt,
    actor: input.actor ?? "user",
    aoSessionId: spawnResult.sessionId,
    dispatchContextPath: context.contextPath
  });
  return updated;
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
      throw new Error("approved manual gate decisions must use approveManualGate to generate gate artifacts");
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

function attachAoSessionId(state: ExecutionState, taskId: string, aoSessionId: string): ExecutionState {
  const task = state.taskStates[taskId];
  if (!task) {
    return state;
  }
  return {
    ...state,
    taskStates: {
      ...state.taskStates,
      [taskId]: {
        ...task,
        aoSessionId
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

async function getConditionalSkipDecision(input: {
  task: ExecutionTask;
  plan: TaskPlan;
  state: ExecutionState;
  artifactDir: string;
}): Promise<{ reason: string; dependencyTaskId?: string; outcome?: string } | undefined> {
  const text = taskText(input.task);
  if (!isConditionalReworkTaskText(text)) {
    return undefined;
  }
  const dependencyTaskId = input.task.dependencies[0];
  if (!dependencyTaskId) {
    return undefined;
  }
  const outcome = await readDependencyOutcome({
    dependencyTaskId,
    plan: input.plan,
    state: input.state,
    artifactDir: input.artifactDir
  });
  if (!outcome) {
    return undefined;
  }
  if (isApprovedOutcome(outcome) && skipsOnApprovedPath(text)) {
    return {
      reason: "conditional branch skipped because upstream gate is approved",
      dependencyTaskId,
      outcome
    };
  }
  if (isPassOutcome(outcome) && skipsOnPassPath(text)) {
    return {
      reason: "conditional branch skipped because upstream verdict is pass",
      dependencyTaskId,
      outcome
    };
  }
  return undefined;
}

async function readDependencyOutcome(input: {
  dependencyTaskId: string;
  plan: TaskPlan;
  state: ExecutionState;
  artifactDir: string;
}): Promise<string | undefined> {
  const release = input.state.manualGateReleases.find((item) =>
    item.taskId === input.dependencyTaskId && item.decision !== "review_dispatched"
  );
  if (release) {
    return release.decision;
  }
  const dependencyTask = input.plan.tasks.find((task) => task.taskId === input.dependencyTaskId);
  if (!dependencyTask) {
    return undefined;
  }
  const decisionArtifact = resolveOutputArtifacts(dependencyTask, input.artifactDir)
    .find((artifact) => artifact.kind.includes("decision") || artifact.kind.includes("verdict"));
  if (!decisionArtifact) {
    return undefined;
  }
  try {
    const decision = JSON.parse(await readFile(decisionArtifact.path, "utf8")) as Record<string, unknown>;
    return typeof decision.decision === "string"
      ? decision.decision
      : typeof decision.verdict === "string"
        ? decision.verdict
        : undefined;
  } catch {
    return undefined;
  }
}

function isApprovedOutcome(outcome: string): boolean {
  return outcome === "approved";
}

function isPassOutcome(outcome: string): boolean {
  return outcome === "pass";
}

class ArtifactContextMissingError extends Error {
  constructor(readonly missing: MissingArtifact[]) {
    super(formatMissingArtifacts(missing));
  }
}

function formatMissingArtifacts(missing: MissingArtifact[]): string {
  return [
    "Required control-plane artifacts are missing:",
    ...missing.map((artifact) =>
      `- ${artifact.taskId ? `${artifact.taskId} / ` : ""}${artifact.kind}: ${artifact.path}${artifact.reason ? ` (${artifact.reason})` : ""}`
    )
  ].join("\n");
}

function formatConflictArtifacts(conflicts: ConflictArtifact[]): string {
  return [
    "Control-plane output artifacts conflict with the expected execution mode:",
    ...conflicts.map((artifact) =>
      `- ${artifact.taskId ? `${artifact.taskId} / ` : ""}${artifact.kind}: ${artifact.path} (${artifact.reason}, expected=${artifact.expected}, actual=${artifact.actual ?? ""})`
    )
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskText(task: ExecutionTask): string {
  return [task.title, task.description, task.aoPrompt, ...task.acceptanceCriteria].join("\n");
}
