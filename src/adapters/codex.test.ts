import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { CodexCliAdapter, PlaceholderCodexAdapter } from "./codex.js";

const { codexOutput, execaMock } = vi.hoisted(() => {
  const codexOutput = { value: "# Design\n\nGenerated design.", queue: [] as string[] };
  const execaMock = vi.fn(async (_command: string, args: string[], options?: { input?: string }) => {
    void options;
    const { writeFile } = await import("node:fs/promises");
    const outputFlagIndex = args.indexOf("--output-last-message");
    if (outputFlagIndex >= 0) {
      await writeFile(args[outputFlagIndex + 1] ?? "", codexOutput.queue.shift() ?? codexOutput.value);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { codexOutput, execaMock };
});

vi.mock("execa", () => ({
  execa: execaMock
}));

describe("CodexCliAdapter", () => {
  beforeEach(() => {
    codexOutput.value = "# Design\n\nGenerated design.";
    codexOutput.queue = [];
    execaMock.mockClear();
  });

  it("defaults the Codex CLI model to gpt-5.5", async () => {
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    await codex.createDesign({
      id: "REQ-001",
      source: "test",
      title: "Model default",
      description: "Verify default model.",
      acceptanceCriteria: [],
      constraints: []
    });

    const args = execaMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
  });

  it("normalizes Codex task-plan output that puts rationale fields inside executionPolicy", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending",
          executionPolicy: {
            developerSelfTestRequired: true,
            qaRequired: true,
            regressionRequired: true,
            reviewerRequired: true,
            maxReviewRounds: 3,
            requirePrOrRp: true,
            policyRationale: "Implementation tasks need the full delivery loop."
          }
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.executionPolicy).toEqual(defaultExecutionPolicy);
    expect("policyRationale" in (plan.tasks[0]?.executionPolicy ?? {})).toBe(false);
  });

  it("normalizes Codex design coverage trace aliases and unknown evidence task ids", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      designCoverageTrace: [
        {
          requirement: "IPv6 实现、冒烟或验收证据",
          sourceRef: "目标与非目标",
          status: "covered",
          taskIds: ["TASK-001", "TASK-999"],
          rationale: "IPv6 由 TASK-001 覆盖。"
        }
      ],
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Verify IPv6 support",
          description: "Verify IPv6 support.",
          type: "verification",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "qa",
          acceptanceCriteria: ["IPv6 smoke test passes"],
          aoPrompt: "[WF-001 / TASK-001] Verify IPv6 support.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.designCoverageTrace).toEqual([
      {
        requirementId: "ipv6-support",
        requirement: "IPv6 实现、冒烟或验收证据",
        source: "目标与非目标",
        status: "covered",
        evidenceTaskIds: ["TASK-001"],
        rationale: "IPv6 由 TASK-001 覆盖。"
      }
    ]);
  });

  it("skips unidentifiable Codex design coverage trace entries instead of failing schema parsing", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      designCoverageTrace: [
        {
          status: "covered",
          evidenceTaskIds: ["TASK-001"]
        }
      ],
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.designCoverageTrace).toBeUndefined();
  });

  it("normalizes human reviewer role aliases from Codex task-plan output", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Approve G0 result",
          description: "Human review and release gate for the G0 result.",
          type: "review",
          dependencies: [],
          dependencyCondition: "manual_gate",
          aoRole: "human-reviewer",
          acceptanceCriteria: ["G0 result is reviewed"],
          aoPrompt: "[WF-001 / TASK-001] Review G0 result.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.aoRole).toBe("reviewer");
  });

  it("normalizes calibration task type from Codex task-plan output into review phase calibration", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "G0 reality check",
          description: "Calibrate repository reality before implementation.",
          type: "calibration",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "architect",
          acceptanceCriteria: ["G0 result is documented"],
          aoPrompt: "[WF-001 / TASK-001] G0 reality check.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.type).toBe("review");
    expect(plan.tasks[0]?.phase).toBe("calibration");
  });

  it("repairs invalid task-plan schema output before returning a plan", async () => {
    codexOutput.queue = [
      JSON.stringify({
        workflowId: "WF-001",
        title: "Plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-001",
            title: "Implement feature",
            description: "Implement the feature.",
            type: "implementation",
            dependencies: ["TASK-404"],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Feature works"],
            aoPrompt: "[WF-001 / TASK-001] Implement feature.",
            status: "pending"
          }
        ]
      }),
      JSON.stringify({
        workflowId: "WF-001",
        title: "Plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-001",
            title: "Implement feature",
            description: "Implement the feature.",
            type: "implementation",
            dependencies: [],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Feature works"],
            aoPrompt: "[WF-001 / TASK-001] Implement feature.",
            status: "pending"
          }
        ]
      })
    ];
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.dependencies).toEqual([]);
    expect(execaMock).toHaveBeenCalledTimes(2);
    const repairPrompt = execaMock.mock.calls[1]?.[2]?.input as string;
    expect(repairPrompt).toContain("schema repair");
    expect(repairPrompt).toContain("Unknown dependency");
  });

  it("throws a structured repair error when schema repair rounds are exhausted", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: ["TASK-404"],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test", schemaRepairRounds: 1 });

    await expect(
      codex.createTaskPlan({
        workflowId: "WF-001",
        approvedDesign: "# Design\n\nApproved design."
      })
    ).rejects.toMatchObject({
      name: "TaskPlanSchemaRepairError",
      repairAttempts: 1
    });
    expect(execaMock).toHaveBeenCalledTimes(2);
  });
});

describe("PlaceholderCodexAdapter", () => {
  it("keeps revised task plans valid with the default execution policy", async () => {
    const codex = new PlaceholderCodexAdapter();
    const currentPlan: TaskPlan = taskPlanSchema.parse({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });

    const revised = await codex.reviseTaskPlan({
      currentPlan,
      review: {
        workflowId: "WF-001",
        round: 1,
        planner: "codex",
        reviewer: "claude-code",
        planVersion: "task-plan-current",
        reviewDecision: "changes_requested",
        findings: [
          {
            id: "TPF-001",
            title: "补充验收标准",
            body: "任务计划需要补充验收标准。",
            severity: "major",
            status: "unresolved"
          }
        ]
      }
    });

    expect(taskPlanSchema.safeParse(revised).success).toBe(true);
    expect(revised.tasks[0]?.executionPolicy).toEqual(defaultExecutionPolicy);
  });
});
