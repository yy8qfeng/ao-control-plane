import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AoCliAdapter } from "../adapters/ao.js";
import { executePlan } from "../workflow/plan-execution.js";
import { ArtifactStore } from "./artifact-store.js";
import { browseDirectories } from "./filesystem-browser.js";
import { ProjectConfigStore } from "./project-config.js";
import { renderIndexHtml } from "./ui.js";
import {
  createTaskPlanStage,
  runDesignReviewStage,
  runGovernanceWorkflow,
  type GovernanceRequest
} from "./governance-runner.js";

export interface WebServerOptions {
  host?: string;
  port: number;
  artifactRoot: string;
  aoProjectRoot?: string;
}

export async function startWebServer(options: WebServerOptions): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const host = options.host ?? "127.0.0.1";
  const defaultArtifactRoot = resolve(options.artifactRoot);
  const projectConfig = new ProjectConfigStore(join(defaultArtifactRoot, "project-config.json"));
  await mkdir(defaultArtifactRoot, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      await routeRequest({
        request,
        response,
        defaultArtifactRoot,
        projectConfig,
        aoProjectRoot: options.aoProjectRoot
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
  aoProjectRoot?: string;
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
    const result = await runGovernanceWorkflow({
      request: normalizeGovernanceRequest(body),
      store: createRequestStore(body, input.defaultArtifactRoot)
    });
    sendJson(input.response, 200, result);
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
