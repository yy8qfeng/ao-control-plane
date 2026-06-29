import { describe, expect, it } from "vitest";
import { taskPlanSchema } from "./task-plan.js";

describe("taskPlanSchema", () => {
  it("accepts tasks that specify AO roles only", () => {
    const result = taskPlanSchema.safeParse({
      id: "plan-001",
      title: "Valid plan",
      tasks: [
        {
          id: "task-001",
          title: "Implement feature",
          type: "development",
          aoRole: "backend-senior",
          prompt: "Implement the feature.",
          dependencies: [],
          dependencyCondition: "all_completed"
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects execution tasks that specify concrete agents or models", () => {
    const result = taskPlanSchema.safeParse({
      id: "plan-001",
      title: "Invalid plan",
      tasks: [
        {
          id: "task-001",
          title: "Implement feature",
          type: "development",
          aoRole: "backend-senior",
          prompt: "Implement the feature.",
          dependencies: [],
          dependencyCondition: "all_completed",
          agent: "codex",
          model: "gpt-5.2"
        }
      ]
    });

    expect(result.success).toBe(false);
  });
});
