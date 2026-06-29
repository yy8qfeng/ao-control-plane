#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { AoCliAdapter } from "./adapters/ao.js";
import { ClaudeCodeCliAdapter, StructuredOutputError } from "./adapters/claude-code.js";
import { CodexCliAdapter } from "./adapters/codex.js";
import { designReviewSchema } from "./schemas/design-review.js";
import { taskPlanSchema } from "./schemas/task-plan.js";
import {
  createCompletionReport,
  normalizeAoSessions,
  reconcileTaskSessions
} from "./workflow/ao-status.js";
import { executePlan } from "./workflow/plan-execution.js";
import { runWorkflow } from "./workflow/run-workflow.js";
import { startWebServer } from "./web/server.js";

const program = new Command();

program
  .name("ao-control-plane")
  .description("Requirement design review and structured execution control plane for AO")
  .version("0.1.0");

program
  .command("run-workflow")
  .argument("<requirement-file>", "Requirement JSON file")
  .option("--project-root <path>", "Project root used as cwd for Codex and ClaudeCode")
  .option("--artifact-root <path>", "Directory used to store generated workflow artifacts", ".ao-control-plane")
  .option("--codex-bin <command>", "Codex CLI command", "codex")
  .option("--claude-bin <command>", "ClaudeCode CLI command", "claude")
  .option("--codex-model <model>", "Codex model", "gpt-5.2")
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
          console.error(
            "ClaudeCode output is not valid JSON or does not match the schema. Human review artifacts were written."
          );
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
  .description("Execute a validated task plan through AO built-in roles")
  .action(async (file: string, options: { projectRoot?: string; dryRun?: boolean }) => {
    const plan = await readTaskPlan(file);
    const ao = new AoCliAdapter({
      projectRoot: options.projectRoot,
      dryRun: options.dryRun
    });
    const result = await executePlan({ plan, ao });
    console.log(JSON.stringify(result, null, 2));
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

await program.parseAsync();

async function readTaskPlan(file: string) {
  const parsed = await readJson(file);
  return taskPlanSchema.parse(parsed);
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
