import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AoCliAdapter } from "../adapters/ao.js";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import {
  ContinuousExecutionRunner,
  decideManualGate,
  markExecutionTaskCompleted,
  retryExecutionTask,
  stopExecution
} from "../workflow/continuous-plan-execution.js";
import {
  type ExecutionState,
  type ExecutionTaskState,
  type ExecutionStateStore,
  summarizeExecutionState
} from "../workflow/execution-state-store.js";
import { acquireExecutionLock, type ExecutionLockHandle } from "../workflow/execution-lock.js";
import { requestTaskPlanRevision, type PlanRevisionRequest } from "../workflow/task-plan-revision-review-loop.js";

export interface ExecutionJobSnapshot {
  jobId: string;
  workflowId: string;
  mode?: "created" | "resumed" | "attached";
  status: ExecutionState["status"];
  currentTaskId?: string | null;
  summary?: ReturnType<typeof summarizeExecutionState>;
  activeTask?: ExecutionTaskSnapshot;
  tasks?: ExecutionTaskSnapshot[];
  failure?: ExecutionState["failure"];
  logs?: unknown[];
  readonly?: boolean;
}

export interface ExecutionTaskSnapshot {
  taskId: string;
  title?: string;
  type?: string;
  status: ExecutionTaskState["status"] | string;
  aoRole?: string;
  aoSessionId?: string;
  attempt?: number;
  maxAttempts?: number;
  startedAt?: string;
  completedAt?: string | null;
  failureReason?: string | null;
  statusObservations?: ExecutionTaskState["statusObservations"];
}

interface ManagedExecutionJob {
  jobId: string;
  workflowId: string;
  runner?: ContinuousExecutionRunner;
  lock?: ExecutionLockHandle;
  readonly?: boolean;
}

export class ExecutionJobManager {
  private readonly jobs = new Map<string, ManagedExecutionJob>();

  constructor(private readonly input: {
    store: ExecutionStateStore;
    artifactRoot: string;
    createAo: () => Pick<AoCliAdapter, "spawnTask" | "listSessions">;
    createCodex?: () => CodexAdapter;
    createClaudeCode?: () => ClaudeCodeAdapter;
  }) {}

  async restoreFromDisk(): Promise<void> {
    const states = await this.input.store.scanStates();
    for (const state of states) {
      const jobId = this.getJobId(state.workflowId);
      if (state.status === "running") {
        try {
          const lock = await acquireExecutionLock({
            artifactRoot: this.input.artifactRoot,
            workflowId: state.workflowId,
            holder: "web",
            jobId
          });
          const runner = new ContinuousExecutionRunner({
            workflowId: state.workflowId,
            store: this.input.store,
            ao: this.input.createAo()
          });
          this.jobs.set(jobId, { jobId, workflowId: state.workflowId, runner, lock });
          runner.start();
        } catch {
          this.jobs.set(jobId, { jobId, workflowId: state.workflowId, readonly: true });
        }
      } else if (state.status === "stopped" || state.status === "waiting_manual_gate" || state.status === "paused_for_replan" || state.status === "failed") {
        this.jobs.set(jobId, { jobId, workflowId: state.workflowId, readonly: true });
      }
    }
  }

  async createOrResume(input: {
    workflowId: string;
    pollIntervalMs?: number;
    staleLockMs?: number;
  }): Promise<ExecutionJobSnapshot> {
    const state = await this.input.store.ensureState(input.workflowId);
    if (state.status === "completed") {
      throw httpError(409, "Workflow execution is already completed");
    }
    if (state.status === "failed") {
      throw httpError(409, "Workflow execution is failed; please use retry, mark completed, or request revision from the AO execution panel first");
    }
    if (state.status === "paused_for_replan") {
      throw httpError(409, "Workflow execution is paused for replan");
    }
    if (state.status === "waiting_manual_gate") {
      throw httpError(409, "Workflow execution is waiting for manual gate decision");
    }
    if (state.status === "running") {
      const jobId = this.getJobId(input.workflowId);
      const job = this.jobs.get(jobId) ?? await this.attachExistingJob(jobId);
      if (job) {
        const snapshot = await this.getSnapshot(jobId);
        return { ...snapshot, mode: "attached" };
      }
      throw httpError(409, "Workflow execution already has an active job");
    }

    const mode = state.status === "stopped" ? "resumed" : "created";
    const jobId = this.getJobId(input.workflowId);
    const ao = this.input.createAo();
    await this.ensureAoAvailable(ao);
    const lock = await acquireExecutionLock({
      artifactRoot: this.input.artifactRoot,
      workflowId: input.workflowId,
      holder: "web",
      jobId,
      staleLockMs: input.staleLockMs
    });
    const runner = new ContinuousExecutionRunner({
      workflowId: input.workflowId,
      store: this.input.store,
      ao,
      pollIntervalMs: input.pollIntervalMs
    });
    this.jobs.set(jobId, { jobId, workflowId: input.workflowId, runner, lock });
    runner.start();
    const snapshot = await this.getSnapshot(jobId);
    return { ...snapshot, mode };
  }

