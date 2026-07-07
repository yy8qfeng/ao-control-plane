import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import {
  TASK_PLAN_NORMALIZATION_SOURCE,
  parseTaskPlanWithNormalization
} from "./task-plan-normalizer.js";
import type { ManualGateRelease } from "./task-readiness.js";

export type PlanVersion = "task-plan-current" | `task-plan-v${number}`;

export type ExecutionJobStatus =
  | "idle"
  | "running"
  | "waiting_manual_gate"
  | "paused_for_replan"
  | "failed"
  | "completed"
  | "stopped";

export type ExecutionTaskRuntimeStatus =
  "pending" | "working" | "completed" | "blocked_for_human" | "failed" | "superseded";

export type ExecutionErrorKind =
  | "ao_spawn_failed"
  | "ao_status_failed"
  | "ao_task_failed"
  | "ao_task_stuck"
  | "ao_task_needs_input"
  | "ao_task_needs_structured_decision"
  | "manual_gate_blocked"
  | "manual_gate_requires_replan"
  | "manual_gate_rework_required"
  | "revision_requested"
  | "revision_failed"
  | "dependency_deadlock"
  | "artifact_context_missing"
  | "artifact_contract_missing"
  | "artifact_contract_violation"
  | "artifact_input_conflict"
  | "artifact_output_ambiguous"
  | "artifact_output_missing"
  | "artifact_output_conflict"
  | "artifact_output_reconcile_failed"
  | "manual_gate_artifact_write_failed"
  | "plan_missing"
  | "plan_invalid"
  | "state_corrupted"
  | "dispatcher_stopped"
  | "worktree_cleanup_failed";

export interface ExecutionFailure {
  taskId?: string;
  kind: ExecutionErrorKind;
  message: string;
  occurredAt: string;
  spawnCandidateSessionIds?: string[];
}

export interface AoStatusObservation {
  attempt: number;
  status: string;
  observedAt: string;
}

export const executionLogTypeSchema = z.enum([
  "ao_dispatch_context_created",
  "artifact_context_missing",
  "artifact_contract_missing",
  "artifact_contract_resolved",
  "artifact_contract_violation",
  "artifact_canonical_verified",
  "artifact_candidate_found",
  "artifact_candidate_rejected",
  "artifact_input_conflict",
  "artifact_output_ambiguous",
  "artifact_output_conflict",
  "artifact_output_missing",
  "artifact_output_normalized",
  "artifact_output_reconcile_failed",
  "artifact_output_reconcile_skipped",
  "artifact_output_reconcile_started",
  "artifact_output_recovered_from_worktree",
  "ao_task_needs_structured_decision",
  "ao_task_needs_input",
  "ao_task_outcome_invalid",
  "ao_task_outcome_resolved",
  "dispatcher_stopped",
  "manual_gate_approved",
  "manual_gate_artifact_write_failed",
  "manual_gate_decision_invalid",
  "manual_gate_decided",
  "manual_gate_rework_required",
  "manual_gate_review_dispatched",
  "migrate_plan_status_confirmed",
  "manual_gate_waiting",
  "task_completed_from_ao_report",
  "task_dispatch_failed",
  "task_dispatch_missing_session",
  "task_dispatch_orphaned",
  "task_dispatched",
  "task_execution_missing_session",
  "task_marked_completed",
  "task_retry_requested",
  "task_skipped",
  "worktree_cleanup_candidate_detected",
  "worktree_cleanup_completed",
  "worktree_cleanup_failed",
  "worktree_path_discovered_via_fallback"
]);

export type ExecutionLogType = z.infer<typeof executionLogTypeSchema>;

export interface ExecutionTaskState {
  taskId: string;
  status: ExecutionTaskRuntimeStatus;
  aoRole: string;
  aoSessionId?: string;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string | null;
  failureReason?: string | null;
  statusObservations?: AoStatusObservation[];
  dispatchContextPath?: string;
  markedCompletedBy?: {
    actor: "user" | "cli";
    rationale: string;
    at: string;
  };
}

