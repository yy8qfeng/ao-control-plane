import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import {
  type ExecutionRebaseReport,
  type ExecutionState,
  type ExecutionStateStore,
  type RevisionAmendment,
  getPlanPath
} from "./execution-state-store.js";
import { runTaskPlanReviewLoop } from "./task-plan-review-loop.js";

export interface PlanRevisionRequest {
  workflowId: string;
  triggerTaskId: string;
  reasonCategory: string;
  rationale: string;
}

export interface PlanRevisionResult {
  amendment: RevisionAmendment;
  approved: boolean;
  plan?: TaskPlan;
  reviews: TaskPlanReview[];
  rebaseReport?: ExecutionRebaseReport;
}

const maxRevisionReviewRounds = 3;

export async function requestTaskPlanRevision(input: {
  store: ExecutionStateStore;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  workflowId: string;
  approvedDesign: string;
  request: PlanRevisionRequest;
  signal?: AbortSignal;
}): Promise<PlanRevisionResult> {
  const rationale = input.request.rationale.trim();
  if (!rationale) {
    throw new Error("rationale is required");
  }
  const state = await input.store.ensureState(input.workflowId);
  validateRevisionRequest(state, input.request);
  const existing = await input.store.hasOpenAmendment(input.workflowId);
  if (existing) {
    throw new Error(`Workflow ${input.workflowId} already has pending amendment ${existing.revision}`);
  }

  const currentPlan = await input.store.readActiveTaskPlan(state);
  const triggerTask = currentPlan.tasks.find((task) => task.taskId === input.request.triggerTaskId);
  if (!triggerTask) {
    throw new Error(`triggerTaskId ${input.request.triggerTaskId} does not exist in active plan`);
  }
  if (input.request.reasonCategory === "g0_invalid" && triggerTask.phase !== "calibration") {
    throw new Error("reasonCategory g0_invalid can only be used with a calibration task");
  }

  const revision = await input.store.nextRevisionNumber(input.workflowId);
  const amendment: RevisionAmendment = {
    revision,
    workflowId: input.workflowId,
    triggerTaskId: input.request.triggerTaskId,
    reasonCategory: input.request.reasonCategory,
    rationale,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
  await input.store.writeRevisionArtifacts({ workflowId: input.workflowId, revision, amendment });
  await input.store.update(input.workflowId, (current) => ({
    ...current,
    status: "paused_for_replan",
    currentTaskId: input.request.triggerTaskId,
    failure: {
      taskId: input.request.triggerTaskId,
      kind: "revision_requested",
      message: rationale,
      occurredAt: new Date().toISOString()
    }
  }));

  const syntheticReview = createRevisionReview({
    workflowId: input.workflowId,
    revision,
    planVersion: state.planVersion,
    request: input.request
  });
  const draftPlan = await input.codex.reviseTaskPlan({
    currentPlan,
    review: syntheticReview,
    approvedDesign: input.approvedDesign
  }, { signal: input.signal });
  await input.store.writeRevisionArtifacts({ workflowId: input.workflowId, revision, amendment, draftPlan });

  const reviewResult = await runTaskPlanReviewLoop({
    workflowId: input.workflowId,
    approvedDesign: input.approvedDesign,
    deferredFindings: [],
    codex: input.codex,
    claudeCode: input.claudeCode,
    options: { maxTaskPlanReviewRounds: maxRevisionReviewRounds },
    initialPlan: draftPlan,
    previousReviews: [syntheticReview],
    signal: input.signal
  });

  const reviews = reviewResult.reviews;
  if (!reviewResult.approved) {
    await input.store.writeRevisionArtifacts({
      workflowId: input.workflowId,
      revision,
      amendment: { ...amendment, status: "failed" },
      draftPlan: reviewResult.plan,
      reviews
    });
    await input.store.failState(input.workflowId, {
      kind: "revision_failed",
      taskId: input.request.triggerTaskId,
      message: "Task plan revision review exceeded maxRevisionReviewRounds"
    });
    return {
      amendment: { ...amendment, status: "failed" },
      approved: false,
      plan: reviewResult.plan,
      reviews
    };
  }

  const rebaseReport = createRebaseReport({
    workflowId: input.workflowId,
    revision,
    previousState: state,
    previousPlan: currentPlan,
    nextPlan: reviewResult.plan
  });
  await input.store.writeRevisionArtifacts({
    workflowId: input.workflowId,
    revision,
    amendment: { ...amendment, status: "approved" },
    draftPlan: reviewResult.plan,
    finalPlan: reviewResult.plan,
    reviews,
    rebaseReport
  });
  await input.store.update(input.workflowId, (current) => {
    const nextTaskStates = { ...current.taskStates };
    for (const taskId of rebaseReport.supersededTaskIds) {
      const existingTask = nextTaskStates[taskId];
      if (existingTask) {
        nextTaskStates[taskId] = { ...existingTask, status: "superseded" };
      }
    }
    return {
      ...current,
      planVersion: `task-plan-v${revision}`,
      planPath: getPlanPath(`task-plan-v${revision}`),
      status: "running",
      currentTaskId: null,
      failure: null,
      taskStates: nextTaskStates,
      pendingDispatch: null
    };
  });

  return {
    amendment: { ...amendment, status: "approved" },
    approved: true,
    plan: reviewResult.plan,
    reviews,
    rebaseReport
  };
}

function validateRevisionRequest(state: ExecutionState, request: PlanRevisionRequest): void {
  if (!request.triggerTaskId.trim()) {
    throw new Error("triggerTaskId is required");
  }
  if (!request.reasonCategory.trim()) {
    throw new Error("reasonCategory is required");
  }
  const taskState = state.taskStates[request.triggerTaskId];
  const matchesCurrentTask = state.currentTaskId === request.triggerTaskId;
  const matchesBlockedTask = taskState?.status === "blocked_for_human";
  if (!matchesCurrentTask && !matchesBlockedTask) {
    throw new Error("triggerTaskId must match currentTaskId or refer to a blocked task");
  }
}

function createRevisionReview(input: {
  workflowId: string;
  revision: number;
  planVersion: string;
  request: PlanRevisionRequest;
}): TaskPlanReview {
  return {
    workflowId: input.workflowId,
    round: 1,
    planner: "codex",
    reviewer: "claude-code",
    planVersion: input.planVersion,
    reviewDecision: "changes_requested",
    findings: [
      {
        id: `TPF-REVISION-${input.revision}`,
        title: `计划修订请求：${input.request.reasonCategory}`,
        body: input.request.rationale,
        severity: "blocking",
        status: "unresolved"
      }
    ]
  };
}

function createRebaseReport(input: {
  workflowId: string;
  revision: number;
  previousState: ExecutionState;
  previousPlan: TaskPlan;
  nextPlan: TaskPlan;
}): ExecutionRebaseReport {
  const nextTaskIds = new Set(input.nextPlan.tasks.map((task) => task.taskId));
  const previousTaskIds = new Set(input.previousPlan.tasks.map((task) => task.taskId));
  const carriedTaskIds = Object.keys(input.previousState.taskStates).filter((taskId) => nextTaskIds.has(taskId));
  const supersededTaskIds = [...previousTaskIds].filter((taskId) => !nextTaskIds.has(taskId));
  const conflictTaskIds = carriedTaskIds.filter((taskId) => input.previousState.taskStates[taskId]?.status === "superseded");
  return {
    revision: input.revision,
    workflowId: input.workflowId,
    previousPlanVersion: input.previousState.planVersion,
    nextPlanVersion: `task-plan-v${input.revision}`,
    generatedAt: new Date().toISOString(),
    carriedTaskIds,
    supersededTaskIds,
    conflictTaskIds
  };
}
