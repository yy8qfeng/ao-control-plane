import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";

export interface GovernanceArtifacts {
  requirement: Requirement;
  workflow: Workflow;
  design: string;
  reviews: DesignReview[];
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
      artifacts.plan
        ? writeJson(join(workflowDir, "task-plan.json"), artifacts.plan)
        : writeJson(join(workflowDir, "task-plan.json"), null)
    ]);

    return workflowDir;
  }

  async readTaskPlan(workflowId: string): Promise<TaskPlan> {
    const raw = await readFile(join(this.getWorkflowDir(workflowId), "task-plan.json"), "utf8");
    const parsed = JSON.parse(raw) as TaskPlan | null;
    if (!parsed) {
      throw new Error(`Workflow ${workflowId} does not have a task plan`);
    }
    return parsed;
  }

  async readWorkflow(workflowId: string): Promise<GovernanceArtifacts> {
    const workflowDir = this.getWorkflowDir(workflowId);
    const [requirement, workflow, design, reviews, plan] = await Promise.all([
      readJson<Requirement>(join(workflowDir, "requirement.json")),
      readJson<Workflow>(join(workflowDir, "workflow.json")),
      readFile(join(workflowDir, "design.md"), "utf8"),
      readJson<DesignReview[]>(join(workflowDir, "reviews.json")),
      readJson<TaskPlan | null>(join(workflowDir, "task-plan.json"))
    ]);

    return {
      requirement,
      workflow,
      design,
      reviews,
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
