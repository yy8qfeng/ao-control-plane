import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask } from "../schemas/task-plan.js";
import { AoCliAdapter, buildSpawnArgs, parseSessionId } from "./ao.js";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn()
}));

vi.mock("execa", () => ({
  execa: execaMock
}));

beforeEach(() => {
  execaMock.mockReset();
});

const baseTask: ExecutionTask = {
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

describe("buildSpawnArgs", () => {
  it("uses AO role and prompt without generating --agent", () => {
    expect(buildSpawnArgs(baseTask)).toEqual([
      "spawn",
      "--role",
      "backend-senior",
      "--prompt",
      "[WF-001 / TASK-001] Implement API."
    ]);
    expect(buildSpawnArgs(baseTask)).not.toContain("--agent");
  });

  it("rejects concrete agent fields even if a caller bypasses schema parsing", () => {
    const task: ExecutionTask = {
      ...baseTask,
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

describe("AoCliAdapter", () => {
  it("returns SESSION from successful AO spawn output", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "Logged in to github.com"
    });
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Session ft-1 spawned\nSESSION=ft-1",
      stderr: ""
    });

    const adapter = new AoCliAdapter({ projectRoot: "C:\\workspace\\fast-transport" });

    await expect(adapter.spawnTask(baseTask)).resolves.toMatchObject({
      sessionId: "ft-1"
    });
    expect(execaMock).toHaveBeenNthCalledWith(1, "gh", ["auth", "status"], {
      cwd: "C:\\workspace\\fast-transport",
      reject: false
    });
    expect(execaMock).toHaveBeenNthCalledWith(2, "ao", buildSpawnArgs(baseTask), {
      cwd: "C:\\workspace\\fast-transport",
      reject: false
    });
  });

  it("throws AO stderr when spawn exits without creating a session", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "Logged in to github.com"
    });
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "AO is not running"
    });

    const adapter = new AoCliAdapter({ projectRoot: "C:\\workspace\\fast-transport" });

    await expect(adapter.spawnTask(baseTask))
      .rejects.toThrow("AO spawn failed with exit code 1: AO is not running");
  });

  it("fails before AO spawn when GitHub CLI is not authenticated", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts."
    });

    const adapter = new AoCliAdapter({ projectRoot: "C:\\workspace\\fast-transport" });

    await expect(adapter.validateDispatchPrerequisites())
      .rejects.toThrow("GitHub CLI is not authenticated");
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("lists AO status with full report history for completion detection", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ data: [{ name: "ft-1", status: "idle", reports: [] }] }),
      stderr: ""
    });

    const adapter = new AoCliAdapter({
      projectRoot: "C:\\workspace\\fast-transport",
      projectId: "fast-transport_53d581ab27"
    });

    await expect(adapter.listSessions()).resolves.toEqual({
      data: [{ name: "ft-1", status: "idle", reports: [] }]
    });
    expect(execaMock).toHaveBeenCalledWith("ao", [
      "status",
      "--json",
      "--reports",
      "full",
      "--project",
      "fast-transport_53d581ab27"
    ], {
      cwd: "C:\\workspace\\fast-transport",
      reject: false
    });
  });
});
