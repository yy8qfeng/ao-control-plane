import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";
import { createInitialState } from "./execution-state-store.js";
import {
  cleanupAoWorktrees,
  listWorktreeCleanupCandidates,
  reconcileTaskOutputsFromAoWorktree
} from "./ao-output-reconcile.js";

let tempDir: string | undefined;

describe("ao output reconciliation", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("recovers expected outputs from the current AO worktree and normalizes AO review metadata", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-RECONCILE", "TASK-006", "ft-7");
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_review_gate_decision.json"), JSON.stringify({
      workflowId: plan.workflowId,
      taskId: task.taskId,
      decision: "approved",
      source: "control_plane_manual_gate",
      decidedBy: "reviewer:ft-7"
    }), "utf8");
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_approved.flag"), "approved\n", "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree({
      task,
      plan,
      state: createInitialState(plan.workflowId),
      artifactDir,
      aoSessionId: "ft-7",
      manualGateMode: "ao_review",
      sessions: [{ id: "ft-7", worktreePath }]
    });

    expect(result.failures).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.recovered).toHaveLength(2);
    const decision = JSON.parse(await readFile(join(artifactDir, "ipc_contract_review_gate_decision.json"), "utf8")) as {
      source: string;
      aoSessionId: string;
      normalizedFrom?: { source: string };
    };
    expect(decision.source).toBe("ao_review");
    expect(decision.aoSessionId).toBe("ft-7");
    expect(decision.normalizedFrom?.source).toBe("control_plane_manual_gate");
  });

  it("does not overwrite manual approve artifacts from an AO worktree", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-MANUAL-PROTECT", "TASK-002", "ft-2");
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_review_gate_decision.json"), JSON.stringify({
      workflowId: plan.workflowId,
      taskId: task.taskId,
      decision: "approved",
      source: "ao_review",
      aoSessionId: "ft-2"
    }), "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree({
      task,
      plan,
      state: createInitialState(plan.workflowId),
      artifactDir,
      aoSessionId: "ft-2",
      manualGateMode: "manual_approve",
      sessions: [{ id: "ft-2", worktreePath }]
    });

    expect(result.recovered).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "manual_approve_protected" })]);
  });

  it("rejects candidates whose workflowId does not match", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-WORKFLOW-MISMATCH", "TASK-006", "ft-7");
    await writeDecisionCandidate(worktreePath, plan.workflowId, {
      workflowId: "WF-OTHER",
      taskId: task.taskId,
      decision: "approved",
      source: "ao_review",
      aoSessionId: "ft-7"
    });

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.contractViolations).toEqual([expect.objectContaining({ reason: "workflow_mismatch", expected: plan.workflowId, actual: "WF-OTHER" })]);
    await expect(access(join(artifactDir, "ipc_contract_review_gate_decision.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects candidates whose taskId does not match", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-TASK-MISMATCH", "TASK-006", "ft-7");
    await writeDecisionCandidate(worktreePath, plan.workflowId, {
      workflowId: plan.workflowId,
      taskId: "TASK-OTHER",
      decision: "approved",
      source: "ao_review",
      aoSessionId: "ft-7"
    });

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.contractViolations).toEqual([expect.objectContaining({ reason: "task_mismatch", expected: task.taskId, actual: "TASK-OTHER" })]);
  });

  it("enters conflict when canonical exists with different content and does not overwrite it", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-CANONICAL-CONFLICT", "TASK-006", "ft-7");
    const canonical = { workflowId: plan.workflowId, taskId: task.taskId, decision: "rejected", source: "ao_review", aoSessionId: "ft-7" };
    await writeFile(join(artifactDir, "ipc_contract_review_gate_decision.json"), JSON.stringify(canonical), "utf8");
    await writeDecisionCandidate(worktreePath, plan.workflowId, {
      workflowId: plan.workflowId,
      taskId: task.taskId,
      decision: "approved",
      source: "ao_review",
      aoSessionId: "ft-7"
    });

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.conflicts).toEqual([expect.objectContaining({ reason: "canonical_exists_with_different_content" })]);
    await expect(readFile(join(artifactDir, "ipc_contract_review_gate_decision.json"), "utf8")).resolves.toBe(JSON.stringify(canonical));
  });

  it("rejects .flag files exceeding the size limit", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-FLAG-SIZE", "TASK-006", "ft-7");
    await writeDecisionCandidate(worktreePath, plan.workflowId, approvedDecision(plan.workflowId, task.taskId));
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_approved.flag"), "x".repeat(64 * 1024 + 1), "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([expect.objectContaining({ kind: "ipc_contract_approved_flag", reason: "size_exceeded" })]);
    expect(result.recovered).toEqual([]);
  });

  it("rejects JSON files exceeding the size limit", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-JSON-SIZE", "TASK-006", "ft-7");
    await writeFile(
      join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_review_gate_decision.json"),
      `{"workflowId":"${plan.workflowId}","taskId":"${task.taskId}","decision":"approved","source":"ao_review","aoSessionId":"ft-7","padding":"${"x".repeat(1024 * 1024)}"}`,
      "utf8"
    );

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([expect.objectContaining({ kind: "ipc_contract_review_gate_decision", reason: "size_exceeded" })]);
  });

  it("rejects invalid JSON candidates", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-INVALID-JSON", "TASK-006", "ft-7");
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "ipc_contract_review_gate_decision.json"), "{bad-json", "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([expect.objectContaining({ reason: "invalid_json" })]);
  });

  it("skips reconciliation when the AO worktree cannot be found", async () => {
    const { artifactDir, plan, task } = await seedManualGateWorktree("WF-NO-WORKTREE", "TASK-006", "ft-seeded");

    const result = await reconcileTaskOutputsFromAoWorktree({
      task,
      plan,
      state: createInitialState(plan.workflowId),
      artifactDir,
      aoSessionId: "ft-definitely-missing",
      manualGateMode: "ao_review",
      sessions: [{ id: "ft-definitely-missing", worktreePath: join(tempDir ?? "", "missing-worktree") }]
    });

    expect(result.skipped).toEqual([expect.objectContaining({ reason: "worktree_not_found" })]);
  });

  it("returns missing when worktree exists but expected output candidate is absent", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-CANDIDATE-MISSING", "TASK-006", "ft-7");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ipc_contract_review_gate_decision", reason: "candidate_missing" })
      ])
    );
    expect(result.conflicts).toEqual([]);
  });

  it("computes candidate paths for absolute expectedOutput.path values", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-ABSOLUTE-PATH", "TASK-006", "ft-7");
    task.outputArtifacts = [
      { kind: "gate_decision", path: join(artifactDir, "nested", "gate_decision.json"), required: true }
    ];
    await mkdir(join(worktreePath, ".ao-control-plane", plan.workflowId, "nested"), { recursive: true });
    await writeFile(join(worktreePath, ".ao-control-plane", plan.workflowId, "nested", "gate_decision.json"), JSON.stringify(approvedDecision(plan.workflowId, task.taskId)), "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.recovered).toEqual([expect.objectContaining({ to: join(artifactDir, "nested", "gate_decision.json") })]);
  });

  it("recovers declared outputs from documented mirror files when AO writes outside .ao-control-plane", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-MIRROR-CANDIDATE", "TASK-008", "ft-7", [
      { kind: "transport_contract_freeze", path: "transport_contract_freeze.json", required: true },
      { kind: "transport_contract_freeze_markdown", path: "transport_contract_freeze.md", required: false }
    ]);
    await mkdir(join(worktreePath, "docs", "transport"), { recursive: true });
    await writeFile(join(worktreePath, "docs", "transport", "transport-contract-freeze.json"), JSON.stringify({
      workflowId: plan.workflowId,
      taskId: task.taskId,
      frozenBy: "ft-7"
    }), "utf8");
    await writeFile(join(worktreePath, "docs", "transport", "transport-contract-freeze.md"), "# Transport contract\n", "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.recovered).toEqual([
      expect.objectContaining({
        from: join(worktreePath, "docs", "transport", "transport-contract-freeze.json"),
        to: join(artifactDir, "transport_contract_freeze.json")
      }),
      expect.objectContaining({
        from: join(worktreePath, "docs", "transport", "transport-contract-freeze.md"),
        to: join(artifactDir, "transport_contract_freeze.md")
      })
    ]);
  });

  it("reports ambiguous candidates without also reporting conflicts", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-AMBIGUOUS-CANDIDATES", "TASK-008", "ft-7", [
      { contractId: "transport_contract_freeze", kind: "transport_contract_freeze", path: "transport_contract_freeze.json", required: true }
    ]);
    const payload = {
      workflowId: plan.workflowId,
      taskId: task.taskId,
      frozenBy: "ft-7"
    };
    await mkdir(join(worktreePath, "docs", "transport"), { recursive: true });
    await writeFile(join(worktreePath, "docs", "transport", "transport-contract-freeze.json"), JSON.stringify(payload), "utf8");
    await writeFile(join(worktreePath, "docs", "transport", "transport_contract_freeze.json"), JSON.stringify(payload), "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.ambiguousCandidates).toHaveLength(2);
    expect(result.conflicts).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("matches documented mirror paths case-insensitively when the contract allows it", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-CASE-AWARE", "TASK-008", "ft-7", [
      { contractId: "transport_contract_freeze", kind: "transport_contract_freeze", path: "transport_contract_freeze.json", required: true }
    ]);
    await mkdir(join(worktreePath, "Docs", "Transport"), { recursive: true });
    await writeFile(join(worktreePath, "Docs", "Transport", "Transport-Contract-Freeze.json"), JSON.stringify({
      workflowId: plan.workflowId,
      taskId: task.taskId,
      frozenBy: "ft-7"
    }), "utf8");

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    if (process.platform === "win32" || process.platform === "darwin") {
      expect(result.recovered).toEqual([
        expect.objectContaining({
          from: join(worktreePath, "Docs", "Transport", "Transport-Contract-Freeze.json")
        })
      ]);
    } else {
      expect(result.missing).toEqual([
        expect.objectContaining({ reason: "candidate_missing" })
      ]);
    }
  });

  it("rejects expectedOutput paths outside artifactDir", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-PATH-ESCAPE", "TASK-006", "ft-7");
    task.outputArtifacts = [
      { kind: "gate_decision", path: join(tempDir ?? "", "outside", "gate_decision.json"), required: true }
    ];

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([expect.objectContaining({ reason: "path_escape" })]);
  });

  it("rejects absolute expectedOutput paths on another root", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-PATH-OTHER-ROOT", "TASK-006", "ft-7");
    task.outputArtifacts = [
      { kind: "gate_decision", path: process.platform === "win32" ? "Z:\\outside\\gate_decision.json" : "/outside/gate_decision.json", required: true }
    ];

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.failures).toEqual([expect.objectContaining({ reason: "path_escape" })]);
  });

  it("only normalizes AO review decisions when source proof is provided", async () => {
    const { artifactDir, worktreePath, plan, task } = await seedManualGateWorktree("WF-SOURCE-PROOF", "TASK-006", "ft-7");
    await writeDecisionCandidate(worktreePath, plan.workflowId, {
      workflowId: plan.workflowId,
      taskId: task.taskId,
      decision: "approved",
      source: "control_plane_manual_gate",
      decidedBy: "reviewer:other-session"
    });

    const result = await reconcileTaskOutputsFromAoWorktree(reconcileInput({ artifactDir, worktreePath, plan, task }));

    expect(result.contractViolations).toEqual([expect.objectContaining({ reason: "source_proof_missing" })]);
  });

  it("allows reviewerSessionId and reviewerIndependence source proof", async () => {
    const first = await seedManualGateWorktree("WF-REVIEWER-PROOF-A", "TASK-006", "ft-7");
    await writeDecisionCandidate(first.worktreePath, first.plan.workflowId, {
      ...approvedDecision(first.plan.workflowId, first.task.taskId),
      source: "control_plane_manual_gate",
      reviewerSessionId: "ft-7"
    });
    const firstResult = await reconcileTaskOutputsFromAoWorktree(reconcileInput(first));
    expect(firstResult.recovered[0]?.normalized).toBe(true);

    await rm(tempDir ?? "", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempDir = undefined;
    const second = await seedManualGateWorktree("WF-REVIEWER-PROOF-B", "TASK-006", "ft-7");
    await writeDecisionCandidate(second.worktreePath, second.plan.workflowId, {
      ...approvedDecision(second.plan.workflowId, second.task.taskId),
      source: "control_plane_manual_gate",
      reviewerIndependence: { reviewerSessionId: "ft-7" }
    });
    const secondResult = await reconcileTaskOutputsFromAoWorktree(reconcileInput(second));
    expect(secondResult.recovered[0]?.normalized).toBe(true);
  });

  it("dry-runs worktree cleanup without removing candidates", async () => {
    const { projectRoot, worktreePath } = await seedGitWorktree("ft-clean");
    const state = {
      ...createInitialState("WF-CLEANUP"),
      supersededSessions: ["ft-clean"]
    };

    const result = await cleanupAoWorktrees({
      state,
      projectRoot,
      sessionIds: ["ft-clean"],
      dryRun: true,
      sessions: [{ id: "ft-clean", status: "completed", worktreePath }]
    });

    expect(result.candidates).toEqual([expect.objectContaining({ sessionId: "ft-clean" })]);
    expect(result.skipped).toEqual([expect.objectContaining({ sessionId: "ft-clean", reason: "dryRun" })]);
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  it("does not list the current working session as a cleanup candidate", async () => {
    const { projectRoot, worktreePath } = await seedGitWorktree("ft-current");
    const state = {
      ...createInitialState("WF-CURRENT"),
      taskStates: {
        "TASK-001": {
          taskId: "TASK-001",
          status: "working" as const,
          aoRole: "reviewer",
          aoSessionId: "ft-current",
          attempt: 1,
          maxAttempts: 3
        }
      },
      supersededSessions: ["ft-current"]
    };

    await expect(listWorktreeCleanupCandidates({
      state,
      projectRoot,
      sessions: [{ id: "ft-current", status: "completed", worktreePath }]
    })).resolves.toEqual([]);
  });

  it("does not list superseded sessions with uncommitted worktree changes", async () => {
    const { projectRoot, worktreePath } = await seedGitWorktree("ft-dirty");
    await writeFile(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");
    const state = {
      ...createInitialState("WF-DIRTY"),
      supersededSessions: ["ft-dirty"]
    };

    await expect(listWorktreeCleanupCandidates({
      state,
      projectRoot,
      sessions: [{ id: "ft-dirty", status: "completed", worktreePath }]
    })).resolves.toEqual([]);
  });
});

async function seedManualGateWorktree(
  workflowId: string,
  taskId: string,
  sessionId: string,
  outputArtifacts?: ExecutionTask["outputArtifacts"]
) {
  tempDir = await mkdtemp(join(tmpdir(), "ao-output-reconcile-"));
  const artifactDir = join(tempDir, "canonical", ".ao-control-plane", workflowId);
  const worktreePath = join(tempDir, ".agent-orchestrator", "projects", "project", "worktrees", sessionId);
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(worktreePath, ".ao-control-plane", workflowId), { recursive: true });
  const task = createTask(workflowId, taskId, outputArtifacts);
  const plan: TaskPlan = { workflowId, title: "Plan", tasks: [task] };
  return { artifactDir, worktreePath, plan, task };
}

function createTask(workflowId: string, taskId: string, outputArtifacts?: ExecutionTask["outputArtifacts"]): ExecutionTask {
  return {
    taskId,
    workflowId,
    title: "IPC contract manual gate",
    description: "reviewer 复核 IPC 契约。",
    type: "verification",
    dependencies: [],
    dependencyCondition: "manual_gate",
    aoRole: "reviewer",
    acceptanceCriteria: ["approved 时产出 ipc_contract_approved.flag。"],
    aoPrompt: `[${workflowId} / ${taskId}] review ipc.`,
    executionPolicy: defaultExecutionPolicy,
    status: "pending",
    outputArtifacts: outputArtifacts ?? [
      { kind: "ipc_contract_review_gate_decision", path: "ipc_contract_review_gate_decision.json", required: true },
      { kind: "ipc_contract_approved_flag", path: "ipc_contract_approved.flag", requiredWhen: "decision=approved" }
    ]
  };
}

function reconcileInput(input: {
  artifactDir: string;
  worktreePath: string;
  plan: TaskPlan;
  task: ExecutionTask;
}) {
  return {
    task: input.task,
    plan: input.plan,
    state: createInitialState(input.plan.workflowId),
    artifactDir: input.artifactDir,
    aoSessionId: "ft-7",
    manualGateMode: "ao_review" as const,
    sessions: [{ id: "ft-7", worktreePath: input.worktreePath }]
  };
}

async function writeDecisionCandidate(worktreePath: string, workflowId: string, decision: unknown): Promise<void> {
  await writeFile(
    join(worktreePath, ".ao-control-plane", workflowId, "ipc_contract_review_gate_decision.json"),
    JSON.stringify(decision),
    "utf8"
  );
}

function approvedDecision(workflowId: string, taskId: string): Record<string, unknown> {
  return {
    workflowId,
    taskId,
    decision: "approved",
    source: "ao_review",
    aoSessionId: "ft-7"
  };
}

async function seedGitWorktree(sessionId: string): Promise<{ projectRoot: string; worktreePath: string }> {
  tempDir = await mkdtemp(join(tmpdir(), "ao-output-reconcile-git-"));
  const projectRoot = join(tempDir, "project");
  const worktreePath = join(tempDir, "worktrees", sessionId);
  await mkdir(projectRoot, { recursive: true });
  await execa("git", ["init"], { cwd: projectRoot });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot });
  await execa("git", ["config", "user.name", "Test User"], { cwd: projectRoot });
  await writeFile(join(projectRoot, "README.md"), "test\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: projectRoot });
  await execa("git", ["commit", "-m", "init"], { cwd: projectRoot });
  await execa("git", ["branch", `session/${sessionId}`], { cwd: projectRoot });
  await mkdir(join(tempDir, "worktrees"), { recursive: true });
  await execa("git", ["worktree", "add", worktreePath, `session/${sessionId}`], { cwd: projectRoot });
  return { projectRoot, worktreePath };
}
