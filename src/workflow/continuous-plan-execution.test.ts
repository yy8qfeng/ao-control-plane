import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AoCliAdapter } from "../adapters/ao.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import {
  approveManualGate,
  ContinuousExecutionRunner,
  decideManualGate,
  dispatchReworkTask,
  dispatchManualGateReview,
  reconcileExecutionTaskArtifacts,
  pauseForManualGateRework,
  retryExecutionTask,
  stopExecution
} from "./continuous-plan-execution.js";
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

  it("auto-dispatches manual_gate review tasks instead of waiting for routine human release", async () => {
    const workflowId = "WF-MANUAL";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate"
      })
    ]));
    const ao = createFakeAo(["completed"]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 3
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(ao.spawned).toEqual(["TASK-002"]);
    expect(state.status).toBe("completed");
    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
    expect(state.manualGateReleases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "TASK-002",
          decision: "review_dispatched",
          mode: "ao_review",
          aoSessionId: "session-TASK-002"
        })
      ])
    );
  });

  it("turns manual gate needs_input into a structured decision failure without confirmation delay", async () => {
    const workflowId = "WF-NEEDS-STRUCTURED";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer",
        outputArtifacts: [
          {
            contractId: "g0_review_gate_decision",
            kind: "g0_review_gate_decision",
            path: "g0_review_gate_decision.json",
            required: true
          }
        ]
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-002",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "completed",
          aoRole: "backend-senior",
          attempt: 1,
          maxAttempts: 3
        },
        "TASK-002": {
          taskId: "TASK-002",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-structured",
          attempt: 1,
          maxAttempts: 3
        }
      },
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "review_dispatched",
        mode: "ao_review",
        aoSessionId: "ft-structured"
      }]
    }));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([{ id: "ft-structured", status: "needs_input", prompt: `[${workflowId} / TASK-002] gate` }]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      failureConfirmationCount: 3,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      taskId: "TASK-002",
      kind: "ao_task_needs_structured_decision"
    });
    expect(state.taskStates["TASK-002"]?.failureReason).toBe("ao_task_needs_structured_decision");
  });

  it("dispatches upstream rework by resetting the target and gate tasks", async () => {
    const workflowId = "WF-REWORK-DISPATCH";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer"
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "paused_for_replan",
      currentTaskId: "TASK-002",
      failure: {
        taskId: "TASK-002",
        kind: "manual_gate_rework_required",
        message: "返工",
        occurredAt: new Date().toISOString()
      },
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "completed",
          aoRole: "backend-senior",
          aoSessionId: "ft-producer",
          attempt: 1,
          maxAttempts: 3
        },
        "TASK-002": {
          taskId: "TASK-002",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-reviewer",
          attempt: 1,
          maxAttempts: 3,
          failureReason: "manual_gate_rework_required"
        }
      },
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "review_dispatched",
        mode: "ao_review",
        aoSessionId: "ft-reviewer"
      }]
    }));

    await dispatchReworkTask({
      store,
      workflowId,
      gateTaskId: "TASK-002",
      targetTaskId: "TASK-001",
      rationale: "修复 B1",
      actor: "user"
    });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("running");
    expect(state.failure).toBeNull();
    expect(state.taskStates["TASK-001"]?.status).toBe("pending");
    expect(state.taskStates["TASK-002"]?.status).toBe("pending");
    expect(state.supersededSessions).toEqual(expect.arrayContaining(["ft-producer", "ft-reviewer"]));
    expect(state.manualGateReleases).toEqual([]);
  });

  it("decideManualGate requires_replan writes paused state through the shared helper", async () => {
    const workflowId = "WF-GATE-REPLAN-HELPER";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer"
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002",
      taskStates: {
        "TASK-002": {
          taskId: "TASK-002",
          status: "blocked_for_human",
          aoRole: "reviewer",
          attempt: 1,
          maxAttempts: 3
        }
      }
    }));

    await decideManualGate({
      store,
      workflowId,
      taskId: "TASK-002",
      decision: "requires_replan",
      rationale: "需要重规划",
      actor: "user"
    });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("paused_for_replan");
    expect(state.currentTaskId).toBe("TASK-002");
    expect(state.failure).toMatchObject({
      taskId: "TASK-002",
      kind: "manual_gate_requires_replan",
      message: "需要重规划"
    });
    expect(state.taskStates["TASK-002"]?.failureReason).toBe("manual_gate_requires_replan");
    expect(state.manualGateReleases).toEqual([
      expect.objectContaining({ taskId: "TASK-002", decision: "requires_replan" })
    ]);
  });

  it("pauseForManualGateRework writes rework paused state without manual gate release", async () => {
    const workflowId = "WF-GATE-REWORK-HELPER";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer"
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-002",
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "review_dispatched",
        mode: "ao_review",
        aoSessionId: "ft-reviewer"
      }],
      taskStates: {
        "TASK-002": {
          taskId: "TASK-002",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-reviewer",
          attempt: 1,
          maxAttempts: 3
        }
      }
    }));

    await pauseForManualGateRework({
      store,
      workflowId,
      taskId: "TASK-002",
      targetTaskIds: ["TASK-001"],
      findings: [{ id: "B1", severity: "blocking", summary: "返工", targetTaskId: "TASK-001" }],
      rationale: "需要上游返工",
      actor: "runner"
    });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("paused_for_replan");
    expect(state.failure).toMatchObject({
      taskId: "TASK-002",
      kind: "manual_gate_rework_required",
      message: "需要上游返工"
    });
    expect(state.taskStates["TASK-002"]?.failureReason).toBe("manual_gate_rework_required");
    expect(state.manualGateReleases).toEqual([
      expect.objectContaining({ taskId: "TASK-002", decision: "review_dispatched" })
    ]);
  });

  it("rejects retry while a task needs a structured decision", async () => {
    const workflowId = "WF-STRUCTURED-RETRY";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer"
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "failed",
      currentTaskId: "TASK-001",
      failure: {
        taskId: "TASK-001",
        kind: "ao_task_needs_structured_decision",
        message: "缺结构化决策",
        occurredAt: new Date().toISOString()
      },
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "blocked_for_human",
          aoRole: "reviewer",
          attempt: 1,
          maxAttempts: 3,
          failureReason: "ao_task_needs_structured_decision"
        }
      }
    }));

    await expect(retryExecutionTask({
      store,
      workflowId,
      taskId: "TASK-001",
      actor: "user"
    })).rejects.toThrow("needs structured decision");
  });

  it("skips replan-only manual gate branches after an approved upstream gate", async () => {
    const workflowId = "WF-SKIP-APPROVED-REPLAN";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { title: "G0 仓库现实校准", status: "completed" }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "review",
        aoRole: "reviewer"
      }),
      createTask(workflowId, "TASK-003", {
        title: "G0 复核失败回流重规划",
        description: "仅在 TASK-002 非 approved 时触发，approved 路径不派发。",
        dependencies: ["TASK-002"],
        dependencyCondition: "manual_gate",
        type: "design",
        aoRole: "architect"
      }),
      createTask(workflowId, "TASK-004", {
        title: "后续设计任务",
        dependencies: ["TASK-002"]
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_review_gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-002",
      decision: "approved",
      source: "control_plane_manual_gate"
    }), "utf8");
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_approved.flag"), "approved\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "completed",
          aoRole: "architect",
          attempt: 1,
          maxAttempts: 3
        },
        "TASK-002": {
          taskId: "TASK-002",
          status: "completed",
          aoRole: "reviewer",
          attempt: 1,
          maxAttempts: 3
        }
      },
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "approved",
        mode: "manual_approve",
        rationale: "approved",
        releasedAt: new Date().toISOString()
      }]
    }));
    const ao = createFakeAo(["completed"]);
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: ao as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 3
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.taskStates["TASK-003"]?.status).toBe("superseded");
    expect(ao.spawned).toEqual(["TASK-004"]);
    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_skipped",
          taskId: "TASK-003",
          outcome: "approved"
        })
      ])
    );
  });

  it("skips fail-only QA replan branches after a pass verdict", async () => {
    const workflowId = "WF-SKIP-PASS-REPLAN";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-094", {
        title: "统一发布前 QA verdict 汇总裁决",
        type: "verification",
        aoRole: "qa",
        status: "completed"
      }),
      createTask(workflowId, "TASK-095", {
        title: "统一 QA verdict 失败回流重规划",
        description: "仅在 TASK-094 verdict=fail 时由 manual_gate 触发；pass 路径不派发。",
        dependencies: ["TASK-094"],
        dependencyCondition: "manual_gate",
        type: "design",
        aoRole: "architect"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "unified_qa_verdict.json"), JSON.stringify({ verdict: "pass" }), "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      taskStates: {
        "TASK-094": {
          taskId: "TASK-094",
          status: "completed",
          aoRole: "qa",
          attempt: 1,
          maxAttempts: 3
        }
      }
    }));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 2
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("completed");
    expect(state.taskStates["TASK-095"]?.status).toBe("superseded");
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

  it("completes a working task when AO reports completed while the session is idle", async () => {
    const workflowId = "WF-IDLE-REPORT-COMPLETED";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-001",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "working",
          aoRole: "architect",
          aoSessionId: "ft-1",
          attempt: 1,
          maxAttempts: 3,
          startedAt: new Date().toISOString(),
          completedAt: null,
          failureReason: null,
          statusObservations: []
        }
      }
    }));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: {
        async spawnTask() {
          throw new Error("spawnTask should not be called");
        },
        async listSessions() {
          return {
            data: [
              {
                name: "ft-1",
                status: "idle",
                reports: [
                  {
                    reportState: "completed",
                    accepted: true
                  }
                ]
              }
            ]
          };
        }
      },
      pollIntervalMs: 1,
      maxTicks: 2
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("completed");
    expect(state.taskStates["TASK-001"]?.status).toBe("completed");
    expect(state.taskStates["TASK-001"]?.statusObservations?.at(-1)?.status).toBe("completed");
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

  it("fails dispatch when AO spawn returns no session id", async () => {
    const workflowId = "WF-MISSING-SPAWN-SESSION";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: {
        async spawnTask() {
          return { stdout: "spawned without session marker", stderr: "" };
        },
        async listSessions() {
          return { sessions: [] };
        }
      },
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      kind: "ao_spawn_failed",
      taskId: "TASK-001"
    });
    expect(state.pendingDispatch).toBeNull();
    expect(state.taskStates["TASK-001"]?.status).toBe("blocked_for_human");
    expect(state.taskStates["TASK-001"]?.aoSessionId).toBeUndefined();
    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_dispatch_missing_session",
          taskId: "TASK-001"
        })
      ])
    );
  });

  it("marks task blocked when AO spawn throws before returning a session", async () => {
    const workflowId = "WF-SPAWN-THROWS";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: {
        async spawnTask() {
          throw new Error("GitHub CLI is not authenticated");
        },
        async listSessions() {
          return { sessions: [] };
        }
      },
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      kind: "ao_spawn_failed",
      taskId: "TASK-001",
      message: "GitHub CLI is not authenticated"
    });
    expect(state.pendingDispatch).toBeNull();
    expect(state.taskStates["TASK-001"]?.status).toBe("blocked_for_human");
    expect(state.taskStates["TASK-001"]?.failureReason).toBe("ao_spawn_failed");
  });

  it("fails restored working task when no session id or matching AO session exists", async () => {
    const workflowId = "WF-MISSING-RESTORED-SESSION";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-001",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "working",
          aoRole: "backend-senior",
          attempt: 1,
          maxAttempts: 3,
          startedAt: new Date().toISOString(),
          completedAt: null,
          failureReason: null,
          statusObservations: []
        }
      }
    }));
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
      kind: "ao_spawn_failed",
      taskId: "TASK-001"
    });
    expect(state.taskStates["TASK-001"]?.status).toBe("blocked_for_human");
    expect(state.taskStates["TASK-001"]?.failureReason).toBe("ao_session_missing");
    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_execution_missing_session",
          taskId: "TASK-001"
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

  it("allows retry even when attempt already reached the previous maxAttempts value", async () => {
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

    await retryExecutionTask({ store, workflowId, taskId: "TASK-001" });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("running");
    expect(state.taskStates["TASK-001"]?.status).toBe("pending");
    expect(state.failure).toBeNull();
  });

  it("allows retry for legacy failed spawn states whose task is still pending", async () => {
    const workflowId = "WF-RETRY-LEGACY-PENDING";
    const { store } = await seedPlan(createPlan(workflowId, [createTask(workflowId, "TASK-001")]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "failed",
      currentTaskId: "TASK-001",
      failure: {
        taskId: "TASK-001",
        kind: "ao_spawn_failed",
        message: "GitHub CLI is not authenticated",
        occurredAt: new Date().toISOString()
      },
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "pending",
          aoRole: "backend-senior",
          attempt: 3,
          maxAttempts: 3
        }
      }
    }));

    await retryExecutionTask({ store, workflowId, taskId: "TASK-001" });

    const state = await store.readState(workflowId);
    expect(state.status).toBe("running");
    expect(state.taskStates["TASK-001"]?.status).toBe("pending");
    expect(state.failure).toBeNull();
  });

  it("manual gate approval completes the task and writes gate artifacts without AO spawn", async () => {
    const workflowId = "WF-MANUAL-APPROVE";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "completed",
          aoRole: "architect",
          attempt: 1,
          maxAttempts: 3
        },
        "TASK-002": {
          taskId: "TASK-002",
          status: "pending",
          aoRole: "reviewer",
          attempt: 0,
          maxAttempts: 3
        }
      }
    }));

    const state = await approveManualGate({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "人工确认 G0 产物可作为后续输入",
      actor: "user"
    });

    expect(state.status).toBe("running");
    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
    expect(state.manualGateReleases[0]).toMatchObject({
      taskId: "TASK-002",
      decision: "approved",
      mode: "manual_approve",
      generatedArtifacts: ["g0_review_gate_decision.json", "g0_approved.flag"]
    });
    const decision = JSON.parse(await readFile(join(store.getWorkflowDir(workflowId), "g0_review_gate_decision.json"), "utf8")) as { source: string };
    expect(decision.source).toBe("control_plane_manual_gate");
    await expect(access(join(store.getWorkflowDir(workflowId), "g0_approved.flag"))).resolves.toBeUndefined();
  });

  it("reuses matching existing manual gate artifacts when release state is missing", async () => {
    const workflowId = "WF-MANUAL-APPROVE-EXISTING";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    const artifactDir = store.getWorkflowDir(workflowId);
    await writeFile(join(artifactDir, "g0_repo_reality_check.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "g0_review_gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-002",
      decision: "approved",
      source: "control_plane_manual_gate"
    }), "utf8");
    await writeFile(join(artifactDir, "g0_approved.flag"), "approved\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002"
    }));

    const state = await approveManualGate({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "补齐旧状态 release",
      actor: "user"
    });

    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
    expect(state.manualGateReleases[0]?.generatedArtifacts).toEqual([
      "g0_review_gate_decision.json",
      "g0_approved.flag"
    ]);
  });

  it("keeps manual gate approval idempotent under concurrent requests", async () => {
    const workflowId = "WF-MANUAL-APPROVE-CONCURRENT";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002"
    }));

    await Promise.all([
      approveManualGate({
        store,
        workflowId,
        taskId: "TASK-002",
        rationale: "并发放行请求 A",
        actor: "user"
      }),
      approveManualGate({
        store,
        workflowId,
        taskId: "TASK-002",
        rationale: "并发放行请求 B",
        actor: "user"
      })
    ]);

    const state = await store.readState(workflowId);
    const releases = state.manualGateReleases.filter((release) => release.taskId === "TASK-002");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      decision: "approved",
      mode: "manual_approve",
      generatedArtifacts: ["g0_review_gate_decision.json", "g0_approved.flag"]
    });
    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
  });

  it("dispatches manual gate review with a dispatch context manifest", async () => {
    const workflowId = "WF-MANUAL-REVIEW";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002"
    }));
    const spawnedPrompts: string[] = [];
    const state = await dispatchManualGateReview({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "需要 AO 独立复核",
      projectRoot: "C:\\workspace\\fast transport",
      actor: "user",
      ao: {
        async spawnTask(task) {
          spawnedPrompts.push(task.aoPrompt);
          return { sessionId: "ft-review", stdout: "", stderr: "" };
        },
        async listSessions() {
          return { sessions: [] };
        }
      }
    });

    expect(state.taskStates["TASK-002"]?.status).toBe("working");
    expect(state.taskStates["TASK-002"]?.aoSessionId).toBe("ft-review");
    expect(state.manualGateReleases[0]).toMatchObject({
      decision: "review_dispatched",
      mode: "ao_review",
      aoSessionId: "ft-review"
    });
    expect(spawnedPrompts[0]).toContain("projectRoot: C:\\workspace\\fast transport");
    expect(spawnedPrompts[0]).toContain("artifactDir:");
    expect(spawnedPrompts[0]).toContain("g0_repo_reality_check.json");
    expect(spawnedPrompts[0]).toContain("g0_review_gate_decision.json");
    const contextPath = state.taskStates["TASK-002"]?.dispatchContextPath ?? "";
    const manifest = JSON.parse(await readFile(contextPath, "utf8")) as { projectRoot: string; dependencyArtifacts: unknown[] };
    expect(manifest.projectRoot).toBe("C:\\workspace\\fast transport");
    expect(manifest.dependencyArtifacts).toHaveLength(1);
  });

  it("rejects direct approved decisions so gate artifacts cannot be skipped", async () => {
    const workflowId = "WF-DIRECT-APPROVED-REJECTED";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        dependencies: [],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));

    await expect(decideManualGate({
      store,
      workflowId,
      taskId: "TASK-001",
      decision: "approved",
      rationale: "旧路径直接批准",
      actor: "user"
    })).rejects.toThrow("approved manual gate decisions must use approveManualGate");
  });

  it("cleans up manual gate review context manifest when AO spawn fails", async () => {
    const workflowId = "WF-MANUAL-REVIEW-SPAWN-FAIL";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002"
    }));

    const state = await dispatchManualGateReview({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "需要 AO 独立复核",
      actor: "user",
      ao: {
        async spawnTask() {
          throw new Error("ao spawn failed");
        },
        async listSessions() {
          return { sessions: [] };
        }
      }
    });

    const contextPath = state.taskStates["TASK-002"]?.dispatchContextPath ?? "";
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("ao_spawn_failed");
    await expect(access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks dispatch when a required dependency artifact is missing", async () => {
    const workflowId = "WF-MISSING-CONTEXT";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002"
    }));

    const state = await dispatchManualGateReview({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "需要 AO 独立复核",
      actor: "user",
      ao: {
        async spawnTask() {
          throw new Error("spawnTask should not be called");
        },
        async listSessions() {
          return { sessions: [] };
        }
      }
    });

    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("artifact_context_missing");
    expect(state.failure?.message).toContain("g0_repo_reality_check.json");
  });

  it("blocks completed AO tasks when required output artifacts are missing", async () => {
    const workflowId = "WF-MISSING-OUTPUT";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准"
      })
    ]));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createFakeAo(["completed"]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 3
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("artifact_output_missing");
    expect(state.failure?.message).toContain("g0_repo_reality_check.json");
  });

  it("recovers completed AO review outputs from the AO session worktree before completing the task", async () => {
    const workflowId = "WF-RECONCILE-RUNNER";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-005", {
        title: "冻结跨语言 IPC 核心字节布局契约",
        status: "completed"
      }),
      createTask(workflowId, "TASK-006", {
        title: "跨语言 IPC 契约人工复核门禁",
        description: "reviewer 复核 IPC 契约是否冻结。",
        dependencies: ["TASK-005"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer",
        outputArtifacts: [
          { kind: "ipc_contract_review_gate_decision", path: "ipc_contract_review_gate_decision.json", required: true },
          { kind: "ipc_contract_approved_flag", path: "ipc_contract_approved.flag", requiredWhen: "decision=approved" }
        ]
      })
    ]));
    const artifactDir = store.getWorkflowDir(workflowId);
    await writeFile(join(artifactDir, "ipc_byte_layout_freeze.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "ipc_byte_layout_freeze.md"), "# IPC\n", "utf8");
    await writeFile(join(artifactDir, "ipc_byte_layout_qa_verdict.json"), "{}\n", "utf8");
    const worktreePath = join(tempDir ?? "", ".agent-orchestrator", "projects", "project", "worktrees", "ft-7");
    await mkdir(join(worktreePath, ".ao-control-plane", workflowId), { recursive: true });
    await writeFile(join(worktreePath, ".ao-control-plane", workflowId, "ipc_contract_review_gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-006",
      decision: "approved",
      source: "control_plane_manual_gate",
      reviewerIndependence: {
        reviewerSessionId: "ft-7"
      }
    }), "utf8");
    await writeFile(join(worktreePath, ".ao-control-plane", workflowId, "ipc_contract_approved.flag"), "approved\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-006",
      taskStates: {
        "TASK-005": {
          taskId: "TASK-005",
          status: "completed",
          aoRole: "architect",
          attempt: 1,
          maxAttempts: 3
        },
        "TASK-006": {
          taskId: "TASK-006",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-7",
          attempt: 1,
          maxAttempts: 3,
          statusObservations: []
        }
      },
      manualGateReleases: [{
        taskId: "TASK-006",
        decision: "review_dispatched",
        mode: "ao_review",
        rationale: "派发 AO 复核",
        releasedAt: new Date().toISOString(),
        attempt: 1,
        aoSessionId: "ft-7"
      }]
    }));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([{ id: "ft-7", status: "completed", prompt: `[${workflowId} / TASK-006] review`, worktreePath }]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 2
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("completed");
    const decision = JSON.parse(await readFile(join(artifactDir, "ipc_contract_review_gate_decision.json"), "utf8")) as { source: string; aoSessionId: string };
    expect(decision.source).toBe("ao_review");
    expect(decision.aoSessionId).toBe("ft-7");
    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "artifact_output_recovered_from_worktree", taskId: "TASK-006" }),
        expect.objectContaining({ type: "artifact_output_normalized", taskId: "TASK-006" })
      ])
    );
  });

  it("rolls back recovered artifacts when second validation still fails", async () => {
    const workflowId = "WF-RECONCILE-ROLLBACK";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        outputArtifacts: [
          { kind: "gate_decision", path: "gate_decision.json", required: true },
          { kind: "approved_flag", path: "approved.flag", requiredWhen: "decision=approved" }
        ]
      })
    ]));
    const artifactDir = store.getWorkflowDir(workflowId);
    const worktreePath = join(tempDir ?? "", ".agent-orchestrator", "projects", "project", "worktrees", "ft-rollback");
    await mkdir(join(worktreePath, ".ao-control-plane", workflowId), { recursive: true });
    await writeFile(join(worktreePath, ".ao-control-plane", workflowId, "gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-001",
      decision: "approved"
    }), "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "failed",
      currentTaskId: "TASK-001",
      failure: {
        taskId: "TASK-001",
        kind: "artifact_output_missing",
        message: "missing output",
        occurredAt: new Date().toISOString()
      },
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "blocked_for_human",
          aoRole: "backend-senior",
          aoSessionId: "ft-rollback",
          attempt: 1,
          maxAttempts: 3
        }
      }
    }));

    const result = await reconcileExecutionTaskArtifacts({
      store,
      workflowId,
      taskId: "TASK-001",
      sessions: [{ id: "ft-rollback", status: "completed", prompt: `[${workflowId} / TASK-001]`, worktreePath }]
    });

    expect(result.completed).toBe(false);
    expect(result.failureKind).toBe("artifact_output_missing");
    expect(result.reconcileResult?.failures).toEqual([
      expect.objectContaining({
        reason: "canonical_validation_failed",
        rolledBackPaths: [join(artifactDir, "gate_decision.json")]
      })
    ]);
    await expect(access(join(artifactDir, "gate_decision.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks completed AO review when gate decision source conflicts with release mode", async () => {
    const workflowId = "WF-CONFLICT-OUTPUT";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    const artifactDir = store.getWorkflowDir(workflowId);
    await writeFile(join(artifactDir, "g0_repo_reality_check.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "g0_review_gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-002",
      decision: "approved",
      source: "control_plane_manual_gate"
    }), "utf8");
    await writeFile(join(artifactDir, "g0_approved.flag"), "approved\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "running",
      currentTaskId: "TASK-002",
      taskStates: {
        "TASK-002": {
          taskId: "TASK-002",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-review",
          attempt: 1,
          maxAttempts: 3,
          statusObservations: []
        }
      },
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "review_dispatched",
        mode: "ao_review",
        rationale: "派发 AO 门禁复核",
        releasedAt: new Date().toISOString(),
        attempt: 1,
        aoSessionId: "ft-review"
      }]
    }));
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([{ id: "ft-review", status: "completed", prompt: `[${workflowId} / TASK-002] review` }]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("artifact_output_conflict");
    expect(state.taskStates["TASK-002"]?.status).toBe("blocked_for_human");
    await expect(store.readLogs(workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "artifact_output_conflict",
          taskId: "TASK-002"
        })
      ])
    );
  });

  it("ignores superseded AO sessions after manual gate recovery", async () => {
    const workflowId = "WF-SUPERSEDED";
    const { store } = await seedPlan(createPlan(workflowId, [
      createTask(workflowId, "TASK-001", {
        title: "G0 仓库现实校准",
        status: "completed"
      }),
      createTask(workflowId, "TASK-002", {
        title: "G0 人工复核放行",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "reviewer"
      })
    ]));
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_repo_reality_check.json"), "{}\n", "utf8");
    await store.update(workflowId, (state) => ({
      ...state,
      status: "waiting_manual_gate",
      currentTaskId: "TASK-002",
      taskStates: {
        "TASK-002": {
          taskId: "TASK-002",
          status: "working",
          aoRole: "reviewer",
          aoSessionId: "ft-2",
          attempt: 1,
          maxAttempts: 3
        }
      },
      manualGateReleases: [{
        taskId: "TASK-002",
        decision: "approved",
        rationale: "旧语义放行",
        releasedAt: new Date().toISOString()
      }]
    }));
    await approveManualGate({
      store,
      workflowId,
      taskId: "TASK-002",
      rationale: "转换为人工门禁放行",
      actor: "user"
    });
    await writeFile(join(store.getWorkflowDir(workflowId), "g0_review_gate_decision.json"), JSON.stringify({
      workflowId,
      taskId: "TASK-002",
      decision: "approved",
      source: "ao_review",
      aoSessionId: "ft-2"
    }), "utf8");
    const runner = new ContinuousExecutionRunner({
      workflowId,
      store,
      ao: createListOnlyAo([{ id: "ft-2", status: "failed", prompt: `[${workflowId} / TASK-002] old` }]) as Pick<AoCliAdapter, "spawnTask" | "listSessions">,
      pollIntervalMs: 1,
      failureConfirmationCount: 1,
      maxTicks: 1
    });

    await runner.run();

    const state = await store.readState(workflowId);
    expect(state.supersededSessions).toContain("ft-2");
    expect(state.taskStates["TASK-002"]?.status).toBe("completed");
    expect(state.status).not.toBe("failed");
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

function createListOnlyAo(sessions: Array<{ id: string; status: string; prompt: string; worktreePath?: string }>) {
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
