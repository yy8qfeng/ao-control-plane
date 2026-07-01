import { describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { runTaskPlanReviewLoop } from "./task-plan-review-loop.js";

describe("runTaskPlanReviewLoop", () => {
  it("lets Codex revise task-plan findings until ClaudeCode approves", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            acceptanceCriteria: [...task.acceptanceCriteria, "补齐任务计划审查意见"]
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return input.round === 1
          ? {
              workflowId: input.workflowId,
              round: input.round,
              planner: "codex",
              reviewer: "claude-code",
              planVersion: input.planVersion,
              reviewDecision: "changes_requested",
              findings: [
                {
                  id: "TPF-001",
                  title: "验收标准不足",
                  body: "任务计划需要补充可验证验收标准。",
                  severity: "major",
                  status: "unresolved"
                }
              ]
            }
          : approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(reviseTaskPlanCalls).toBe(1);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("补齐任务计划审查意见");
  });

  it("blocks for human when task-plan review rounds are exhausted", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-001",
              title: "仍需整改",
              body: "任务计划仍不可执行。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        };
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-BLOCKED-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 2 }
    });

    expect(result.approved).toBe(false);
    expect(result.blockedForHuman).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(reviseTaskPlanCalls).toBe(1);
  });

  it("continues from an existing task plan without creating a new one", async () => {
    let createTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        createTaskPlanCalls += 1;
        return createPlan(input.workflowId, "新生成计划");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-CONTINUE-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3, startingRound: 4 },
      initialPlan: createPlan("WF-CONTINUE-PLAN", "已有计划")
    });

    expect(createTaskPlanCalls).toBe(0);
    expect(result.reviews[0]?.round).toBe(4);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("已有计划");
  });
});

function createPlan(workflowId: string, criterion: string): TaskPlan {
  return {
    workflowId,
    title: "Plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Implement feature",
        description: "Implement the feature.",
        type: "implementation",
        dependencies: [],
        dependencyCondition: "all_completed",
        aoRole: "backend-senior",
        acceptanceCriteria: [criterion],
        aoPrompt: `[${workflowId} / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. ${criterion}\n上下文摘要：Follow the approved design.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending"
      }
    ]
  };
}

function approveTaskPlan(input: {
  workflowId: string;
  round: number;
  planVersion: string;
}): TaskPlanReview {
  return {
    workflowId: input.workflowId,
    round: input.round,
    planner: "codex",
    reviewer: "claude-code",
    planVersion: input.planVersion,
    reviewDecision: "approved",
    findings: []
  };
}

async function unusedDesignMethod(): Promise<string> {
  throw new Error("should not create design inside task-plan review loop");
}

async function unusedDesignRevision(): Promise<string> {
  throw new Error("should not revise design inside task-plan review loop");
}

async function unusedDesignReview(): Promise<DesignReview> {
  throw new Error("should not review design inside task-plan review loop");
}
