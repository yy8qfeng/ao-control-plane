import { describe, expect, it } from "vitest";
import type { AoCliAdapter } from "../adapters/ao.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
import { executePlan } from "./plan-execution.js";

describe("executePlan", () => {
  it("dispatches only pending tasks whose dependencies are satisfied", async () => {
    const spawned: string[] = [];
    const ao = createAo((taskId) => spawned.push(taskId));
    const plan = createPlan([
      createTask({
        taskId: "TASK-001",
        title: "Completed prerequisite",
        description: "Completed prerequisite.",
        status: "completed"
      }),
      createTask({
        taskId: "TASK-002",
        title: "Ready task",
        description: "Ready task.",
        type: "test",
        dependencies: ["TASK-001"],
        aoRole: "qa",
        acceptanceCriteria: ["Tests pass"],
        aoPrompt: "[WF-001 / TASK-002] Test."
      }),
      createTask({
        taskId: "TASK-003",
        title: "Blocked task",
        description: "Blocked task.",
        type: "review",
        dependencies: ["TASK-002"],
        aoRole: "reviewer",
        acceptanceCriteria: ["Reviewed"],
        aoPrompt: "[WF-001 / TASK-003] Review."
      })
    ]);

    const result = await executePlan({ plan, ao: ao as AoCliAdapter });

    expect(spawned).toEqual(["TASK-002"]);
    expect(result).toEqual({
      sessions: [
        {
          taskId: "TASK-002",
          aoRole: "qa",
          sessionId: "session-TASK-002"
        }
      ],
      blockedTasks: [
        {
          taskId: "TASK-003",
          kind: "waiting_dependencies",
          reason: "waiting for dependencies: TASK-002"
        }
      ]
    });
  });

  it("dispatches any_completed tasks when at least one dependency is complete", async () => {
    const spawned: string[] = [];
    const ao = createAo((taskId) => spawned.push(taskId));
    const plan = createPlan([
      createTask({
        taskId: "TASK-001",
        title: "Completed dependency",
        description: "Completed dependency.",
        status: "completed"
      }),
      createTask({
        taskId: "TASK-002",
        title: "Alternative dependency",
        description: "Alternative dependency."
      }),
      createTask({
        taskId: "TASK-003",
        title: "Any dependency task",
        description: "Any dependency task.",
        type: "verification",
        dependencies: ["TASK-001", "TASK-002"],
        dependencyCondition: "any_completed",
        aoRole: "qa",
        acceptanceCriteria: ["Verified"],
        aoPrompt: "[WF-001 / TASK-003] Verify."
      })
    ]);

    const result = await executePlan({ plan, ao: ao as AoCliAdapter });

    expect(spawned).toEqual(["TASK-002", "TASK-003"]);
    expect(result.blockedTasks).toEqual([]);
  });

  it("keeps manual_gate tasks blocked until dependencies complete", async () => {
    const spawned: string[] = [];
    const ao = createAo((taskId) => spawned.push(taskId));
    const plan = createPlan([
      createTask({
        taskId: "TASK-001",
        title: "Incomplete dependency",
        description: "Incomplete dependency."
      }),
      createTask({
        taskId: "TASK-002",
        title: "Manual gate task",
        description: "Manual gate task.",
        type: "verification",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        aoRole: "qa",
        acceptanceCriteria: ["Verified"],
        aoPrompt: "[WF-001 / TASK-002] Verify."
      })
    ]);

    const result = await executePlan({ plan, ao: ao as unknown as AoCliAdapter });

    expect(spawned).toEqual(["TASK-001"]);
    expect(result.blockedTasks).toEqual([
      {
        taskId: "TASK-002",
        kind: "waiting_dependencies",
        reason: "waiting for dependencies: TASK-001"
      }
    ]);
  });

  it("keeps manual_gate tasks blocked after dependencies complete", async () => {
    const ao = {
      async spawnTask() {
        throw new Error("manual gate tasks should not dispatch automatically");
      }
    } satisfies Pick<AoCliAdapter, "spawnTask">;
    const plan = createPlan([
      createTask({
        taskId: "TASK-001",
        title: "Completed dependency",
        description: "Completed dependency.",
        status: "completed"
      }),
      createTask({
        taskId: "TASK-002",
        title: "Manual gate task",
        description: "Manual gate task.",
        type: "verification",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        aoRole: "qa",
        acceptanceCriteria: ["Verified"],
        aoPrompt: "[WF-001 / TASK-002] Verify."
      })
    ]);

    await expect(executePlan({ plan, ao: ao as unknown as AoCliAdapter })).resolves.toEqual({
      sessions: [],
      blockedTasks: [
        {
          taskId: "TASK-002",
          kind: "manual_gate",
          reason: "manual_gate requires human approval before dispatch"
        }
      ]
    });
  });

  it("dispatches released manual_gate tasks after dependencies complete", async () => {
    const spawned: string[] = [];
    const ao = createAo((taskId) => spawned.push(taskId));
    const plan = createPlan([
      createTask({
        taskId: "TASK-001",
        title: "Completed dependency",
        description: "Completed dependency.",
        status: "completed"
      }),
      createTask({
        taskId: "TASK-002",
        title: "Released manual gate task",
        description: "Released manual gate task.",
        type: "verification",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        aoRole: "qa",
        acceptanceCriteria: ["Verified"],
        aoPrompt: "[WF-001 / TASK-002] Verify."
      })
    ]);

    const result = await executePlan({
      plan,
      ao: ao as AoCliAdapter,
      releasedManualGateTaskIds: ["TASK-002"]
    });

    expect(spawned).toEqual(["TASK-002"]);
    expect(result).toEqual({
      sessions: [
        {
          taskId: "TASK-002",
          aoRole: "qa",
          sessionId: "session-TASK-002"
        }
      ],
      blockedTasks: []
    });
  });
});

function createAo(onSpawn: (taskId: string) => void): Pick<AoCliAdapter, "spawnTask"> {
  return {
    async spawnTask(task) {
      onSpawn(task.taskId);
      return {
        sessionId: `session-${task.taskId}`,
        stdout: "",
        stderr: ""
      };
    }
  };
}

function createPlan(tasks: Array<Record<string, unknown>>): TaskPlan {
  return taskPlanSchema.parse({
    workflowId: "WF-001",
    title: "Plan",
    tasks
  });
}

function createTask(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: "TASK-001",
    workflowId: "WF-001",
    title: "Task",
    description: "Task.",
    type: "implementation",
    dependencies: [],
    dependencyCondition: "all_completed",
    aoRole: "backend-senior",
    acceptanceCriteria: ["Done"],
    aoPrompt: "[WF-001 / TASK-001] Task.",
    status: "pending",
    ...overrides
  };
}
