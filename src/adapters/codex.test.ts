import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { PlaceholderCodexAdapter } from "./codex.js";

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
