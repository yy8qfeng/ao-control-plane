import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { resolveAoTaskOutcome } from "./ao-task-outcome.js";
import type { ExecutionState, ExecutionTaskState } from "./execution-state-store.js";

let tempDir: string | undefined;

describe("resolveAoTaskOutcome", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("returns needs_structured_decision when a manual gate needs_input has no decision artifact", async () => {
    const context = await createContext();
    const outcome = await resolveAoTaskOutcome({
      ...context,
      session: { id: "ft-1", status: "needs_input" },
      manualGateMode: "ao_review"
    });

    expect(outcome).toMatchObject({
      kind: "needs_structured_decision",
      failureKind: "ao_task_needs_structured_decision"
    });
    expect(outcome.kind === "needs_structured_decision" ? outcome.requiredOutputs : []).toContain(
      join(context.artifactDir, "g0_review_gate_decision.json")
    );
  });

  it("returns rework_required from a canonical AO review decision artifact", async () => {
    const context = await createContext();
    await writeFile(
      join(context.artifactDir, "g0_review_gate_decision.json"),
      JSON.stringify({
        workflowId: context.plan.workflowId,
        taskId: context.task.taskId,
        decision: "rework_required",
        source: "ao_review",
        aoSessionId: "ft-1",
        targetTaskIds: ["TASK-001"],
        findings: [
          {
            id: "B1",
            severity: "blocking",
            summary: "缺少上游证据。",
            targetTaskId: "TASK-001",
            requiredAction: "补齐上游产物。"
          }
        ]
      }),
      "utf8"
    );

    const outcome = await resolveAoTaskOutcome({
      ...context,
      session: { id: "ft-1", status: "needs_input" },
      manualGateMode: "ao_review"
    });

    expect(outcome).toMatchObject({
      kind: "rework_required",
      targetTaskIds: ["TASK-001"],
      findings: [expect.objectContaining({ id: "B1", targetTaskId: "TASK-001" })]
    });
  });
});

async function createContext(): Promise<{
  plan: TaskPlan;
  task: TaskPlan["tasks"][number];
  taskState: ExecutionTaskState;
  state: ExecutionState;
  artifactDir: string;
}> {
  tempDir = await mkdtemp(join(tmpdir(), "ao-task-outcome-"));
  await mkdir(tempDir, { recursive: true });
  const workflowId = "WF-OUTCOME";
  const producer = createTask(workflowId, "TASK-001", {
    title: "G0 仓库现实校准",
    status: "completed"
  });
  const gate = createTask(workflowId, "TASK-002", {
    title: "G0 人工复核放行",
    type: "review",
    aoRole: "reviewer",
    dependencies: ["TASK-001"],
    dependencyCondition: "manual_gate",
    outputArtifacts: [
      {
        contractId: "g0_review_gate_decision",
        kind: "g0_review_gate_decision",
        path: "g0_review_gate_decision.json",
        required: true
      },
      {
        contractId: "g0_approved_flag",
        kind: "g0_approved_flag",
        path: "g0_approved.flag",
        required: false,
        requiredWhen: "decision=approved"
      },
      {
        contractId: "g0_replan_request",
        kind: "g0_replan_request",
        path: "g0_replan_request.json",
        required: false,
        requiredWhen: "decision=rework_required"
      }
    ]
  });
  const plan = { workflowId, title: "Outcome plan", tasks: [producer, gate] };
  const taskState: ExecutionTaskState = {
    taskId: gate.taskId,
    status: "working",
    aoRole: gate.aoRole,
    aoSessionId: "ft-1",
    attempt: 1,
    maxAttempts: 3
  };
  return {
    plan,
    task: gate,
    taskState,
    artifactDir: tempDir,
    state: {
      workflowId,
      planVersion: "task-plan-current",
      planPath: "task-plan.json",
      status: "running",
      currentTaskId: gate.taskId,
      updatedAt: new Date().toISOString(),
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "completed",
          aoRole: producer.aoRole,
          attempt: 1,
          maxAttempts: 3
        },
        [gate.taskId]: taskState
      },
      manualGateReleases: [
        {
          taskId: gate.taskId,
          decision: "review_dispatched",
          mode: "ao_review",
          aoSessionId: "ft-1"
        }
      ],
      pendingDispatch: null,
      supersededSessions: []
    }
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
