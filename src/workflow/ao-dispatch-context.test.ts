import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask } from "../schemas/task-plan.js";
import {
  buildAoDispatchContext,
  resolveInputArtifacts,
  resolveOutputArtifacts,
  synthesizeManualGateArtifacts,
  validateTaskOutputArtifacts
} from "./ao-dispatch-context.js";
import { createInitialState } from "./execution-state-store.js";

let tempDir: string | undefined;

describe("ao dispatch context", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("evaluates requiredWhen expressions with explicit edge cases", async () => {
    const artifactDir = await createTempArtifactDir();
    const task = createTask("WF-REQ-WHEN", {
      outputArtifacts: [
        { kind: "gate_decision", path: "gate_decision.json", required: true },
        { kind: "approved_flag", path: "approved.flag", requiredWhen: "decision=approved" },
        { kind: "ao_flag", path: "ao.flag", requiredWhen: "decision=approved&&source=ao_review" },
        { kind: "invalid_flag", path: "invalid.flag", requiredWhen: "decision=" },
        { kind: "missing_field_flag", path: "missing-field.flag", requiredWhen: "missing=field" }
      ]
    });
    await writeFile(join(artifactDir, "gate_decision.json"), JSON.stringify({
      decision: "approved",
      source: "ao_review"
    }), "utf8");

    const result = await validateTaskOutputArtifacts({ task, artifactDir });

    expect(result.conflictArtifacts).toEqual([]);
    expect(result.missingArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approved_flag", reason: "missing" }),
        expect.objectContaining({ kind: "ao_flag", reason: "missing" }),
        expect.objectContaining({ kind: "invalid_flag", reason: "required_when_invalid" })
      ])
    );
    expect(result.missingArtifacts.some((artifact) => artifact.kind === "missing_field_flag")).toBe(false);
  });

  it("reports invalid decision JSON before evaluating requiredWhen", async () => {
    const artifactDir = await createTempArtifactDir();
    const task = createTask("WF-REQ-WHEN-INVALID", {
      outputArtifacts: [
        { kind: "gate_decision", path: "gate_decision.json", required: true },
        { kind: "approved_flag", path: "approved.flag", requiredWhen: "decision=approved" }
      ]
    });
    await writeFile(join(artifactDir, "gate_decision.json"), "{not-json", "utf8");

    const result = await validateTaskOutputArtifacts({ task, artifactDir });

    expect(result.missingArtifacts).toEqual([
      expect.objectContaining({ kind: "gate_decision", reason: "decision_invalid" })
    ]);
  });

  it("detects gate decision source conflicts for AO review outputs", async () => {
    const artifactDir = await createTempArtifactDir();
    const task = createTask("WF-SOURCE-CONFLICT", {
      outputArtifacts: [
        { kind: "gate_decision", path: "gate_decision.json", required: true }
      ]
    });
    await writeFile(join(artifactDir, "gate_decision.json"), JSON.stringify({
      decision: "approved",
      source: "control_plane_manual_gate"
    }), "utf8");

    const result = await validateTaskOutputArtifacts({
      task,
      artifactDir,
      manualGateMode: "ao_review",
      aoSessionId: "ft-review"
    });

    expect(result.conflictArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "source_mismatch", expected: "ao_review" }),
        expect.objectContaining({ reason: "ao_session_mismatch", expected: "ft-review" })
      ])
    );
  });

  it("preserves Windows paths with spaces and Unicode in the manifest and prompt", async () => {
    const artifactDir = await createTempArtifactDir();
    await writeFile(join(artifactDir, "task-plan.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "execution-state.json"), "{}\n", "utf8");
    const workflowId = "WF-WINDOWS-PATHS";
    const task = createTask(workflowId);
    const plan = { workflowId, title: "Plan", tasks: [task] };

    const context = await buildAoDispatchContext({
      task,
      plan,
      state: createInitialState(workflowId),
      projectRoot: "C:\\workspace\\fast transport\\中文项目",
      artifactDir,
      attempt: 1
    });

    const manifest = JSON.parse(await readFile(context.contextPath, "utf8")) as { projectRoot: string };
    expect(manifest.projectRoot).toBe("C:\\workspace\\fast transport\\中文项目");
    expect(context.prompt).toContain("projectRoot: C:\\workspace\\fast transport\\中文项目");
    expect(context.prompt).toContain("artifactDir:");
    expect(context.prompt).toContain("coreInputs:");
    expect(context.prompt).toContain("task_plan:");
    expect(context.prompt).toContain("execution_state:");
    expect(context.prompt).toContain("expectedOutputs:");
  });

  it("synthesizes manual gate artifacts with explicit decision and flag kinds", async () => {
    const artifactDir = await createTempArtifactDir();
    const workflowId = "WF-SYNTH-KINDS";
    const task = createTask(workflowId, {
      outputArtifacts: [
        { kind: "gate_decision", path: "custom-decision.json", required: true },
        { kind: "approved_flag", path: "custom-approved.flag", requiredWhen: "decision=approved" }
      ]
    });
    const plan = { workflowId, title: "Plan", tasks: [task] };

    const synthesized = await synthesizeManualGateArtifacts({
      task,
      plan,
      state: createInitialState(workflowId),
      artifactDir,
      rationale: "人工批准",
      actor: "user"
    });

    expect(synthesized.generatedArtifacts).toEqual(["custom-decision.json", "custom-approved.flag"]);
    await expect(readFile(join(artifactDir, "custom-decision.json"), "utf8")).resolves.toContain("control_plane_manual_gate");
    await expect(readFile(join(artifactDir, "custom-approved.flag"), "utf8")).resolves.toContain("approved");
  });

  it("infers domain manual gate inputs and outputs from dependency artifacts", async () => {
    const artifactDir = await createTempArtifactDir();
    const workflowId = "WF-DOMAIN-GATE";
    const producer = createTask(workflowId, {
      taskId: "TASK-005",
      title: "冻结跨语言 IPC 核心字节布局契约",
      description: "冻结 IPC 布局。",
      aoPrompt: `[${workflowId} / TASK-005] freeze ipc.`,
      acceptanceCriteria: ["冻结控制块字段。"],
      outputArtifacts: [
        { contractId: "ipc_byte_layout_freeze", kind: "ipc_byte_layout_freeze", path: "ipc_byte_layout_freeze.json", required: true },
        { contractId: "ipc_byte_layout_freeze_markdown", kind: "ipc_byte_layout_freeze_markdown", path: "ipc_byte_layout_freeze.md", required: true },
        { contractId: "ipc_byte_layout_qa_verdict", kind: "ipc_byte_layout_qa_verdict", path: "ipc_byte_layout_qa_verdict.json", required: true }
      ]
    });
    const reviewer = createTask(workflowId, {
      taskId: "TASK-006",
      title: "跨语言 IPC 契约人工复核门禁",
      description: "reviewer 复核 IPC 契约是否跨 Rust/Java 同步冻结。",
      dependencies: ["TASK-005"],
      dependencyCondition: "manual_gate",
      aoPrompt: `[${workflowId} / TASK-006] review ipc.`,
      acceptanceCriteria: ["approved 时产出 ipc_contract_approved.flag。"],
      outputArtifacts: [
        { contractId: "ipc_contract_review_gate_decision", kind: "ipc_contract_review_gate_decision", path: "ipc_contract_review_gate_decision.json", required: true },
        { contractId: "ipc_contract_approved_flag", kind: "ipc_contract_approved_flag", path: "ipc_contract_approved.flag", requiredWhen: "decision=approved" }
      ]
    });
    const plan = { workflowId, title: "Plan", tasks: [producer, reviewer] };

    expect(resolveInputArtifacts(reviewer, plan, artifactDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "TASK-005", kind: "ipc_byte_layout_freeze" }),
        expect.objectContaining({ taskId: "TASK-005", kind: "ipc_byte_layout_qa_verdict" })
      ])
    );
    expect(resolveOutputArtifacts(reviewer, artifactDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ipc_contract_review_gate_decision", path: join(artifactDir, "ipc_contract_review_gate_decision.json") }),
        expect.objectContaining({ kind: "ipc_contract_approved_flag", path: join(artifactDir, "ipc_contract_approved.flag"), requiredWhen: "decision=approved" })
      ])
    );
  });

  it("makes AO prompt distinguish dependency inputs from expected outputs", async () => {
    const artifactDir = await createTempArtifactDir();
    await writeFile(join(artifactDir, "task-plan.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "execution-state.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "ipc_byte_layout_freeze.json"), "{}\n", "utf8");
    await writeFile(join(artifactDir, "ipc_byte_layout_freeze.md"), "# IPC\n", "utf8");
    await writeFile(join(artifactDir, "ipc_byte_layout_qa_verdict.json"), "{}\n", "utf8");
    const workflowId = "WF-DOMAIN-GATE-PROMPT";
    const producer = createTask(workflowId, {
      taskId: "TASK-005",
      title: "冻结跨语言 IPC 核心字节布局契约",
      description: "冻结 IPC 布局。",
      aoPrompt: `[${workflowId} / TASK-005] freeze ipc.`,
      acceptanceCriteria: ["冻结控制块字段。"],
      outputArtifacts: [
        { contractId: "ipc_byte_layout_freeze", kind: "ipc_byte_layout_freeze", path: "ipc_byte_layout_freeze.json", required: true },
        { contractId: "ipc_byte_layout_freeze_markdown", kind: "ipc_byte_layout_freeze_markdown", path: "ipc_byte_layout_freeze.md", required: true },
        { contractId: "ipc_byte_layout_qa_verdict", kind: "ipc_byte_layout_qa_verdict", path: "ipc_byte_layout_qa_verdict.json", required: true }
      ]
    });
    const reviewer = createTask(workflowId, {
      taskId: "TASK-006",
      title: "跨语言 IPC 契约人工复核门禁",
      description: "reviewer 复核 IPC 契约是否跨 Rust/Java 同步冻结。",
      dependencies: ["TASK-005"],
      dependencyCondition: "manual_gate",
      aoPrompt: `[${workflowId} / TASK-006] review ipc.`,
      acceptanceCriteria: ["approved 时产出 ipc_contract_approved.flag。"],
      outputArtifacts: [
        { contractId: "ipc_contract_review_gate_decision", kind: "ipc_contract_review_gate_decision", path: "ipc_contract_review_gate_decision.json", required: true },
        { contractId: "ipc_contract_approved_flag", kind: "ipc_contract_approved_flag", path: "ipc_contract_approved.flag", requiredWhen: "decision=approved" }
      ]
    });
    const plan = { workflowId, title: "Plan", tasks: [producer, reviewer] };

    const context = await buildAoDispatchContext({
      task: reviewer,
      plan,
      state: createInitialState(workflowId),
      projectRoot: "C:\\workspace\\fast-transport",
      artifactDir,
      attempt: 1
    });

    expect(context.prompt).toContain("Dependency artifacts are required inputs");
    expect(context.prompt).toContain("Expected outputs are files you must create");
    expect(context.prompt).toContain("Do not treat a missing expected output as missing input");
    expect(context.prompt).toContain("An empty AO worktree is not evidence that control-plane artifacts are missing");
    expect(context.prompt).toContain("Write every required expected output to the exact absolute expectedOutputs.path");
    expect(context.prompt).toContain("source=\"ao_review\"");
    expect(context.prompt).toContain("INPUT ipc_byte_layout_freeze");
    expect(context.prompt).toContain("OUTPUT ipc_contract_approved_flag");
    expect(context.manifest.instructions).toEqual(
      expect.arrayContaining([
        "Dependency artifacts are required inputs; read every required dependency artifact from artifactDir before asking for user help.",
        "Expected outputs are files you must create for this task; their absence before the task starts is normal.",
        "Do not treat a missing expected output as missing input."
      ])
    );
    expect(context.missingRequiredArtifacts).toEqual([]);
  });
});

async function createTempArtifactDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "ao-dispatch-context-"));
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

function createTask(workflowId: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    taskId: "TASK-001",
    workflowId,
    title: "Task",
    description: "Task.",
    type: "verification",
    dependencies: [],
    dependencyCondition: "all_completed",
    aoRole: "reviewer",
    acceptanceCriteria: ["Done"],
    aoPrompt: `[${workflowId} / TASK-001] Task.`,
    executionPolicy: defaultExecutionPolicy,
    status: "pending",
    ...overrides
  };
}
