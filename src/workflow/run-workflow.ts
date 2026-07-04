import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { StructuredOutputError } from "../adapters/claude-code.js";
import { TaskPlanSchemaRepairError, type CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { requirementInputSchema, buildRequirementFromInput } from "../schemas/requirement-input.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlanApprovalReport } from "../schemas/task-plan-approval-report.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";
import { runDesignReviewLoop } from "./design-review-loop.js";
import {
  TASK_PLAN_NORMALIZATION_SOURCE,
  normalizeTaskPlanModelOutput,
  type TaskPlanNormalizationReport
} from "./task-plan-normalizer.js";
import { runTaskPlanReviewLoop } from "./task-plan-review-loop.js";

export interface RunWorkflowResult {
  workflow: Workflow;
  requirement: Requirement;
  artifactDir: string;
  design?: string;
  reviews: DesignReview[];
  taskPlanReviews: TaskPlanReview[];
  designPath?: string;
  reviewsPath: string;
  taskPlanReviewsPath?: string;
  taskPlanApprovalReportPath?: string;
  taskPlanApprovalReport?: TaskPlanApprovalReport;
  taskPlanPath?: string;
  plan?: TaskPlan;
}

export type RunWorkflowEvent =
  | { type: "workflow_started"; workflow: Workflow; artifactDir: string }
  | { type: "design_started"; designVersion: string }
  | { type: "design_completed"; designVersion: string; design: string; path: string }
  | { type: "review_started"; round: number; designVersion: string }
  | { type: "review_completed"; review: DesignReview; path: string }
  | { type: "revision_started"; round: number }
  | { type: "planning_started"; deferredFindings: DesignReview["findings"] }
  | { type: "task_plan_generated"; round: number; planVersion: string; plan: TaskPlan; path: string }
  | { type: "task_plan_normalized"; round: number; report: TaskPlanNormalizationReport; path: string }
  | { type: "task_plan_review_started"; round: number; planVersion: string }
  | { type: "task_plan_review_completed"; review: TaskPlanReview; path: string }
  | { type: "task_plan_local_gate_started"; round: number; planVersion: string }
  | { type: "task_plan_local_gate_arbitration_required"; review: TaskPlanReview; path: string }
  | {
      type: "task_plan_local_gate_arbitration_started";
      round: number;
      planVersion: string;
      review: TaskPlanReview;
    }
  | { type: "task_plan_local_gate_arbitration_completed"; review: TaskPlanReview; path: string }
  | { type: "task_plan_revision_started"; round: number }
  | { type: "planning_completed"; plan: TaskPlan; path: string; approvalReport: TaskPlanApprovalReport; approvalReportPath: string }
  | { type: "workflow_completed"; result: RunWorkflowResult }
  | { type: "workflow_blocked_for_human"; message: string }
  | { type: "workflow_failed"; message: string };

export async function runWorkflow(input: {
  requirementFile: string;
  artifactRoot: string;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  onEvent?: (event: RunWorkflowEvent) => Promise<void> | void;
  signal?: AbortSignal;
}): Promise<RunWorkflowResult> {
  const requirementInput = requirementInputSchema.parse(await readJson(input.requirementFile));
  const requirement = buildRequirementFromInput(requirementInput);
  const artifactDir = resolve(input.artifactRoot, requirement.id);
  await mkdir(artifactDir, { recursive: true });

  const workflow: Workflow = {
    workflowId: requirement.id,
    title: requirement.title,
    rawRequirement: requirement.description,
    status: "designing",
    designRounds: 0,
    maxDesignReviewRounds: requirementInput.maxDesignReviewRounds,
    tasks: []
  };
  const existingState = await readExistingWorkflowState(artifactDir);
  const startingRound = existingState.reviews.length + 1;
  const reviews: DesignReview[] = [...existingState.reviews];
  const taskPlanReviews: TaskPlanReview[] = [...existingState.taskPlanReviews];
  let latestDesign = existingState.design;

  await writeJson(join(artifactDir, "requirement.json"), requirement);
  await writeJson(join(artifactDir, "workflow.json"), workflow);
  await input.onEvent?.({ type: "workflow_started", workflow, artifactDir });

  try {
    let initialDesign: string | undefined;

    if (existingState.design) {
      const previousReview = existingState.reviews.at(-1);
      await input.onEvent?.({ type: "revision_started", round: previousReview?.round ?? 0 });
      initialDesign = await input.codex.reviseDesign({
        currentDesign: existingState.design,
        review: createContinuationReview(requirement, previousReview)
      }, { signal: input.signal });
    }

    const reviewLoop = await runDesignReviewLoop({
      requirement,
      codex: input.codex,
      claudeCode: input.claudeCode,
      options: { maxDesignReviewRounds: requirementInput.maxDesignReviewRounds, startingRound },
      signal: input.signal,
      initialDesign,
      hooks: {
        onDesign: async ({ designVersion, design }) => {
          await input.onEvent?.({ type: "design_started", designVersion });
          workflow.status = "design_reviewing";
          latestDesign = design;
          const designPath = join(artifactDir, "design.md");
          await writeFile(designPath, design, "utf8");
          await writeJson(join(artifactDir, "workflow.json"), workflow);
          await input.onEvent?.({
            type: "design_completed",
            designVersion,
            design,
            path: designPath
          });
        },
        onReviewStart: async ({ round, designVersion }) => {
          await input.onEvent?.({ type: "review_started", round, designVersion });
        },
        onReview: async ({ review }) => {
          reviews.push(review);
          workflow.designRounds = reviews.length;
          workflow.status =
            review.reviewDecision === "changes_requested" ? "design_revising" : "design_reviewing";
          const reviewPath = join(artifactDir, `review-${review.round}.json`);
          await writeJson(reviewPath, review);
          await writeJson(join(artifactDir, "reviews.json"), reviews);
          await writeJson(join(artifactDir, "workflow.json"), workflow);
          await input.onEvent?.({ type: "review_completed", review, path: reviewPath });
        },
        onRevisionStart: async ({ round }) => {
          await input.onEvent?.({ type: "revision_started", round });
        }
      }
    });

    workflow.designRounds = reviews.length;
    workflow.approvedDesignVersion = reviewLoop.approved ? reviewLoop.designVersion : undefined;
    latestDesign = reviewLoop.design;

    if (!reviewLoop.approved) {
      workflow.status = "blocked_for_human";
      await writeJson(join(artifactDir, "workflow.json"), workflow);
      const result = {
        workflow,
        requirement,
        artifactDir,
        design: reviewLoop.design,
        reviews,
        taskPlanReviews,
        designPath: join(artifactDir, "design.md"),
        reviewsPath: join(artifactDir, "reviews.json")
      };
      await input.onEvent?.({ type: "workflow_completed", result });
      return result;
    }

    workflow.status = "planning";
    await writeJson(join(artifactDir, "workflow.json"), workflow);
    await input.onEvent?.({ type: "planning_started", deferredFindings: reviewLoop.deferredFindings });

    const planLoop = await runTaskPlanReviewLoop({
      workflowId: workflow.workflowId,
      approvedDesign: reviewLoop.design,
      deferredFindings: reviewLoop.deferredFindings,
      codex: input.codex,
      claudeCode: input.claudeCode,
      options: {
        maxTaskPlanReviewRounds: requirementInput.maxDesignReviewRounds,
        startingRound: existingState.taskPlanReviews.length + 1
      },
      signal: input.signal,
      initialPlan: existingState.plan,
      previousReviews: existingState.taskPlanReviews,
      hooks: {
        onPlan: async ({ round, planVersion, plan, normalizationReport }) => {
          const draftPath = join(artifactDir, "task-plan-draft.json");
          if (normalizationReport) {
            const normalizationReportPath = join(artifactDir, `task-plan-normalization-report-${round}.json`);
            await writeJson(normalizationReportPath, normalizationReport);
            workflow.lastNormalization = {
              round,
              reportPath: `task-plan-normalization-report-${round}.json`,
              changeCount: normalizationReport.changes.length,
              outcome: normalizationReport.outcome
            };
            await input.onEvent?.({
              type: "task_plan_normalized",
              round,
              report: normalizationReport,
              path: normalizationReportPath
            });
          }
          await writeJson(draftPath, plan);
          await writeJson(join(artifactDir, "workflow.json"), workflow);
          await input.onEvent?.({
            type: "task_plan_generated",
            round,
            planVersion,
            plan,
            path: draftPath
          });
        },
        onReviewStart: async ({ round, planVersion }) => {
          await input.onEvent?.({ type: "task_plan_review_started", round, planVersion });
        },
        onReview: async ({ review }) => {
          taskPlanReviews.push(review);
          const reviewPath = await writeTaskPlanReviewArtifact(artifactDir, review, "model");
          await writeJson(join(artifactDir, "task-plan-reviews.json"), taskPlanReviews);
          await input.onEvent?.({ type: "task_plan_review_completed", review, path: reviewPath });
        },
        onLocalGateStart: async ({ round, planVersion }) => {
          await input.onEvent?.({ type: "task_plan_local_gate_started", round, planVersion });
        },
        onLocalGate: async ({ review }) => {
          taskPlanReviews.push(review);
          const reviewPath = await writeTaskPlanReviewArtifact(artifactDir, review, "local-gate");
          await writeJson(join(artifactDir, "task-plan-reviews.json"), taskPlanReviews);
          await input.onEvent?.({ type: "task_plan_local_gate_arbitration_required", review, path: reviewPath });
        },
        onLocalGateArbitrationStart: async ({ round, planVersion, review }) => {
          await input.onEvent?.({
            type: "task_plan_local_gate_arbitration_started",
            round,
            planVersion,
            review
          });
        },
        onLocalGateArbitration: async ({ review }) => {
          taskPlanReviews.push(review);
          const reviewPath = await writeTaskPlanReviewArtifact(artifactDir, review, "local-gate-arbitration");
          await writeJson(join(artifactDir, "task-plan-reviews.json"), taskPlanReviews);
          await input.onEvent?.({
            type: "task_plan_local_gate_arbitration_completed",
            review,
            path: reviewPath
          });
        },
        onRevisionStart: async ({ round }) => {
          await input.onEvent?.({ type: "task_plan_revision_started", round });
        }
      }
    });

    if (!planLoop.approved) {
      workflow.status = "blocked_for_human";
      workflow.tasks = [];
      const taskPlanApprovalReportPath = join(artifactDir, "task-plan-approval-report.json");
      await writeJson(taskPlanApprovalReportPath, planLoop.approvalReport);
      await removeOptionalFile(join(artifactDir, "task-plan.json"));
      await writeJson(join(artifactDir, "workflow.json"), workflow);
      const result = {
        workflow,
        requirement,
        artifactDir,
        design: reviewLoop.design,
        reviews,
        taskPlanReviews,
        designPath: join(artifactDir, "design.md"),
        reviewsPath: join(artifactDir, "reviews.json"),
        taskPlanReviewsPath: join(artifactDir, "task-plan-reviews.json"),
        taskPlanApprovalReportPath,
        taskPlanApprovalReport: planLoop.approvalReport,
        plan: planLoop.plan
      };
      await input.onEvent?.({ type: "workflow_completed", result });
      return result;
    }

    const plan = taskPlanSchema.parse(planLoop.plan);

    workflow.status = "executing";
    workflow.tasks = plan.tasks.map((task) => task.taskId);
    const taskPlanPath = join(artifactDir, "task-plan.json");
    const taskPlanApprovalReportPath = join(artifactDir, "task-plan-approval-report.json");
    await writeJson(taskPlanPath, plan);
    await writeJson(taskPlanApprovalReportPath, planLoop.approvalReport);
    await writeJson(join(artifactDir, "workflow.json"), workflow);
    await input.onEvent?.({
      type: "planning_completed",
      plan,
      path: taskPlanPath,
      approvalReport: planLoop.approvalReport,
      approvalReportPath: taskPlanApprovalReportPath
    });

    const result = {
      workflow,
      requirement,
      artifactDir,
      design: reviewLoop.design,
      reviews,
      taskPlanReviews,
      designPath: join(artifactDir, "design.md"),
      reviewsPath: join(artifactDir, "reviews.json"),
      taskPlanReviewsPath: join(artifactDir, "task-plan-reviews.json"),
      taskPlanApprovalReportPath,
      taskPlanApprovalReport: planLoop.approvalReport,
      taskPlanPath,
      plan
    };
    await input.onEvent?.({ type: "workflow_completed", result });
    return result;
  } catch (error) {
    if (error instanceof TaskPlanSchemaRepairError) {
      workflow.status = "blocked_for_human";
      workflow.tasks = [];
      const rawOutputPath = join(artifactDir, "invalid-task-plan-output.txt");
      const normalizationReportPath = join(artifactDir, `task-plan-normalization-report-${error.report.round || 0}.json`);
      await writeFile(rawOutputPath, error.rawOutput, "utf8");
      await writeJson(normalizationReportPath, error.report);
      workflow.lastNormalization = {
        round: error.report.round,
        reportPath: `task-plan-normalization-report-${error.report.round || 0}.json`,
        changeCount: error.report.changes.length,
        outcome: error.report.outcome
      };
      await writeJson(join(artifactDir, "human-review-required.json"), {
        reason: error.message,
        category: "task-plan-schema-repair",
        repairAttempts: error.repairAttempts,
        rawOutputPath,
        normalizationReportPath
      });
      await writeJson(join(artifactDir, "workflow.json"), workflow);
      await input.onEvent?.({ type: "workflow_blocked_for_human", message: error.message });
      const result = {
        workflow,
        requirement,
        artifactDir,
        design: latestDesign,
        reviews,
        taskPlanReviews,
        designPath: join(artifactDir, "design.md"),
        reviewsPath: join(artifactDir, "reviews.json")
      };
      await input.onEvent?.({ type: "workflow_completed", result });
      return result;
    }

    workflow.status = input.signal?.aborted ? "stopped" : "failed";
    await writeJson(join(artifactDir, "workflow.json"), workflow);

    if (error instanceof StructuredOutputError) {
      await writeFile(join(artifactDir, "invalid-claude-output.txt"), error.rawOutput, "utf8");
      await writeJson(join(artifactDir, "human-review-required.json"), {
        reason: error.message,
        detail: String(error.causeDetail ?? ""),
        rawOutputPath: join(artifactDir, "invalid-claude-output.txt")
      });
    }

    await input.onEvent?.({
      type: "workflow_failed",
      message: error instanceof Error ? error.message : "Unknown workflow error"
    });
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as unknown;
}

async function readExistingWorkflowState(artifactDir: string): Promise<{
  design?: string;
  reviews: DesignReview[];
  taskPlanReviews: TaskPlanReview[];
  plan?: TaskPlan;
}> {
  const [design, reviews, taskPlanReviews, draftPlan, finalPlan] = await Promise.all([
    readOptionalText(join(artifactDir, "design.md")),
    readOptionalJson<DesignReview[]>(join(artifactDir, "reviews.json")),
    readOptionalJson<TaskPlanReview[]>(join(artifactDir, "task-plan-reviews.json")),
    readOptionalJson<unknown>(join(artifactDir, "task-plan-draft.json")),
    readOptionalJson<unknown>(join(artifactDir, "task-plan.json"))
  ]);
  const workflowId = inferWorkflowIdFromPlan(draftPlan) ?? inferWorkflowIdFromPlan(finalPlan);
  const normalizedDraft = draftPlan && workflowId
    ? normalizeTaskPlanModelOutput(draftPlan, { workflowId, source: TASK_PLAN_NORMALIZATION_SOURCE.artifact }).plan
    : undefined;
  const normalizedFinal = finalPlan && workflowId
    ? normalizeTaskPlanModelOutput(finalPlan, { workflowId, source: TASK_PLAN_NORMALIZATION_SOURCE.artifact }).plan
    : undefined;

  return {
    design,
    reviews: reviews ?? [],
    taskPlanReviews: taskPlanReviews ?? [],
    // Prefer the draft when continuing planning so blocked or interrupted revisions keep iterating in place.
    plan: normalizedDraft ?? normalizedFinal
  };
}

function inferWorkflowIdFromPlan(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "workflowId" in value && typeof value.workflowId === "string"
    ? value.workflowId
    : undefined;
}

function createContinuationReview(
  requirement: Requirement,
  previousReview: DesignReview | undefined
): DesignReview {
  const supplementFinding = {
    id: "DRF-SUPPLEMENT-001",
    title: "根据最新需求补充更新设计稿",
    body: [
      "同一需求会话已存在历史设计稿。",
      "请不要重新生成无关初稿，而是在当前设计稿基础上吸收最新 requirement.json 中的需求描述、讨论记录、验收标准和约束。",
      "保持设计稿为完整 Markdown，并保留已有合理设计内容。"
    ].join("\n"),
    severity: "major" as const,
    status: "unresolved" as const,
    rationale: `当前需求：${requirement.description}`
  };

  return {
    workflowId: requirement.id,
    round: previousReview?.round ?? 0,
    designer: "codex",
    reviewer: "claude-code",
    designVersion: "design-current",
    reviewDecision: "changes_requested",
    findings: [supplementFinding, ...(previousReview?.findings ?? [])]
  };
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  const raw = await readOptionalText(file);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTaskPlanReviewArtifact(
  artifactDir: string,
  review: TaskPlanReview,
  kind: "model" | "local-gate" | "local-gate-arbitration"
): Promise<string> {
  const suffix = kind === "model" ? "" : `-${kind}`;
  const reviewPath = join(artifactDir, `task-plan-review-${review.round}${suffix}.json`);
  await writeJson(reviewPath, review);
  await writeJson(join(artifactDir, "task-plan-review-latest.json"), review);
  return reviewPath;
}

async function removeOptionalFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
