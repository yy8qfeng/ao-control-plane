import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionStateStore, atomicWriteJson } from "./execution-state-store.js";

let tempDir: string | undefined;

describe("ExecutionStateStore", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("reports corrupted execution-state.json as failed state with parse details", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-state-"));
    const workflowId = "WF-CORRUPTED";
    const store = new ExecutionStateStore(tempDir);
    await mkdir(store.getWorkflowDir(workflowId), { recursive: true });
    await writeFile(join(store.getWorkflowDir(workflowId), "execution-state.json"), "{not-json", "utf8");

    const states = await store.scanStates();
    const state = states.find((item) => item.workflowId === workflowId);

    expect(state?.status).toBe("failed");
    expect(state?.failure?.kind).toBe("state_corrupted");
    expect(state?.failure?.message).toContain("execution-state.json is corrupted:");
  });

  it("fails active plan reads when planVersion points to a missing versioned plan", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-state-"));
    const workflowId = "WF-MISSING-PLAN";
    const store = new ExecutionStateStore(tempDir);
    await mkdir(store.getWorkflowDir(workflowId), { recursive: true });
    await atomicWriteJson(join(store.getWorkflowDir(workflowId), "execution-state.json"), {
      workflowId,
      planVersion: "task-plan-v2",
      planPath: "task-plan-v2.json",
      status: "running",
      currentTaskId: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      completedAt: null,
      stoppedAt: null,
      failure: null,
      taskStates: {},
      manualGateReleases: [],
      pendingDispatch: null
    });

    const state = await store.ensureState(workflowId);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("plan_missing");
    expect(state.failure?.message).toContain("missing task-plan-v2.json");
  });
});
