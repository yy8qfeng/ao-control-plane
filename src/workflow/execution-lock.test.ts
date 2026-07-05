import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExecutionLock } from "./execution-lock.js";

let tempDir: string | undefined;

describe("execution lock", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("overwrites stale lock only after stale threshold", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-lock-"));
    const workflowId = "WF-LOCK";
    const workflowDir = join(tempDir, workflowId);
    await mkdir(workflowDir, { recursive: true });
    const oldToken = "old-token";
    await writeFile(join(workflowDir, "execution.lock.token"), oldToken, "utf8");
    await writeFile(join(workflowDir, "execution.lock"), JSON.stringify({
      holder: "cli",
      pid: 999999,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      lockFileToken: oldToken
    }), "utf8");

    const lock = await acquireExecutionLock({
      artifactRoot: tempDir,
      workflowId,
      holder: "web",
      staleLockMs: 1
    });

    await lock.release();
  });

  it("rejects a recent lock even when pid is not alive", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-lock-"));
    const workflowId = "WF-LOCK-RECENT";
    const workflowDir = join(tempDir, workflowId);
    await mkdir(workflowDir, { recursive: true });
    const token = "recent-token";
    await writeFile(join(workflowDir, "execution.lock.token"), token, "utf8");
    await writeFile(join(workflowDir, "execution.lock"), JSON.stringify({
      holder: "cli",
      pid: 999999,
      acquiredAt: new Date().toISOString(),
      lockFileToken: token
    }), "utf8");

    await expect(acquireExecutionLock({
      artifactRoot: tempDir,
      workflowId,
      holder: "web",
      staleLockMs: 300000
    })).rejects.toThrow("recent execution lock");
  });
});
