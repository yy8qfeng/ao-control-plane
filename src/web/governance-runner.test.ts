import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { parseTaskPlanWithNormalization } from "../workflow/task-plan-normalizer.js";
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
    await expect(readFile(join(result.artifactDir, "task-plan-approval-report.json"), "utf8")).resolves.toContain(
      '"approved": true'
    );
    expect(result.taskPlanApprovalReport?.approved).toBe(true);
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

  it("persists and restores task plan normalization reports for web planning", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-WEB-NORMALIZATION-REPORT";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Web normalization report",
        source: "test",
        description: "Persist normalization reports.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Web normalization report",
        rawRequirement: "Persist normalization reports.",
        status: "ready_for_planning",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Web normalization report",
      reviews: [
        {
          workflowId,
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-current",
          reviewDecision: "approved",
          findings: []
        }
      ]
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        return parseTaskPlanWithNormalization(
          {
            workflowId,
            title: "Plan",
            tasks: [
              {
                taskId: "TASK-001",
                workflowId,
                title: "G0 reality check",
                description: "Calibrate repository reality.",
                type: "calibration",
                dependencies: [],
                dependencyCondition: "all_completed",
                aoRole: "architect",
                acceptanceCriteria: ["G0 result is documented"],
                aoPrompt: `[${workflowId} / TASK-001] G0 reality check.`,
                status: "pending"
              }
            ]
          },
          { workflowId, source: "codex" }
        );
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return {
          workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "approved",
          findings: []
        };
      }
    };

    const planned = await createTaskPlanStage({ store, workflowId, codex, claudeCode });
    const restored = await store.readWorkflow(workflowId);

    expect(planned.taskPlanNormalizationReports).toHaveLength(1);
    expect(restored.taskPlanNormalizationReports).toHaveLength(1);
    expect(restored.taskPlanNormalizationReports?.[0]?.changes[0]?.path).toBe("tasks.0.type");
    expect(restored.workflow.lastNormalization?.reportPath).toBe("task-plan-normalization-report-1.json");
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

  it("continues a rejected draft instead of a stale final plan for executing workflows", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-EXECUTING-REJECTED-DRAFT";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Executing rejected draft",
        source: "test",
        description: "Continue a rejected draft task plan.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Executing rejected draft",
        rawRequirement: "Continue a rejected draft task plan.",
        status: "executing",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: ["TASK-001"]
      },
      design: "# Executing rejected draft",
      reviews: [
        {
          workflowId,
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      taskPlanApprovalReport: {
        workflowId,
        planVersion: "task-plan-current",
        generatedAt: "2026-07-02T00:00:00.000Z",
        approved: false,
        planReadiness: "gated_implementable",
        dispatchSummary: {
          dispatchableTaskCount: 1,
          waitingTaskCount: 1,
          manualGateTaskCount: 1,
          blockingFindingCount: 1
        },
        designCoverageTrace: [],
        findingSummary: [
          {
            id: "TPF-DRAFT",
            title: "Draft still needs changes",
            severity: "major",
            status: "unresolved"
          }
        ]
      },
      plan: createPlan(workflowId, "Old final criterion"),
      draftPlan: createPlan(workflowId, "Rejected draft criterion")
    });

    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        expect(input.plan.tasks[0]?.acceptanceCriteria).toContain("Rejected draft criterion");
        return {
          workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "approved",
          findings: []
        };
      }
    };

    const reviewed = await createTaskPlanStage({
      store,
      workflowId,
      claudeCode
    });

    expect(reviewed.workflow.status).toBe("executing");
    expect(reviewed.plan?.tasks[0]?.acceptanceCriteria).toContain("Rejected draft criterion");
    expect(reviewed.draftPlan).toBeUndefined();
    await expect(readFile(join(reviewed.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      "Rejected draft criterion"
    );
    await expect(readFile(join(reviewed.artifactDir, "task-plan.json"), "utf8")).resolves.not.toContain(
      "Old final criterion"
    );
  });

  it("removes stale final task plans when replanning an executing workflow is blocked", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-EXECUTING-REPLAN-BLOCK";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Executing replan block",
        source: "test",
        description: "Replan an already executable task plan.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Executing replan block",
        rawRequirement: "Replan an already executable task plan.",
        status: "executing",
        designRounds: 1,
        maxDesignReviewRounds: 2,
        approvedDesignVersion: "design-current",
        tasks: ["TASK-001"]
      },
      design: "# Executing replan block",
      reviews: [
        {
          workflowId,
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-current",
          reviewDecision: "approved",
          findings: []
        }
      ],
      plan: createPlan(workflowId, "Old approved criterion")
    });

    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from existing plan");
      },
      async reviseTaskPlan(): Promise<TaskPlan> {
        return createPlan(workflowId, "Blocked replan draft criterion");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return {
          workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "changes_requested",
          findings: [
            {
              id: `TPF-${input.round}`,
              title: "继续整改",
              body: "本轮任务计划仍需整改。",
              severity: "major",
              status: "unresolved"
            }
          ]
        };
      }
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("blocked_for_human");
    expect(planned.workflow.tasks).toEqual([]);
    expect(planned.plan).toBeUndefined();
    expect(planned.draftPlan?.tasks[0]?.acceptanceCriteria).toContain("Blocked replan draft criterion");
    await expect(readFile(join(planned.artifactDir, "task-plan.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(planned.artifactDir, "task-plan-draft.json"), "utf8")).resolves.toContain(
      "Blocked replan draft criterion"
    );
    await expect(readFile(join(planned.artifactDir, "task-plan-approval-report.json"), "utf8")).resolves.toContain(
      '"approved": false'
    );
  });

  it("uses the requested review round limit when continuing a task-plan draft", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-CONTINUE-PLAN-ROUNDS";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Continue plan rounds",
        source: "test",
        description: "Continue task-plan review with an increased round limit.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Continue plan rounds",
        rawRequirement: "Continue task-plan review with an increased round limit.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Continue plan rounds",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-OLD",
              title: "旧任务计划问题",
              body: "旧问题需要在续审计划中承接。",
              severity: "major",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: createPlan(workflowId, "Initial draft criterion")
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
      },
      async reviseTaskPlan(): Promise<TaskPlan> {
        return createPlan(workflowId, "Addresses TPF-OLD and TPF-ROUND-2");
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
          reviewDecision: input.round === 2 ? "changes_requested" : "approved",
          findings:
            input.round === 2
              ? [
                  {
                    id: "TPF-ROUND-2",
                    title: "第二轮任务计划问题",
                    body: "第二轮问题需要在下一版计划中承接。",
                    severity: "major",
                    status: "unresolved"
                  }
                ]
              : []
        };
      }
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      maxTaskPlanReviewRounds: 2,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("executing");
    expect(planned.taskPlanReviews?.map((review) => review.round)).toEqual([1, 2, 3]);
    expect(planned.plan?.tasks[0]?.acceptanceCriteria).toContain("Addresses TPF-OLD and TPF-ROUND-2");
  });

  it("persists task-plan review checkpoints before a later continuation failure", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-CONTINUE-PLAN-CHECKPOINT";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Continue plan checkpoint",
        source: "test",
        description: "Persist task-plan continuation checkpoints.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Continue plan checkpoint",
        rawRequirement: "Persist task-plan continuation checkpoints.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Continue plan checkpoint",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-OLD",
              title: "旧任务计划问题",
              body: "旧问题需要在续审计划中承接。",
              severity: "major",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: createPlan(workflowId, "Initial draft criterion")
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
      },
      async reviseTaskPlan(): Promise<TaskPlan> {
        return createPlan(workflowId, "Checkpointed draft addresses TPF-OLD and TPF-ROUND-2");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        if (input.round === 3) {
          throw new Error("ClaudeCode network failure");
        }
        return {
          workflowId: input.workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-ROUND-2",
              title: "第二轮任务计划问题",
              body: "第二轮问题需要在下一版计划中承接。",
              severity: "major",
              status: "unresolved"
            }
          ]
        };
      }
    };

    await expect(
      createTaskPlanStage({
        store,
        workflowId,
        maxTaskPlanReviewRounds: 3,
        codex,
        claudeCode
      })
    ).rejects.toThrow("ClaudeCode network failure");

    const checkpoint = await store.readWorkflow(workflowId);
    expect(checkpoint.taskPlanReviews?.map((review) => review.round)).toEqual([1, 2]);
    expect(checkpoint.draftPlan?.tasks[0]?.acceptanceCriteria).toContain(
      "Checkpointed draft addresses TPF-OLD and TPF-ROUND-2"
    );
    expect(checkpoint.taskPlanApprovalReport).toBeUndefined();
  });

  it("revises a rejected draft before reviewing again when continuation resumes after revision start", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-RESUME-REVISION-FIRST";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Resume revision first",
        source: "test",
        description: "Resume after review requested changes.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Resume revision first",
        rawRequirement: "Resume after review requested changes.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Approved design",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 28,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-NEEDS-REVISION",
              title: "缺少 revised marker",
              body: "任务计划必须包含 revised marker。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ],
      taskPlanNormalizationReports: [
        {
          workflowId,
          round: 28,
          generatedAt: "2026-07-03T00:00:00.000Z",
          source: "codex",
          rawSchemaErrors: [],
          changes: [],
          droppedEntries: [],
          strictSchemaErrors: [],
          outcome: "passed"
        }
      ],
      draftPlan: createPlan(workflowId, "Old unreviewed criterion")
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
      },
      async reviseTaskPlan(): Promise<TaskPlan> {
        return createPlan(workflowId, "TPF-NEEDS-REVISION revised marker");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        expect(input.round).toBe(29);
        expect(input.plan.tasks[0]?.acceptanceCriteria).toContain("TPF-NEEDS-REVISION revised marker");
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
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      maxTaskPlanReviewRounds: 1,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("executing");
    expect(planned.plan?.tasks[0]?.acceptanceCriteria).toContain("TPF-NEEDS-REVISION revised marker");
    expect(planned.taskPlanReviews?.map((review) => review.round)).toEqual([28, 29]);
  });

  it("blocks task planning when ClaudeCode approves but the local gate still finds unresolved findings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-LOCAL-GATE-BLOCK";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Local gate block",
        source: "test",
        description: "Block approved task plan when local gate fails.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Local gate block",
        rawRequirement: "Block approved task plan when local gate fails.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Local gate block",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-RAWIP",
              title: "RawIpAdapter 权限失败错误契约缺失",
              body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: createPlan(workflowId, "Final approved criterion")
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
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
          reviewDecision: "approved",
          findings: []
        };
      }
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("blocked_for_human");
    expect(planned.plan).toBeUndefined();
    expect(planned.draftPlan?.tasks[0]?.acceptanceCriteria).toContain("Final approved criterion");
    expect(
      planned.taskPlanReviews?.some((review) =>
        review.findings.some((finding) => finding.id === "TPG-PREVIOUS-TPF-RAWIP")
      )
    ).toBe(true);
    expect(planned.taskPlanApprovalReport?.approved).toBe(false);
    expect(planned.taskPlanReviews?.at(-1)?.reviewer).toBe("claude-code");
    expect(planned.taskPlanReviews?.at(-1)?.findings[0]?.id).toContain("TPF-ARBITRATION-MISSING");
    await expect(readFile(join(planned.artifactDir, "task-plan-approval-report.json"), "utf8")).resolves.toContain(
      '"approved": false'
    );
    await expect(readFile(join(planned.artifactDir, "task-plan.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(planned.artifactDir, "task-plan-draft.json"), "utf8")).resolves.toContain(
      "Final approved criterion"
    );
  });

  it("writes the final task plan when ClaudeCode arbitration accepts local gate findings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-LOCAL-GATE-ARBITRATION-APPROVED";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Local gate arbitration approved",
        source: "test",
        description: "Accept local gate finding after arbitration.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Local gate arbitration approved",
        rawRequirement: "Accept local gate finding after arbitration.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Local gate arbitration approved",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-RAWIP",
              title: "RawIpAdapter 权限失败错误契约缺失",
              body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: createPlan(workflowId, "Final approved criterion")
    });
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
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
          reviewDecision: "approved",
          findings: []
        };
      },
      async reviewTaskPlanLocalGate(input): Promise<TaskPlanReview> {
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
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("executing");
    expect(planned.plan?.tasks[0]?.acceptanceCriteria).toContain("Final approved criterion");
    expect(planned.draftPlan).toBeUndefined();
    expect(planned.taskPlanApprovalReport?.approved).toBe(true);
    expect(planned.taskPlanApprovalReport?.localGateArbitration?.decision).toBe("approved");
    await expect(readFile(join(planned.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      "Final approved criterion"
    );
    await expect(readFile(join(planned.artifactDir, "task-plan-draft.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("blocks after repeated local gate failures exhaust task-plan review rounds", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const workflowId = "WF-LOCAL-GATE-REPEATED";
    await store.saveWorkflow({
      requirement: {
        id: workflowId,
        title: "Repeated local gate block",
        source: "test",
        description: "Keep blocking until local gate evidence exists.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId,
        title: "Repeated local gate block",
        rawRequirement: "Keep blocking until local gate evidence exists.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 3,
        approvedDesignVersion: "design-current",
        tasks: []
      },
      design: "# Repeated local gate block",
      reviews: [
        {
          workflowId,
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
          workflowId,
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-CLOCK",
              title: "clock_domain 字段未贯通",
              body: "clock_domain 必须贯通到 IpcStats 和 TransportStats。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ],
      draftPlan: createPlan(workflowId, "Final approved criterion")
    });
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from draft");
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
          reviewDecision: "approved",
          findings: []
        };
      }
    };

    const planned = await createTaskPlanStage({
      store,
      workflowId,
      codex,
      claudeCode
    });

    expect(planned.workflow.status).toBe("blocked_for_human");
    expect(planned.plan).toBeUndefined();
    expect(reviseTaskPlanCalls).toBe(3);
    expect(planned.taskPlanReviews).toHaveLength(10);
    expect(planned.taskPlanReviews?.at(-1)?.findings[0]?.id).toContain("TPF-ARBITRATION-MISSING");
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

async function unusedDesignMethod(): Promise<string> {
  throw new Error("should not create design");
}

async function unusedDesignRevision(): Promise<string> {
  throw new Error("should not revise design");
}

async function unusedDesignReview(): Promise<DesignReview> {
  throw new Error("should not review design");
}
