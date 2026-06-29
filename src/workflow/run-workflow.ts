import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { StructuredOutputError } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { requirementInputSchema, buildRequirementFromInput } from "../schemas/requirement-input.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";
import { runDesignReviewLoop } from "./design-review-loop.js";

export interface RunWorkflowResult {
  workflow: Workflow;
  requirement: Requirement;
  artifactDir: string;
  design?: string;
  reviews: DesignReview[];
  designPath?: string;
  reviewsPath: string;
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
  | { type: "planning_started" }
  | { type: "planning_completed"; plan: TaskPlan; path: string }
  | { type: "workflow_completed"; result: RunWorkflowResult }
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
  const reviews: DesignReview[] = [];

  await writeJson(join(artifactDir, "requirement.json"), requirement);
  await writeJson(join(artifactDir, "workflow.json"), workflow);
  await input.onEvent?.({ type: "workflow_started", workflow, artifactDir });

  try {
    const reviewLoop = await runDesignReviewLoop({
      requirement,
      codex: input.codex,
      claudeCode: input.claudeCode,
      options: { maxDesignReviewRounds: requirementInput.maxDesignReviewRounds },
      signal: input.signal,
      hooks: {
        onDesign: async ({ designVersion, design }) => {
          await input.onEvent?.({ type: "design_started", designVersion });
          workflow.status = "design_reviewing";
          const designPath = join(artifactDir, `${designVersion}.md`);
          await writeFile(designPath, design, "utf8");
          await writeFile(join(artifactDir, "design.md"), design, "utf8");
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

    workflow.designRounds = reviewLoop.reviews.length;
    workflow.approvedDesignVersion = reviewLoop.approved ? reviewLoop.designVersion : undefined;

    if (!reviewLoop.approved) {
      workflow.status = "blocked_for_human";
      await writeJson(join(artifactDir, "workflow.json"), workflow);
      const result = {
        workflow,
        requirement,
        artifactDir,
        design: reviewLoop.design,
        reviews,
        designPath: join(artifactDir, "design.md"),
        reviewsPath: join(artifactDir, "reviews.json")
      };
      await input.onEvent?.({ type: "workflow_completed", result });
      return result;
    }

    workflow.status = "planning";
    await writeJson(join(artifactDir, "workflow.json"), workflow);
    await input.onEvent?.({ type: "planning_started" });

    const plan = taskPlanSchema.parse(
      await input.claudeCode.createTaskPlan({
        workflowId: workflow.workflowId,
        approvedDesign: reviewLoop.design
      }, { signal: input.signal })
    );

    workflow.status = "executing";
    workflow.tasks = plan.tasks.map((task) => task.taskId);
    const taskPlanPath = join(artifactDir, "task-plan.json");
    await writeJson(taskPlanPath, plan);
    await writeJson(join(artifactDir, "workflow.json"), workflow);
    await input.onEvent?.({ type: "planning_completed", plan, path: taskPlanPath });

    const result = {
      workflow,
      requirement,
      artifactDir,
      design: reviewLoop.design,
      reviews,
      designPath: join(artifactDir, "design.md"),
      reviewsPath: join(artifactDir, "reviews.json"),
      taskPlanPath,
      plan
    };
    await input.onEvent?.({ type: "workflow_completed", result });
    return result;
  } catch (error) {
    workflow.status = "failed";
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

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
