import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { atomicWriteJson, ExecutionStateStore } from "./execution-state-store.js";
import { requestTaskPlanRevision } from "./task-plan-revision-review-loop.js";

let tempDir: string | undefined;

describe("requestTaskPlanRevision", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("allows manual_gate requires_replan when triggerTaskId matches currentTaskId", async () => {
    const workflowId = "WF-REVISION-GATE";
    const plan = createPlan(workflowId, [
      createTask(workflowId, "TASK-001", { status: "completed" }),
      createTask(workflowId, "TASK-002", {
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        type: "verification",
        aoRole: "qa"
      })
    ]);
    const store = await seedRevisionWorkflow(plan, {
      status: "paused_for_replan",
      currentTaskId: "TASK-002"
    });

    const result = await requestTaskPlanRevision({
      store,
      codex: createCodex(plan),
      claudeCode: approvingClaudeCode,
      workflowId,
      approvedDesign: "# Design",
      request: {
        workflowId,
        triggerTaskId: "TASK-002",
        reasonCategory: "manual_gate_dispute",
        rationale: "门禁证据与任务计划不一致，需要修订。"
      }
    });

    expect(result.approved).toBe(true);
    const state = await store.readState(workflowId);
    expect(state.planVersion).toBe("task-plan-v2");
    expect(state.currentTaskId).toBeNull();
    expect(state.status).toBe("running");
  });

  it("rejects g0_invalid for non-calibration tasks", async () => {
    const workflowId = "WF-REVISION-G0";
    const plan = createPlan(workflowId, [createTask(workflowId, "TASK-001")]);
    const store = await seedRevisionWorkflow(plan, {
      status: "failed",
      currentTaskId: "TASK-001",
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "blocked_for_human",
          aoRole: "backend-senior",
          attempt: 1,
          maxAttempts: 3
        }
      }
    });

    await expect(requestTaskPlanRevision({
      store,
      codex: createCodex(plan),
      claudeCode: approvingClaudeCode,
      workflowId,
      approvedDesign: "# Design",
      request: {
        workflowId,
        triggerTaskId: "TASK-001",
        reasonCategory: "g0_invalid",
        rationale: "G0 结果无效。"
      }
    })).rejects.toThrow("g0_invalid can only be used with a calibration task");
  });
});

async function seedRevisionWorkflow(
  plan: TaskPlan,
  stateOverrides: Record<string, unknown>
): Promise<ExecutionStateStore> {
  tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-revision-"));
  const store = new ExecutionStateStore(tempDir);
  await mkdir(store.getWorkflowDir(plan.workflowId), { recursive: true });
  await atomicWriteJson(join(store.getWorkflowDir(plan.workflowId), "task-plan.json"), plan);
  await writeFile(join(store.getWorkflowDir(plan.workflowId), "design.md"), "# Design", "utf8");
  await atomicWriteJson(join(store.getWorkflowDir(plan.workflowId), "execution-state.json"), {
    workflowId: plan.workflowId,
    planVersion: "task-plan-current",
    planPath: "task-plan.json",
    status: "running",
    currentTaskId: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    stoppedAt: null,
    failure: null,
    taskStates: {},
    manualGateReleases: [],
    pendingDispatch: null,
    ...stateOverrides
  });
  return store;
}

function createCodex(plan: TaskPlan): CodexAdapter {
  return {
    async createDesign() {
      return "# Design";
    },
    async reviseDesign() {
      return "# Design";
    },
    async createTaskPlan() {
      return plan;
    },
    async reviseTaskPlan() {
      return plan;
    }
  };
}

const approvingClaudeCode: ClaudeCodeAdapter = {
  async reviewDesign(input) {
    return {
      workflowId: input.workflowId,
      round: input.round,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: input.designVersion,
      reviewDecision: "approved",
      findings: []
    };
  },
  async reviewTaskPlan(input) {
    return {
      workflowId: input.workflowId,
      round: input.round,
      planner: "codex",
      reviewer: "claude-code",
      planVersion: input.planVersion,
      reviewDecision: "approved",
      findings: []
    };
  },
  async reviewTaskPlanLocalGate(input) {
    return {
      workflowId: input.workflowId,
      round: input.round,
      planner: "codex",
      reviewer: "claude-code",
      planVersion: input.planVersion,
      reviewDecision: "approved",
      findings: input.localGateReview.findings.map((finding) => ({
        ...finding,
        status: "accepted_as_is"
      }))
    };
  }
};

function createPlan(workflowId: string, tasks: TaskPlan["tasks"]): TaskPlan {
  return { workflowId, title: "Revision plan", tasks };
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
