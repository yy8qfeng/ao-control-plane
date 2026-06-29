#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { AoCliAdapter } from "./adapters/ao.js";
import { taskPlanSchema } from "./schemas/task-plan.js";
import { executePlan } from "./workflow/plan-execution.js";

const program = new Command();

program
  .name("ao-control-plane")
  .description("Requirement design review and structured execution control plane for AO")
  .version("0.1.0");

program
  .command("validate-plan")
  .argument("<file>", "Task plan JSON file")
  .description("Validate a structured task plan before sending it to AO")
  .action(async (file: string) => {
    const plan = await readTaskPlan(file);
    console.log(JSON.stringify({ valid: true, planId: plan.id, taskCount: plan.tasks.length }, null, 2));
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

await program.parseAsync();

async function readTaskPlan(file: string) {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return taskPlanSchema.parse(parsed);
}
