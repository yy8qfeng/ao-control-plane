import { describe, expect, it } from "vitest";
import { taskPlanSchema } from "./task-plan.js";

describe("taskPlanSchema", () => {
  it("accepts tasks that specify AO roles only", () => {
    const result = taskPlanSchema.safeParse({
      workflowId: "WF-001",
      title: "Valid plan",
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
          aoPrompt: "[WF-001 / TASK-001] Implement the feature.",
          status: "pending"
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects execution tasks that specify concrete agents or models", () => {
    const result = taskPlanSchema.safeParse({
      workflowId: "WF-001",
      title: "Invalid plan",
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
          aoPrompt: "[WF-001 / TASK-001] Implement the feature.",
          status: "pending",
          agent: "codex",
          model: "gpt-5.2",
          provider: "openai"
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("rejects prompts that try to select concrete agents", () => {
    const result = taskPlanSchema.safeParse({
      workflowId: "WF-001",
      title: "Invalid plan",
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
          aoPrompt: "[WF-001 / TASK-001] Use codex to implement the feature.",
          status: "pending"
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});
