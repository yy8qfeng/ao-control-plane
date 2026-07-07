import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AoCliAdapter } from "../adapters/ao.js";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import {
  findMissingRequiredArtifacts,
  resolveInputArtifacts,
  resolveOutputArtifacts,
  type MissingArtifact,
  type ResolvedArtifact
} from "../workflow/ao-dispatch-context.js";
import {
  approveManualGate,
  ContinuousExecutionRunner,
  decideManualGate,
  dispatchReworkTask,
  dispatchManualGateReview,
  markExecutionTaskCompleted,
  reconcileExecutionTaskArtifacts,
  retryExecutionTask,
  stopExecution
} from "../workflow/continuous-plan-execution.js";
import {
  type ExecutionState,
  type ExecutionLogEvent,
  type ExecutionTaskState,
  type ExecutionStateStore,
  summarizeExecutionState
} from "../workflow/execution-state-store.js";
import { normalizeAoSessions } from "../workflow/ao-status.js";
import {
  cleanupAoWorktrees,
  listWorktreeCleanupCandidates,
  type ArtifactReconcileResult
} from "../workflow/ao-output-reconcile.js";
import { getArtifactContractRegistry } from "../workflow/artifact-contract-registry.js";
import { acquireExecutionLock, type ExecutionLockHandle } from "../workflow/execution-lock.js";
import {
  requestTaskPlanRevision,
  type PlanRevisionRequest
} from "../workflow/task-plan-revision-review-loop.js";

type ExecutionAoAdapter = Pick<AoCliAdapter, "spawnTask" | "listSessions"> &
  Partial<Pick<AoCliAdapter, "validateDispatchPrerequisites">>;

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
  manualGateReleases?: ExecutionState["manualGateReleases"];
  manualGateContext?: ManualGateContextSnapshot;
  artifactDiagnostics?: ArtifactDiagnosticsSnapshot;
  aoOutcome?: AoOutcomeSnapshot;
}

export interface AoOutcomeSnapshot {
  taskId?: string;
  latestOutcome?: ExecutionLogEvent;
  latestStructuredDecision?: ExecutionLogEvent;
  latestRework?: ExecutionLogEvent;
  latestInvalid?: ExecutionLogEvent;
  error?: string;
}

export interface ManualGateContextSnapshot {
  taskId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  aoPrompt?: string;
  dependencies: string[];
  inputArtifacts: ResolvedArtifact[];
  expectedOutputs: ResolvedArtifact[];
  missingArtifacts: MissingArtifact[];
  generatedArtifacts?: string[];
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

export interface ArtifactDiagnosticsSnapshot {
  taskId?: string;
  contracts: Array<{
    contractId: string;
    kind: string;
    canonicalPath: string;
    required: boolean;
    requiredWhen?: string;
    canonicalExists: boolean;
    candidatePaths: Array<{
      source: string;
      purpose: string;
      path: string;
      priority: number;
    }>;
  }>;
  missingArtifacts: MissingArtifact[];
  latestReconcile?: unknown;
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

  constructor(
    private readonly input: {
      store: ExecutionStateStore;
      artifactRoot: string;
      projectRoot?: string;
      createAo: () => ExecutionAoAdapter;
      createCodex?: () => CodexAdapter;
      createClaudeCode?: () => ClaudeCodeAdapter;
    }
  ) {}

