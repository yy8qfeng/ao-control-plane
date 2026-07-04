import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        normalizationReport: {
          round: 2,
          reportPath: "task-plan-normalization-report-2.json",
          outcome: "passed",
          changeCount: 1,
          droppedEntryCount: 0
        },
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
      taskPlanNormalizationReports: [
        {
          workflowId: "WF-PLAN-REVIEWS",
          round: 2,
          generatedAt: "2026-07-02T00:00:00.000Z",
          source: "codex",
          sourceHistory: [
            {
              round: 2,
              source: "codex",
              reason: "bound normalization report"
            }
          ],
          rawSchemaErrors: [],
          changes: [
            {
              path: "tasks.0.type",
              from: "calibration",
              to: "review",
              reason: "task type alias normalized to supported enum"
            }
          ],
          droppedEntries: [],
          strictSchemaErrors: [],
          outcome: "passed"
        }
      ],
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
    await writeFile(
      join(tempDir, "WF-PLAN-REVIEWS", "task-plan-normalization-report-10000.json"),
      JSON.stringify({
        workflowId: "WF-PLAN-REVIEWS",
        round: 10000,
        generatedAt: "2026-07-02T00:00:00.000Z",
        source: "codex",
        rawSchemaErrors: [],
        changes: [],
        droppedEntries: [],
        strictSchemaErrors: [],
        outcome: "passed"
      }),
      "utf8"
    );

    const restored = await store.readWorkflow("WF-PLAN-REVIEWS");
    expect(restored.taskPlanReviews).toHaveLength(1);
    expect(restored.taskPlanReviews?.[0]?.reviewDecision).toBe("approved");
    expect(restored.taskPlanApprovalReport?.planReadiness).toBe("directly_implementable");
    expect(restored.taskPlanNormalizationReports).toHaveLength(1);
    expect(restored.taskPlanNormalizationReports?.[0]?.round).toBe(2);
    expect(restored.taskPlanNormalizationReports?.[0]?.sourceHistory?.[0]?.source).toBe("codex");
    expect(restored.taskPlanNormalizationReports?.[0]?.changes[0]?.path).toBe("tasks.0.type");
    expect(restored.draftPlan?.tasks[0]?.title).toBe("Draft task");
  });

  it("updates latest and round-specific task plan review files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const store = new ArtifactStore(tempDir);

    await store.saveWorkflow({
      requirement: {
        id: "WF-PLAN-REVIEW-FILES",
        title: "Plan review files",
        source: "test",
        description: "Persist latest and round review files.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-PLAN-REVIEW-FILES",
        title: "Plan review files",
        rawRequirement: "Persist latest and round review files.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 3,
        tasks: []
      },
      design: "# Plan review files",
      reviews: [],
      taskPlanReviews: [
        {
          workflowId: "WF-PLAN-REVIEW-FILES",
          round: 2,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "approved",
          findings: [
            {
              id: "TPF-MODEL-OK",
              title: "Model review approved",
              body: "Model review approved.",
              severity: "observation",
              status: "accepted_as_is"
            }
          ]
        },
        {
          workflowId: "WF-PLAN-REVIEW-FILES",
          round: 2,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPG-LOCAL",
              title: "Local gate finding",
              body: "[local-gate] Local gate finding.",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        },
        {
          workflowId: "WF-PLAN-REVIEW-FILES",
          round: 2,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "approved",
          findings: [
            {
              id: "TPF-ARBITRATION-OK",
              title: "Arbitration accepted",
              body: "Arbitration accepted.",
              severity: "observation",
              status: "accepted_as_is"
            }
          ]
        }
      ]
    });

    const workflowDir = join(tempDir, "WF-PLAN-REVIEW-FILES");
    await expect(readFile(join(workflowDir, "task-plan-review-2.json"), "utf8")).resolves.toContain(
      "TPF-MODEL-OK"
    );
    await expect(readFile(join(workflowDir, "task-plan-review-2-local-gate.json"), "utf8")).resolves.toContain(
      "TPG-LOCAL"
    );
    await expect(
      readFile(join(workflowDir, "task-plan-review-2-local-gate-arbitration.json"), "utf8")
    ).resolves.toContain("TPF-ARBITRATION-OK");
    await expect(readFile(join(workflowDir, "task-plan-review-latest.json"), "utf8")).resolves.toContain(
      "TPF-ARBITRATION-OK"
    );
  });

  it("returns structured errors for invalid normalization reports without blocking workflow reads", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const workflowDir = join(tempDir, "WF-BAD-NORMALIZATION-REPORT");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "requirement.json"),
      JSON.stringify({
        id: "WF-BAD-NORMALIZATION-REPORT",
        title: "Bad normalization report",
        source: "test",
        description: "Read workflow with bad normalization report.",
        acceptanceCriteria: [],
        constraints: []
      }),
      "utf8"
    );
    await writeFile(
      join(workflowDir, "workflow.json"),
      JSON.stringify({
        workflowId: "WF-BAD-NORMALIZATION-REPORT",
        title: "Bad normalization report",
        rawRequirement: "Read workflow with bad normalization report.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 3,
        tasks: []
      }),
      "utf8"
    );
    await writeFile(join(workflowDir, "design.md"), "# Design", "utf8");
    await writeFile(join(workflowDir, "reviews.json"), "[]", "utf8");
    await writeFile(
      join(workflowDir, "task-plan-normalization-report-1.json"),
      JSON.stringify({
        workflowId: "WF-BAD-NORMALIZATION-REPORT",
        round: 1,
        generatedAt: "2026-07-03T00:00:00.000Z",
        source: "release",
        rawSchemaErrors: [],
        changes: [],
        droppedEntries: [],
        strictSchemaErrors: [],
        outcome: "passed"
      }),
      "utf8"
    );
    await writeFile(
      join(workflowDir, "task-plan-normalization-report-2.json"),
      JSON.stringify({
        workflowId: "WF-BAD-NORMALIZATION-REPORT",
        round: 2,
        generatedAt: "2026-07-03T00:00:00.000Z",
        source: "codex",
        sourceHistory: [
          {
            round: 2,
            source: "codex",
            reason: "first reason"
          },
          {
            round: 2,
            source: "codex",
            reason: "second reason"
          }
        ],
        rawSchemaErrors: [],
        changes: [],
        droppedEntries: [],
        strictSchemaErrors: [],
        outcome: "passed"
      }),
      "utf8"
    );
    await writeFile(
      join(workflowDir, "task-plan-normalization-report-3.json"),
      JSON.stringify({
        workflowId: "WF-BAD-NORMALIZATION-REPORT",
        round: 3,
        generatedAt: "2026-07-03T00:00:00.000Z",
        source: "codex",
        rawSchemaErrors: "not-an-array",
        changes: [],
        droppedEntries: [],
        strictSchemaErrors: [],
        outcome: "passed"
      }),
      "utf8"
    );

    const restored = await new ArtifactStore(tempDir).readWorkflow("WF-BAD-NORMALIZATION-REPORT");

    expect(restored.taskPlanNormalizationReports).toBeUndefined();
    expect(restored.taskPlanNormalizationReportErrors).toHaveLength(3);
    expect(restored.taskPlanNormalizationReportErrors?.[0]).toMatchObject({
      round: 1,
      severity: "critical"
    });
    expect(restored.taskPlanNormalizationReportErrors?.[0]?.message).toContain("critical source: Invalid enum value");
    expect(restored.taskPlanNormalizationReportErrors?.[0]?.details).toContain('received "release"');
    expect(restored.taskPlanNormalizationReportErrors?.[0]?.issues?.[0]).toMatchObject({
      path: "source",
      code: "invalid_enum_value",
      severity: "critical",
      detailFields: {
        expected: '"codex" | "artifact" | "cli"',
        received: '"release"'
      },
      detailValues: {
        expectedOptions: ["codex", "artifact", "cli"],
        received: "release"
      }
    });
    expect(restored.taskPlanNormalizationReportErrors?.[1]).toMatchObject({
      round: 2,
      severity: "warning"
    });
    expect(restored.taskPlanNormalizationReportErrors?.[1]?.message).toContain("warning sourceHistory.1.reason");
    expect(restored.taskPlanNormalizationReportErrors?.[2]).toMatchObject({
      round: 3,
      severity: "critical"
    });
    expect(restored.taskPlanNormalizationReportErrors?.[2]?.details).toContain("expected array, received string");
    expect(restored.taskPlanNormalizationReportErrors?.[2]?.issues?.[0]).toMatchObject({
      path: "rawSchemaErrors",
      code: "invalid_type",
      severity: "critical",
      details: "expected array, received string",
      detailFields: {
        expected: "array",
        received: "string"
      },
      detailValues: {
        expected: "array",
        received: "string"
      }
    });
  });

  it("normalizes persisted task plans when reading execution artifacts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const store = new ArtifactStore(tempDir);
    const workflowDir = join(tempDir, "WF-READ-NORMALIZED");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "task-plan.json"),
      JSON.stringify({
        workflowId: "WF-READ-NORMALIZED",
        title: "Plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-READ-NORMALIZED",
            title: "Review G0",
            description: "Human review.",
            type: "calibration",
            dependencies: [],
            dependencyCondition: "manual_gate",
            aoRole: "human-reviewer",
            acceptanceCriteria: ["Reviewed"],
            aoPrompt: "[WF-READ-NORMALIZED / TASK-001] Review G0.",
            status: "pending"
          }
        ]
      }),
      "utf8"
    );

    const plan = await store.readTaskPlan("WF-READ-NORMALIZED");

    expect(plan.tasks[0]?.type).toBe("review");
    expect(plan.tasks[0]?.phase).toBe("calibration");
    expect(plan.tasks[0]?.aoRole).toBe("reviewer");
  });
});
