#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { appVersion } from "./app-version.js";
import { AoCliAdapter } from "./adapters/ao.js";
import { ClaudeCodeCliAdapter, StructuredOutputError } from "./adapters/claude-code.js";
import { CodexCliAdapter } from "./adapters/codex.js";
import { designReviewSchema } from "./schemas/design-review.js";
import {
  createCompletionReport,
  normalizeAoSessions,
  reconcileTaskSessions
} from "./workflow/ao-status.js";
import { executePlan } from "./workflow/plan-execution.js";
import {
  ContinuousExecutionRunner,
  decideManualGate,
  markExecutionTaskCompleted,
  retryExecutionTask,
  stopExecution
} from "./workflow/continuous-plan-execution.js";
import { acquireExecutionLock } from "./workflow/execution-lock.js";
import { getExecutionStateStore } from "./workflow/execution-state-store.js";
import type { PlanVersion } from "./workflow/execution-state-store.js";
import { runWorkflow } from "./workflow/run-workflow.js";
import { TASK_PLAN_NORMALIZATION_SOURCE, parseTaskPlanWithNormalization } from "./workflow/task-plan-normalizer.js";
import { startWebServer } from "./web/server.js";
import { stopServiceOnPort } from "./web/service-control.js";

const program = new Command();

program
  .name("ao-control-plane")
  .description("Requirement design review and structured execution control plane for AO")
  .version(appVersion);

program
  .command("run-workflow")
  .argument("<requirement-file>", "Requirement JSON file")
  .option("--project-root <path>", "Project root used as cwd for Codex and ClaudeCode")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--codex-bin <command>", "Codex CLI command", "codex")
  .option("--claude-bin <command>", "ClaudeCode CLI command", "claude")
  .option("--codex-model <model>", "Codex model", "gpt-5.5")
  .option("--codex-effort <level>", "Codex reasoning effort", "high")
  .option("--claude-model <model>", "ClaudeCode model")
  .option("--claude-effort <level>", "ClaudeCode effort", "high")
  .description("Run requirement design, ClaudeCode review, Codex revision, and task-plan generation")
  .action(
    async (
      requirementFile: string,
      options: {
        projectRoot?: string;
        artifactRoot: string;
        codexBin: string;
        claudeBin: string;
        codexModel: string;
        codexEffort: "low" | "medium" | "high" | "xhigh";
        claudeModel?: string;
        claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
      }
    ) => {
      let result;
      try {
        result = await runWorkflow({
          requirementFile,
          artifactRoot: options.artifactRoot,
          codex: new CodexCliAdapter({
            projectRoot: options.projectRoot,
            codexBin: options.codexBin,
            model: options.codexModel,
            reasoningEffort: options.codexEffort
          }),
          claudeCode: new ClaudeCodeCliAdapter({
            projectRoot: options.projectRoot,
            claudeBin: options.claudeBin,
            model: options.claudeModel,
            effort: options.claudeEffort
          })
        });
      } catch (error) {
        if (error instanceof StructuredOutputError) {
          console.error(`${error.message}. Human review artifacts were written.`);
        }
        throw error;
      }

      console.log(
        JSON.stringify(
          {
            workflowId: result.workflow.workflowId,
            status: result.workflow.status,
            artifactDir: result.artifactDir,
            designPath: result.designPath,
            reviewsPath: result.reviewsPath,
            taskPlanPath: result.taskPlanPath
          },
          null,
          2
        )
      );
    }
  );

program
  .command("validate-plan")
  .argument("<file>", "Task plan JSON file")
  .description("Validate a structured task plan before sending it to AO")
  .action(async (file: string) => {
    const plan = await readTaskPlan(file);
    console.log(JSON.stringify({ valid: true, workflowId: plan.workflowId, taskCount: plan.tasks.length }, null, 2));
  });

