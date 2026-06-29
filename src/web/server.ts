import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AoCliAdapter } from "../adapters/ao.js";
import { ClaudeCodeCliAdapter, StructuredOutputError } from "../adapters/claude-code.js";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexCliAdapter } from "../adapters/codex.js";
import type { CodexAdapter } from "../adapters/codex.js";
import { executePlan } from "../workflow/plan-execution.js";
import { runWorkflow } from "../workflow/run-workflow.js";
import { ArtifactStore } from "./artifact-store.js";
import { browseDirectories } from "./filesystem-browser.js";
import { ProjectConfigStore } from "./project-config.js";
import { renderIndexHtml } from "./ui.js";
import {
  createTaskPlanStage,
  runDesignReviewStage,
  type GovernanceRequest
} from "./governance-runner.js";
import { buildRequirementDescription } from "./request-formatting.js";
import { WorkflowJobStore } from "./workflow-jobs.js";

export interface WebServerOptions {
  host?: string;
  port: number;
  artifactRoot: string;
  aoProjectRoot?: string;
  allowPublicHost?: boolean;
  createCodexAdapter?: (projectRoot?: string) => CodexAdapter;
  createClaudeCodeAdapter?: (projectRoot?: string) => ClaudeCodeAdapter;
}

export async function startWebServer(options: WebServerOptions): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const host = options.host ?? "127.0.0.1";
  assertSafeHost(host, options.allowPublicHost ?? false);
  const defaultArtifactRoot = resolve(options.artifactRoot);
  const projectConfig = new ProjectConfigStore(join(defaultArtifactRoot, "project-config.json"));
  const workflowJobs = new WorkflowJobStore();
  await mkdir(defaultArtifactRoot, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      await routeRequest({
        request,
        response,
        defaultArtifactRoot,
        projectConfig,
        workflowJobs,
        aoProjectRoot: options.aoProjectRoot,
        createCodexAdapter: options.createCodexAdapter,
        createClaudeCodeAdapter: options.createClaudeCodeAdapter
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, host, resolveListen);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;

  return {
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      })
  };
}

