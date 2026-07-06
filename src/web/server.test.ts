import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { startWebServer } from "./server.js";
import { renderIndexHtml } from "./ui.js";

let tempDir: string | undefined;
let server: Awaited<ReturnType<typeof startWebServer>> | undefined;

describe("web server", () => {
  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("runs governance and dry-runs execution through HTTP APIs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => fakeCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as { recentProjectRoots: string[] };
    expect(projects.recentProjectRoots).toEqual([]);

    const selectResponse = await fetch(`${server.url}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot })
    });
    const selected = (await selectResponse.json()) as {
      selectedProjectRoot: string;
      recentProjectRoots: string[];
    };
    expect(selectResponse.status).toBe(200);
    expect(selected.selectedProjectRoot).toBe(projectRoot);
    expect(selected.recentProjectRoots).toContain(projectRoot);

    const browseRootResponse = await fetch(`${server.url}/api/filesystem/browse`);
    const browseRoot = (await browseRootResponse.json()) as { roots: unknown[] };
    expect(browseRootResponse.status).toBe(200);
    expect(browseRoot.roots.length).toBeGreaterThan(0);

    const browseProjectResponse = await fetch(
      `${server.url}/api/filesystem/browse?path=${encodeURIComponent(tempDir)}`
    );
    const browseProject = (await browseProjectResponse.json()) as {
      currentPath: string;
      directories: Array<{ name: string; path: string }>;
    };
    expect(browseProjectResponse.status).toBe(200);
    expect(browseProject.currentPath).toBe(tempDir);
    expect(browseProject.directories.some((directory) => directory.name === "project")).toBe(true);

    const reviewResponse = await fetch(`${server.url}/api/governance/design-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        title: "User permissions",
        description: "Add role-based permissions.",
        acceptanceCriteria: ["Permissions are enforced"],
        constraints: ["Do not modify AO"],
        maxDesignReviewRounds: 3
      })
    });
    const reviewed = (await reviewResponse.json()) as {
      workflow: { workflowId: string; status: string };
      artifactDir: string;
    };

    expect(reviewResponse.status).toBe(200);
    expect(reviewed.workflow.status).toBe("ready_for_planning");
    expect(reviewed.artifactDir).toContain(join(projectRoot, ".ao-control-plane"));

    const planResponse = await fetch(`${server.url}/api/governance/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: reviewed.workflow.workflowId
      })
    });
    const planJob = (await planResponse.json()) as { jobId: string; status: string; logs: string[] };

    expect(planResponse.status).toBe(202);
    expect(planJob.status).toBe("running");
    expect(planJob.logs[0]).toContain("任务计划续审任务");
    const plannedJob = await waitForCompletedJob(server.url, planJob.jobId);
    expect(plannedJob.logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex 正在生成任务计划第 1 轮。"),
        expect.stringContaining("Codex 已生成任务计划草稿第 1 轮"),
        expect.stringContaining("ClaudeCode 正在审查任务计划第 1 轮。"),
        expect.stringContaining("ClaudeCode 任务计划第 1 轮结论：approved。")
      ])
    );
    const planned = plannedJob.result;
    expect(planned.workflow.status).toBe("executing");
    expect(planned.plan.tasks).toHaveLength(1);
    await expect(
      readFile(join(projectRoot, ".ao-control-plane", planned.workflow.workflowId, "task-plan.json"), "utf8")
    ).resolves.toContain(planned.workflow.workflowId);

    const executionResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: planned.workflow.workflowId,
        dryRun: true
      })
    });
    const execution = (await executionResponse.json()) as { sessions: unknown[] };

    expect(executionResponse.status).toBe(200);
    expect(execution.sessions).toHaveLength(1);
  });

  it("reads persisted workflow artifacts so restored drafts can show task counts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    const workflowId = "WF-RESTORE-COUNT";
    await mkdir(projectRoot);
    await seedReadyForPlanningWorkflow(projectRoot, workflowId);
    await writeJson(
      join(projectRoot, ".ao-control-plane", workflowId, "task-plan-draft.json"),
      createWebPlan(workflowId)
    );
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });

    const response = await fetch(
      `${server.url}/api/governance/workflows/${encodeURIComponent(workflowId)}?projectRoot=${encodeURIComponent(projectRoot)}`
    );
    const restored = (await response.json()) as {
      draftPlan?: { tasks: unknown[] };
      workflow?: { workflowId: string };
      artifactDir?: string;
    };

    expect(response.status).toBe(200);
    expect(restored.workflow?.workflowId).toBe(workflowId);
    expect(restored.draftPlan?.tasks).toHaveLength(1);
    expect(restored.artifactDir).toBe(join(projectRoot, ".ao-control-plane", workflowId));
  });

  it("releases manual gate tasks through the AO execute API in dry-run mode", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });
    await seedExecutingWorkflow(projectRoot, "WF-MANUAL-GATE", createManualGatePlan("WF-MANUAL-GATE"));

    // Keep direct /api/ao/execute tests in dry-run mode so the suite never starts real AO sessions.
    const blockedResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true
      })
    });
    const blocked = (await blockedResponse.json()) as { sessions: unknown[]; blockedTasks: Array<{ taskId: string }> };
    expect(blockedResponse.status).toBe(200);
    expect(blocked.sessions).toEqual([]);
    expect(blocked.blockedTasks).toEqual([
      {
        taskId: "TASK-002",
        kind: "manual_gate",
        reason: "manual_gate requires human approval before dispatch"
      }
    ]);

    const releasedResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true,
        releasedManualGateTaskIds: [
          {
            taskId: "TASK-002",
            decision: "approved",
            rationale: "人工确认放行"
          }
        ]
      })
    });
    const released = (await releasedResponse.json()) as { sessions: Array<{ taskId: string; sessionId: string }> };
    expect(releasedResponse.status).toBe(200);
    expect(released.sessions).toEqual([
      {
        taskId: "TASK-002",
        aoRole: "qa",
        sessionId: "dry-run-TASK-002"
      }
    ]);

    const replanResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true,
        releasedManualGateTaskIds: [
          {
            taskId: "TASK-002",
            decision: "requires_replan",
            rationale: "人工要求重规划"
          }
        ]
      })
    });
    const replan = (await replanResponse.json()) as { sessions: unknown[]; blockedTasks: Array<{ taskId: string; kind: string }> };
    expect(replanResponse.status).toBe(200);
    expect(replan.sessions).toEqual([]);
    expect(replan.blockedTasks).toEqual([
      {
        taskId: "TASK-002",
        kind: "manual_gate",
        reason: "manual_gate requires human approval before dispatch"
      }
    ]);
  });

  it("rejects invalid manual gate release ids through the AO execute API", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });
    await seedExecutingWorkflow(projectRoot, "WF-MANUAL-GATE", createManualGatePlan("WF-MANUAL-GATE"));

    const unknownResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true,
        releasedManualGateTaskIds: ["TASK-404"]
      })
    });
    const unknown = (await unknownResponse.json()) as { error: string };
    expect(unknownResponse.status).toBe(400);
    expect(unknown.error).toContain("unknown task id: TASK-404");

    const nonManualGateResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true,
        releasedManualGateTaskIds: ["TASK-001"]
      })
    });
    const nonManualGate = (await nonManualGateResponse.json()) as { error: string };
    expect(nonManualGateResponse.status).toBe(400);
    expect(nonManualGate.error).toContain("non-manual_gate task id: TASK-001");

    const invalidDecisionResponse = await fetch(`${server.url}/api/ao/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-MANUAL-GATE",
        dryRun: true,
        releasedManualGateTaskIds: [{ taskId: "TASK-002", decision: "skip" }]
      })
    });
    const invalidDecision = (await invalidDecisionResponse.json()) as { error: string };
    expect(invalidDecisionResponse.status).toBe(400);
    expect(invalidDecision.error).toContain("decision must be approved, requires_replan, or blocked");
  });

  it("runs continuous execution through execution job APIs in dry-run mode", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });
    await seedExecutingWorkflow(projectRoot, "WF-CONTINUOUS-WEB", createWebPlan("WF-CONTINUOUS-WEB"));

    const startResponse = await fetch(`${server.url}/api/ao/execution-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-CONTINUOUS-WEB",
        dryRun: true,
        pollIntervalMs: 1
      })
    });
    const started = (await startResponse.json()) as {
      jobId: string;
      mode: string;
      status: string;
    };

    expect(startResponse.status).toBe(200);
    expect(started.mode).toBe("created");

    const completed = await waitForExecutionJobStatus(server.url, started.jobId, projectRoot, "completed");
    expect(completed.summary.completed).toBe(1);
    expect(completed.currentTaskId).toBeNull();
    expect(completed.tasks?.[0]?.status).toBe("completed");
    expect(completed.logs.some((event) => event.type === "task_dispatched")).toBe(true);
  });

  it("approves a waiting manual gate through the split execution job API", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });
    await seedExecutingWorkflow(projectRoot, "WF-GATE-APPROVE", createManualGatePlan("WF-GATE-APPROVE"));

    const startResponse = await fetch(`${server.url}/api/ao/execution-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-GATE-APPROVE",
        dryRun: true,
        pollIntervalMs: 1
      })
    });
    const started = (await startResponse.json()) as { jobId: string };
    const waiting = await waitForExecutionJobStatus(server.url, started.jobId, projectRoot, "waiting_manual_gate");
    expect(waiting.manualGateContext?.taskId).toBe("TASK-002");

    const approveResponse = await fetch(
      `${server.url}/api/ao/execution-jobs/${encodeURIComponent(started.jobId)}/manual-gates/TASK-002/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot,
          rationale: "人工确认放行"
        })
      }
    );
    const approved = (await approveResponse.json()) as { status: string; tasks?: Array<{ taskId: string; status: string }> };

    expect(approveResponse.status).toBe(200);
    expect(["running", "completed"]).toContain(approved.status);
    expect(approved.tasks?.find((task) => task.taskId === "TASK-002")?.status).toBe("completed");
    await waitForExecutionJobStatus(server.url, started.jobId, projectRoot, "completed");
    await expect(readFile(join(projectRoot, ".ao-control-plane", "WF-GATE-APPROVE", "task-002_gate_decision.json"), "utf8"))
      .resolves.toContain("control_plane_manual_gate");
  });

  it("dispatches a waiting manual gate review through the split execution job API", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });
    await seedExecutingWorkflow(projectRoot, "WF-GATE-DISPATCH", createManualGatePlan("WF-GATE-DISPATCH"));

    const startResponse = await fetch(`${server.url}/api/ao/execution-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-GATE-DISPATCH",
        dryRun: true,
        pollIntervalMs: 1
      })
    });
    const started = (await startResponse.json()) as { jobId: string };
    await waitForExecutionJobStatus(server.url, started.jobId, projectRoot, "waiting_manual_gate");

    const dispatchResponse = await fetch(
      `${server.url}/api/ao/execution-jobs/${encodeURIComponent(started.jobId)}/manual-gates/TASK-002/dispatch-review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot,
          rationale: "派发 AO reviewer 复核"
        })
      }
    );
    const dispatched = (await dispatchResponse.json()) as {
      status: string;
      activeTask?: { taskId: string; aoSessionId?: string; status: string };
      logs: Array<{ type: string }>;
    };

    expect(dispatchResponse.status).toBe(200);
    expect(dispatched.status).toBe("running");
    expect(dispatched.activeTask).toMatchObject({
      taskId: "TASK-002",
      status: "working"
    });
    expect(dispatched.activeTask?.aoSessionId).toBeTruthy();
    expect(dispatched.logs.some((event) => event.type === "manual_gate_review_dispatched")).toBe(true);
    await fetch(`${server.url}/api/ao/execution-jobs/${encodeURIComponent(started.jobId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot })
    });
  });

  it("runs the real governance endpoint through injected adapters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => fakeCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    const runResponse = await fetch(`${server.url}/api/governance/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-WEB-REAL",
        title: "User permissions",
        description: "Add role-based permissions.",
        acceptanceCriteria: ["Permissions are enforced"],
        constraints: ["Do not modify AO"],
        maxDesignReviewRounds: 3
      })
    });
    const started = (await runResponse.json()) as { jobId: string; status: string };

    expect(runResponse.status).toBe(202);
    expect(started.status).toBe("running");

    const result = await waitForJob(server.url, started.jobId);
    expect(result.workflow.status).toBe("executing");
    expect(result.design).toContain("# User permissions");
    expect(result.reviews).toHaveLength(1);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.taskPlanPath).toBe(
      join(projectRoot, ".ao-control-plane", "WF-WEB-REAL", "task-plan.json")
    );
    const workflowEntries = await readdir(join(projectRoot, ".ao-control-plane", "WF-WEB-REAL"));
    expect(workflowEntries.filter((entry) => /^design-v\d+\.md$/.test(entry))).toEqual([]);
    await expect(readFile(join(projectRoot, ".ao-control-plane", "WF-WEB-REAL", "design.md"), "utf8")).resolves.toContain(
      "# User permissions"
    );
  });

  it("stops a running governance job", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => slowCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    const runResponse = await fetch(`${server.url}/api/governance/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-WEB-STOP",
        title: "Stop me",
        description: "This workflow should be stopped."
      })
    });
    const started = (await runResponse.json()) as { jobId: string };

    const stopResponse = await fetch(
      `${server.url}/api/governance/jobs/${encodeURIComponent(started.jobId)}/stop`,
      { method: "POST" }
    );
    const stopped = (await stopResponse.json()) as { status: string; currentStep: string };

    expect(stopResponse.status).toBe(200);
    expect(stopped.status).toBe("stopped");
    expect(stopped.currentStep).toBe("已停止");
  });

  it("passes the stop signal into a running task-plan job", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    let planSignal: AbortSignal | undefined;
    const slowPlanCodex: CodexAdapter = {
      createDesign: fakeCodex.createDesign,
      reviseDesign: fakeCodex.reviseDesign,
      async createTaskPlan(_input, options) {
        planSignal = options?.signal;
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Workflow was stopped by user")), {
            once: true
          });
        });
        return createWebPlan("WF-PLAN-STOP");
      },
      reviseTaskPlan: fakeCodex.reviseTaskPlan
    };

    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => slowPlanCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    await seedReadyForPlanningWorkflow(projectRoot, "WF-PLAN-STOP");

    const planResponse = await fetch(`${server.url}/api/governance/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-PLAN-STOP"
      })
    });
    const started = (await planResponse.json()) as { jobId: string; status: string };
    expect(planResponse.status).toBe(202);
    expect(started.status).toBe("running");
    await waitForCondition(() => Boolean(planSignal), "task-plan job did not receive an abort signal");

    const stopResponse = await fetch(
      `${server.url}/api/governance/jobs/${encodeURIComponent(started.jobId)}/stop`,
      { method: "POST" }
    );
    const stopped = (await stopResponse.json()) as { status: string; currentStep: string };

    expect(stopResponse.status).toBe(200);
    expect(stopped.status).toBe("stopped");
    expect(stopped.currentStep).toBe("已停止");
    expect(planSignal?.aborted).toBe(true);
    await expect(
      readFile(join(projectRoot, ".ao-control-plane", "WF-PLAN-STOP", "task-plan.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses injected adapters for standalone task-plan review jobs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    let codexProjectRoot: string | undefined;
    let claudeProjectRoot: string | undefined;
    const planCodex: CodexAdapter = {
      createDesign: fakeCodex.createDesign,
      reviseDesign: fakeCodex.reviseDesign,
      async createTaskPlan(input) {
        return createWebPlan(input.workflowId);
      },
      reviseTaskPlan: fakeCodex.reviseTaskPlan
    };
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: (receivedProjectRoot) => {
        codexProjectRoot = receivedProjectRoot;
        return planCodex;
      },
      createClaudeCodeAdapter: (receivedProjectRoot) => {
        claudeProjectRoot = receivedProjectRoot;
        return fakeClaudeCode;
      }
    });
    await seedReadyForPlanningWorkflow(projectRoot, "WF-PLAN-REAL-ADAPTERS");

    const planResponse = await fetch(`${server.url}/api/governance/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId: "WF-PLAN-REAL-ADAPTERS"
      })
    });
    const started = (await planResponse.json()) as { jobId: string; status: string };
    expect(planResponse.status).toBe(202);
    expect(started.status).toBe("running");

    const planned = await waitForJob(server.url, started.jobId);
    expect(planned.plan.tasks[0]).toMatchObject({
      taskId: "TASK-001",
      title: "Implement permissions"
    });
    expect(codexProjectRoot).toBe(projectRoot);
    expect(claudeProjectRoot).toBe(projectRoot);
  });

  it("logs standalone task-plan review jobs from the next existing review round", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    const workflowId = "WF-PLAN-ROUND-2";
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => fakeCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });
    await seedReadyForPlanningWorkflow(projectRoot, workflowId);
    await writeJson(join(projectRoot, ".ao-control-plane", workflowId, "task-plan-reviews.json"), [
      {
        workflowId,
        round: 1,
        planner: "codex",
        reviewer: "claude-code",
        planVersion: "task-plan-current",
        reviewDecision: "approved",
        findings: [
          {
            id: "TPF-001",
            title: "已处理的历史意见",
            body: "历史意见已处理，不应阻塞续审。",
            severity: "observation",
            status: "addressed"
          }
        ]
      }
    ]);

    const planResponse = await fetch(`${server.url}/api/governance/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        workflowId
      })
    });
    const started = (await planResponse.json()) as { jobId: string; status: string };
    expect(planResponse.status).toBe(202);
    expect(started.status).toBe("running");

    const plannedJob = await waitForCompletedJob(server.url, started.jobId, 2);
    expect(plannedJob.logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex 正在生成任务计划第 2 轮。"),
        expect.stringContaining("ClaudeCode 正在审查任务计划第 2 轮。"),
        expect.stringContaining("ClaudeCode 任务计划第 2 轮结论：approved。")
      ])
    );
    expect(plannedJob.result.workflow.status).toBe("executing");
  });

  it("persists and clears requirement draft form data", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });

    const saveResponse = await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-DRAFT",
        projectRoot: join(tempDir, "project"),
        title: "Draft requirement",
        description: "Persist this form.",
        discussion: "Continue later.",
        acceptanceCriteria: ["Draft restores"],
        constraints: ["Keep workflow id"],
        maxDesignReviewRounds: 5
      })
    });
    expect(saveResponse.status).toBe(200);

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as {
      requirementDraft: {
        workflowId: string;
        title: string;
        acceptanceCriteria: string;
        maxDesignReviewRounds: number;
      };
      requirementDrafts: Array<{ workflowId?: string; title: string }>;
    };
    expect(projects.requirementDraft.workflowId).toBe("WF-DRAFT");
    expect(projects.requirementDraft.title).toBe("Draft requirement");
    expect(projects.requirementDraft.acceptanceCriteria).toBe("Draft restores");
    expect(projects.requirementDraft.maxDesignReviewRounds).toBe(5);
    expect(projects.requirementDrafts).toHaveLength(1);

    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-DRAFT",
        title: "Draft requirement updated",
        description: "Same workflow, latest only.",
        maxDesignReviewRounds: 3
      })
    });
    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-OTHER-DRAFT",
        title: "Other draft",
        description: "A different requirement.",
        maxDesignReviewRounds: 3
      })
    });

    const historyResponse = await fetch(`${server.url}/api/projects`);
    const history = (await historyResponse.json()) as {
      requirementDrafts: Array<{ workflowId?: string; title: string }>;
    };
    expect(history.requirementDrafts).toHaveLength(2);
    expect(history.requirementDrafts.some((draft) => draft.title === "Draft requirement")).toBe(false);
    expect(history.requirementDrafts.some((draft) => draft.title === "Draft requirement updated")).toBe(true);
    expect(history.requirementDrafts.some((draft) => draft.title === "Other draft")).toBe(true);

    const draftToDelete = history.requirementDrafts.find((draft) => draft.workflowId === "WF-DRAFT");
    expect(draftToDelete).toBeTruthy();
    const deleteResponse = await fetch(
      `${server.url}/api/governance/drafts/${encodeURIComponent(`workflow:${draftToDelete?.workflowId}`)}`,
      { method: "DELETE" }
    );
    expect(deleteResponse.status).toBe(200);

    const deletedHistoryResponse = await fetch(`${server.url}/api/projects`);
    const deletedHistory = (await deletedHistoryResponse.json()) as {
      requirementDraft?: { workflowId?: string };
      requirementDrafts: Array<{ workflowId?: string; title: string }>;
    };
    expect(deletedHistory.requirementDraft?.workflowId).toBe("WF-OTHER-DRAFT");
    expect(deletedHistory.requirementDrafts).toHaveLength(1);
    expect(deletedHistory.requirementDrafts[0]?.title).toBe("Other draft");

    const clearResponse = await fetch(`${server.url}/api/governance/draft`, { method: "DELETE" });
    expect(clearResponse.status).toBe(200);

    const clearedResponse = await fetch(`${server.url}/api/projects`);
    const cleared = (await clearedResponse.json()) as {
      requirementDraft?: unknown;
      requirementDrafts: unknown[];
    };
    expect(cleared.requirementDraft).toBeUndefined();
    expect(cleared.requirementDrafts).toHaveLength(1);
  });

  it("uses title as the draft identity before a workflow id exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });

    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Same draft title",
        description: "Initial description.",
        maxDesignReviewRounds: 3
      })
    });
    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Same draft title",
        description: "Updated description should replace the same draft.",
        maxDesignReviewRounds: 3
      })
    });

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as {
      requirementDrafts: Array<{ draftKey?: string; description: string }>;
    };

    expect(projects.requirementDrafts).toHaveLength(1);
    expect(projects.requirementDrafts[0]?.draftKey).toBe("draft:same draft title");
    expect(projects.requirementDrafts[0]?.description).toBe("Updated description should replace the same draft.");
  });

  it("merges the title draft into the generated workflow draft", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => fakeCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        title: "Generated merge draft",
        description: "This title draft should be replaced by workflow identity.",
        maxDesignReviewRounds: 3
      })
    });
    const runResponse = await fetch(`${server.url}/api/governance/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        title: "Generated merge draft",
        description: "This title draft should be replaced by workflow identity.",
        maxDesignReviewRounds: 3
      })
    });
    const started = (await runResponse.json()) as { jobId: string };
    const result = await waitForJob(server.url, started.jobId);

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as {
      requirementDrafts: Array<{ workflowId?: string; draftKey?: string }>;
    };

    expect(projects.requirementDrafts).toHaveLength(1);
    expect(projects.requirementDrafts[0]?.workflowId).toBe(result.workflow.workflowId);
    expect(projects.requirementDrafts[0]?.draftKey).toBe(`workflow:${result.workflow.workflowId}`);
  });

  it("binds generated workflow artifacts to requirement history and deletes them with the draft", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir,
      createCodexAdapter: () => fakeCodex,
      createClaudeCodeAdapter: () => fakeClaudeCode
    });

    const runResponse = await fetch(`${server.url}/api/governance/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        title: "Generated workflow draft",
        description: "Generate without manually supplying a workflow id.",
        maxDesignReviewRounds: 3
      })
    });
    const started = (await runResponse.json()) as { jobId: string; status: string };
    expect(runResponse.status).toBe(202);
    expect(started.status).toBe("running");

    const result = await waitForJob(server.url, started.jobId);
    const workflowId = result.workflow.workflowId;
    const workflowDir = join(projectRoot, ".ao-control-plane", workflowId);
    await expect(stat(workflowDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as {
      requirementDraft?: { workflowId?: string; draftKey?: string };
      requirementDrafts: Array<{ workflowId?: string; draftKey?: string; title: string }>;
    };
    expect(projects.requirementDraft?.workflowId).toBe(workflowId);
    expect(projects.requirementDrafts).toHaveLength(1);
    expect(projects.requirementDrafts[0]?.workflowId).toBe(workflowId);

    const otherWorkflowDir = join(projectRoot, ".ao-control-plane", "WF-OTHER");
    await mkdir(otherWorkflowDir, { recursive: true });

    const deleteResponse = await fetch(
      `${server.url}/api/governance/drafts/${encodeURIComponent(projects.requirementDrafts[0]?.draftKey ?? "")}`,
      { method: "DELETE" }
    );
    const deleted = (await deleteResponse.json()) as { requirementDrafts: unknown[] };
    expect(deleteResponse.status).toBe(200);
    expect(deleted.requirementDrafts).toHaveLength(0);
    await expect(stat(workflowDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(otherWorkflowDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("deletes artifacts from the selected project root when old drafts do not store projectRoot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });

    await fetch(`${server.url}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot })
    });
    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-OLD-DRAFT",
        title: "Old draft",
        description: "Saved before projectRoot was bound.",
        maxDesignReviewRounds: 3
      })
    });
    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "WF-NEXT-DRAFT",
        title: "Next draft",
        description: "This draft should be selected after deletion.",
        maxDesignReviewRounds: 3
      })
    });

    const workflowDir = join(projectRoot, ".ao-control-plane", "WF-OLD-DRAFT");
    await mkdir(workflowDir, { recursive: true });

    const deleteResponse = await fetch(
      `${server.url}/api/governance/drafts/${encodeURIComponent("workflow:WF-OLD-DRAFT")}`,
      { method: "DELETE" }
    );
    const deleted = (await deleteResponse.json()) as {
      requirementDraft?: { workflowId?: string; title?: string };
      requirementDrafts: Array<{ workflowId?: string }>;
    };

    expect(deleteResponse.status).toBe(200);
    expect(deleted.requirementDraft?.workflowId).toBe("WF-NEXT-DRAFT");
    expect(deleted.requirementDrafts).toHaveLength(1);
    await expect(stat(workflowDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes matching workflow artifacts for legacy drafts without workflowId", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
    });

    await fetch(`${server.url}/api/projects/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot })
    });
    await fetch(`${server.url}/api/governance/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        title: "Legacy draft",
        description: "This legacy draft only has content identity and no workflow id.",
        discussion: "The generated workflow should still be removed.",
        maxDesignReviewRounds: 3
      })
    });

    const workflowDir = join(projectRoot, ".ao-control-plane", "WF-LEGACY-CONTENT");
    await mkdir(workflowDir, { recursive: true });
    await writeJson(join(workflowDir, "requirement.json"), {
      id: "WF-LEGACY-CONTENT",
      title: "Legacy draft updated title",
      source: "web",
      description: [
        "This legacy draft only has content identity and no workflow id.",
        "",
        "讨论记录：",
        "The generated workflow should still be removed."
      ].join("\n")
    });

    const projectsResponse = await fetch(`${server.url}/api/projects`);
    const projects = (await projectsResponse.json()) as {
      requirementDrafts: Array<{ draftKey?: string }>;
    };

    const deleteResponse = await fetch(
      `${server.url}/api/governance/drafts/${encodeURIComponent(projects.requirementDrafts[0]?.draftKey ?? "")}`,
      { method: "DELETE" }
    );

    expect(deleteResponse.status).toBe(200);
    await expect(stat(workflowDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects public host binding unless explicitly allowed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));

    await expect(
      startWebServer({
        host: "0.0.0.0",
        port: 0,
        artifactRoot: tempDir
      })
    ).rejects.toThrow("Refusing to bind the web console to a public host");
  });

  it("renders a deferred implementation completion message in the web UI", () => {
    const html = renderIndexHtml();

    expect(html).toContain("设计已达到可实施标准，部分问题将进入实施阶段处理。");
  });

  it("renders execution controls for continuous execution and structured manual gate release", () => {
    const html = renderIndexHtml();

    expect(html).toContain('id="executeButton"');
    expect(html).toContain('id="retryExecutionTaskButton"');
    expect(html).toContain('id="markExecutionTaskCompletedButton"');
    expect(html).toContain('id="requestExecutionRevisionButton"');
    expect(html).toContain('id="releaseManualGateButton"');
    expect(html).toContain('id="dispatchManualGateReviewButton"');
    expect(html).toContain('id="replanManualGateButton"');
    expect(html).toContain('id="blockManualGateButton"');
    expect(html).toContain("启动连续执行");
    expect(html).toContain("重试任务");
    expect(html).toContain("人工标记完成");
    expect(html).toContain("提交重规划请求");
    expect(html).toContain("门禁放行");
    expect(html).toContain("派发门禁复核");
    expect(html).toContain("门禁要求重规划");
    expect(html).toContain("门禁标记阻断");
    expect(html).toContain("dryRun: false");
    expect(html).toContain("/api/ao/execution-jobs");
    expect(html).toContain("即将启动连续执行");
    expect(html).toContain("连续执行已启动");
    expect(html).toContain("连续执行状态：");
    expect(html).toContain("当前任务：");
    expect(html).toContain("AO session：");
    expect(html).toContain("已中断，需要人工处理");
    expect(html).toContain("submitExecutionRecovery");
    expect(html).toContain("/retry");
    expect(html).toContain("/mark-completed");
    expect(html).toContain("/revision-requests");
    expect(html).toContain("getRecoverableExecutionTaskId");
    expect(html).toContain("getExecutionRecoveryButtonTitle");
    expect(html).toContain("loadExecutionSnapshot");
    expect(html).toContain("manual_gate 等待时，人工批准门禁并继续执行。");
    expect(html).toContain("manual_gate 等待时，派发 AO reviewer 复核上下文产物。");
    expect(html).toContain("taskPlanApprovalReport");
    expect(html).toContain("approveManualGate");
    expect(html).toContain("dispatchManualGateReview");
    expect(html).toContain('submitManualGateDecision("requires_replan"');
    expect(html).toContain('submitManualGateDecision("blocked"');
    expect(html).toContain("Web UI 门禁放行");
    expect(html).toContain("Web UI 派发门禁复核");
    expect(html).toContain("门禁上下文：");
    expect(html).toContain("Web UI 门禁要求重规划");
    expect(html).toContain("Web UI 门禁标记阻断");
    expect(html).toContain("审批状态：");
    expect(html).toContain("归一化状态：");
    expect(html).toContain("归一化变更：");
    expect(html).toContain("丢弃条目：");
    expect(html).toContain("归一化报告：");
    expect(html).toContain("损坏报告：");
    expect(html).toContain("formatNormalizationReportErrors");
    expect(html).toContain("critical \" + critical + \" / warning \" + warning");
    expect(html).toContain("损坏报告明细：");
    expect(html).toContain("- round \" + group.round + \"：\" + group.errors.length + \" 个");
    expect(html).toContain("formatNormalizationReportErrorDetail");
    expect(html).toContain("\" / details \" + error.details");
    expect(html).toContain("formatNormalizationReportErrorDetailFields");
    expect(html).toContain("getNormalizationErrorSeverityRank");
    expect(html).toContain("compareNormalizationReportErrors");
    expect(html).toContain("String(leftIssue.code || \"\").localeCompare");
    expect(html).toContain("String(leftIssue.path || left.path || \"\").localeCompare");
    expect(html).toContain("\" / fields \" + fields.join");
    expect(html).toContain("来源演化：");
    expect(html).toContain("- \" + entry.source + \" / round \" + entry.round + \" / \" + entry.reason");
    expect(html).toContain("formatTaskPlanNormalizationSummary");
    expect(html).toContain("function getActivePlan()");
    expect(html).toContain("任务计划草稿：尚未通过最终审查或仲裁。");
    expect(html).toContain("（草稿）");
    expect(html).toContain("未知（\" + String(outcome || \"未记录\") + \"）");
    expect(html).toContain("可实施状态：");
    expect(html).toContain("覆盖缺口：");
    expect(html).toContain("待处理 finding：");
    expect(html).toContain('state.execution?.status === "waiting_manual_gate"');
    expect(html).not.toContain('id="dryRunToggle"');
    expect(html).not.toContain("预演模式");
    expect(html).not.toContain('task.reason === "manual_gate requires human approval before dispatch"');
  });
});

const fakeCodex: CodexAdapter = {
  async createDesign() {
    return [
      "# User permissions",
      "",
      "## 背景与问题定义",
      "Add role-based permissions.",
      "",
      "## 目标与非目标",
      "Enforce permissions.",
      "",
      "## 影响范围",
      "Backend.",
      "",
      "## 方案概述",
      "Use existing middleware.",
      "",
      "## 接口、数据或关键契约变化",
      "No response shape change.",
      "",
      "## 任务拆解前置约束",
      "Use AO roles only.",
      "",
      "## 风险、回滚方案和替代方案",
      "Revert middleware changes.",
      "",
      "## 可测试性自评",
      "Add permission tests."
    ].join("\n");
  },
  async reviseDesign() {
    throw new Error("should not revise approved design");
  },
  async createTaskPlan(input): Promise<TaskPlan> {
    return createWebPlan(input.workflowId);
  },
  async reviseTaskPlan() {
    throw new Error("should not revise approved task plan");
  }
};

async function waitForJob(url: string, jobId: string) {
  const job = await waitForCompletedJob(url, jobId);
  return job.result;
}

async function waitForExecutionJobStatus(
  url: string,
  jobId: string,
  projectRoot: string,
  expectedStatus: string
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(
      `${url}/api/ao/execution-jobs/${encodeURIComponent(jobId)}?projectRoot=${encodeURIComponent(projectRoot)}`
    );
    const job = (await response.json()) as {
      status: string;
      currentTaskId: string | null;
      summary: { completed: number };
      tasks?: Array<{ status: string }>;
      logs: Array<{ type: string }>;
      failure?: { message: string };
      manualGateContext?: { taskId: string };
    };
    if (job.status === expectedStatus) {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.failure?.message ?? "execution job failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`execution job did not reach ${expectedStatus}`);
}

async function waitForCompletedJob(url: string, jobId: string, expectedTaskPlanReviews = 1) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/api/governance/jobs/${encodeURIComponent(jobId)}`);
    const job = (await response.json()) as {
      status: string;
      design?: unknown;
      reviews: unknown[];
      taskPlanReviews: unknown[];
      result?: {
        workflow: { workflowId: string; status: string };
        design: string;
        reviews: unknown[];
        taskPlanReviews: unknown[];
        plan: { tasks: unknown[] };
        taskPlanPath: string;
      };
      error?: string;
      logs: string[];
    };
    if (job.status === "completed" && job.result) {
      expect(job.design).toBeTruthy();
      expect(job.reviews).toHaveLength(1);
      expect(job.taskPlanReviews).toHaveLength(expectedTaskPlanReviews);
      return { ...job, result: job.result };
    }
    if (job.status === "failed") {
      throw new Error(job.error ?? "job failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not complete");
}

const fakeClaudeCode: ClaudeCodeAdapter = {
  async reviewDesign(input): Promise<DesignReview> {
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
  async reviewTaskPlan(input): Promise<TaskPlanReview> {
    return {
      workflowId: input.workflowId,
      round: input.round,
      planner: "codex",
      reviewer: "claude-code",
      planVersion: input.planVersion,
      reviewDecision: "approved",
      findings: []
    };
  }
};

const slowCodex: CodexAdapter = {
  async createDesign(_requirement, options) {
    await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return "# never";
  },
  async reviseDesign() {
    return "# never";
  },
  async createTaskPlan() {
    throw new Error("should not plan stopped workflow");
  },
  async reviseTaskPlan() {
    throw new Error("should not revise task plan for stopped workflow");
  }
};

function createWebPlan(workflowId: string): TaskPlan {
  return {
    workflowId,
    title: "Plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Implement permissions",
        description: "Implement role-based permissions.",
        type: "implementation",
        dependencies: [],
        dependencyCondition: "all_completed",
        aoRole: "backend-senior",
        acceptanceCriteria: ["Permissions are enforced"],
        aoPrompt:
          `[${workflowId} / TASK-001]\n任务名称：Implement permissions\nAO 角色：backend-senior\n验收标准：\n1. Permissions are enforced\n上下文摘要：Use existing middleware.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending"
      }
    ]
  };
}

function createManualGatePlan(workflowId: string): TaskPlan {
  return {
    workflowId,
    title: "Manual gate plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Completed prerequisite",
        description: "Completed prerequisite.",
        type: "implementation",
        dependencies: [],
        dependencyCondition: "all_completed",
        aoRole: "backend-senior",
        acceptanceCriteria: ["Prerequisite completed"],
        aoPrompt: `[${workflowId} / TASK-001]\n任务名称：Completed prerequisite\nAO 角色：backend-senior\n验收标准：\n1. Prerequisite completed\n上下文摘要：Manual gate test.`,
        executionPolicy: defaultExecutionPolicy,
        status: "completed"
      },
      {
        taskId: "TASK-002",
        workflowId,
        title: "Manual gate verification",
        description: "Manual gate verification.",
        type: "verification",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        aoRole: "qa",
        acceptanceCriteria: ["Manual gate released"],
        aoPrompt: `[${workflowId} / TASK-002]\n任务名称：Manual gate verification\nAO 角色：qa\n验收标准：\n1. Manual gate released\n上下文摘要：Manual gate test.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending"
      }
    ]
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function seedReadyForPlanningWorkflow(projectRoot: string, workflowId: string): Promise<void> {
  const workflowDir = join(projectRoot, ".ao-control-plane", workflowId);
  await mkdir(workflowDir, { recursive: true });
  await writeJson(join(workflowDir, "requirement.json"), {
    id: workflowId,
    title: "Plan stop",
    source: "test",
    description: "Stop task-plan review.",
    acceptanceCriteria: [],
    constraints: []
  });
  await writeJson(join(workflowDir, "workflow.json"), {
    workflowId,
    title: "Plan stop",
    rawRequirement: "Stop task-plan review.",
    status: "ready_for_planning",
    designRounds: 1,
    maxDesignReviewRounds: 3,
    approvedDesignVersion: "design-current",
    tasks: []
  });
  await writeFile(join(workflowDir, "design.md"), "# Plan stop\n\n## 背景与问题定义\nStop task-plan review.", "utf8");
  await writeJson(join(workflowDir, "reviews.json"), [
    {
      workflowId,
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-current",
      reviewDecision: "approved",
      findings: []
    }
  ]);
}

async function seedExecutingWorkflow(projectRoot: string, workflowId: string, plan: TaskPlan): Promise<void> {
  const workflowDir = join(projectRoot, ".ao-control-plane", workflowId);
  await mkdir(workflowDir, { recursive: true });
  await writeJson(join(workflowDir, "requirement.json"), {
    id: workflowId,
    title: "Manual gate",
    source: "test",
    description: "Manual gate execution.",
    acceptanceCriteria: [],
    constraints: []
  });
  await writeJson(join(workflowDir, "workflow.json"), {
    workflowId,
    title: "Manual gate",
    rawRequirement: "Manual gate execution.",
    status: "executing",
    designRounds: 1,
    maxDesignReviewRounds: 3,
    approvedDesignVersion: "design-current",
    tasks: plan.tasks.map((task) => task.taskId)
  });
  await writeFile(join(workflowDir, "design.md"), "# Manual gate\n\n## 背景与问题定义\nManual gate execution.", "utf8");
  await writeJson(join(workflowDir, "reviews.json"), [
    {
      workflowId,
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-current",
      reviewDecision: "approved",
      findings: []
    }
  ]);
  await writeJson(join(workflowDir, "task-plan.json"), plan);
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
