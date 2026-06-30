import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import { runDesignReviewLoop } from "./design-review-loop.js";
import { runTaskPlanReviewLoop } from "./task-plan-review-loop.js";

export interface PlanningWorkflowResult {
  workflow: Workflow;
  design: string;
  reviews: Awaited<ReturnType<typeof runDesignReviewLoop>>["reviews"];
  taskPlanReviews: TaskPlanReview[];
  plan?: TaskPlan;
}

export async function runPlanningWorkflow(input: {
  requirement: Requirement;
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  maxDesignReviewRounds: number;
}): Promise<PlanningWorkflowResult> {
  const workflow: Workflow = {
    workflowId: input.requirement.id,
    title: input.requirement.title,
    rawRequirement: input.requirement.description,
    status: "designing",
    designRounds: 0,
    maxDesignReviewRounds: input.maxDesignReviewRounds,
    tasks: []
  };

  const reviewLoop = await runDesignReviewLoop({
    requirement: input.requirement,
    codex: input.codex,
    claudeCode: input.claudeCode,
    options: { maxDesignReviewRounds: input.maxDesignReviewRounds }
  });

  workflow.designRounds = reviewLoop.reviews.length;

  if (!reviewLoop.approved) {
    workflow.status = "blocked_for_human";
    return {
      workflow,
      design: reviewLoop.design,
      reviews: reviewLoop.reviews,
      taskPlanReviews: []
    };
  }

  workflow.status = "planning";
  workflow.approvedDesignVersion = reviewLoop.designVersion;

  const planLoop = await runTaskPlanReviewLoop({
    workflowId: workflow.workflowId,
    approvedDesign: reviewLoop.design,
    deferredFindings: reviewLoop.deferredFindings,
    codex: input.codex,
    claudeCode: input.claudeCode,
    options: { maxTaskPlanReviewRounds: input.maxDesignReviewRounds }
  });

  if (!planLoop.approved) {
    workflow.status = "blocked_for_human";
    return {
      workflow,
      design: reviewLoop.design,
      reviews: reviewLoop.reviews,
      taskPlanReviews: planLoop.reviews,
      plan: planLoop.plan
    };
  }

  const plan = taskPlanSchema.parse(planLoop.plan);

  workflow.status = "executing";
  workflow.tasks = plan.tasks.map((task) => task.taskId);

  return {
    workflow,
    design: reviewLoop.design,
    reviews: reviewLoop.reviews,
    taskPlanReviews: planLoop.reviews,
    plan
  };
}
