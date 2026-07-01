import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask } from "../schemas/task-plan.js";
import { buildSpawnArgs, parseSessionId } from "./ao.js";

describe("buildSpawnArgs", () => {
  it("uses AO role and prompt without generating --agent", () => {
    const task: ExecutionTask = {
      taskId: "TASK-001",
      workflowId: "WF-001",
      title: "Implement API",
      description: "Implement API.",
      type: "implementation",
      dependencies: [],
      dependencyCondition: "all_completed",
      aoRole: "backend-senior",
      acceptanceCriteria: ["API works"],
      aoPrompt: "[WF-001 / TASK-001] Implement API.",
      executionPolicy: defaultExecutionPolicy,
      status: "pending"
    };

    expect(buildSpawnArgs(task)).toEqual([
      "spawn",
      "--role",
      "backend-senior",
      "--prompt",
      "[WF-001 / TASK-001] Implement API."
    ]);
    expect(buildSpawnArgs(task)).not.toContain("--agent");
  });

  it("rejects concrete agent fields even if a caller bypasses schema parsing", () => {
    const task: ExecutionTask = {
      taskId: "TASK-001",
      workflowId: "WF-001",
      title: "Implement API",
      description: "Implement API.",
      type: "implementation",
      dependencies: [],
      dependencyCondition: "all_completed",
      aoRole: "backend-senior",
      acceptanceCriteria: ["API works"],
      aoPrompt: "[WF-001 / TASK-001] Implement API.",
      executionPolicy: defaultExecutionPolicy,
      status: "pending",
      agent: "codex"
    } as ExecutionTask;

    expect(() => buildSpawnArgs(task)).toThrow("forbidden execution field: agent");
  });
});

describe("parseSessionId", () => {
  it("extracts SESSION from single-line and multi-line AO output", () => {
    expect(parseSessionId("SESSION=app-3")).toBe("app-3");
    expect(parseSessionId("created\nSESSION=app-4\nready")).toBe("app-4");
  });

  it("returns undefined when AO output has no SESSION marker", () => {
    expect(parseSessionId("session created without marker")).toBeUndefined();
  });
});
