import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExecutionLock {
  holder: "web" | "cli";
  pid: number;
  jobId?: string;
  acquiredAt: string;
  lockFileToken: string;
}

export interface ExecutionLockOptions {
  artifactRoot: string;
  workflowId: string;
  holder: "web" | "cli";
  jobId?: string;
  staleLockMs?: number;
}

const defaultStaleLockMs = 300000;

export class ExecutionLockHandle {
  constructor(
    private readonly lockFile: string,
    private readonly tokenFile: string,
    private readonly token: string
  ) {}

  async release(): Promise<void> {
    try {
      const lock = JSON.parse(await readFile(this.lockFile, "utf8")) as ExecutionLock;
      const token = await readOptional(this.tokenFile);
      if (lock.lockFileToken === this.token && token === this.token) {
        await rm(this.lockFile, { force: true });
        await rm(this.tokenFile, { force: true });
      }
    } catch {
      // Lock release must never mask terminal runner state.
    }
  }
}

export async function acquireExecutionLock(options: ExecutionLockOptions): Promise<ExecutionLockHandle> {
  const staleLockMs = options.staleLockMs ?? readStaleLockMsFromEnv();
  const workflowDir = join(options.artifactRoot, options.workflowId);
  const lockFile = join(workflowDir, "execution.lock");
  const tokenFile = join(workflowDir, "execution.lock.token");
  await mkdir(workflowDir, { recursive: true });

  const existing = await readExistingLock(lockFile, tokenFile);
  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.lock.acquiredAt);
    const tokenMatches = existing.token === existing.lock.lockFileToken;
    const pidAlive = isPidAlive(existing.lock.pid);
    if (pidAlive && tokenMatches) {
      throw new Error(`Workflow ${options.workflowId} is locked by ${existing.lock.holder} pid ${existing.lock.pid}`);
    }
    if (ageMs < staleLockMs) {
      throw new Error(`Workflow ${options.workflowId} has a recent execution lock; retry after stale lock threshold`);
    }
  }

  const lockFileToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lock: ExecutionLock = {
    holder: options.holder,
    pid: process.pid,
    jobId: options.jobId,
    acquiredAt: new Date().toISOString(),
    lockFileToken
  };
  await writeFile(tokenFile, lockFileToken, "utf8");
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return new ExecutionLockHandle(lockFile, tokenFile, lockFileToken);
}

export function readStaleLockMsFromEnv(): number {
  const value = Number(process.env.AO_CONTROL_PLANE_STALE_LOCK_MS);
  return Number.isFinite(value) && value > 0 ? value : defaultStaleLockMs;
}

async function readExistingLock(lockFile: string, tokenFile: string): Promise<{
  lock: ExecutionLock;
  token: string | undefined;
} | undefined> {
  try {
    await access(lockFile, constants.F_OK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return {
    lock: JSON.parse(await readFile(lockFile, "utf8")) as ExecutionLock,
    token: await readOptional(tokenFile)
  };
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
