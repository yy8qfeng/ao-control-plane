import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AoCliAdapter } from "../adapters/ao.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { ContinuousExecutionRunner, retryExecutionTask, stopExecution } from "./continuous-plan-execution.js";
import { atomicWriteJson, ExecutionStateStore } from "./execution-state-store.js";

let tempDir: string | undefined;

describe("ContinuousExecutionRunner", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("serially dispatches the next ready task after the previous task completes", async () => {
    const { store, workflowId } = await seedPlan(createPlan("WF-CONTINUOUS", [
      createTask("WF-CONTINUOUS", "TASK-001"),
      createTask("WF-CONTINUOUS", "TASK-002", { dependencies: ["TASK-001"] })
    ]));
    const ao = createFakeAo(["completed", "completed"]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 5
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(ao.spawned).toEqual(["TASK-001", "TASK-002"]);
    expect(state.status).toBe("completed");
    expect(state.taskStates["TASK-001"]?.status).toBe("completed");
    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
  });

  it("pauses at manual_gate without dispatching it", async () => {
    const workflowId = "WF-MANUAL";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate"
      })
    ]));
    const ao = createFakeAo([]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 2
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(ao.spawned).toEqual([]);
    expect(state.status).toBe("waiting_manual_gate");
    expect(state.currentTaskId).toBe("TASK-002");
  });

  it("requires repeated same-attempt AO failure observations before failing", async () => {
    const workflowId = "WF-FAILED";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001")
    ]));
    const ao = createFakeAo(["failed"]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      failureConfirmationCount: 2,
      maxTicks: 4
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("ao_task_failed");
    expect(state.taskStates["TASK-001"]?.status).toBe("blocked_for_human");
    expect(state.taskStates["TASK-001"]?.statusObservations).toHaveLength(2);
  });

  it("records stopped state without polluting failure", async () => {
    const workflowId = "WF-STOP";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));

    const state = await stopExecution({ store, workflowId, actor: "user" });

    expect(state.status).toBe("stopped");
    expect(state.failure).toBeNull();
    await expect(store.readLogs(workflowId)).resolves.toEqual([
      expect.objectContaining({ type: "dispatcher_stopped", actor: "user" })
    ]);
  });

  it("logs orphaned dispatch when pendingDispatch is invalidated before spawn returns", async () => {
    const workflowId = "WF-ORPHAN";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    const ao = {
      async spawnTask() {
        await store.update(workflowId, (state) => ({ ...state, status: "stopped", pendingDispatch: null }));
        return { sessionId: "session-orphaned", stdout: "", stderr: "" };
      },
      async listSessions() {
        return { sessions: [] };
      }
    };
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_dispatch_orphaned",
          taskId: "TASK-001",
          aoSessionId: "session-orphaned"
        })
      ])
    );
  });

  it("recovers pendingDispatch by matching an orphan AO session", async () => {
    const workflowId = "WF-PENDING-RECOVER";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      pendingDispatch: {
        dispatchId: "DISPATCH-test",
        taskId: "TASK-001",
        attempt: 1,
        createdAt: new Date().toISOString()
      }
    }));
    const ao = {
      async spawnTask() {
        throw new Error("should not respawn recovered pendingDispatch");
      },
      async listSessions() {
        return {
          sessions: [
            {
              id: "session-recovered",
              status: "completed",
              prompt: `[${workflowId} / TASK-001] TASK-001.`
            }
          ]
        };
      }
    };
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 2
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.pendingDispatch).toBeNull();
    expect(state.taskStates["TASK-001"]?.aoSessionId).toBe("session-recovered");
    expect(state.status).toBe("completed");
  });

  it("fails pendingDispatch recovery when multiple candidate sessions match", async () => {
    const workflowId = "WF-PENDING-MULTI";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await seedPendingDispatch(store, workflowId, "TASK-001");
    const ao = createListOnlyAo([
      { id: "session-a", status: "running", prompt: `[${workflowId} / TASK-001] A` },
      { id: "session-b", status: "running", prompt: `[${workflowId} / TASK-001] B` }
    ]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("state_corrupted");
    expect(state.pendingDispatch).toBeNull();
    expect(state.failure?.spawnCandidateSessionIds).toEqual(["session-a", "session-b"]);
  });

  it("fails pendingDispatch recovery when task id is unknown", async () => {
    const workflowId = "WF-PENDING-UNKNOWN";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await seedPendingDispatch(store, workflowId, "TASK-404");
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      kind: "state_corrupted",
      message: "pendingDispatch references unknown task TASK-404"
    });
  });

  it("fails after AO status query exceeds maxAoStatusFailures", async () => {
    const workflowId = "WF-AO-STATUS-FAILED";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: {
        async spawnTask(task) {
          return { sessionId: `session-${task.taskId}`, stdout: "", stderr: "" };
        },
        async listSessions() {
          throw new Error("ao session ls failed");
        }
      },
      pollIntervalMs: 1,
      maxAoStatusFailures: 2,
      maxTicks: 4
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      kind: "ao_status_failed",
      message: "ao session ls failed"
    });
  });

  it("rejects retry when attempt already reached maxAttempts", async () => {
    const workflowId = "WF-RETRY-MAX";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "failed",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "blocked_for_human",
          aoRole: "backend-senior",
          attempt: 3,
          maxAttempts: 3
        }
      }
    }));

    await expect(retryExecutionTask({ store, workflowId, taskId: "TASK-001" }))
      .rejects.toThrow("exceeded maxAttempts 3");
  });
});

