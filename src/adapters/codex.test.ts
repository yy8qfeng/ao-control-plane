import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { CodexCliAdapter, PlaceholderCodexAdapter } from "./codex.js";

const { codexOutput, execaMock } = vi.hoisted(() => {
  const codexOutput = { value: "# Design\n\nGenerated design." };
  const execaMock = vi.fn(async (_command: string, args: string[]) => {
    const { writeFile } = await import("node:fs/promises");
    const outputFlagIndex = args.indexOf("--output-last-message");
    if (outputFlagIndex >= 0) {
      await writeFile(args[outputFlagIndex + 1] ?? "", codexOutput.value);
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
