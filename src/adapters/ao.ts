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

    const result = await execa("ao", args, {
      cwd: this.options.projectRoot,
      reject: false
    });

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

    const args = ["session", "ls", "--json", "--include-terminated"];
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

function assertNoConcreteAgentFields(task: ExecutionTask): void {
  const taskRecord = task as Record<string, unknown>;
  for (const field of forbiddenExecutionFields) {
    if (field in taskRecord) {
      throw new Error(`AO dispatcher rejects forbidden execution field: ${field}`);
    }
  }
}
