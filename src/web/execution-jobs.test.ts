import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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

  it("attaches existing running execution when start is clicked again", async () => {
    const workflowId = "WF-ATTACH-RUNNING";
    const { manager } = await seedManager(workflowId, "running", true);

    const snapshot = await manager.createOrResume({ workflowId });

    expect(snapshot.mode).toBe("attached");
    expect(snapshot.status).toBe("running");
    expect(snapshot.readonly).toBe(true);
    expect(snapshot.activeTask?.taskId).toBe("TASK-001");
    expect(snapshot.activeTask?.aoSessionId).toBe("session-TASK-001");
    expect(snapshot.tasks?.[0]?.status).toBe("working");
  });

  it("fails before acquiring a lock when AO is unavailable", async () => {
    const workflowId = "WF-AO-UNAVAILABLE";
    const { manager, store } = await seedManager(workflowId, "stopped", false, true);

    await expect(manager.createOrResume({ workflowId })).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("AO 未启动或不可用")
    });
    const state = await store.readState(workflowId);
    expect(state.status).toBe("stopped");
  });

  it("retries a readonly failed execution job and starts the runner", async () => {
    const workflowId = "WF-RETRY-READONLY";
    const { manager } = await seedManager(workflowId, "failed", true);
    await manager.restoreFromDisk();

    const snapshot = await manager.retry(`EXEC-${workflowId}`, "TASK-001");

    expect(["running", "completed"]).toContain(snapshot.status);
    expect(snapshot.readonly).toBe(false);
    expect(snapshot.failure).toBeNull();
    await manager.stop(snapshot.jobId);
  });

  it("does not clear a failed task when retry cannot reach AO", async () => {
    const workflowId = "WF-RETRY-AO-UNAVAILABLE";
    const { manager, store } = await seedManager(workflowId, "failed", true, true);
    await manager.restoreFromDisk();

    await expect(manager.retry(`EXEC-${workflowId}`, "TASK-001")).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining(`workflowId=${workflowId}, jobId=EXEC-${workflowId}`)
    });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.taskStates["TASK-001"]?.status).toBe("blocked_for_human");
    expect(state.failure?.kind).toBe("ao_spawn_failed");
  });

  it("releases the prepared lock when retry validation fails", async () => {
    const workflowId = "WF-RETRY-MAX-ATTEMPTS";
    const { manager } = await seedManager(workflowId, "failed", true, false, 3, 3);
    await manager.restoreFromDisk();

    await expect(manager.retry(`EXEC-${workflowId}`, "TASK-001"))
      .rejects.toThrow("exceeded maxAttempts 3");

    await expect(access(join(tempDir ?? "", workflowId, "execution.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the prepared lock when mark completed validation fails", async () => {
    const workflowId = "WF-MARK-COMPLETED-EMPTY";
    const { manager } = await seedManager(workflowId, "failed", true);
    await manager.restoreFromDisk();

    await expect(manager.markCompleted(`EXEC-${workflowId}`, "TASK-001", ""))
      .rejects.toThrow("rationale is required");

    await expect(access(join(tempDir ?? "", workflowId, "execution.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function seedManager(
  workflowId: string,
  status: "running" | "stopped" | "failed",
  withActiveTask = false,
  aoUnavailable = false,
  attempt = 1,
  maxAttempts = 3
) {
  tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-execution-jobs-"));
  const store = new ExecutionStateStore(tempDir);
  await mkdir(store.getWorkflowDir(workflowId), { recursive: true });
  await atomicWriteJson(join(store.getWorkflowDir(workflowId), "task-plan.json"), createPlan(workflowId));
  await atomicWriteJson(join(store.getWorkflowDir(workflowId), "execution-state.json"), {
    workflowId,
    planVersion: "task-plan-current",
    planPath: "task-plan.json",
    status,
    currentTaskId: withActiveTask ? "TASK-001" : null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    stoppedAt: status === "stopped" ? new Date().toISOString() : null,
    failure: status === "failed" ? {
      taskId: "TASK-001",
      kind: "ao_spawn_failed",
      message: "AO session missing",
      occurredAt: new Date().toISOString()
    } : null,
    taskStates: withActiveTask ? {
      "TASK-001": {
        taskId: "TASK-001",
        status: status === "failed" ? "blocked_for_human" : "working",
        aoRole: "backend-senior",
        aoSessionId: status === "failed" ? undefined : "session-TASK-001",
        attempt,
        maxAttempts,
        startedAt: new Date().toISOString(),
        completedAt: null,
        failureReason: status === "failed" ? "AO session missing" : null,
        statusObservations: []
      }
    } : {},
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
        if (aoUnavailable) {
          throw new Error("ao daemon is offline");
        }
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
