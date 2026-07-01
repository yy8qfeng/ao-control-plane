import { PlaceholderClaudeCodeAdapter } from "../adapters/claude-code.js";
import { PlaceholderCodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { requirementSchema, type Requirement } from "../schemas/requirement.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { Workflow } from "../schemas/workflow.js";
import { runDesignReviewLoop } from "../workflow/design-review-loop.js";
import { runTaskPlanReviewLoop } from "../workflow/task-plan-review-loop.js";
import { ArtifactStore, type GovernanceArtifacts } from "./artifact-store.js";
import { buildRequirementDescription } from "./request-formatting.js";

export interface GovernanceRequest {
  workflowId?: string;
  title: string;
  description: string;
  discussion?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  maxDesignReviewRounds?: number;
}

export interface GovernanceRunResult extends GovernanceArtifacts {
  artifactDir: string;
  reviews: DesignReview[];
  taskPlanReviews?: TaskPlanReview[];
}

export async function runDesignReviewStage(input: {
  request: GovernanceRequest;
  store: ArtifactStore;
}): Promise<GovernanceRunResult> {
  const requirement = buildRequirement(input.request);
  const maxDesignReviewRounds = input.request.maxDesignReviewRounds ?? 3;
  const existing = await readExistingArtifacts(input.store, requirement.id);
  const codex = new PlaceholderCodexAdapter();
  const initialDesign = existing
    ? await codex.reviseDesign({
        currentDesign: existing.design,
        review: createSupplementReview(requirement, existing.reviews.at(-1))
      })
    : undefined;
  const reviewLoop = await runDesignReviewLoop({
    requirement,
    codex,
    claudeCode: new PlaceholderClaudeCodeAdapter(),
    options: { maxDesignReviewRounds },
    initialDesign
  });
  const workflow: Workflow = {
    ...createDraftWorkflow(requirement, maxDesignReviewRounds),
    status: reviewLoop.approved ? "ready_for_planning" : "blocked_for_human",
    designRounds: reviewLoop.reviews.length,
    approvedDesignVersion: reviewLoop.approved ? reviewLoop.designVersion : undefined
  };
  const artifacts: GovernanceArtifacts = {
    requirement,
    workflow,
    design: reviewLoop.design,
    reviews: reviewLoop.reviews
  };
  const artifactDir = await input.store.saveWorkflow(artifacts);
  return { ...artifacts, artifactDir };
}

export async function createTaskPlanStage(input: {
  workflowId: string;
  store: ArtifactStore;
}): Promise<GovernanceRunResult> {
  const artifacts = await input.store.readWorkflow(input.workflowId);
  const hasExecutablePlan = artifacts.workflow.status === "executing" && Boolean(artifacts.plan);
  const initialPlan = hasExecutablePlan ? artifacts.plan : artifacts.draftPlan ?? artifacts.plan;
  const canPlan =
    artifacts.workflow.status === "ready_for_planning" ||
    (artifacts.workflow.status === "blocked_for_human" && Boolean(initialPlan)) ||
    (artifacts.workflow.status === "executing" && Boolean(initialPlan));
  if (!canPlan) {
    throw new Error(`Workflow ${input.workflowId} is not ready for planning`);
  }

  const existingTaskPlanReviews = artifacts.taskPlanReviews ?? [];
  const planLoop = await runTaskPlanReviewLoop({
    workflowId: artifacts.workflow.workflowId,
    approvedDesign: artifacts.design,
    deferredFindings: collectDeferredFindings(artifacts.reviews),
    codex: new PlaceholderCodexAdapter(),
    claudeCode: new PlaceholderClaudeCodeAdapter(),
    options: {
      maxTaskPlanReviewRounds: artifacts.workflow.maxDesignReviewRounds,
      startingRound: existingTaskPlanReviews.length + 1
    },
    initialPlan
  });
  // The loop emits absolute round numbers from startingRound, so appending preserves review history.
  const taskPlanReviews = [...existingTaskPlanReviews, ...planLoop.reviews];
  const nextPlan = planLoop.approved ? planLoop.plan : hasExecutablePlan ? artifacts.plan : undefined;
  const nextArtifacts: GovernanceArtifacts = {
    ...artifacts,
    workflow: {
      ...artifacts.workflow,
      status: planLoop.approved || hasExecutablePlan ? "executing" : "blocked_for_human",
      tasks: planLoop.approved
        ? planLoop.plan.tasks.map((task) => task.taskId)
        : hasExecutablePlan
          ? artifacts.workflow.tasks
          : []
    },
    taskPlanReviews,
    draftPlan: planLoop.approved ? undefined : planLoop.plan,
    plan: nextPlan
  };
  const artifactDir = await input.store.saveWorkflow(nextArtifacts);
  return { ...nextArtifacts, artifactDir };
}

function collectDeferredFindings(reviews: DesignReview[]): DesignReview["findings"] {
  const finalReview = reviews.at(-1);
  return finalReview?.reviewDecision === "defer_to_implementation"
    ? finalReview.findings.filter((finding) => finding.status === "unresolved")
    : [];
}

export async function runGovernanceWorkflow(input: {
  request: GovernanceRequest;
  store: ArtifactStore;
}): Promise<GovernanceRunResult> {
  const reviewed = await runDesignReviewStage({
    request: input.request,
    store: input.store
  });
  if (reviewed.workflow.status !== "ready_for_planning") {
    return reviewed;
  }

  return createTaskPlanStage({
    workflowId: reviewed.workflow.workflowId,
    store: input.store
  });
}

function buildRequirement(request: GovernanceRequest): Requirement {
  return requirementSchema.parse({
    id: request.workflowId?.trim() || createWorkflowId(),
    title: request.title.trim(),
    source: "web",
    description: buildRequirementDescription(request),
    acceptanceCriteria: request.acceptanceCriteria ?? [],
    constraints: request.constraints ?? []
  });
}

function createWorkflowId(): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `WF-${timestamp}`;
}

async function readExistingArtifacts(store: ArtifactStore, workflowId: string): Promise<GovernanceArtifacts | undefined> {
  try {
    return await store.readWorkflow(workflowId);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function createSupplementReview(requirement: Requirement, previousReview: DesignReview | undefined): DesignReview {
  return {
    workflowId: requirement.id,
    round: previousReview?.round ?? 0,
    designer: "codex",
    reviewer: "claude-code",
    designVersion: "design-current",
    reviewDecision: "changes_requested",
    findings: [
      {
        id: "DRF-SUPPLEMENT-001",
        title: "根据最新需求补充更新设计稿",
        body: "请在当前设计稿基础上吸收最新需求描述、讨论记录、验收标准和约束。",
        severity: "major",
        status: "unresolved",
        rationale: requirement.description
      },
      ...(previousReview?.findings ?? [])
    ]
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createDraftWorkflow(requirement: Requirement, maxDesignReviewRounds: number): Workflow {
  return {
    workflowId: requirement.id,
    title: requirement.title,
    rawRequirement: requirement.description,
    status: "draft",
    designRounds: 0,
    maxDesignReviewRounds,
    tasks: []
  };
}
