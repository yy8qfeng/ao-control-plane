import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { atomicWriteJson, ExecutionStateStore } from "../workflow/execution-state-store.js";
import { ExecutionJobManager } from "./execution-jobs.js";

let tempDir: string | undefined;

describe("ExecutionJobManager", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("attaches existing running state as readonly when no runner and lock are held", async () => {
    const workflowId = "WF-ATTACH-READONLY";
    const { manager } = await seedManager(workflowId, "running");

    const snapshot = await manager.getSnapshot(`EXEC-${workflowId}`);

    expect(snapshot.status).toBe("running");
    expect(snapshot.readonly).toBe(true);
  });

  it("returns resumed mode when starting a stopped execution job", async () => {
    const workflowId = "WF-RESUME-MODE";
    const { manager } = await seedManager(workflowId, "stopped");

    const snapshot = await manager.createOrResume({
      workflowId,
      pollIntervalMs: 1,
      staleLockMs: 1
    });

    expect(snapshot.mode).toBe("resumed");
    expect(snapshot.status).toBe("running");
    await manager.stop(snapshot.jobId);
  });
});

async function seedManager(workflowId: string, status: "running" | "stopped") {
  tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-execution-jobs-"));
  const store = new ExecutionStateStore(tempDir);
  await mkdir(store.getWorkflowDir(workflowId), { recursive: true });
  await atomicWriteJson(join(store.getWorkflowDir(workflowId), "task-plan.json"), createPlan(workflowId));
  await atomicWriteJson(join(store.getWorkflowDir(workflowId), "execution-state.json"), {
    workflowId,
    planVersion: "task-plan-current",
    planPath: "task-plan.json",
    status,
    currentTaskId: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    stoppedAt: status === "stopped" ? new Date().toISOString() : null,
    failure: null,
    taskStates: {},
    manualGateReleases: [],
    pendingDispatch: null
  });
  const manager = new ExecutionJobManager({
    store,
    artifactRoot: tempDir,
    createAo: () => ({
      async spawnTask(task) {
        return { sessionId: `session-${task.taskId}`, stdout: "", stderr: "" };
      },
      async listSessions() {
        return { sessions: [] };
      }
    })
  });
  return { manager, store };
}

function createPlan(workflowId: string): TaskPlan {
  return {
    workflowId,
    title: "Plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Task",
        description: "Task.",
        type: "implementation",
        dependencies: [],
        dependencyCondition: "all_completed",
        aoRole: "backend-senior",
        acceptanceCriteria: ["Done"],
        aoPrompt: `[${workflowId} / TASK-001] Task.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending"
      }
    ]
  };
}
