import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import { createLocalGateReview, validateTaskPlanApprovalGate } from "./task-plan-gates.js";

export interface TaskPlanReviewLoopOptions {
  maxTaskPlanReviewRounds: number;
  startingRound?: number;
}

export interface TaskPlanReviewLoopHooks {
  onPlan?: (input: { planVersion: string; plan: TaskPlan; round: number }) => Promise<void> | void;
  onReviewStart?: (input: { round: number; planVersion: string }) => Promise<void> | void;
  onReview?: (input: { review: TaskPlanReview }) => Promise<void> | void;
  onLocalGateStart?: (input: { round: number; planVersion: string }) => Promise<void> | void;
  onLocalGate?: (input: { review: TaskPlanReview }) => Promise<void> | void;
  onRevisionStart?: (input: { round: number; review: TaskPlanReview }) => Promise<void> | void;
}

export interface TaskPlanReviewLoopResult {
  approved: boolean;
  plan: TaskPlan;
  planVersion: string;
  reviews: TaskPlanReview[];
  blockedForHuman: boolean;
  finalReviewDecision?: TaskPlanReview["reviewDecision"];
}

export async function runTaskPlanReviewLoop(input: {
  workflowId: string;
  approvedDesign: string;
  deferredFindings: DesignReview["findings"];
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  options: TaskPlanReviewLoopOptions;
  hooks?: TaskPlanReviewLoopHooks;
  signal?: AbortSignal;
  initialPlan?: TaskPlan;
  previousReviews?: TaskPlanReview[];
}): Promise<TaskPlanReviewLoopResult> {
  throwIfAborted(input.signal);
  let plan = input.initialPlan
    ? taskPlanSchema.parse(input.initialPlan)
    : taskPlanSchema.parse(
        await input.codex.createTaskPlan({
          workflowId: input.workflowId,
          approvedDesign: input.approvedDesign,
          deferredFindings: input.deferredFindings
        }, { signal: input.signal })
      );
  const reviews: TaskPlanReview[] = [];
  const previousReviews = input.previousReviews ?? [];
  const planVersion = "task-plan-current";
  const startingRound = input.options.startingRound ?? 1;
  const finalRound = startingRound + input.options.maxTaskPlanReviewRounds - 1;

  for (let round = startingRound; round <= finalRound; round += 1) {
    throwIfAborted(input.signal);
    await input.hooks?.onPlan?.({ planVersion, plan, round });
    await input.hooks?.onReviewStart?.({ round, planVersion });
    const review = await input.claudeCode.reviewTaskPlan({
      workflowId: input.workflowId,
      round,
      planVersion,
      plan,
      approvedDesign: input.approvedDesign
    }, { signal: input.signal });

    reviews.push(review);
    await input.hooks?.onReview?.({ review });

    if (review.reviewDecision === "approved") {
      await input.hooks?.onLocalGateStart?.({ round, planVersion });
      const gate = validateTaskPlanApprovalGate({
        workflowId: input.workflowId,
        deferredFindings: input.deferredFindings,
        plan,
        previousReviews: [...previousReviews, ...reviews.slice(0, -1)]
      });

      if (!gate.passed) {
        const localGateReview = createLocalGateReview({
          workflowId: input.workflowId,
          round,
          planVersion,
          gate
        });
        reviews.push(localGateReview);
        await input.hooks?.onLocalGate?.({ review: localGateReview });

        if (round === finalRound) {
          break;
        }

        await input.hooks?.onRevisionStart?.({ round, review: localGateReview });
        plan = taskPlanSchema.parse(
          await input.codex.reviseTaskPlan({
            currentPlan: plan,
            review: localGateReview,
            approvedDesign: input.approvedDesign
          }, { signal: input.signal })
        );
        continue;
      }

      return {
        approved: true,
        plan,
        planVersion,
        reviews,
        blockedForHuman: false,
        finalReviewDecision: review.reviewDecision
      };
    }

    if (round === finalRound) {
      break;
    }

    await input.hooks?.onRevisionStart?.({ round, review });
    plan = taskPlanSchema.parse(
      await input.codex.reviseTaskPlan({
        currentPlan: plan,
        review,
        approvedDesign: input.approvedDesign
      }, { signal: input.signal })
    );
  }

  return {
    approved: false,
    plan,
    planVersion,
    reviews,
    blockedForHuman: true,
    finalReviewDecision: reviews.at(-1)?.reviewDecision
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Workflow was stopped by user");
  }
}