program
  .command("execute-plan")
  .argument("<file>", "Task plan JSON file")
  .option("--project-root <path>", "AO project root used as cwd for ao CLI")
  .option("--dry-run", "Print intended AO calls without spawning sessions")
  .option("--release-manual-gate <taskId...>", "Explicitly release manual_gate task ids for dispatch")
  .description("Execute a validated task plan through AO built-in roles")
  .action(async (file: string, options: { projectRoot?: string; dryRun?: boolean; releaseManualGate?: string[] }) => {
    const plan = await readTaskPlan(file);
    const ao = new AoCliAdapter({
      projectRoot: options.projectRoot,
      dryRun: options.dryRun
    });
    const result = await executePlan({
      plan,
      ao,
      releasedManualGateTaskIds: options.releaseManualGate
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("execute-plan-continuous")
  .argument("<task-plan-file>", "Task plan JSON file")
  .option("--project-root <path>", "AO project root used as cwd for ao CLI")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--workflow-id <id>", "Workflow id; defaults to task-plan.workflowId")
  .option("--poll-interval-ms <number>", "AO status poll interval", "5000")
  .option("--stale-lock-ms <number>", "Execution lock stale threshold")
  .option("--dry-run", "Run continuous scheduling without spawning real AO sessions")
  .option("--attach", "Only print current execution state and logs without driving the runner")
  .description("Execute a task plan continuously, serially dispatching ready AO tasks")
  .action(async (
    taskPlanFile: string,
    options: {
      projectRoot?: string;
      artifactRoot: string;
      workflowId?: string;
      pollIntervalMs: string;
      staleLockMs?: string;
      dryRun?: boolean;
      attach?: boolean;
    }
  ) => {
    const plan = await readTaskPlan(taskPlanFile);
    const workflowId = options.workflowId ?? plan.workflowId;
    const store = getExecutionStateStore(options.artifactRoot);
    if (options.attach) {
      console.log(JSON.stringify({
        state: await store.ensureState(workflowId),
        logs: await store.readLogs(workflowId)
      }, null, 2));
      return;
    }

    await activateCliPlanFile({ store, workflowId, taskPlanFile });
    const lock = options.dryRun
      ? undefined
      : await acquireExecutionLock({
          artifactRoot: options.artifactRoot,
          workflowId,
          holder: "cli",
          staleLockMs: options.staleLockMs ? Number(options.staleLockMs) : undefined
        });
    try {
      const runner = new ContinuousExecutionRunner({
        workflowId,
        store,
        ao: new AoCliAdapter({
          projectRoot: options.projectRoot,
          dryRun: options.dryRun
        }),
        pollIntervalMs: Number(options.pollIntervalMs)
      });
      await runner.run();
      console.log(JSON.stringify(await store.ensureState(workflowId), null, 2));
    } finally {
      await lock?.release();
    }
  });

program
  .command("execution-status")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .description("Print continuous execution state and recent logs")
  .action(async (options: { workflowId: string; artifactRoot: string }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    console.log(JSON.stringify({
      state: await store.ensureState(options.workflowId),
      logs: await store.readLogs(options.workflowId)
    }, null, 2));
  });

program
  .command("execution-stop")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .description("Stop continuous execution without killing AO sessions")
  .action(async (options: { workflowId: string; artifactRoot: string }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    console.log(JSON.stringify(await stopExecution({ store, workflowId: options.workflowId, actor: "cli" }), null, 2));
  });

program
  .command("execution-resume")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .option("--project-root <path>", "AO project root used as cwd for ao CLI")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--poll-interval-ms <number>", "AO status poll interval", "5000")
  .option("--stale-lock-ms <number>", "Execution lock stale threshold")
  .option("--dry-run", "Run continuous scheduling without spawning real AO sessions")
  .description("Resume a stopped continuous execution")
  .action(async (options: {
    workflowId: string;
    projectRoot?: string;
    artifactRoot: string;
    pollIntervalMs: string;
    staleLockMs?: string;
    dryRun?: boolean;
  }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    const lock = options.dryRun
      ? undefined
      : await acquireExecutionLock({
          artifactRoot: options.artifactRoot,
          workflowId: options.workflowId,
          holder: "cli",
          staleLockMs: options.staleLockMs ? Number(options.staleLockMs) : undefined
        });
    try {
      const runner = new ContinuousExecutionRunner({
        workflowId: options.workflowId,
        store,
        ao: new AoCliAdapter({ projectRoot: options.projectRoot, dryRun: options.dryRun }),
        pollIntervalMs: Number(options.pollIntervalMs)
      });
      await runner.run();
      console.log(JSON.stringify(await store.ensureState(options.workflowId), null, 2));
    } finally {
      await lock?.release();
    }
  });

program
  .command("execution-retry")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .requiredOption("--task-id <taskId>", "Task id")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .description("Mark a blocked or failed task for retry")
  .action(async (options: { workflowId: string; taskId: string; artifactRoot: string }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    console.log(JSON.stringify(await retryExecutionTask({ store, workflowId: options.workflowId, taskId: options.taskId, actor: "cli" }), null, 2));
  });

program
  .command("execution-mark-completed")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .requiredOption("--task-id <taskId>", "Task id")
  .requiredOption("--rationale <text>", "Human completion rationale")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .description("Mark a task completed after human verification")
  .action(async (options: { workflowId: string; taskId: string; rationale: string; artifactRoot: string }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    console.log(JSON.stringify(await markExecutionTaskCompleted({
      store,
      workflowId: options.workflowId,
      taskId: options.taskId,
      rationale: options.rationale,
      actor: "cli"
    }), null, 2));
  });

program
  .command("execution-release-gate")
  .requiredOption("--workflow-id <id>", "Workflow id")
  .requiredOption("--task-id <taskId>", "Task id")
  .option("--decision <decision>", "approved, requires_replan, or blocked", "approved")
  .option("--rationale <text>", "Decision rationale", "CLI manual gate decision")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .description("Submit a structured manual gate decision")
  .action(async (options: {
    workflowId: string;
    taskId: string;
    decision: "approved" | "requires_replan" | "blocked";
    rationale: string;
    artifactRoot: string;
  }) => {
    const store = getExecutionStateStore(options.artifactRoot);
    console.log(JSON.stringify(await decideManualGate({
      store,
      workflowId: options.workflowId,
      taskId: options.taskId,
      decision: options.decision,
      rationale: options.rationale,
      actor: "cli"
    }), null, 2));
  });

program
  .command("collect-status")
  .argument("<plan-file>", "Task plan JSON file")
  .option("--project-root <path>", "AO project root used as cwd for ao CLI")
  .option("--project-id <id>", "AO project id used only for ao session ls")
  .option("--sessions-file <file>", "Read AO session JSON from a file instead of invoking ao")
  .description("Collect AO session status and map sessions back to workflow tasks")
  .action(
    async (
      planFile: string,
      options: { projectRoot?: string; projectId?: string; sessionsFile?: string }
    ) => {
      const plan = await readTaskPlan(planFile);
      const rawSessions = options.sessionsFile
        ? await readJson(options.sessionsFile)
        : await new AoCliAdapter({
            projectRoot: options.projectRoot,
            projectId: options.projectId
          }).listSessions();
      const sessions = normalizeAoSessions(rawSessions);
      const mappings = reconcileTaskSessions({ plan, sessions });

      console.log(JSON.stringify({ workflowId: plan.workflowId, tasks: mappings }, null, 2));
    }
  );

program
  .command("report")
  .argument("<plan-file>", "Task plan JSON file")
  .argument("<reviews-file>", "Design review JSON array file")
  .option("--project-root <path>", "AO project root used as cwd for ao CLI")
  .option("--project-id <id>", "AO project id used only for ao session ls")
  .option("--sessions-file <file>", "Read AO session JSON from a file instead of invoking ao")
  .description("Create a final workflow report from reviews, task plan, and AO sessions")
  .action(
    async (
      planFile: string,
      reviewsFile: string,
      options: { projectRoot?: string; projectId?: string; sessionsFile?: string }
    ) => {
      const plan = await readTaskPlan(planFile);
      const reviews = await readDesignReviews(reviewsFile);
      const rawSessions = options.sessionsFile
        ? await readJson(options.sessionsFile)
        : await new AoCliAdapter({
            projectRoot: options.projectRoot,
            projectId: options.projectId
          }).listSessions();
      const report = createCompletionReport({
        workflowId: plan.workflowId,
        reviews,
        plan,
        sessions: normalizeAoSessions(rawSessions)
      });

      console.log(JSON.stringify(report, null, 2));
    }
  );

program
  .command("serve")
  .option("--host <host>", "Host for the local web console", "127.0.0.1")
  .option("--port <port>", "Port for the local web console", "4317")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--project-root <path>", "AO project root used when executing task plans")
  .option("--allow-public-host", "Allow binding the web console to a public host")
  .description("Start the local web console for requirement governance")
  .action(
    async (options: {
      host: string;
      port: string;
      artifactRoot: string;
      projectRoot?: string;
      allowPublicHost?: boolean;
    }) => {
      const server = await startWebServer({
        host: options.host,
        port: Number(options.port),
        artifactRoot: options.artifactRoot,
        aoProjectRoot: options.projectRoot,
        allowPublicHost: options.allowPublicHost
      });
      console.log(`AO Control Plane web console: ${server.url}`);
      await new Promise<void>(() => {
        // Keep the process alive until the user stops it.
      });
    }
  );

program
  .command("stop-service")
  .option("--port <port>", "Port of the local web console", "4317")
  .description("Stop the local web console listening on the given port")
  .action(async (options: { port: string }) => {
    const result = await stopServiceOnPort(Number(options.port));
    if (result.stoppedPids.length === 0) {
      console.log(`No AO Control Plane service was listening on port ${result.port}.`);
      return;
    }

    console.log(
      JSON.stringify(
        {
          port: result.port,
          stoppedPids: result.stoppedPids,
          skippedPids: result.skippedPids
        },
        null,
        2
      )
    );
  });

program
  .command("restart-service")
  .option("--host <host>", "Host for the local web console", "127.0.0.1")
  .option("--port <port>", "Port for the local web console", "4317")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--project-root <path>", "AO project root used when executing task plans")
  .option("--allow-public-host", "Allow binding the web console to a public host")
  .description("Stop the local web console on the port and start it again")
  .action(
    async (options: {
      host: string;
      port: string;
      artifactRoot: string;
      projectRoot?: string;
      allowPublicHost?: boolean;
    }) => {
      const stopResult = await stopServiceOnPort(Number(options.port));
      if (stopResult.stoppedPids.length > 0) {
        console.log(`Stopped service process(es): ${stopResult.stoppedPids.join(", ")}`);
      }

      const server = await startWebServer({
        host: options.host,
        port: Number(options.port),
        artifactRoot: options.artifactRoot,
        aoProjectRoot: options.projectRoot,
        allowPublicHost: options.allowPublicHost
      });
      console.log(`AO Control Plane web console: ${server.url}`);
      await new Promise<void>(() => {
        // Keep the process alive until the user stops it.
      });
    }
  );

await program.parseAsync();

async function activateCliPlanFile(input: {
  store: ReturnType<typeof getExecutionStateStore>;
  workflowId: string;
  taskPlanFile: string;
}): Promise<void> {
  const fileName = basename(input.taskPlanFile);
  const workflowDir = input.store.getWorkflowDir(input.workflowId);
  const expectedPath = resolve(workflowDir, fileName);
  const actualPath = resolve(input.taskPlanFile);
  if (actualPath !== expectedPath) {
    throw new Error(
      `execute-plan-continuous requires ${fileName} to already be in the workflow artifact directory: ${workflowDir}`
    );
  }
  const versionMatch = fileName.match(/^task-plan-v(\d+)\.json$/);
  if (fileName !== "task-plan.json" && !versionMatch) {
    throw new Error("execute-plan-continuous only accepts task-plan.json or task-plan-v{N}.json as active plans");
  }
  if (!versionMatch) {
    return;
  }
  const planVersion = `task-plan-v${versionMatch[1]}` as PlanVersion;
  await input.store.update(input.workflowId, (state) => ({
    ...state,
    planVersion,
    planPath: fileName
  }));
}

async function readTaskPlan(file: string) {
  const parsed = await readJson(file);
  return parseTaskPlanWithNormalization(parsed, {
    workflowId: inferWorkflowId(parsed),
    source: TASK_PLAN_NORMALIZATION_SOURCE.cli
  }, `Task plan file ${file} is invalid`);
}

async function readDesignReviews(file: string) {
  const parsed = await readJson(file);
  if (!Array.isArray(parsed)) {
    throw new Error("Design reviews file must contain a JSON array");
  }
  return parsed.map((review) => designReviewSchema.parse(review));
}

async function readJson(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as unknown;
}

function inferWorkflowId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "workflowId" in value && typeof value.workflowId === "string"
    ? value.workflowId
    : undefined;
}