export interface PendingDispatch {
  dispatchId: string;
  taskId: string;
  attempt: number;
  createdAt: string;
  dispatchContextPath?: string;
  spawnCandidateSessionIds?: string[];
}

export interface ExecutionState {
  workflowId: string;
  planVersion: PlanVersion;
  planPath: string;
  status: ExecutionJobStatus;
  currentTaskId?: string | null;
  startedAt?: string | null;
  updatedAt: string;
  completedAt?: string | null;
  stoppedAt?: string | null;
  failure?: ExecutionFailure | null;
  taskStates: Record<string, ExecutionTaskState>;
  manualGateReleases: ManualGateRelease[];
  pendingDispatch?: PendingDispatch | null;
  supersededSessions?: string[];
}

export interface ExecutionLogEvent {
  type: string;
  taskId?: string;
  attempt: number;
  actor: "runner" | "user" | "cli" | "web";
  at: string;
  [key: string]: unknown;
}

export type AppendExecutionLogEvent = Omit<ExecutionLogEvent, "at" | "type"> & {
  type: ExecutionLogType;
  at?: string;
};

export interface RevisionAmendment {
  revision: number;
  workflowId: string;
  triggerTaskId: string;
  reasonCategory: string;
  rationale: string;
  createdAt: string;
  status: "pending" | "approved" | "failed" | "abandoned";
}

export interface ExecutionRebaseReport {
  revision: number;
  workflowId: string;
  previousPlanVersion: PlanVersion;
  nextPlanVersion: PlanVersion;
  generatedAt: string;
  carriedTaskIds: string[];
  supersededTaskIds: string[];
  conflictTaskIds: string[];
}

const planVersionSchema = z.union([
  z.literal("task-plan-current"),
  z.string().regex(/^task-plan-v\d+$/)
]) as z.ZodType<PlanVersion>;

const executionStateSchema = z.object({
  workflowId: z.string().min(1),
  planVersion: planVersionSchema,
  planPath: z.string().min(1),
  status: z.enum([
    "idle",
    "running",
    "waiting_manual_gate",
    "paused_for_replan",
    "failed",
    "completed",
    "stopped"
  ]),
  currentTaskId: z.string().min(1).nullable().optional(),
  startedAt: z.string().nullable().optional(),
  updatedAt: z.string().min(1),
  completedAt: z.string().nullable().optional(),
  stoppedAt: z.string().nullable().optional(),
  failure: z
    .object({
      taskId: z.string().min(1).optional(),
      kind: z.enum([
        "ao_spawn_failed",
        "ao_status_failed",
        "ao_task_failed",
        "ao_task_stuck",
        "ao_task_needs_input",
        "ao_task_needs_structured_decision",
        "manual_gate_blocked",
        "manual_gate_requires_replan",
        "manual_gate_rework_required",
        "revision_requested",
        "revision_failed",
        "dependency_deadlock",
    "artifact_context_missing",
    "artifact_contract_missing",
    "artifact_contract_violation",
    "artifact_input_conflict",
    "artifact_output_ambiguous",
    "artifact_output_missing",
        "artifact_output_conflict",
        "artifact_output_reconcile_failed",
        "manual_gate_artifact_write_failed",
        "plan_missing",
        "plan_invalid",
        "state_corrupted",
        "dispatcher_stopped",
        "worktree_cleanup_failed"
      ]),
      message: z.string().min(1),
      occurredAt: z.string().min(1),
      spawnCandidateSessionIds: z.array(z.string().min(1)).optional()
    })
    .nullable()
    .optional(),
  taskStates: z.record(
    z.object({
      taskId: z.string().min(1),
      status: z.enum([
        "pending",
        "working",
        "completed",
        "blocked_for_human",
        "failed",
        "superseded"
      ]),
      aoRole: z.string().min(1),
      aoSessionId: z.string().min(1).optional(),
      attempt: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
      startedAt: z.string().optional(),
      completedAt: z.string().nullable().optional(),
      failureReason: z.string().nullable().optional(),
      statusObservations: z
        .array(
          z.object({
            attempt: z.number().int().nonnegative(),
            status: z.string().min(1),
            observedAt: z.string().min(1)
          })
        )
        .optional(),
      dispatchContextPath: z.string().min(1).optional(),
      markedCompletedBy: z
        .object({
          actor: z.enum(["user", "cli"]),
          rationale: z.string().min(1),
          at: z.string().min(1)
        })
        .optional()
    })
  ),
  manualGateReleases: z
    .array(
      z.object({
        taskId: z.string().min(1),
        decision: z.enum(["approved", "requires_replan", "blocked", "review_dispatched"]),
        mode: z.enum(["manual_approve", "ao_review"]).optional(),
        rationale: z.string().optional(),
        releasedAt: z.string().optional(),
        attempt: z.number().int().nonnegative().optional(),
        generatedArtifacts: z.array(z.string().min(1)).optional(),
        dispatchContextPath: z.string().min(1).optional(),
        aoSessionId: z.string().min(1).optional(),
        supersededAoSessionId: z.string().min(1).optional()
      })
    )
    .default([]),
  pendingDispatch: z
    .object({
      dispatchId: z.string().min(1),
      taskId: z.string().min(1),
      attempt: z.number().int().positive(),
      createdAt: z.string().min(1),
      dispatchContextPath: z.string().min(1).optional(),
      spawnCandidateSessionIds: z.array(z.string().min(1)).optional()
    })
    .nullable()
    .optional(),
  supersededSessions: z.array(z.string().min(1)).default([])
});

