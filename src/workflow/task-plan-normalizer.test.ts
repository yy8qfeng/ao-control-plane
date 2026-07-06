import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import {
  normalizeTaskPlanModelOutput,
  parseTaskPlanWithNormalization,
  taskPlanNormalizationReportSchema,
  TaskPlanNormalizationError
} from "./task-plan-normalizer.js";

describe("normalizeTaskPlanModelOutput", () => {
  it("normalizes task type aliases and phase-like AO roles", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        tasks: [
          createRawTask({
            taskId: "TASK-001",
            title: "Release verification",
            description: "Publish release notes and verify release.",
            type: "release",
            aoRole: "release"
          }),
          createRawTask({
            taskId: "TASK-002",
            title: "QA validation",
            description: "Run QA validation.",
            type: "qa",
            aoRole: "planning"
          })
        ]
      }),
      { workflowId: "WF-NORMALIZE", round: 2, source: "codex" }
    );

    expect(result.plan?.tasks[0]?.type).toBe("verification");
    expect(result.plan?.tasks[0]?.phase).toBe("release");
    expect(result.plan?.tasks[0]?.aoRole).toBe("docs");
    expect(result.plan?.tasks[1]?.type).toBe("test");
    expect(result.plan?.tasks[1]?.phase).toBe("planning");
    expect(result.plan?.tasks[1]?.aoRole).toBe("qa");
    expect(result.report.outcome).toBe("passed");
    expect(result.report.changes.map((change) => change.path)).toContain("tasks.0.type");
    expect(result.report.changes.map((change) => change.path)).toContain("tasks.0.aoRole");
  });

  it("normalizes role aliases", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        tasks: [
          createRawTask({ taskId: "TASK-001", aoRole: "human-reviewer", type: "review" }),
          createRawTask({ taskId: "TASK-002", aoRole: "senior-backend", type: "implementation" }),
          createRawTask({ taskId: "TASK-003", aoRole: "backend-lead", type: "refactor" }),
          createRawTask({ taskId: "TASK-004", aoRole: "senior-frontend", type: "implementation" })
        ]
      }),
      { workflowId: "WF-NORMALIZE", source: "codex" }
    );

    expect(result.plan?.tasks.map((task) => task.aoRole)).toEqual([
      "reviewer",
      "backend-senior",
      "backend-senior",
      "frontend-senior"
    ]);
  });

  it("normalizes design coverage aliases, inferred requirement ids, and unknown evidence ids", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        designCoverageTrace: [
          {
            requirementKey: "explicit-key",
            title: "Explicit coverage",
            section: "目标",
            status: "covered",
            taskIds: ["TASK-001", "TASK-999"]
          },
          {
            requirement: "IPv6 实现、冒烟或验收证据",
            sourceRef: "验收",
            status: "covered",
            evidenceTaskIds: []
          },
          {
            status: "covered",
            evidenceTaskIds: ["TASK-001"]
          }
        ],
        tasks: [createRawTask({ taskId: "TASK-001", type: "verification", aoRole: "qa" })]
      }),
      { workflowId: "WF-NORMALIZE", source: "codex" }
    );

    expect(result.plan?.designCoverageTrace).toEqual([
      {
        requirementId: "explicit-key",
        requirement: "Explicit coverage",
        source: "目标",
        status: "covered",
        evidenceTaskIds: ["TASK-001"]
      },
      {
        requirementId: "ipv6-support",
        requirement: "IPv6 实现、冒烟或验收证据",
        source: "验收",
        status: "covered",
        evidenceTaskIds: []
      }
    ]);
    expect(result.report.droppedEntries.some((entry) => entry.reason.includes("unknown evidence task ids"))).toBe(true);
    expect(result.report.droppedEntries.some((entry) => entry.reason === "requirementId cannot be inferred")).toBe(true);
  });

  it("restores weakened implementation execution policy and removes rationale fields", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        tasks: [
          createRawTask({
            type: "implementation",
            executionPolicy: {
              developerSelfTestRequired: true,
              qaRequired: false,
              regressionRequired: true,
              reviewerRequired: false,
              maxQaRounds: 1,
              maxReviewRounds: 2,
              requirePrOrRp: false,
              policyRationale: "模型解释"
            }
          })
        ]
      }),
      { workflowId: "WF-NORMALIZE", source: "codex" }
    );

    expect(result.plan?.tasks[0]?.executionPolicy).toEqual(defaultExecutionPolicy);
    expect(result.report.droppedEntries.map((entry) => entry.path)).toContain("tasks.0.executionPolicy.policyRationale");
  });

  it("infers structured artifact contracts for planning, contract, QA, and release gates", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        tasks: [
          createRawTask({
            taskId: "TASK-001",
            title: "Task plan gate",
            description: "Review task plan gate.",
            type: "verification",
            aoRole: "reviewer"
          }),
          createRawTask({
            taskId: "TASK-002",
            title: "Contract freeze",
            description: "Write contract freeze evidence.",
            type: "verification",
            aoRole: "reviewer"
          }),
          createRawTask({
            taskId: "TASK-003",
            title: "QA verdict",
            description: "Write QA verdict.",
            type: "verification",
            aoRole: "qa"
          }),
          createRawTask({
            taskId: "TASK-004",
            title: "Release decision gate",
            description: "Write release decision.",
            type: "verification",
            aoRole: "docs"
          })
        ]
      }),
      { workflowId: "WF-NORMALIZE", source: "codex" }
    );

    expect(result.plan?.tasks.map((task) => task.outputArtifacts?.[0]?.path)).toEqual([
      "task-plan-approval-report.json",
      "contract-freeze-evidence.json",
      "qa_verdict.json",
      "release_decision.json"
    ]);
  });

  it("reports raw schema failures without throwing enum errors", () => {
    const result = normalizeTaskPlanModelOutput(
      { workflowId: "WF-BAD", title: "Bad plan", tasks: [{}] },
      { workflowId: "WF-BAD", source: "codex" }
    );

    expect(result.plan).toBeUndefined();
    expect(result.report.outcome).toBe("raw_failed");
    expect(result.report.rawSchemaErrors.length).toBeGreaterThan(0);
  });

  it("reports strict schema failures after normalization", () => {
    const result = normalizeTaskPlanModelOutput(
      createRawPlan({
        tasks: [
          createRawTask({ taskId: "TASK-001", dependencies: ["TASK-404"] })
        ]
      }),
      { workflowId: "WF-NORMALIZE", source: "codex" }
    );

    expect(result.plan).toBeUndefined();
    expect(result.report.outcome).toBe("strict_failed");
    expect(result.report.strictSchemaErrors.some((issue) => issue.message.includes("Unknown dependency"))).toBe(true);
  });

  it("throws a structured normalization error from parse helper", () => {
    expect(() =>
      parseTaskPlanWithNormalization(
        createRawPlan({
          tasks: [createRawTask({ taskId: "TASK-001", dependencies: ["TASK-404"] })]
        }),
        { workflowId: "WF-NORMALIZE", source: "cli" },
        "invalid plan"
      )
    ).toThrow(TaskPlanNormalizationError);
  });

  it("validates source history in normalization reports", () => {
    const report = taskPlanNormalizationReportSchema.parse({
      workflowId: "WF-NORMALIZE",
      round: 2,
      generatedAt: "2026-07-03T00:00:00.000Z",
      source: "artifact",
      sourceHistory: [
        { round: 1, source: "artifact", reason: "fallback normalization report created" },
        { round: 2, source: "artifact", reason: "previous normalization report carried forward" }
      ],
      rawSchemaErrors: [],
      changes: [],
      droppedEntries: [],
      strictSchemaErrors: [],
      outcome: "passed"
    });

    expect(report.sourceHistory?.[1]?.reason).toBe("previous normalization report carried forward");
    expect(() =>
      taskPlanNormalizationReportSchema.parse({
        ...report,
        sourceHistory: [{ round: 1, source: "release", reason: "invalid source" }]
      })
    ).toThrow();
    expect(() =>
      taskPlanNormalizationReportSchema.parse({
        ...report,
        sourceHistory: [
          { round: 1, source: "artifact", reason: "fallback normalization report created" },
          { round: 1, source: "artifact", reason: "different reason" }
        ]
      })
    ).toThrow("sourceHistory entries for the same round and source must use the same reason");
  });
});

function createRawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowId: "WF-NORMALIZE",
    title: "Plan",
    tasks: [createRawTask()],
    ...overrides
  };
}

function createRawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "TASK-001",
    workflowId: "WF-NORMALIZE",
    title: "Implement feature",
    description: "Implement the feature.",
    type: "implementation",
    dependencies: [],
    dependencyCondition: "all_completed",
    aoRole: "backend-senior",
    acceptanceCriteria: ["Feature works"],
    aoPrompt: "[WF-NORMALIZE / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. Feature works\n上下文摘要：Follow design.",
    status: "pending",
    ...overrides
  };
}
