import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import { ArtifactStore } from "./artifact-store.js";

let tempDir: string | undefined;

describe("ArtifactStore", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("does not write an empty task-plan.json before a plan exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const store = new ArtifactStore(tempDir);

    await store.saveWorkflow({
      requirement: {
        id: "WF-NO-PLAN",
        title: "No plan",
        source: "test",
        description: "Design review did not pass.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-NO-PLAN",
        title: "No plan",
        rawRequirement: "Design review did not pass.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        tasks: []
      },
      design: "# No plan",
      reviews: []
    });

    await expect(store.readTaskPlan("WF-NO-PLAN")).rejects.toThrow(
      "no task plan was generated"
    );
  });

  it("persists task plan review artifacts with workflow artifacts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const store = new ArtifactStore(tempDir);

    await store.saveWorkflow({
      requirement: {
        id: "WF-PLAN-REVIEWS",
        title: "Plan reviews",
        source: "test",
        description: "Persist task plan reviews.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-PLAN-REVIEWS",
        title: "Plan reviews",
        rawRequirement: "Persist task plan reviews.",
        status: "executing",
        designRounds: 1,
        maxDesignReviewRounds: 3,
        tasks: ["TASK-001"]
      },
      design: "# Plan reviews",
      reviews: [],
      taskPlanReviews: [
        {
          workflowId: "WF-PLAN-REVIEWS",
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      taskPlanApprovalReport: {
        workflowId: "WF-PLAN-REVIEWS",
        planVersion: "task-plan-current",
        generatedAt: "2026-07-02T00:00:00.000Z",
        approved: true,
        planReadiness: "directly_implementable",
        dispatchSummary: {
          dispatchableTaskCount: 1,
          waitingTaskCount: 0,
          manualGateTaskCount: 0,
          blockingFindingCount: 0
        },
        designCoverageTrace: [],
        findingSummary: []
      },
      draftPlan: {
        workflowId: "WF-PLAN-REVIEWS",
        title: "Draft plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-PLAN-REVIEWS",
            title: "Draft task",
            description: "Persist draft task.",
            type: "implementation",
            dependencies: [],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Draft criterion"],
            aoPrompt:
              "[WF-PLAN-REVIEWS / TASK-001]\n任务名称：Draft task\nAO 角色：backend-senior\n验收标准：\n1. Draft criterion\n上下文摘要：Persist draft.",
            executionPolicy: defaultExecutionPolicy,
            status: "pending"
          }
        ]
      }
    });

    const restored = await store.readWorkflow("WF-PLAN-REVIEWS");
    expect(restored.taskPlanReviews).toHaveLength(1);
    expect(restored.taskPlanReviews?.[0]?.reviewDecision).toBe("approved");
    expect(restored.taskPlanApprovalReport?.planReadiness).toBe("directly_implementable");
    expect(restored.draftPlan?.tasks[0]?.title).toBe("Draft task");
  });
});