const stateStores = new Map<string, ExecutionStateStore>();

export function getExecutionStateStore(artifactRoot: string): ExecutionStateStore {
  const key = artifactRoot;
  let store = stateStores.get(key);
  if (!store) {
    store = new ExecutionStateStore(artifactRoot);
    stateStores.set(key, store);
  }
  return store;
}

export class ExecutionStateStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly artifactRoot: string) {}

  getWorkflowDir(workflowId: string): string {
    return join(this.artifactRoot, workflowId);
  }

  async ensureState(workflowId: string): Promise<ExecutionState> {
    return this.update(workflowId, async (state) => state);
  }

  async readState(workflowId: string): Promise<ExecutionState> {
    const workflowDir = this.getWorkflowDir(workflowId);
    const raw = await readFile(join(workflowDir, "execution-state.json"), "utf8");
    const parsed = executionStateSchema.parse(JSON.parse(raw));
    await this.validatePlanVersion(workflowId, parsed.planVersion);
    return parsed;
  }

  async readLogs(workflowId: string, limit = 100): Promise<ExecutionLogEvent[]> {
    try {
      const raw = await readFile(
        join(this.getWorkflowDir(workflowId), "execution-log.jsonl"),
        "utf8"
      );
      return raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as ExecutionLogEvent);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async update<T>(
    workflowId: string,
    mutator: (
      state: ExecutionState
    ) =>
      | Promise<ExecutionState | { state: ExecutionState; value: T }>
      | ExecutionState
      | { state: ExecutionState; value: T }
  ): Promise<T | ExecutionState> {
    return this.enqueue(workflowId, async () => {
      const workflowDir = this.getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });
      const state = await this.readStateOrCreate(workflowId);
      const mutated = await mutator(cloneState(state));
      const nextState = "state" in mutated ? mutated.state : mutated;
      nextState.updatedAt = new Date().toISOString();
      await this.validatePlanVersion(workflowId, nextState.planVersion);
      await atomicWriteJson(join(workflowDir, "execution-state.json"), nextState);
      return "state" in mutated ? mutated.value : nextState;
    });
  }

  async appendLog(workflowId: string, event: AppendExecutionLogEvent): Promise<void> {
    await this.enqueue(workflowId, async () => {
      const workflowDir = this.getWorkflowDir(workflowId);
      await mkdir(workflowDir, { recursive: true });
      const normalized = { ...event, at: event.at ?? new Date().toISOString() };
      await appendFile(
        join(workflowDir, "execution-log.jsonl"),
        `${JSON.stringify(normalized)}\n`,
        "utf8"
      );
    });
  }

  async readActiveTaskPlan(state: ExecutionState): Promise<TaskPlan> {
    const initialPlanVersion = state.planVersion;
    const workflowDir = this.getWorkflowDir(state.workflowId);
    const planPath = join(workflowDir, state.planPath);
    let raw: string;
    try {
      raw = await readFile(planPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.failState(state.workflowId, {
          kind: "plan_missing",
          message: `Active plan file does not exist: ${state.planPath}`
        });
      }
      throw error;
    }

    const latest = await this.readState(state.workflowId);
    if (latest.planVersion !== initialPlanVersion) {
      throw new Error("Active plan version changed during read; retry required");
    }

    try {
      return parseTaskPlanWithNormalization(
        JSON.parse(raw) as unknown,
        {
          workflowId: state.workflowId,
          source: TASK_PLAN_NORMALIZATION_SOURCE.artifact
        },
        `Workflow ${state.workflowId} active task plan is invalid`
      );
    } catch (error) {
      await this.failState(state.workflowId, {
        kind: "plan_invalid",
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async writeRevisionArtifacts(input: {
    workflowId: string;
    revision: number;
    amendment: RevisionAmendment;
    draftPlan?: TaskPlan;
    finalPlan?: TaskPlan;
    reviews?: unknown[];
    rebaseReport?: ExecutionRebaseReport;
  }): Promise<void> {
    const workflowDir = this.getWorkflowDir(input.workflowId);
    await mkdir(workflowDir, { recursive: true });
    await atomicWriteJson(
      join(workflowDir, `task-plan-amendment-${input.revision}.json`),
      input.amendment
    );
    if (input.draftPlan) {
      await atomicWriteJson(
        join(workflowDir, `task-plan-v${input.revision}-draft.json`),
        input.draftPlan
      );
    }
    for (const [index, review] of (input.reviews ?? []).entries()) {
      await atomicWriteJson(
        join(workflowDir, `task-plan-review-v${input.revision}-${index + 1}.json`),
        review
      );
    }
    if (input.finalPlan) {
      taskPlanSchema.parse(input.finalPlan);
      await atomicWriteJson(
        join(workflowDir, `task-plan-v${input.revision}.json`),
        input.finalPlan
      );
    }
    if (input.rebaseReport) {
      await atomicWriteJson(
        join(workflowDir, `execution-rebase-report-${input.revision}.json`),
        input.rebaseReport
      );
    }
  }

  async nextRevisionNumber(workflowId: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.getWorkflowDir(workflowId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 2;
      }
      throw error;
    }
    const max = entries
      .map(
        (entry) =>
          entry.match(/^task-plan-amendment-(\d+)\.json$/)?.[1] ??
          entry.match(/^task-plan-v(\d+)\.json$/)?.[1]
      )
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .filter((value) => Number.isInteger(value))
      .reduce((left, right) => Math.max(left, right), 1);
    return Math.max(2, max + 1);
  }

  async hasOpenAmendment(workflowId: string): Promise<RevisionAmendment | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.getWorkflowDir(workflowId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    for (const entry of entries
      .filter((item) => /^task-plan-amendment-\d+\.json$/.test(item))
      .sort()) {
      const amendment = JSON.parse(
        await readFile(join(this.getWorkflowDir(workflowId), entry), "utf8")
      ) as RevisionAmendment;
      if (amendment.status === "pending") {
        return amendment;
      }
    }
    return undefined;
  }

  async scanStates(): Promise<ExecutionState[]> {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const states: ExecutionState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        states.push(await this.readState(entry.name));
      } catch (error) {
        states.push(
          createFailedState(
            entry.name,
            "state_corrupted",
            `execution-state.json is corrupted: ${formatErrorMessage(error)}`
          )
        );
      }
    }
    return states;
  }

  async failState(
    workflowId: string,
    failure: { kind: ExecutionErrorKind; message: string; taskId?: string }
  ): Promise<ExecutionState> {
    return this.update(workflowId, (state) => ({
      ...state,
      status: "failed",
      failure: {
        ...failure,
        occurredAt: new Date().toISOString()
      },
      pendingDispatch: null
    })) as Promise<ExecutionState>;
  }

  private async readStateOrCreate(workflowId: string): Promise<ExecutionState> {
    try {
      return await this.readState(workflowId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return createInitialState(workflowId);
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return createFailedState(
          workflowId,
          "state_corrupted",
          `execution-state.json is corrupted: ${formatErrorMessage(error)}`
        );
      }
      if (error instanceof Error && error.message.includes("points to missing")) {
        return createFailedState(workflowId, "plan_missing", error.message);
      }
      if (error instanceof Error && error.message.includes("missing paired artifact")) {
        return createFailedState(workflowId, "state_corrupted", error.message);
      }
      throw error;
    }
  }

  private async validatePlanVersion(workflowId: string, planVersion: PlanVersion): Promise<void> {
    const workflowDir = this.getWorkflowDir(workflowId);
    const planPath = planVersion === "task-plan-current" ? "task-plan.json" : `${planVersion}.json`;
    try {
      await access(join(workflowDir, planPath), constants.F_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (planVersion === "task-plan-current") {
          return;
        }
        throw new Error(`planVersion ${planVersion} points to missing ${planPath}`);
      }
      throw error;
    }

    const revision = planVersion.match(/^task-plan-v(\d+)$/)?.[1];
    if (!revision) {
      return;
    }
    const required = [
      `task-plan-amendment-${revision}.json`,
      `execution-rebase-report-${revision}.json`
    ];
    for (const file of required) {
      try {
        await access(join(workflowDir, file), constants.F_OK);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new Error(`planVersion ${planVersion} is missing paired artifact ${file}`);
        }
        throw error;
      }
    }
  }

  private async enqueue<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workflowId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      workflowId,
      next.catch(() => undefined)
    );
    return next;
  }
}

