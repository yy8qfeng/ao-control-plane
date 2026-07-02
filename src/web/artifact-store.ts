import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlanApprovalReport } from "../schemas/task-plan-approval-report.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";

export interface GovernanceArtifacts {
  requirement: Requirement;
  workflow: Workflow;
  design: string;
  reviews: DesignReview[];
  /** Optional when no task-plan review has been persisted yet; callers should default to an empty array. */
  taskPlanReviews?: TaskPlanReview[];
  taskPlanApprovalReport?: TaskPlanApprovalReport;
  draftPlan?: TaskPlan;
  plan?: TaskPlan;
}

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async saveWorkflow(artifacts: GovernanceArtifacts): Promise<string> {
    const workflowDir = this.getWorkflowDir(artifacts.workflow.workflowId);
    await mkdir(workflowDir, { recursive: true });

    await Promise.all([
      writeJson(join(workflowDir, "requirement.json"), artifacts.requirement),
      writeJson(join(workflowDir, "workflow.json"), artifacts.workflow),
      writeFile(join(workflowDir, "design.md"), artifacts.design, "utf8"),
      writeJson(join(workflowDir, "reviews.json"), artifacts.reviews),
      artifacts.taskPlanReviews
        ? writeJson(join(workflowDir, "task-plan-reviews.json"), artifacts.taskPlanReviews)
        : Promise.resolve(),
      artifacts.taskPlanApprovalReport
        ? writeJson(join(workflowDir, "task-plan-approval-report.json"), artifacts.taskPlanApprovalReport)
        : removeOptionalFile(join(workflowDir, "task-plan-approval-report.json")),
      artifacts.draftPlan
        ? writeJson(join(workflowDir, "task-plan-draft.json"), artifacts.draftPlan)
        : removeOptionalFile(join(workflowDir, "task-plan-draft.json")),
      artifacts.plan
        ? writeJson(join(workflowDir, "task-plan.json"), artifacts.plan)
        : removeOptionalFile(join(workflowDir, "task-plan.json"))
    ]);

    return workflowDir;
  }

  async readTaskPlan(workflowId: string): Promise<TaskPlan> {
    const raw = await readOptionalFile(join(this.getWorkflowDir(workflowId), "task-plan.json"));
    if (!raw) {
      throw new Error(`Workflow ${workflowId} is not ready for execution because no task plan was generated`);
    }
    const parsed = JSON.parse(raw) as TaskPlan | null;
    if (!parsed) {
      throw new Error(`Workflow ${workflowId} is not ready for execution because task-plan.json is empty`);
    }
    return parsed;
  }

  async readWorkflow(workflowId: string): Promise<GovernanceArtifacts> {
    const workflowDir = this.getWorkflowDir(workflowId);
    const [requirement, workflow, design, reviews, taskPlanReviews, taskPlanApprovalReport, draftPlan, plan] = await Promise.all([
      readJson<Requirement>(join(workflowDir, "requirement.json")),
      readJson<Workflow>(join(workflowDir, "workflow.json")),
      readFile(join(workflowDir, "design.md"), "utf8"),
      readJson<DesignReview[]>(join(workflowDir, "reviews.json")),
      readOptionalJson<TaskPlanReview[]>(join(workflowDir, "task-plan-reviews.json")),
      readOptionalJson<TaskPlanApprovalReport>(join(workflowDir, "task-plan-approval-report.json")),
      readOptionalJson<TaskPlan>(join(workflowDir, "task-plan-draft.json")),
      readOptionalJson<TaskPlan>(join(workflowDir, "task-plan.json"))
    ]);

    return {
      requirement,
      workflow,
      design,
      reviews,
      taskPlanReviews: taskPlanReviews ?? undefined,
      taskPlanApprovalReport: taskPlanApprovalReport ?? undefined,
      draftPlan: draftPlan ?? undefined,
      plan: plan ?? undefined
    };
  }

  getWorkflowDir(workflowId: string): string {
    return join(this.rootDir, workflowId);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  const raw = await readOptionalFile(file);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removeOptionalFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
