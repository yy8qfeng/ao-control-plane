import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
    if (this.options.dryRun) {
      const args = buildSpawnArgs(task);
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

    // Use prompt files by default so Windows shells and AO CLI layers never split or truncate dispatch context markers.
    const promptFile = await writePromptFile(task.aoPrompt);
    const args = buildSpawnArgs(task, { promptFile });
    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa("ao", args, {
        cwd: this.options.projectRoot,
        reject: false
      });
    } finally {
      await rm(dirname(promptFile), { recursive: true, force: true }).catch(() => undefined);
    }

    if (result.exitCode !== 0) {
      throw new Error(`AO spawn failed with exit code ${result.exitCode}: ${formatAoOutput(result)}`);
    }

    const stdout = stringifyOutput(result.stdout);
    const stderr = stringifyOutput(result.stderr);
    return {
      sessionId: parseSessionId(stdout),
      stdout,
      stderr
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

  async readSession(sessionId: string): Promise<unknown> {
    const sessions = await this.listSessions();
    const items = readSessionArray(sessions);
    return items.find((session) => {
      const id = readString(session, ["id", "sessionId", "name"]);
      return id === sessionId;
    });
  }

  async sendFollowUpInstruction(sessionId: string, instruction: string): Promise<AoSpawnResult> {
    if (this.options.dryRun) {
      const session = this.dryRunSessions.find((item) => item.id === sessionId);
      if (session) {
        session.prompt = `${session.prompt}\n\n${instruction}`;
      }
      return { sessionId, stdout: `dry-run follow-up ${sessionId}`, stderr: "" };
    }

    const promptFile = await writePromptFile(instruction);
    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa("ao", ["send", "--session", sessionId, "--prompt-file", promptFile], {
        cwd: this.options.projectRoot,
        reject: false
      });
    } finally {
      await rm(dirname(promptFile), { recursive: true, force: true }).catch(() => undefined);
    }
    if (result.exitCode !== 0) {
      throw new Error(`AO follow-up failed with exit code ${result.exitCode}: ${formatAoOutput(result)}`);
    }
    return { sessionId, stdout: stringifyOutput(result.stdout), stderr: stringifyOutput(result.stderr) };
  }
}

export function buildSpawnArgs(task: ExecutionTask, options: { promptFile?: string } = {}): string[] {
  assertNoConcreteAgentFields(task);
  const args = options.promptFile
    ? ["spawn", "--role", task.aoRole, "--prompt-file", options.promptFile]
    : ["spawn", "--role", task.aoRole, "--prompt", task.aoPrompt];
  return args;
}

export function parseSessionId(stdout: string): string | undefined {
  const match = stdout.match(/SESSION=([^\s]+)/);
  return match?.[1];
}

function formatAoOutput(result: { stdout?: unknown; stderr?: unknown }): string {
  const stderr = stringifyOutput(result.stderr).trim();
  const stdout = stringifyOutput(result.stdout).trim();
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

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("\n");
  }
  return String(value);
}

function assertNoConcreteAgentFields(task: ExecutionTask): void {
  const taskRecord = task as Record<string, unknown>;
  for (const field of forbiddenExecutionFields) {
    if (field in taskRecord) {
      throw new Error(`AO dispatcher rejects forbidden execution field: ${field}`);
    }
  }
}

async function writePromptFile(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ao-prompt-"));
  const file = join(dir, "prompt.txt");
  await writeFile(file, prompt, "utf8");
  return file;
}

function readSessionArray(value: unknown): Record<string, unknown>[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : isRecord(value) && Array.isArray(value.data)
        ? value.data
        : [];
  return raw.filter(isRecord);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