  async getSnapshot(jobId: string): Promise<ExecutionJobSnapshot> {
    const job = this.jobs.get(jobId) ?? await this.attachExistingJob(jobId);
    if (!job) {
      throw httpError(404, "execution job not found");
    }
    const state = await this.input.store.ensureState(job.workflowId);
    let summary: ReturnType<typeof summarizeExecutionState> | undefined;
    let tasks: ExecutionTaskSnapshot[] | undefined;
    let activeTask: ExecutionTaskSnapshot | undefined;
    try {
      const plan = await this.input.store.readActiveTaskPlan(state);
      summary = summarizeExecutionState(plan, state);
      tasks = plan.tasks.map((task) => {
        const runtime = state.taskStates[task.taskId];
        return {
          taskId: task.taskId,
          title: task.title,
          type: task.type,
          status: runtime?.status ?? task.status,
          aoRole: runtime?.aoRole ?? task.aoRole,
          aoSessionId: runtime?.aoSessionId,
          attempt: runtime?.attempt,
          maxAttempts: runtime?.maxAttempts,
          startedAt: runtime?.startedAt,
          completedAt: runtime?.completedAt,
          failureReason: runtime?.failureReason,
          statusObservations: runtime?.statusObservations
        };
      });
      activeTask = tasks.find((task) => task.taskId === state.currentTaskId) ??
        tasks.find((task) => task.status === "working") ??
        tasks.find((task) => task.status === "blocked_for_human");
    } catch {
      summary = undefined;
    }
    return {
      jobId,
      workflowId: job.workflowId,
      status: state.status,
      currentTaskId: state.currentTaskId ?? null,
      summary,
      activeTask,
      tasks,
      failure: state.failure,
      logs: await this.input.store.readLogs(job.workflowId, 100),
      readonly: job.readonly
    };
  }

