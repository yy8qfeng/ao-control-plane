import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import {
  createTaskPlanStage,
  runDesignReviewStage,
  runGovernanceWorkflow
} from "./governance-runner.js";

let tempDir: string | undefined;

describe("runGovernanceWorkflow", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates design review artifacts and a task plan from a web request", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const result = await runGovernanceWorkflow({
      store: new ArtifactStore(tempDir),
      request: {
        title: "User permissions",
        description: "Add role-based permissions.",
        discussion: "Keep AO execution role-only.",
        acceptanceCriteria: ["Permissions are enforced"],
        constraints: ["Do not modify AO"],
        maxDesignReviewRounds: 3
      }
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.plan?.tasks).toHaveLength(1);
    await expect(readFile(join(result.artifactDir, "design.md"), "utf8")).resolves.toContain(
      "## 背景与问题定义"
    );
    await expect(readFile(join(result.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      result.workflow.workflowId
    );
    await expect(readFile(join(result.artifactDir, "task-plan-reviews.json"), "utf8")).resolves.toContain(
      '"reviewDecision": "approved"'
    );
    expect(result.taskPlanReviews).toHaveLength(1);
  });

  it("supports pausing after design review and restarts review count after requirement supplements", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const request = {
      title: "User permissions",
      description: "Add role-based permissions.",
      discussion: "Need one more review before planning.",
      acceptanceCriteria: ["Permissions are enforced"],
      constraints: ["Do not modify AO"],
      maxDesignReviewRounds: 3
    };

    const reviewed = await runDesignReviewStage({ store, request });
    expect(reviewed.workflow.status).toBe("ready_for_planning");
    expect(reviewed.reviews[0]?.round).toBe(1);
    expect(reviewed.plan).toBeUndefined();

    const reviewedAfterSupplement = await runDesignReviewStage({
      store,
      request: {
        ...request,
        workflowId: reviewed.workflow.workflowId,
        discussion: "Need one more review before planning.\n补充：管理员需要可以查看审计日志。"
      }
    });
    expect(reviewedAfterSupplement.workflow.workflowId).toBe(reviewed.workflow.workflowId);
    expect(reviewedAfterSupplement.reviews[0]?.round).toBe(1);

    const planned = await createTaskPlanStage({
      store,
      workflowId: reviewedAfterSupplement.workflow.workflowId
    });
    expect(planned.workflow.status).toBe("executing");
    expect(planned.plan?.tasks).toHaveLength(1);
    expect(planned.taskPlanReviews).toHaveLength(1);
  });

  it("continues task planning from an existing draft after planning blocks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    await store.saveWorkflow({
      requirement: {
        id: "WF-STAGED-CONTINUE",
        title: "Staged continue",
        source: "test",
        description: "Continue task plan.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-STAGED-CONTINUE",
        title: "Staged continue",
        rawRequirement: "Continue task plan.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 3,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Staged continue",
      reviews: [
        {
          workflowId: "WF-STAGED-CONTINUE",
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      taskPlanReviews: [
        {
          workflowId: "WF-STAGED-CONTINUE",
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-001",
              title: "Need more detail",
              body: "Continue from the existing draft.",
              severity: "major",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: {
        workflowId: "WF-STAGED-CONTINUE",
        title: "Existing draft",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-STAGED-CONTINUE",
            title: "Keep existing task",
            description: "Do not regenerate this task.",
            type: "implementation",
            dependencies: [],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Existing draft criterion"],
            aoPrompt:
              "[WF-STAGED-CONTINUE / TASK-001]\n任务名称：Keep existing task\nAO 角色：backend-senior\n验收标准：\n1. Existing draft criterion\n上下文摘要：Continue.",
            executionPolicy: defaultExecutionPolicy,
            status: "pending"
          }
        ]
      }
    });

    const planned = await createTaskPlanStage({
      store,
      workflowId: "WF-STAGED-CONTINUE"
    });

    expect(planned.workflow.status).toBe("executing");
    expect(planned.taskPlanReviews).toHaveLength(2);
    expect(planned.taskPlanReviews?.[1]?.round).toBe(2);
    expect(planned.plan?.tasks[0]?.acceptanceCriteria).toContain("Existing draft criterion");
    await expect(readFile(join(planned.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      "Existing draft criterion"
    );
  });

  it("reviews the approved plan instead of a stale draft for executing workflows", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    await store.saveWorkflow({
      requirement: {
        id: "WF-EXECUTING-REVIEW",
        title: "Executing review",
        source: "test",
        description: "Review an already executable task plan.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-EXECUTING-REVIEW",
        title: "Executing review",
        rawRequirement: "Review an already executable task plan.",
        status: "executing",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: ["TASK-001"]
      },
      design: "# Executing review",
      reviews: [
        {
          workflowId: "WF-EXECUTING-REVIEW",
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      taskPlanReviews: [
        {
          workflowId: "WF-EXECUTING-REVIEW",
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      plan: createPlan("WF-EXECUTING-REVIEW", "Final approved criterion"),
      draftPlan: createPlan("WF-DRAFT-STILL-INVALID", "Draft still needs changes")
    });

    const reviewed = await createTaskPlanStage({
      store,
      workflowId: "WF-EXECUTING-REVIEW"
    });

    expect(reviewed.workflow.status).toBe("executing");
    expect(reviewed.workflow.tasks).toEqual(["TASK-001"]);
    expect(reviewed.plan?.workflowId).toBe("WF-EXECUTING-REVIEW");
    expect(reviewed.plan?.tasks[0]?.acceptanceCriteria).toContain("Final approved criterion");
    expect(reviewed.draftPlan).toBeUndefined();
    expect(reviewed.taskPlanReviews).toHaveLength(2);
    expect(reviewed.taskPlanReviews?.[1]?.round).toBe(2);
    expect(reviewed.taskPlanReviews?.[1]?.reviewDecision).toBe("approved");
    await expect(readFile(join(reviewed.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      "Final approved criterion"
    );
    await expect(readFile(join(reviewed.artifactDir, "task-plan-draft.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

function createPlan(workflowId: string, criterion: string) {
  return {
    workflowId,
    title: "Plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Implement feature",
        description: "Implement the feature.",
        type: "implementation" as const,
        dependencies: [],
        dependencyCondition: "all_completed" as const,
        aoRole: "backend-senior" as const,
        acceptanceCriteria: [criterion],
        aoPrompt: `[${workflowId} / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. ${criterion}\n上下文摘要：Follow the approved design.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending" as const
      }
    ]
  };
}