  async restoreFromDisk(): Promise<void> {
    const states = await this.input.store.scanStates();
    for (const scannedState of states) {
      const state = await this.recoverFailedTaskCompletedByAoReport(scannedState);
      const jobId = this.getJobId(state.workflowId);
      if (state.status === "running" || state.status === "waiting_manual_gate") {
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
            ao: this.input.createAo(),
            projectRoot: this.input.projectRoot
          });
          this.jobs.set(jobId, { jobId, workflowId: state.workflowId, runner, lock });
          runner.start();
        } catch {
          this.jobs.set(jobId, { jobId, workflowId: state.workflowId, readonly: true });
        }
      } else if (
        state.status === "stopped" ||
        state.status === "paused_for_replan" ||
        state.status === "failed"
      ) {
        this.jobs.set(jobId, { jobId, workflowId: state.workflowId, readonly: true });
      }
    }
  }

  async createOrResume(input: {
    workflowId: string;
    pollIntervalMs?: number;
    staleLockMs?: number;
  }): Promise<ExecutionJobSnapshot> {
    const state = await this.recoverFailedTaskCompletedByAoReport(
      await this.input.store.ensureState(input.workflowId)
    );
    if (state.status === "completed") {
      throw httpError(409, "Workflow execution is already completed");
    }
    if (state.status === "failed") {
      throw httpError(
        409,
        "Workflow execution is failed; please use retry, mark completed, or request revision from the AO execution panel first"
      );
    }
    if (state.status === "paused_for_replan") {
      throw httpError(
        409,
        state.failure?.kind === "manual_gate_rework_required"
          ? "Workflow execution is paused waiting for upstream rework"
          : "Workflow execution is paused for replan"
      );
    }
    if (state.status === "running") {
      const jobId = this.getJobId(input.workflowId);
      const job = this.jobs.get(jobId) ?? (await this.attachExistingJob(jobId));
      if (job) {
        const snapshot = await this.getSnapshot(jobId);
        return { ...snapshot, mode: "attached" };
      }
      throw httpError(409, "Workflow execution already has an active job");
    }

    const mode =
      state.status === "stopped" || state.status === "waiting_manual_gate" ? "resumed" : "created";
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
      projectRoot: this.input.projectRoot,
      pollIntervalMs: input.pollIntervalMs
    });
    this.jobs.set(jobId, { jobId, workflowId: input.workflowId, runner, lock });
    runner.start();
    const snapshot = await this.getSnapshot(jobId);
    return { ...snapshot, mode };
  }

  async getSnapshot(jobId: string): Promise<ExecutionJobSnapshot> {
    const job = this.jobs.get(jobId) ?? (await this.attachExistingJob(jobId));
    if (!job) {
      throw httpError(404, "execution job not found");
    }
    const state = await this.input.store.ensureState(job.workflowId);
    let summary: ReturnType<typeof summarizeExecutionState> | undefined;
    let tasks: ExecutionTaskSnapshot[] | undefined;
    let activeTask: ExecutionTaskSnapshot | undefined;
    let manualGateContext: ManualGateContextSnapshot | undefined;
    let artifactDiagnostics: ArtifactDiagnosticsSnapshot | undefined;
    let aoOutcome: AoOutcomeSnapshot | undefined;
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
      activeTask =
        tasks.find((task) => task.taskId === state.currentTaskId) ??
        tasks.find((task) => task.status === "working") ??
        tasks.find((task) => task.status === "blocked_for_human");
      manualGateContext = await this.buildManualGateContext(plan, state);
      artifactDiagnostics = await this.buildArtifactDiagnostics(plan, state);
    } catch {
      summary = undefined;
    }
    try {
      aoOutcome = await this.buildAoOutcomeSnapshot(state);
    } catch (error) {
      aoOutcome = {
        taskId: state.failure?.taskId ?? state.currentTaskId ?? undefined,
        error: formatErrorMessage(error)
      };
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
      readonly: job.readonly,
      manualGateReleases: state.manualGateReleases,
      manualGateContext,
      artifactDiagnostics,
      aoOutcome
    };
  }

  async getArtifactDiagnostics(jobId: string): Promise<ArtifactDiagnosticsSnapshot> {
    const job = this.requireJob(jobId);
    const state = await this.input.store.ensureState(job.workflowId);
    const plan = await this.input.store.readActiveTaskPlan(state);
    const diagnostics = await this.buildArtifactDiagnostics(plan, state);
    if (!diagnostics) {
      throw httpError(404, "No task is available for artifact diagnostics");
    }
    return diagnostics;
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
      await retryExecutionTask({
        store: this.input.store,
        workflowId: job.workflowId,
        taskId,
        actor: "user"
      });
      this.startRunner(job, ao);
      return this.getSnapshot(jobId);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
  }

  async markCompleted(
    jobId: string,
    taskId: string,
    rationale: string
  ): Promise<ExecutionJobSnapshot> {
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

  async decideManualGate(
    jobId: string,
    taskId: string,
    input: {
      decision: "approved" | "requires_replan" | "blocked";
      rationale: string;
    }
  ): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao =
      input.decision === "approved"
        ? await this.prepareContinuation(job, { skipAoCheck: true })
        : undefined;
    try {
      if (input.decision === "approved") {
        const state = await this.input.store.ensureState(job.workflowId);
        await approveManualGate({
          store: this.input.store,
          workflowId: job.workflowId,
          taskId,
          rationale: input.rationale,
          actor: "user",
          recovery: state.status === "running" ||
            state.failure?.kind === "ao_task_needs_structured_decision"
        });
      } else {
        await decideManualGate({
          store: this.input.store,
          workflowId: job.workflowId,
          taskId,
          decision: input.decision,
          rationale: input.rationale,
          actor: "user"
        });
      }
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

  async dispatchManualGateReview(
    jobId: string,
    taskId: string,
    rationale: string
  ): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao = await this.prepareContinuation(job);
    try {
      await dispatchManualGateReview({
        store: this.input.store,
        ao: ao ?? this.input.createAo(),
        workflowId: job.workflowId,
        taskId,
        rationale,
        projectRoot: this.input.projectRoot,
        actor: "user"
      });
      this.startRunner(job, ao);
      return this.getSnapshot(jobId);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
  }

  async reconcileArtifacts(jobId: string): Promise<{
    job: ExecutionJobSnapshot;
    taskId: string;
    aoSessionId?: string;
    reconcileResult?: ArtifactReconcileResult;
    completed: boolean;
    failureKind?:
      | "artifact_output_missing"
      | "artifact_output_conflict"
      | "artifact_output_reconcile_failed"
      | "artifact_output_ambiguous"
      | "artifact_contract_violation";
  }> {
    const job = this.requireJob(jobId);
    const state = await this.input.store.ensureState(job.workflowId);
    const taskId =
      state.failure?.taskId ??
      state.currentTaskId ??
      Object.values(state.taskStates).find(
        (task) =>
          task.status === "blocked_for_human" ||
          task.status === "failed" ||
          task.status === "pending"
      )?.taskId;
    if (!taskId) {
      throw httpError(400, "No current task is available for artifact reconciliation");
    }
    const taskState = state.taskStates[taskId];
    if (taskState?.status === "working") {
      throw httpError(
        409,
        `Task ${taskId} is still working; wait for AO terminal status before reconciling artifacts`
      );
    }
    const sessions = await this.safeListSessions();
    const result = await reconcileExecutionTaskArtifacts({
      store: this.input.store,
      workflowId: job.workflowId,
      taskId,
      projectRoot: this.input.projectRoot,
      sessions,
      actor: "web"
    });
    if (result.completed) {
      const ao = await this.prepareContinuation(job, { skipAoCheck: true });
      this.startRunner(job, ao);
    }
    return {
      job: await this.getSnapshot(jobId),
      taskId,
      aoSessionId: taskState?.aoSessionId,
      reconcileResult: result.reconcileResult,
      completed: result.completed,
      failureKind: result.failureKind
    };
  }

  async listWorktreeCleanupCandidates(jobId: string): Promise<unknown[]> {
    const job = this.requireJob(jobId);
    const state = await this.input.store.ensureState(job.workflowId);
    const sessions = await this.safeListSessions();
    const candidates = await listWorktreeCleanupCandidates({
      state,
      projectRoot: this.input.projectRoot,
      sessions
    });
    for (const candidate of candidates) {
      await this.input.store.appendLog(job.workflowId, {
        type: "worktree_cleanup_candidate_detected",
        taskId: state.currentTaskId ?? undefined,
        attempt: 0,
        actor: "web",
        candidate
      });
    }
    return candidates;
  }

  async cleanupWorktrees(
    jobId: string,
    input: { sessionIds: string[]; dryRun?: boolean }
  ): Promise<unknown> {
    const job = this.requireJob(jobId);
    const state = await this.input.store.ensureState(job.workflowId);
    const sessions = await this.safeListSessions();
    const result = await cleanupAoWorktrees({
      state,
      projectRoot: this.input.projectRoot,
      sessionIds: input.sessionIds,
      dryRun: input.dryRun,
      sessions
    });
    await this.input.store.appendLog(job.workflowId, {
      type: result.failures.length > 0 ? "worktree_cleanup_failed" : "worktree_cleanup_completed",
      taskId: state.currentTaskId ?? undefined,
      attempt: 0,
      actor: "web",
      result
    });
    return result;
  }

  async requestRevision(
    jobId: string,
    request: PlanRevisionRequest
  ): Promise<{
    job: ExecutionJobSnapshot;
    revision: unknown;
  }> {
    const job = this.requireJob(jobId);
    if (!this.input.createCodex || !this.input.createClaudeCode) {
      throw httpError(500, "Task plan revision requires Codex and ClaudeCode adapters");
    }
    const approvedDesign = await readFile(
      join(this.input.store.getWorkflowDir(job.workflowId), "design.md"),
      "utf8"
    );
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

  async dispatchReworkTask(
    jobId: string,
    input: { gateTaskId: string; targetTaskId: string; rationale: string }
  ): Promise<ExecutionJobSnapshot> {
    const job = this.requireJob(jobId);
    const ao = await this.prepareContinuation(job);
    try {
      await dispatchReworkTask({
        store: this.input.store,
        workflowId: job.workflowId,
        gateTaskId: input.gateTaskId,
        targetTaskId: input.targetTaskId,
        rationale: input.rationale,
        actor: "web"
      });
      this.startRunner(job, ao);
      return this.getSnapshot(jobId);
    } catch (error) {
      await this.releasePreparedContinuation(job);
      throw error;
    }
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
    job: ManagedExecutionJob,
    options: { skipAoCheck?: boolean } = {}
  ): Promise<ExecutionAoAdapter | undefined> {
    if (job.runner) {
      return undefined;
    }
    const ao = this.input.createAo();
    if (!options.skipAoCheck) {
      await this.ensureAoAvailable(ao, job);
    }
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

  private startRunner(job: ManagedExecutionJob, ao?: ExecutionAoAdapter): void {
    if (job.runner) {
      job.runner.start();
      return;
    }
    job.runner = new ContinuousExecutionRunner({
      workflowId: job.workflowId,
      store: this.input.store,
      ao: ao ?? this.input.createAo(),
      projectRoot: this.input.projectRoot
    });
    job.readonly = false;
    job.runner.start();
  }

  private async ensureAoAvailable(
    ao: Pick<AoCliAdapter, "listSessions"> &
      Partial<Pick<AoCliAdapter, "validateDispatchPrerequisites">>,
    job?: Pick<ManagedExecutionJob, "jobId" | "workflowId">
  ): Promise<void> {
    try {
      await ao.listSessions();
      await ao.validateDispatchPrerequisites?.();
    } catch (error) {
      const context = job ? `workflowId=${job.workflowId}, jobId=${job.jobId}。` : "";
      const original = formatErrorMessage(error);
      if (original.includes("GitHub CLI is not authenticated")) {
        throw httpError(
          503,
          `GitHub CLI 未认证，AO 派发任务必须先完成 GitHub 集成。请运行 gh auth login，并用 gh auth status 确认成功。${context}原始错误：${original}`
        );
      }
      throw httpError(
        503,
        `AO 未启动或不可用，请先启动 AO 后再启动连续执行。${context}原始错误：${original}`
      );
    }
  }

  private async safeListSessions() {
    try {
      return normalizeAoSessions(await this.input.createAo().listSessions());
    } catch {
      return [];
    }
  }

  private async recoverFailedTaskCompletedByAoReport(
    state: ExecutionState
  ): Promise<ExecutionState> {
    const taskId = state.failure?.taskId ?? state.currentTaskId ?? undefined;
    if (state.status !== "failed" || !taskId) {
      return state;
    }
    const task = state.taskStates[taskId];
    if (!task?.aoSessionId) {
      return state;
    }
    if (state.supersededSessions?.includes(task.aoSessionId)) {
      return state;
    }

    let sessions;
    try {
      sessions = normalizeAoSessions(await this.input.createAo().listSessions());
    } catch {
      return state;
    }
    const session = sessions.find((item) => item.id === task.aoSessionId);
    if (session?.status !== "completed") {
      return state;
    }

    // Restore only the artifact evidence for the completed AO report here.
    // Runner startup remains an explicit web action outside disk-scan recovery.
    const recovered = await reconcileExecutionTaskArtifacts({
      store: this.input.store,
      workflowId: state.workflowId,
      taskId,
      projectRoot: this.input.projectRoot,
      sessions,
      actor: "web"
    });
    return recovered.state;
  }

  private async buildManualGateContext(
    plan: Awaited<ReturnType<ExecutionStateStore["readActiveTaskPlan"]>>,
    state: ExecutionState
  ): Promise<ManualGateContextSnapshot | undefined> {
    if (
      !["waiting_manual_gate", "running", "failed", "paused_for_replan"].includes(state.status) ||
      !state.currentTaskId
    ) {
      return undefined;
    }
    const task = plan.tasks.find((item) => item.taskId === state.currentTaskId);
    if (!task || task.dependencyCondition !== "manual_gate") {
      return undefined;
    }
    const artifactDir = this.input.store.getWorkflowDir(state.workflowId);
    const inputArtifacts = resolveInputArtifacts(task, plan, artifactDir);
    const release = state.manualGateReleases.find(
      (item) => item.taskId === task.taskId && item.mode === "manual_approve"
    );
    return {
      taskId: task.taskId,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      aoPrompt: task.aoPrompt,
      dependencies: task.dependencies,
      inputArtifacts,
      expectedOutputs: resolveOutputArtifacts(task, artifactDir),
      missingArtifacts: await findMissingRequiredArtifacts(inputArtifacts),
      generatedArtifacts: release?.generatedArtifacts
    };
  }

  private async buildArtifactDiagnostics(
    plan: Awaited<ReturnType<ExecutionStateStore["readActiveTaskPlan"]>>,
    state: ExecutionState
  ): Promise<ArtifactDiagnosticsSnapshot | undefined> {
    const taskId =
      state.failure?.taskId ??
      state.currentTaskId ??
      Object.values(state.taskStates).find(
        (task) => task.status === "blocked_for_human" || task.status === "failed"
      )?.taskId;
    const task = taskId ? plan.tasks.find((item) => item.taskId === taskId) : undefined;
    if (!task) {
      return undefined;
    }
    const artifactDir = this.input.store.getWorkflowDir(state.workflowId);
    const registry = getArtifactContractRegistry();
    const expectedOutputs = resolveOutputArtifacts(task, artifactDir);
    const logs = await this.input.store.readLogs(state.workflowId, 100);
    const latestReconcile = [...logs]
      .reverse()
      .find(
        (event) =>
          event.taskId === task.taskId &&
          (event.type === "artifact_output_reconcile_started" ||
            event.type === "artifact_output_reconcile_failed" ||
            event.type === "artifact_output_conflict" ||
            event.type === "artifact_output_missing")
      );
    return {
      taskId: task.taskId,
      contracts: await Promise.all(
        expectedOutputs
          .flatMap((artifact) => {
            const contract = registry.resolveContractForArtifact(artifact);
            return contract
              ? [
                  {
                    contractId: contract.id,
                    kind: contract.kind,
                    canonicalPath: artifact.path,
                    required: artifact.required,
                    requiredWhen: artifact.requiredWhen,
                    canonicalExists: false,
                    candidatePaths: contract.candidatePaths.map((candidate) => ({
                      source: candidate.source,
                      purpose: candidate.purpose,
                      path: candidate.file,
                      priority: candidate.priority
                    }))
                  }
                ]
              : [];
          })
          .map(async (item) => ({
            ...item,
            canonicalExists: !(
              await findMissingRequiredArtifacts([
                {
                  kind: item.kind,
                  path: item.canonicalPath,
                  required: true
                }
              ])
            ).length
          }))
      ),
      missingArtifacts: await findMissingRequiredArtifacts(
        expectedOutputs.filter((artifact) => artifact.required)
      ),
      latestReconcile
    };
  }

  private async buildAoOutcomeSnapshot(state: ExecutionState): Promise<AoOutcomeSnapshot | undefined> {
    const taskId = state.failure?.taskId ?? state.currentTaskId ?? undefined;
    const logs = await this.input.store.readLogs(state.workflowId, 100);
    const latestOutcome = [...logs]
      .reverse()
      .find((event) => event.type === "ao_task_outcome_resolved" && (!taskId || event.taskId === taskId));
    const latestStructuredDecision = [...logs]
      .reverse()
      .find((event) => event.type === "ao_task_needs_structured_decision" && (!taskId || event.taskId === taskId));
    const latestRework = [...logs]
      .reverse()
      .find((event) => event.type === "manual_gate_rework_required" && (!taskId || event.taskId === taskId));
    const latestInvalid = [...logs]
      .reverse()
      .find((event) => event.type === "ao_task_outcome_invalid" && (!taskId || event.taskId === taskId));
    if (!latestOutcome && !latestStructuredDecision && !latestRework && !latestInvalid) {
      return undefined;
    }
    return {
      taskId,
      latestOutcome,
      latestStructuredDecision,
      latestRework,
      latestInvalid
    };
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