async function routeRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  defaultArtifactRoot: string;
  projectConfig: ProjectConfigStore;
  workflowJobs: WorkflowJobStore;
  aoProjectRoot?: string;
  createCodexAdapter?: (projectRoot?: string) => CodexAdapter;
  createClaudeCodeAdapter?: (projectRoot?: string) => ClaudeCodeAdapter;
}): Promise<void> {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    sendHtml(input.response, renderIndexHtml());
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(input.response, 200, await input.projectConfig.read());
    return;
  }

  if (method === "GET" && url.pathname === "/api/filesystem/browse") {
    sendJson(input.response, 200, await browseDirectories(url.searchParams.get("path") ?? undefined));
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/api/governance/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.replace("/api/governance/jobs/", ""));
    const job = input.workflowJobs.getJob(jobId);
    if (!job) {
      sendJson(input.response, 404, { error: "job not found" });
      return;
    }
    sendJson(input.response, 200, job);
    return;
  }

  if (method === "POST" && url.pathname.match(/^\/api\/governance\/jobs\/[^/]+\/stop$/)) {
    const jobId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
    const job = input.workflowJobs.stopJob(jobId);
    if (!job) {
      sendJson(input.response, 404, { error: "job not found" });
      return;
    }
    sendJson(input.response, 200, job);
    return;
  }

  if (method === "POST" && url.pathname === "/api/projects/select") {
    const body = (await readJsonBody(input.request)) as ProjectScopedRequest;
    if (!body.projectRoot?.trim()) {
      sendJson(input.response, 400, { error: "projectRoot is required" });
      return;
    }

    sendJson(input.response, 200, await input.projectConfig.rememberProjectRoot(body.projectRoot));
    return;
  }

  if (method === "POST" && url.pathname === "/api/governance/design-review") {
    const body = (await readJsonBody(input.request)) as GovernanceRequest & ProjectScopedRequest;
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const result = await runDesignReviewStage({
      request: normalizeGovernanceRequest(body),
      store: createRequestStore(body, input.defaultArtifactRoot)
    });
    sendJson(input.response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/governance/plan") {
    const body = (await readJsonBody(input.request)) as { workflowId?: string } & ProjectScopedRequest;
    if (!body.workflowId) {
      sendJson(input.response, 400, { error: "workflowId is required" });
      return;
    }
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const result = await createTaskPlanStage({
      workflowId: body.workflowId,
      store: createRequestStore(body, input.defaultArtifactRoot)
    });
    sendJson(input.response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/governance/run") {
    const body = (await readJsonBody(input.request)) as GovernanceRequest & ProjectScopedRequest;
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const job = input.workflowJobs.createJob();
    void runRealGovernanceWorkflow({
        request: normalizeGovernanceRequest(body),
        defaultArtifactRoot: input.defaultArtifactRoot,
        projectRoot: resolveProjectRoot(body, input.aoProjectRoot),
        createCodexAdapter: input.createCodexAdapter,
        createClaudeCodeAdapter: input.createClaudeCodeAdapter,
        onEvent: (event) => {
          input.workflowJobs.recordEvent(job.snapshot.jobId, event);
        },
        signal: job.controller.signal
      }).catch((error: unknown) => {
        input.workflowJobs.failJob(job.snapshot.jobId, error);
        if (error instanceof StructuredOutputError) {
          input.workflowJobs.recordEvent(job.snapshot.jobId, {
            type: "workflow_failed",
            message:
              "ClaudeCode output is not valid JSON or does not match the schema. Human review artifacts were written."
          });
        }
      });
    sendJson(input.response, 202, job.snapshot);
    return;
  }

  if (method === "POST" && url.pathname === "/api/ao/execute") {
    const body = (await readJsonBody(input.request)) as {
      workflowId?: string;
      dryRun?: boolean;
    } & ProjectScopedRequest;
    if (!body.workflowId) {
      sendJson(input.response, 400, { error: "workflowId is required" });
      return;
    }
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const store = createRequestStore(body, input.defaultArtifactRoot);
    const projectRoot = resolveProjectRoot(body, input.aoProjectRoot);
    const plan = await store.readTaskPlan(body.workflowId);
    const result = await executePlan({
      plan,
      ao: new AoCliAdapter({
        projectRoot,
        dryRun: body.dryRun ?? true
      })
    });
    sendJson(input.response, 200, result);
    return;
  }

  sendJson(input.response, 404, { error: "Not found" });
}

interface ProjectScopedRequest {
  projectRoot?: string;
}

function normalizeGovernanceRequest(request: GovernanceRequest): GovernanceRequest {
  return {
    ...request,
    acceptanceCriteria: normalizeLines(request.acceptanceCriteria),
    constraints: normalizeLines(request.constraints)
  };
}

function createRequestStore(
  request: ProjectScopedRequest,
  defaultArtifactRoot: string
): ArtifactStore {
  return new ArtifactStore(resolveArtifactRoot(request, defaultArtifactRoot));
}

function resolveArtifactRoot(request: ProjectScopedRequest, defaultArtifactRoot: string): string {
  const projectRoot = request.projectRoot?.trim();
  return projectRoot ? join(resolve(projectRoot), ".ao-control-plane") : defaultArtifactRoot;
}

function resolveProjectRoot(
  request: ProjectScopedRequest,
  fallbackProjectRoot: string | undefined
): string | undefined {
  const projectRoot = request.projectRoot?.trim();
  return projectRoot ? resolve(projectRoot) : fallbackProjectRoot;
}

async function rememberProjectRootIfPresent(
  request: ProjectScopedRequest,
  projectConfig: ProjectConfigStore
): Promise<void> {
  if (request.projectRoot?.trim()) {
    await projectConfig.rememberProjectRoot(request.projectRoot);
  }
}

function normalizeLines(value: string[] | undefined): string[] {
  return value?.map((item) => item.trim()).filter(Boolean) ?? [];
}

async function runRealGovernanceWorkflow(input: {
  request: GovernanceRequest;
  defaultArtifactRoot: string;
  projectRoot?: string;
  createCodexAdapter?: (projectRoot?: string) => CodexAdapter;
  createClaudeCodeAdapter?: (projectRoot?: string) => ClaudeCodeAdapter;
  onEvent?: Parameters<typeof runWorkflow>[0]["onEvent"];
  signal?: AbortSignal;
}) {
  const artifactRoot = resolveArtifactRoot(
    { projectRoot: input.projectRoot },
    input.defaultArtifactRoot
  );
  await mkdir(artifactRoot, { recursive: true });
  const requirementFile = join(artifactRoot, "web-requirement-input.json");
  await writeFile(
    requirementFile,
    `${JSON.stringify(toRequirementInput(input.request), null, 2)}\n`,
    "utf8"
  );

  return runWorkflow({
    requirementFile,
    artifactRoot,
    codex: input.createCodexAdapter?.(input.projectRoot) ?? new CodexCliAdapter({ projectRoot: input.projectRoot }),
    claudeCode:
      input.createClaudeCodeAdapter?.(input.projectRoot) ??
      new ClaudeCodeCliAdapter({ projectRoot: input.projectRoot }),
    onEvent: input.onEvent,
    signal: input.signal
  });
}

function toRequirementInput(request: GovernanceRequest): Record<string, unknown> {
  return {
    id: request.workflowId?.trim() || undefined,
    title: request.title.trim(),
    source: "web",
    description: buildRequirementDescription(request),
    acceptanceCriteria: request.acceptanceCriteria ?? [],
    constraints: request.constraints ?? [],
    maxDesignReviewRounds: request.maxDesignReviewRounds ?? 3
  };
}

function assertSafeHost(host: string, allowPublicHost: boolean): void {
  const normalized = host.trim().toLowerCase();
  const publicHosts = new Set(["0.0.0.0", "::", "[::]"]);
  if (!allowPublicHost && publicHosts.has(normalized)) {
    throw new Error("Refusing to bind the web console to a public host without --allow-public-host");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}
