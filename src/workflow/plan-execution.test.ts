import { describe, expect, it } from "vitest";
import type { AoCliAdapter } from "../adapters/ao.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { executePlan } from "./plan-execution.js";

describe("executePlan", () => {
  it("dispatches only pending tasks whose dependencies are satisfied", async () => {
    const spawned: string[] = [];
    const ao = {
      async spawnTask(task) {
        spawned.push(task.taskId);
        return {
          sessionId: `session-${task.taskId}`,
          stdout: "",
          stderr: ""
        };
      }
    } satisfies Pick<AoCliAdapter, "spawnTask">;
    const plan: TaskPlan = {
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Completed prerequisite",
          description: "Completed prerequisite.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Done"],
          aoPrompt: "[WF-001 / TASK-001] Completed.",
          status: "completed"
        },
        {
          taskId: "TASK-002",
          workflowId: "WF-001",
          title: "Ready task",
          description: "Ready task.",
          type: "test",
          dependencies: ["TASK-001"],
          dependencyCondition: "all_completed",
          aoRole: "qa",
          acceptanceCriteria: ["Tests pass"],
          aoPrompt: "[WF-001 / TASK-002] Test.",
          status: "pending"
        },
        {
          taskId: "TASK-003",
          workflowId: "WF-001",
          title: "Blocked task",
          description: "Blocked task.",
          type: "review",
          dependencies: ["TASK-002"],
          dependencyCondition: "all_completed",
          aoRole: "reviewer",
          acceptanceCriteria: ["Reviewed"],
          aoPrompt: "[WF-001 / TASK-003] Review.",
          status: "pending"
        }
      ]
    };

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
          reason: "waiting for dependencies: TASK-002"
        }
      ]
    });
  });

  it("dispatches any_completed tasks when at least one dependency is complete", async () => {
    const spawned: string[] = [];
    const ao = {
      async spawnTask(task) {
        spawned.push(task.taskId);
        return {
          sessionId: `session-${task.taskId}`,
          stdout: "",
          stderr: ""
        };
      }
    } satisfies Pick<AoCliAdapter, "spawnTask">;
    const plan: TaskPlan = {
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Completed dependency",
          description: "Completed dependency.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Done"],
          aoPrompt: "[WF-001 / TASK-001] Completed.",
          status: "completed"
        },
        {
          taskId: "TASK-002",
          workflowId: "WF-001",
          title: "Alternative dependency",
          description: "Alternative dependency.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Done"],
          aoPrompt: "[WF-001 / TASK-002] Alternative.",
          status: "pending"
        },
        {
          taskId: "TASK-003",
          workflowId: "WF-001",
          title: "Any dependency task",
          description: "Any dependency task.",
          type: "verification",
          dependencies: ["TASK-001", "TASK-002"],
          dependencyCondition: "any_completed",
          aoRole: "qa",
          acceptanceCriteria: ["Verified"],
          aoPrompt: "[WF-001 / TASK-003] Verify.",
          status: "pending"
        }
      ]
    };

    const result = await executePlan({ plan, ao: ao as AoCliAdapter });

    expect(spawned).toEqual(["TASK-002", "TASK-003"]);
    expect(result.blockedTasks).toEqual([]);
  });

  it("keeps manual_gate tasks blocked after dependencies complete", async () => {
    const ao = {
      async spawnTask() {
        throw new Error("manual gate tasks should not dispatch automatically");
      }
    } satisfies Pick<AoCliAdapter, "spawnTask">;
    const plan: TaskPlan = {
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Completed dependency",
          description: "Completed dependency.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Done"],
          aoPrompt: "[WF-001 / TASK-001] Completed.",
          status: "completed"
        },
        {
          taskId: "TASK-002",
          workflowId: "WF-001",
          title: "Manual gate task",
          description: "Manual gate task.",
          type: "verification",
          dependencies: ["TASK-001"],
          dependencyCondition: "manual_gate",
          aoRole: "qa",
          acceptanceCriteria: ["Verified"],
          aoPrompt: "[WF-001 / TASK-002] Verify.",
          status: "pending"
        }
      ]
    };

    await expect(executePlan({ plan, ao: ao as unknown as AoCliAdapter })).resolves.toEqual({
      sessions: [],
      blockedTasks: [
        {
          taskId: "TASK-002",
          reason: "manual_gate requires human approval before dispatch"
        }
      ]
    });
  });
});
