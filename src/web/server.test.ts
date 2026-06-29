import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
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
});
