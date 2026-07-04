import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AoCliAdapter } from "../adapters/ao.js";
import { ClaudeCodeCliAdapter, StructuredOutputError } from "../adapters/claude-code.js";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexCliAdapter } from "../adapters/codex.js";
import type { CodexAdapter } from "../adapters/codex.js";
import { executePlan, type ManualGateRelease } from "../workflow/plan-execution.js";
import { runWorkflow } from "../workflow/run-workflow.js";
import { ArtifactStore } from "./artifact-store.js";
import { browseDirectories } from "./filesystem-browser.js";
import { ProjectConfigStore, type RequirementDraft } from "./project-config.js";
import { renderIndexHtml } from "./ui.js";
import {
  createTaskPlanStage,
  runDesignReviewStage,
  type TaskPlanStageEvent,
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

  if (method === "GET" && url.pathname.startsWith("/api/governance/workflows/")) {
    const workflowId = decodeURIComponent(url.pathname.replace("/api/governance/workflows/", ""));
    if (!workflowId.trim()) {
      sendJson(input.response, 400, { error: "workflowId is required" });
      return;
    }
    const projectRoot = url.searchParams.get("projectRoot") ?? undefined;
    const store = createRequestStore({ projectRoot }, input.defaultArtifactRoot);
    const artifacts = await store.readWorkflow(workflowId);
    sendJson(input.response, 200, {
      ...artifacts,
      artifactDir: store.getWorkflowDir(workflowId)
    });
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

  if (method === "POST" && url.pathname === "/api/governance/draft") {
    const body = (await readJsonBody(input.request)) as GovernanceRequest & ProjectScopedRequest;
    sendJson(input.response, 200, await input.projectConfig.saveRequirementDraft(toRequirementDraft(body)));
    return;
  }

  if (method === "DELETE" && url.pathname === "/api/governance/draft") {
    sendJson(input.response, 200, await input.projectConfig.clearRequirementDraft());
    return;
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/governance/drafts/")) {
    const draftKey = decodeURIComponent(url.pathname.replace("/api/governance/drafts/", ""));
    if (!draftKey.trim()) {
      sendJson(input.response, 400, { error: "draftKey is required" });
      return;
    }
    const deletion = await input.projectConfig.deleteRequirementDraft(draftKey);
    await deleteDraftArtifacts(
      deletion.deletedDraft,
      deletion.config.selectedProjectRoot,
      input.defaultArtifactRoot
    );
    sendJson(input.response, 200, deletion.config);
    return;
  }

  if (method === "POST" && url.pathname === "/api/governance/design-review") {
    const body = (await readJsonBody(input.request)) as GovernanceRequest & ProjectScopedRequest;
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const result = await runDesignReviewStage({
      request: normalizeGovernanceRequest(body),
      store: createRequestStore(body, input.defaultArtifactRoot)
    });
    await input.projectConfig.saveRequirementDraft(
      toRequirementDraft({ ...body, workflowId: result.workflow.workflowId })
    );
    sendJson(input.response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/governance/plan") {
    const body = (await readJsonBody(input.request)) as { workflowId?: string; maxDesignReviewRounds?: number } & ProjectScopedRequest;
    if (!body.workflowId) {
      sendJson(input.response, 400, { error: "workflowId is required" });
      return;
    }
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const job = input.workflowJobs.createJob({
      currentStep: "准备继续审查任务计划",
      logs: ["已创建任务计划续审任务，准备调用 Codex 和 ClaudeCode。"]
    });
    void createTaskPlanStage({
        workflowId: body.workflowId,
        store: createRequestStore(body, input.defaultArtifactRoot),
        maxTaskPlanReviewRounds: normalizeReviewRoundLimit(body.maxDesignReviewRounds),
        codex: createCodexAdapterForRequest(input.createCodexAdapter, body, input.aoProjectRoot),
        claudeCode: createClaudeCodeAdapterForRequest(input.createClaudeCodeAdapter, body, input.aoProjectRoot),
        onEvent: (event) => recordTaskPlanStageEvent(input.workflowJobs, job.snapshot.jobId, event),
        signal: job.controller.signal
      }).then((result) => {
        input.workflowJobs.recordLog(job.snapshot.jobId, {
          currentStep: "任务计划续审已完成",
          message: `任务计划续审已完成，产物目录：${result.artifactDir}`
        });
        input.workflowJobs.completeGovernanceResult(job.snapshot.jobId, result);
      }).catch((error: unknown) => {
        input.workflowJobs.failJob(job.snapshot.jobId, error);
      });
    sendJson(input.response, 202, job.snapshot);
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
        onEvent: async (event) => {
          input.workflowJobs.recordEvent(job.snapshot.jobId, event);
          if (event.type === "workflow_started") {
            await input.projectConfig.saveRequirementDraft(
              toRequirementDraft({ ...body, workflowId: event.workflow.workflowId })
            );
          }
        },
        signal: job.controller.signal
      }).catch((error: unknown) => {
        if (error instanceof StructuredOutputError) {
          input.workflowJobs.recordEvent(job.snapshot.jobId, {
            type: "workflow_failed",
            message: `${error.message}. Human review artifacts were written.`
          });
          return;
        }

        input.workflowJobs.failJob(job.snapshot.jobId, error);
      }).then(async (result) => {
        if (!result) {
          return;
        }
        await input.projectConfig.saveRequirementDraft(
          toRequirementDraft({ ...body, workflowId: result.workflow.workflowId })
        );
      }).catch((error: unknown) => {
        input.workflowJobs.failJob(job.snapshot.jobId, error);
      });
    sendJson(input.response, 202, job.snapshot);
    return;
  }

  if (method === "POST" && url.pathname === "/api/ao/execute") {
    const body = (await readJsonBody(input.request)) as {
      workflowId?: string;
      dryRun?: boolean;
      releasedManualGateTaskIds?: Array<string | ManualGateRelease>;
    } & ProjectScopedRequest;
    if (!body.workflowId) {
      sendJson(input.response, 400, { error: "workflowId is required" });
      return;
    }
    await rememberProjectRootIfPresent(body, input.projectConfig);
    const store = createRequestStore(body, input.defaultArtifactRoot);
    const projectRoot = resolveProjectRoot(body, input.aoProjectRoot);
    const plan = await store.readTaskPlan(body.workflowId);
    const releasedManualGateTaskIds = normalizeReleasedManualGateTaskIds(
      body.releasedManualGateTaskIds,
      plan
    );
    if (releasedManualGateTaskIds instanceof Error) {
      sendJson(input.response, 400, { error: releasedManualGateTaskIds.message });
      return;
    }
    const result = await executePlan({
      plan,
      ao: new AoCliAdapter({
        projectRoot,
        dryRun: body.dryRun ?? true
      }),
      releasedManualGateTaskIds
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

function normalizeReviewRoundLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.min(20, Math.max(1, Math.trunc(numeric)));
}

function createRequestStore(
  request: ProjectScopedRequest,
  defaultArtifactRoot: string
): ArtifactStore {
  return new ArtifactStore(resolveArtifactRoot(request, defaultArtifactRoot));
}

function recordTaskPlanStageEvent(
  workflowJobs: WorkflowJobStore,
  jobId: string,
  event: TaskPlanStageEvent
): void {
  switch (event.type) {
    case "planning_started":
      workflowJobs.recordLog(jobId, {
        currentStep: `等待 Codex 生成任务计划第 ${event.startingRound} 轮`,
        message:
          event.deferredFindings.length > 0
            ? `Codex 正在生成任务计划第 ${event.startingRound} 轮，并纳入 ${event.deferredFindings.length} 条实施阶段遗留问题。`
            : `Codex 正在生成任务计划第 ${event.startingRound} 轮。`
      });
      break;
    case "task_plan_generated":
      workflowJobs.recordLog(jobId, {
        currentStep: `任务计划草稿第 ${event.round} 轮已生成`,
        message: `Codex 已生成任务计划草稿第 ${event.round} 轮，共 ${event.plan.tasks.length} 个任务。`
      });
      break;
    case "task_plan_review_started":
      workflowJobs.recordLog(jobId, {
        currentStep: `等待 ClaudeCode 审查任务计划第 ${event.round} 轮`,
        message: `ClaudeCode 正在审查任务计划第 ${event.round} 轮。`
      });
      break;
    case "task_plan_review_completed":
      workflowJobs.recordLog(jobId, {
        currentStep: `任务计划第 ${event.review.round} 轮审查已完成`,
        message: `ClaudeCode 任务计划第 ${event.review.round} 轮结论：${event.review.reviewDecision}。`
      });
      break;
    case "task_plan_local_gate_started":
      workflowJobs.recordLog(jobId, {
        currentStep: `本地门禁校验任务计划第 ${event.round} 轮`,
        message: `本地任务计划门禁正在校验第 ${event.round} 轮 approved 结论。`
      });
      break;
    case "task_plan_local_gate_arbitration_required":
      workflowJobs.recordLog(jobId, {
        currentStep: `任务计划第 ${event.review.round} 轮本地门禁未通过`,
        message: `本地任务计划门禁发现 ${event.review.findings.length} 个复核项，已提交 ClaudeCode 仲裁。`
      });
      break;
    case "task_plan_local_gate_arbitration_started":
      workflowJobs.recordLog(jobId, {
        currentStep: `等待 ClaudeCode 仲裁第 ${event.round} 轮本地门禁意见`,
        message: `ClaudeCode 正在仲裁第 ${event.round} 轮本地任务计划门禁意见。`
      });
      break;
    case "task_plan_local_gate_arbitration_completed":
      workflowJobs.recordLog(jobId, {
        currentStep: `第 ${event.review.round} 轮本地门禁仲裁已完成`,
        message: `ClaudeCode 本地门禁仲裁结论：${event.review.reviewDecision}。`
      });
      break;
    case "task_plan_revision_started":
      workflowJobs.recordLog(jobId, {
        currentStep: `等待 Codex 整改任务计划第 ${event.round} 轮意见`,
        message: `Codex 正在根据第 ${event.round} 轮任务计划审查意见整改。`
      });
      break;
  }
}

function resolveArtifactRoot(request: ProjectScopedRequest, defaultArtifactRoot: string): string {
  const projectRoot = request.projectRoot?.trim();
  return projectRoot ? join(resolve(projectRoot), ".ao-control-plane") : defaultArtifactRoot;
}

function normalizeReleasedManualGateTaskIds(
  value: unknown,
  plan: { tasks: Array<{ taskId: string; dependencyCondition: string }> }
): ManualGateRelease[] | Error {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return new Error("releasedManualGateTaskIds must be an array of task ids or release objects");
  }

  const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const normalized = new Map<string, ManualGateRelease>();
  for (const item of value) {
    const release = normalizeManualGateReleaseItem(item);
    if (release instanceof Error) {
      return release;
    }
    const task = taskById.get(release.taskId);
    if (!task) {
      return new Error(`releasedManualGateTaskIds contains unknown task id: ${release.taskId}`);
    }
    if (task.dependencyCondition !== "manual_gate") {
      return new Error(`releasedManualGateTaskIds contains non-manual_gate task id: ${release.taskId}`);
    }
    normalized.set(release.taskId, release);
  }

  return [...normalized.values()];
}

function normalizeManualGateReleaseItem(value: unknown): ManualGateRelease | Error {
  if (typeof value === "string") {
    const taskId = value.trim();
    return taskId
      ? { taskId, decision: "approved", releasedAt: new Date().toISOString() }
      : new Error("releasedManualGateTaskIds must contain non-empty task ids");
  }

  if (!isRecord(value)) {
    return new Error("releasedManualGateTaskIds must contain task ids or release objects");
  }

  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  if (!taskId) {
    return new Error("manual gate release object must contain a non-empty taskId");
  }
  const decision = value.decision;
  if (decision !== "approved" && decision !== "requires_replan" && decision !== "blocked") {
    return new Error("manual gate release decision must be approved, requires_replan, or blocked");
  }

  return {
    taskId,
    decision,
    rationale: typeof value.rationale === "string" && value.rationale.trim() ? value.rationale.trim() : undefined,
    releasedAt: typeof value.releasedAt === "string" && value.releasedAt.trim() ? value.releasedAt.trim() : new Date().toISOString()
  };
}

async function deleteDraftArtifacts(
  draft: RequirementDraft | undefined,
  selectedProjectRoot: string | undefined,
  defaultArtifactRoot: string
): Promise<void> {
  if (!draft) {
    return;
  }

  const artifactRoots = collectCandidateArtifactRoots(draft, selectedProjectRoot, defaultArtifactRoot);
  const workflowIds = new Set<string>();
  const workflowId = draft.workflowId?.trim();
  if (workflowId) {
    workflowIds.add(workflowId);
  }
  const inferredWorkflowIds = await Promise.all(
    artifactRoots.map((artifactRoot) => findMatchingWorkflowDirs(artifactRoot, draft))
  );
  for (const inferred of inferredWorkflowIds.flat()) {
    workflowIds.add(inferred);
  }

  await Promise.all(
    artifactRoots.flatMap((artifactRoot) =>
      [...workflowIds].map((workflowDirName) => deleteWorkflowDir(artifactRoot, workflowDirName))
    )
  );
}

function collectCandidateArtifactRoots(
  draft: RequirementDraft,
  selectedProjectRoot: string | undefined,
  defaultArtifactRoot: string
): string[] {
  const candidates = [
    resolveArtifactRoot({ projectRoot: draft.projectRoot }, defaultArtifactRoot),
    selectedProjectRoot?.trim()
      ? resolveArtifactRoot({ projectRoot: selectedProjectRoot }, defaultArtifactRoot)
      : undefined,
    defaultArtifactRoot
  ].filter((item): item is string => Boolean(item));
  return [...new Set(candidates.map((item) => resolve(item)))];
}

async function deleteWorkflowDir(artifactRoot: string, workflowId: string): Promise<void> {
  const workflowDir = resolve(artifactRoot, workflowId);
  const normalizedRoot = resolve(artifactRoot);
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  const comparableWorkflowDir = process.platform === "win32" ? workflowDir.toLowerCase() : workflowDir;
  const comparableRootPrefix = process.platform === "win32" ? rootPrefix.toLowerCase() : rootPrefix;

  if (workflowDir === normalizedRoot || !comparableWorkflowDir.startsWith(comparableRootPrefix)) {
    throw new Error(`Refusing to delete workflow artifacts outside artifact root: ${workflowId}`);
  }

  await rm(workflowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function findMatchingWorkflowDirs(
  artifactRoot: string,
  draft: RequirementDraft
): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const matches: string[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const requirement = await readWorkflowRequirement(artifactRoot, entry.name);
        if (requirement && isMatchingRequirementArtifact(requirement, draft)) {
          matches.push(entry.name);
        }
      })
  );
  return matches;
}

async function readWorkflowRequirement(
  artifactRoot: string,
  workflowDirName: string
): Promise<{ title?: unknown; description?: unknown } | undefined> {
  try {
    const raw = await readFile(join(artifactRoot, workflowDirName, "requirement.json"), "utf8");
    return JSON.parse(raw) as { title?: unknown; description?: unknown };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isMatchingRequirementArtifact(
  requirement: { title?: unknown; description?: unknown },
  draft: RequirementDraft
): boolean {
  const requirementDescription = String(requirement.description ?? "").trim();
  const expectedDescription = buildRequirementDescription(draftToGovernanceRequest(draft)).trim();
  if (expectedDescription && requirementDescription === expectedDescription) {
    return true;
  }

  const draftDescription = draft.description.trim();
  const draftDiscussion = draft.discussion?.trim() ?? "";
  if (draftDescription.length < 20 || !requirementDescription.includes(draftDescription)) {
    return false;
  }

  return !draftDiscussion || requirementDescription.includes(draftDiscussion);
}

function resolveProjectRoot(
  request: ProjectScopedRequest,
  fallbackProjectRoot: string | undefined
): string | undefined {
  const projectRoot = request.projectRoot?.trim();
  return projectRoot ? resolve(projectRoot) : fallbackProjectRoot;
}

function createCodexAdapterForRequest(
  factory: ((projectRoot?: string) => CodexAdapter) | undefined,
  request: ProjectScopedRequest,
  fallbackProjectRoot: string | undefined
): CodexAdapter {
  const projectRoot = resolveProjectRoot(request, fallbackProjectRoot);
  return factory?.(projectRoot) ?? new CodexCliAdapter({ projectRoot });
}

function createClaudeCodeAdapterForRequest(
  factory: ((projectRoot?: string) => ClaudeCodeAdapter) | undefined,
  request: ProjectScopedRequest,
  fallbackProjectRoot: string | undefined
): ClaudeCodeAdapter {
  const projectRoot = resolveProjectRoot(request, fallbackProjectRoot);
  return factory?.(projectRoot) ?? new ClaudeCodeCliAdapter({ projectRoot });
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

function toRequirementDraft(request: GovernanceRequest & ProjectScopedRequest) {
  return {
    workflowId: request.workflowId?.trim() || undefined,
    title: request.title?.trim() || "",
    projectRoot: request.projectRoot?.trim() || undefined,
    description: request.description ?? "",
    discussion: request.discussion ?? "",
    acceptanceCriteria: (request.acceptanceCriteria ?? []).join("\n"),
    constraints: (request.constraints ?? []).join("\n"),
    maxDesignReviewRounds: request.maxDesignReviewRounds ?? 3
  };
}

function draftToGovernanceRequest(draft: RequirementDraft): GovernanceRequest {
  return {
    workflowId: draft.workflowId,
    title: draft.title,
    description: draft.description,
    discussion: draft.discussion,
    acceptanceCriteria: splitStoredLines(draft.acceptanceCriteria),
    constraints: splitStoredLines(draft.constraints),
    maxDesignReviewRounds: draft.maxDesignReviewRounds
  };
}

function splitStoredLines(value: string | undefined): string[] {
  return value?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
