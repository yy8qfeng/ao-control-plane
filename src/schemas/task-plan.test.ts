import { describe, expect, it } from "vitest";
import { taskPlanSchema } from "./task-plan.js";

describe("taskPlanSchema", () => {
  const validExecutionPolicy = {
    developerSelfTestRequired: true,
    qaRequired: true,
    regressionRequired: true,
    reviewerRequired: true,
    maxQaRounds: 3,
    maxReviewRounds: 3,
    requirePrOrRp: true
  };

  function createTask(overrides: Record<string, unknown> = {}) {
    return {
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
      ...overrides
    };
  }

  function createPlan(tasks: Array<Record<string, unknown>> = [createTask()], title = "Valid plan") {
    return {
      workflowId: "WF-001",
      title,
      tasks
    };
  }

  it("accepts tasks that specify AO roles only", () => {
    const result = taskPlanSchema.safeParse(createPlan());

    expect(result.success).toBe(true);
  });

  it("fills the default execution policy when omitted", () => {
    const result = taskPlanSchema.safeParse(createPlan());

    expect(result.success && result.data.tasks[0].executionPolicy).toEqual(validExecutionPolicy);
  });

  it("rejects execution tasks that specify concrete agents or models", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          agent: "codex",
          model: "gpt-5.2",
          provider: "openai"
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects prompts that try to select concrete agents", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          aoPrompt: "[WF-001 / TASK-001] Use codex to implement the feature."
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects implementation tasks whose regression workflow is weakened", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          executionPolicy: {
            ...validExecutionPolicy,
            regressionRequired: false,
          }
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects implementation tasks whose QA round limit is weakened", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          executionPolicy: {
            ...validExecutionPolicy,
            maxQaRounds: 2
          }
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("accepts docs tasks with a lighter explicit policy", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          type: "docs",
          aoRole: "docs",
          executionPolicy: {
            developerSelfTestRequired: true,
            qaRequired: true,
            regressionRequired: false,
            reviewerRequired: true,
            maxQaRounds: 2,
            maxReviewRounds: 2,
            requirePrOrRp: true
          }
        })
      ])
    );

    expect(result.success).toBe(true);
  });

  it("rejects partial execution policies instead of completing them with defaults", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          executionPolicy: {
            developerSelfTestRequired: true
          }
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
    expect(
      !result.success &&
        result.error.issues.some((issue) =>
          issue.message.includes(
            "executionPolicy must be complete and valid; invalid or missing fields: qaRequired"
          )
        )
    ).toBe(true);
  });

  it("rejects execution policies with unknown fields", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          executionPolicy: {
            ...validExecutionPolicy,
            bypassQa: true
          }
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("reports forbidden execution fields inside executionPolicy", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          executionPolicy: {
            ...validExecutionPolicy,
            agent: "codex"
          }
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
    expect(
      !result.success &&
        result.error.issues.some(
          (issue) =>
            issue.path.join(".") === "tasks.0.executionPolicy.executionPolicy" &&
            issue.message.includes("invalid or missing fields: agent")
        )
    ).toBe(true);
  });

  it("rejects tasks that are too coarse to execute safely", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          acceptanceCriteria: [
            "Criterion 1",
            "Criterion 2",
            "Criterion 3",
            "Criterion 4",
            "Criterion 5",
            "Criterion 6",
            "Criterion 7",
            "Criterion 8"
          ]
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues.some((issue) => issue.path.includes("acceptanceCriteria"))).toBe(
      true
    );
  });

  it("rejects unknown dependencies", () => {
    const result = taskPlanSchema.safeParse(createPlan([createTask({ dependencies: ["TASK-404"] })], "Invalid plan"));

    expect(result.success).toBe(false);
  });

  it("rejects self dependencies", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          dependencies: ["TASK-001"]
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
    expect(
      !result.success &&
        result.error.issues.some((issue) => issue.message === "Task TASK-001 must not depend on itself")
    ).toBe(true);
  });

  it("rejects two-node dependency cycles", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          taskId: "TASK-001",
          dependencies: ["TASK-002"]
        }),
        createTask({
          taskId: "TASK-002",
          title: "Implement another feature",
          dependencies: ["TASK-001"]
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects three-node dependency cycles", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask({
          taskId: "TASK-001",
          dependencies: ["TASK-002"]
        }),
        createTask({
          taskId: "TASK-002",
          title: "Implement second feature",
          dependencies: ["TASK-003"]
        }),
        createTask({
          taskId: "TASK-003",
          title: "Implement third feature",
          dependencies: ["TASK-001"]
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects duplicated task ids", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([
        createTask(),
        createTask({
          title: "Implement another feature"
        })
      ], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });

  it("rejects task workflow ids that do not match the plan", () => {
    const result = taskPlanSchema.safeParse(createPlan([createTask({ workflowId: "WF-OTHER" })], "Invalid plan"));

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues.some((issue) => issue.path.join(".") === "tasks.0.workflowId")).toBe(
      true
    );
  });

  it("rejects working tasks without an AO session id", () => {
    const result = taskPlanSchema.safeParse(createPlan([createTask({ status: "working" })], "Invalid plan"));

    expect(result.success).toBe(false);
  });

  it("rejects pending tasks with an AO session id", () => {
    const result = taskPlanSchema.safeParse(
      createPlan([createTask({ status: "pending", aoSessionId: "session-1" })], "Invalid plan")
    );

    expect(result.success).toBe(false);
  });
});
