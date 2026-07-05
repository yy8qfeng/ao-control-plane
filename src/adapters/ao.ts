import { execa } from "execa";
import type { ExecutionTask } from "../schemas/task-plan.js";

const forbiddenExecutionFields = ["agent", "model", "provider", "codex", "claudeCode"] as const;

export interface AoSpawnResult {
  sessionId?: string;
  stdout: string;
  stderr: string;
}

export interface AoAdapterOptions {
  projectRoot?: string;
  projectId?: string;
  dryRun?: boolean;
}

export class AoCliAdapter {
  private readonly dryRunSessions: Array<{
    id: string;
    role: string;
    status: string;
    prompt: string;
    displayName: string;
  }> = [];

  constructor(private readonly options: AoAdapterOptions = {}) {}

  async validateDispatchPrerequisites(): Promise<void> {
    if (this.options.dryRun) {
      return;
    }

    const result = await execa("gh", ["auth", "status"], {
      cwd: this.options.projectRoot,
      reject: false
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub CLI is not authenticated; AO dispatch requires GitHub integration. Run "gh auth login", then verify with "gh auth status". ${formatAoOutput(result)}`
      );
    }
  }

  async spawnTask(task: ExecutionTask): Promise<AoSpawnResult> {
    const args = buildSpawnArgs(task);

    if (this.options.dryRun) {
      const sessionId = `dry-run-${task.taskId}`;
      this.dryRunSessions.push({
        id: sessionId,
        role: task.aoRole,
        status: "completed",
        prompt: task.aoPrompt,
        displayName: `[${task.workflowId} / ${task.taskId}] ${task.title}`
      });
      return {
        sessionId,
        stdout: `ao ${args.join(" ")}`,
        stderr: ""
      };
    }

    await this.validateDispatchPrerequisites();

    const result = await execa("ao", args, {
      cwd: this.options.projectRoot,
      reject: false
    });

    if (result.exitCode !== 0) {
      throw new Error(`AO spawn failed with exit code ${result.exitCode}: ${formatAoOutput(result)}`);
    }

    return {
      sessionId: parseSessionId(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async listSessions(): Promise<unknown> {
    if (this.options.dryRun) {
      return { sessions: this.dryRunSessions };
    }

    const args = ["status", "--json", "--reports", "full"];
    if (this.options.projectId) {
      args.push("--project", this.options.projectId);
    }

    const result = await execa("ao", args, {
      cwd: this.options.projectRoot,
      reject: false
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Failed to list AO sessions");
    }

    return JSON.parse(result.stdout) as unknown;
  }
}

export function buildSpawnArgs(task: ExecutionTask): string[] {
  assertNoConcreteAgentFields(task);
  const args = ["spawn", "--role", task.aoRole, "--prompt", task.aoPrompt];
  return args;
}

export function parseSessionId(stdout: string): string | undefined {
  const match = stdout.match(/SESSION=([^\s]+)/);
  return match?.[1];
}

function formatAoOutput(result: { stdout?: string; stderr?: string }): string {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const output = [stderr, stdout].filter(Boolean).join("\n").trim();
  if (!output) {
    return "no output";
  }

  const actionable = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith("✗ ") ||
      line.includes("GitHub CLI is not authenticated") ||
      line.includes("AO is not running")
    );

  return actionable.length > 0 ? actionable.join("\n") : output;
}

function assertNoConcreteAgentFields(task: ExecutionTask): void {
  const taskRecord = task as Record<string, unknown>;
  for (const field of forbiddenExecutionFields) {
    if (field in taskRecord) {
      throw new Error(`AO dispatcher rejects forbidden execution field: ${field}`);
    }
  }
}