async function seedPlan(plan: TaskPlan): Promise<{ store: ExecutionStateStore; workflowId: string }> {
  tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-continuous-"));
  const store = new ExecutionStateStore(tempDir);
  await mkdir(store.getWorkflowDir(plan.workflowId), { recursive: true });
  await atomicWriteJson(join(store.getWorkflowDir(plan.workflowId), "task-plan.json"), plan);
  return { store, workflowId: plan.workflowId };
}

function createFakeAo(statuses: string[]) {
  const sessions: Array<{ id: string; status: string; prompt: string }> = [];
  return {
    spawned: [] as string[],
    async spawnTask(task: { taskId: string; aoPrompt: string }) {
      this.spawned.push(task.taskId);
      const status = statuses.shift() ?? "completed";
      const session = {
        id: `session-${task.taskId}`,
        status,
        prompt: task.aoPrompt
      };
      sessions.push(session);
      return { sessionId: session.id, stdout: "", stderr: "" };
    },
    async listSessions() {
      return { sessions };
    }
  };
}

function createListOnlyAo(sessions: Array<{ id: string; status: string; prompt: string }>) {
  return {
    async spawnTask() {
      throw new Error("spawnTask should not be called");
    },
    async listSessions() {
      return { sessions };
    }
  };
}

async function seedPendingDispatch(
  store: ExecutionStateStore,
  workflowId: string,
  taskId: string
): Promise<void> {
  await store.update(workflowId, (state) => ({
    ...state,
    status: "running",
    pendingDispatch: {
      dispatchId: "DISPATCH-test",
      taskId,
      attempt: 1,
      createdAt: new Date().toISOString()
    }
  }));
}

function createPlan(workflowId: string, tasks: TaskPlan["tasks"]): TaskPlan {
  return {
    workflowId,
    title: "Continuous plan",
    tasks
  };
}

function createTask(
  workflowId: string,
  taskId: string,
  overrides: Partial<TaskPlan["tasks"][number]> = {}
): TaskPlan["tasks"][number] {
  return {
    taskId,
    workflowId,
    title: taskId,
    description: `${taskId}.`,
    type: "implementation",
    dependencies: [],
    dependencyCondition: "all_completed",
    aoRole: "backend-senior",
    acceptanceCriteria: ["Done"],
    aoPrompt: `[${workflowId} / ${taskId}] ${taskId}.`,
    executionPolicy: defaultExecutionPolicy,
    status: "pending",
    ...overrides
  };
}
