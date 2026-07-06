import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask } from "../schemas/task-plan.js";
import {
  buildAoDispatchContext,
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