  async stop(jobId: string): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    job.runner?.requestStop();
    await stopExecution({ store: this.input.store, workflowId: job.workflowId, actor: "user" });
    await job.lock?.release();
    job.readonly = true;
    return this.getSnapshot(jobId);
  }

  async resume(jobId: string, pollIntervalMs?: number): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const state = await this.input.store.ensureState(job.workflowId);
    if (state.status !== "stopped") {
      throw httpError(400, "Only stopped execution jobs can be resumed");
    }
    return this.createOrResume({ workflowId: job.workflowId, pollIntervalMs });
  }

  async retry(jobId: string, taskId: string): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao = await this.prepareContinuation(job);
    try {
      await retryExecutionTask({ store: this.input.store, workflowId: job.workflowId, taskId, actor: "user" });
      this.startRunner(job, ao);
      return this.getSnapshot(jobId);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
  }

  async markCompleted(jobId: string, taskId: string, rationale: string): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao = await this.prepareContinuation(job);
    try {
      await markExecutionTaskCompleted({
        store: this.input.store,
        workflowId: job.workflowId,
        taskId,
        rationale,
        actor: "user"
      });
      this.startRunner(job, ao);
      return this.getSnapshot(jobId);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
  }

  async decideManualGate(jobId: string, taskId: string, input: {
    decision: "approved" | "requires_replan" | "blocked";
    rationale: string;
  }): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao = input.decision === "approved" ? await this.prepareContinuation(job) : undefined;
    try {
      await decideManualGate({
        store: this.input.store,
        workflowId: job.workflowId,
        taskId,
        decision: input.decision,
        rationale: input.rationale,
        actor: "user"
      });
      if (input.decision === "approved") {
        this.startRunner(job, ao);
      }
      return this.getSnapshot(jobId);
    } catch (error) {
      if (input.decision === "approved") {
        await this.releasePreparedContinuation(job);
      }
      throw error;
    }
  }

  async requestRevision(jobId: string, request: PlanRevisionRequest): Promise<{
    job: ExecutionJobSnapshot;
    revision: unknown;
  }> {
    const job = this.requireJob(jobId);
    if (!this.input.createCodex || !this.input.createClaudeCode) {
      throw httpError(500, "Task plan revision requires Codex and ClaudeCode adapters");
    }
    const approvedDesign = await readFile(join(this.input.store.getWorkflowDir(job.workflowId), "design.md"), "utf8");
    const revision = await requestTaskPlanRevision({
      store: this.input.store,
      codex: this.input.createCodex(),
      claudeCode: this.input.createClaudeCode(),
      workflowId: job.workflowId,
      approvedDesign,
      request
    });
    if (revision.approved) {
      await this.ensureRunner(job);
    }
    return { job: await this.getSnapshot(jobId), revision };
  }

  getJobId(workflowId: string): string {
    return `EXEC-${workflowId}`;
  }

  private requireJob(jobId: string): ManagedExecutionJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw httpError(404, "execution job not found");
    }
    return job;
  }

  private async attachExistingJob(jobId: string): Promise<ManagedExecutionJob | undefined> {
    const existing = this.jobs.get(jobId);
    if (existing) {
      return existing;
    }
    if (!jobId.startsWith("EXEC-")) {
      return undefined;
    }
    const workflowId = jobId.slice("EXEC-".length);
    let state: ExecutionState;
    try {
      state = await this.input.store.readState(workflowId);
    } catch {
      return undefined;
    }
    const job: ManagedExecutionJob = {
      jobId,
      workflowId: state.workflowId,
      readonly: true
    };
    this.jobs.set(jobId, job);
    return job;
  }

  private async ensureRunner(job: ManagedExecutionJob): Promise<void> {
    const ao = await this.prepareContinuation(job);
    try {
      this.startRunner(job, ao);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
  }

  private async prepareContinuation(
    job: ManagedExecutionJob
  ): Promise<Pick<AoCliAdapter, "spawnTask" | "listSessions"> | undefined> {
    if (job.runner) {
      return undefined;
    }
    const ao = this.input.createAo();
    await this.ensureAoAvailable(ao, job);
    job.lock ??= await acquireExecutionLock({
      artifactRoot: this.input.artifactRoot,
      workflowId: job.workflowId,
      holder: "web",
      jobId: job.jobId
    });
    return ao;
  }

  private async releasePreparedContinuation(job: ManagedExecutionJob): Promise<void> {
    if (job.runner || !job.lock) {
      return;
    }
    await job.lock.release();
    job.lock = undefined;
    job.readonly = true;
  }

  private startRunner(
    job: ManagedExecutionJob,
    ao?: Pick<AoCliAdapter, "spawnTask" | "listSessions">
  ): void {
    if (job.runner) {
      job.runner.start();
      return;
    }
    job.runner = new ContinuousExecutionRunner({
      workflowId: job.workflowId,
      store: this.input.store,
      ao: ao ?? this.input.createAo()
    });
    job.readonly = false;
    job.runner.start();
  }

  private async ensureAoAvailable(
    ao: Pick<AoCliAdapter, "listSessions">,
    job?: Pick<ManagedExecutionJob, "jobId" | "workflowId">
  ): Promise<void> {
    try {
      await ao.listSessions();
    } catch (error) {
      const context = job ? `workflowId=${job.workflowId}, jobId=${job.jobId}。` : "";
      throw httpError(
        503,
        `AO 未启动或不可用，请先启动 AO 后再启动连续执行。${context}原始错误：${formatErrorMessage(error)}`
      );
    }
  }
}

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
