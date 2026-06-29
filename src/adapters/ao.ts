import { execa } from "execa";
import type { ExecutionTask } from "../schemas/task-plan.js";

export interface AoSpawnResult {
  sessionId?: string;
  stdout: string;
  stderr: string;
}

export interface AoAdapterOptions {
  projectRoot?: string;
  dryRun?: boolean;
}

export class AoCliAdapter {
  constructor(private readonly options: AoAdapterOptions = {}) {}

  async spawnTask(task: ExecutionTask): Promise<AoSpawnResult> {
    const args = ["spawn", "--role", task.aoRole, "--prompt", task.prompt];

    if (this.options.dryRun) {
      return {
        sessionId: `dry-run-${task.id}`,
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
    const result = await execa("ao", ["session", "ls", "--json", "--include-terminated"], {
      cwd: this.options.projectRoot,
      reject: false
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Failed to list AO sessions");
    }

    return JSON.parse(result.stdout) as unknown;
  }
}

function parseSessionId(stdout: string): string | undefined {
  const match = stdout.match(/SESSION=([^\s]+)/);
  return match?.[1];
}
