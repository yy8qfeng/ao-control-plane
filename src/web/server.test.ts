import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { startWebServer } from "./server.js";

let tempDir: string | undefined;
let server: Awaited<ReturnType<typeof startWebServer>> | undefined;

describe("web server", () => {
  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("runs governance and dry-runs execution through HTTP APIs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-web-"));
    const projectRoot = join(tempDir, "project");
    await mkdir(projectRoot);
    server = await startWebServer({
      port: 0,
      artifactRoot: tempDir
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
    const planned = (await planResponse.json()) as {
      workflow: { workflowId: string; status: string };
      plan: { tasks: unknown[] };
    };

    expect(planResponse.status).toBe(200);
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
    await expect(
      readFile(join(projectRoot, ".ao-control-plane", "WF-WEB-REAL", "design-v1.md"), "utf8")
    ).resolves.toContain("# User permissions");
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
  }
};

async function waitForJob(url: string, jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/api/governance/jobs/${encodeURIComponent(jobId)}`);
    const job = (await response.json()) as {
      status: string;
      designs: unknown[];
      reviews: unknown[];
      result?: {
        workflow: { workflowId: string; status: string };
        design: string;
        reviews: unknown[];
        plan: { tasks: unknown[] };
        taskPlanPath: string;
      };
      error?: string;
    };
    expect(job.designs.length).toBeGreaterThanOrEqual(0);
    if (job.status === "completed" && job.result) {
      expect(job.designs).toHaveLength(1);
      expect(job.reviews).toHaveLength(1);
      return job.result;
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
  async createTaskPlan(input): Promise<TaskPlan> {
    return {
      workflowId: input.workflowId,
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: input.workflowId,
          title: "Implement permissions",
          description: "Implement role-based permissions.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Permissions are enforced"],
          aoPrompt:
            "[WF-WEB-REAL / TASK-001]\n任务名称：Implement permissions\nAO 角色：backend-senior\n验收标准：\n1. Permissions are enforced\n上下文摘要：Use existing middleware.",
          status: "pending"
        }
      ]
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
  }
};