export function createInitialState(workflowId: string): ExecutionState {
  const now = new Date().toISOString();
  return {
    workflowId,
    planVersion: "task-plan-current",
    planPath: "task-plan.json",
    status: "idle",
    currentTaskId: null,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
    stoppedAt: null,
    failure: null,
    taskStates: {},
    manualGateReleases: [],
    pendingDispatch: null,
    supersededSessions: []
  };
}

export function createFailedState(
  workflowId: string,
  kind: ExecutionErrorKind,
  message: string
): ExecutionState {
  const now = new Date().toISOString();
  return {
    ...createInitialState(workflowId),
    status: "failed",
    updatedAt: now,
    failure: {
      kind,
      message,
      occurredAt: now
    }
  };
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tmpFile, file);
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    await rename(tmpFile, file).catch(() => {
      throw error;
    });
  }
  await rm(tmpFile, { force: true }).catch(() => undefined);
}

export function getPlanPath(planVersion: PlanVersion): string {
  return planVersion === "task-plan-current" ? "task-plan.json" : `${planVersion}.json`;
}

export function summarizeExecutionState(
  plan: TaskPlan,
  state: ExecutionState
): {
  completed: number;
  working: number;
  pending: number;
  blocked: number;
  failed: number;
  superseded: number;
} {
  const counts = {
    completed: 0,
    working: 0,
    pending: 0,
    blocked: 0,
    failed: 0,
    superseded: 0
  };
  for (const task of plan.tasks) {
    const runtimeStatus = state.taskStates[task.taskId]?.status ?? task.status;
    if (runtimeStatus === "completed") {
      counts.completed += 1;
    } else if (runtimeStatus === "working") {
      counts.working += 1;
    } else if (runtimeStatus === "blocked_for_human") {
      counts.blocked += 1;
    } else if (runtimeStatus === "failed") {
      counts.failed += 1;
    } else if (runtimeStatus === "superseded") {
      counts.superseded += 1;
    } else {
      counts.pending += 1;
    }
  }
  return counts;
}

function cloneState(state: ExecutionState): ExecutionState {
  return JSON.parse(JSON.stringify(state)) as ExecutionState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
