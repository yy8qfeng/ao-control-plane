import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface StopServiceResult {
  port: number;
  stoppedPids: number[];
  skippedPids: number[];
}

export async function stopServiceOnPort(port: number): Promise<StopServiceResult> {
  const pids = await findListeningPids(port);
  const stoppedPids: number[] = [];
  const skippedPids: number[] = [];

  for (const pid of pids) {
    if (pid <= 0 || pid === process.pid) {
      skippedPids.push(pid);
      continue;
    }

    try {
      process.kill(pid, "SIGTERM");
      stoppedPids.push(pid);
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") {
        skippedPids.push(pid);
        continue;
      }
      throw error;
    }
  }

  return { port, stoppedPids, skippedPids };
}

export async function findListeningPids(port: number): Promise<number[]> {
  return process.platform === "win32" ? findWindowsListeningPids(port) : findUnixListeningPids(port);
}

async function findWindowsListeningPids(port: number): Promise<number[]> {
  const command = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `Get-NetTCPConnection -LocalPort ${port} -State Listen |`,
    "Where-Object { $_.OwningProcess -gt 0 } |",
    "Select-Object -ExpandProperty OwningProcess -Unique"
  ].join(" ");
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
    windowsHide: true
  });

  return parsePidLines(stdout);
}

async function findUnixListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    return parsePidLines(stdout);
  } catch (error) {
    if (isNodeError(error) && typeof error.code === "number" && error.code === 1) {
      return [];
    }
    throw error;
  }
}

export function parsePidLines(stdout: string): number[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )
  ];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
