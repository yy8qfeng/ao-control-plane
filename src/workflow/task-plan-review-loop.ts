import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlanApprovalReport } from "../schemas/task-plan-approval-report.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import { createLocalGateReview, validateTaskPlanApprovalGate } from "./task-plan-gates.js";
import {
  TASK_PLAN_NORMALIZATION_SOURCE,
  cloneTaskPlanNormalizationReport,
  getTaskPlanNormalizationReport,
  type TaskPlanNormalizationSource,
  type TaskPlanNormalizationReport
} from "./task-plan-normalizer.js";

export interface TaskPlanReviewLoopOptions {
  maxTaskPlanReviewRounds: number;
  startingRound?: number;
}

export interface TaskPlanReviewLoopHooks {
  onPlan?: (input: {
    planVersion: string;
    plan: TaskPlan;
    round: number;
    normalizationReport?: TaskPlanNormalizationReport;
  }) => Promise<void> | void;
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
  approvalReport: TaskPlanApprovalReport;
}

export async function runTaskPlanReviewLoop(input: {
  workflowId: string;
  approvedDesign: string;
  deferredFindings: DesignReview["findings"];
  codex: CodexAdapter;
  claudeCode: ClaudeCodeAdapter;
  options: TaskPlanReviewLoopOptions;
  normalizationSource?: TaskPlanNormalizationSource;
  hooks?: TaskPlanReviewLoopHooks;
  signal?: AbortSignal;
  initialPlan?: TaskPlan;
  previousReviews?: TaskPlanReview[];
}): Promise<TaskPlanReviewLoopResult> {
  throwIfAborted(input.signal);
  const initialPlan = input.initialPlan
    ? input.initialPlan
    : await input.codex.createTaskPlan({
      workflowId: input.workflowId,
      approvedDesign: input.approvedDesign,
      deferredFindings: input.deferredFindings
    }, { signal: input.signal });
  let normalizationReport = materializeNormalizationReport(
    initialPlan,
    input.options.startingRound ?? 1,
    getTaskPlanNormalizationReport(initialPlan),
    input.initialPlan ? input.normalizationSource ?? TASK_PLAN_NORMALIZATION_SOURCE.artifact : TASK_PLAN_NORMALIZATION_SOURCE.codex
  );
  let plan = taskPlanSchema.parse(initialPlan);
  const reviews: TaskPlanReview[] = [];
  const previousReviews = input.previousReviews ?? [];
  const planVersion = "task-plan-current";
  const startingRound = input.options.startingRound ?? 1;
  const finalRound = startingRound + input.options.maxTaskPlanReviewRounds - 1;

  for (let round = startingRound; round <= finalRound; round += 1) {
    throwIfAborted(input.signal);
    normalizationReport = materializeNormalizationReport(plan, round, normalizationReport, normalizationReport.source);
    await input.hooks?.onPlan?.({ planVersion, plan, round, normalizationReport });
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
        planVersion,
        approvedDesign: input.approvedDesign,
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
        const revisedPlan = await input.codex.reviseTaskPlan({
          currentPlan: plan,
          review: localGateReview,
          approvedDesign: input.approvedDesign
        }, { signal: input.signal });
        normalizationReport = materializeRevisedNormalizationReport(revisedPlan, round + 1, normalizationReport);
        plan = taskPlanSchema.parse(revisedPlan);
        continue;
      }

      return {
        approved: true,
        plan,
        planVersion,
        reviews,
        blockedForHuman: false,
        finalReviewDecision: review.reviewDecision,
        approvalReport: attachNormalizationSummary(gate.approvalReport, normalizationReport)
      };
    }

    if (round === finalRound) {
      break;
    }

    await input.hooks?.onRevisionStart?.({ round, review });
    const revisedPlan = await input.codex.reviseTaskPlan({
      currentPlan: plan,
      review,
      approvedDesign: input.approvedDesign
    }, { signal: input.signal });
    normalizationReport = materializeRevisedNormalizationReport(revisedPlan, round + 1, normalizationReport);
    plan = taskPlanSchema.parse(revisedPlan);
  }

  const approvalReport = validateTaskPlanApprovalGate({
    workflowId: input.workflowId,
    planVersion,
    approvedDesign: input.approvedDesign,
    deferredFindings: input.deferredFindings,
    plan,
    previousReviews: [...previousReviews, ...reviews]
  }).approvalReport;

  return {
    approved: false,
    plan,
    planVersion,
    reviews,
    blockedForHuman: true,
    finalReviewDecision: reviews.at(-1)?.reviewDecision,
    approvalReport: attachNormalizationSummary(approvalReport, normalizationReport)
  };
}

function materializeNormalizationReport(
  plan: TaskPlan,
  round: number,
  previous?: TaskPlanNormalizationReport,
  source: TaskPlanNormalizationSource = TASK_PLAN_NORMALIZATION_SOURCE.artifact
): TaskPlanNormalizationReport {
  const boundReport = getTaskPlanNormalizationReport(plan);
  const report = boundReport ?? previous;
  if (report) {
    return appendSourceHistory(
      cloneTaskPlanNormalizationReport(report, { round }),
      round,
      boundReport ? "bound normalization report" : "previous normalization report carried forward"
    );
  }
  return appendSourceHistory({
    workflowId: plan.workflowId,
    round,
    generatedAt: new Date().toISOString(),
    source,
    rawSchemaErrors: [],
    changes: [],
    droppedEntries: [],
    strictSchemaErrors: [],
    outcome: "passed"
  }, round, "fallback normalization report created");
}

function materializeRevisedNormalizationReport(
  revisedPlan: TaskPlan,
  round: number,
  previousReport: TaskPlanNormalizationReport
): TaskPlanNormalizationReport {
  if (!previousReport) {
    throw new Error("Task-plan revision normalization requires a previous normalization report");
  }
  const revisedReport = getTaskPlanNormalizationReport(revisedPlan);
  return materializeNormalizationReport(
    revisedPlan,
    round,
    revisedReport ?? previousReport,
    revisedReport?.source ?? previousReport.source
  );
}

function appendSourceHistory(
  report: TaskPlanNormalizationReport,
  round: number,
  reason: string
): TaskPlanNormalizationReport {
  const history = [...(report.sourceHistory ?? [])];
  const last = history.at(-1);
  if (last?.round !== round || last.source !== report.source) {
    history.push({ round, source: report.source, reason });
  }
  return { ...report, sourceHistory: history };
}

function attachNormalizationSummary(
  approvalReport: TaskPlanApprovalReport,
  report: TaskPlanNormalizationReport | undefined
): TaskPlanApprovalReport {
  if (!report) {
    return approvalReport;
  }
  return {
    ...approvalReport,
    normalizationReport: {
      round: report.round,
      reportPath: `task-plan-normalization-report-${report.round}.json`,
      outcome: report.outcome,
      changeCount: report.changes.length,
      droppedEntryCount: report.droppedEntries.length
    }
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Workflow was stopped by user");
  }
}
