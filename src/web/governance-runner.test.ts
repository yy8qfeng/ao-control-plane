import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import {
  createTaskPlanStage,
  runDesignReviewStage,
  runGovernanceWorkflow
} from "./governance-runner.js";

let tempDir: string | undefined;

describe("runGovernanceWorkflow", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates design review artifacts and a task plan from a web request", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const result = await runGovernanceWorkflow({
      store: new ArtifactStore(tempDir),
      request: {
        title: "User permissions",
        description: "Add role-based permissions.",
        discussion: "Keep AO execution role-only.",
        acceptanceCriteria: ["Permissions are enforced"],
        constraints: ["Do not modify AO"],
        maxDesignReviewRounds: 3
      }
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.plan?.tasks).toHaveLength(1);
    await expect(readFile(join(result.artifactDir, "design.md"), "utf8")).resolves.toContain(
      "## 背景与问题定义"
    );
    await expect(readFile(join(result.artifactDir, "task-plan.json"), "utf8")).resolves.toContain(
      result.workflow.workflowId
    );
  });

  it("supports pausing after design review and restarts review count after requirement supplements", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-"));
    const store = new ArtifactStore(tempDir);
    const request = {
      title: "User permissions",
      description: "Add role-based permissions.",
      discussion: "Need one more review before planning.",
      acceptanceCriteria: ["Permissions are enforced"],
      constraints: ["Do not modify AO"],
      maxDesignReviewRounds: 3
    };

    const reviewed = await runDesignReviewStage({ store, request });
    expect(reviewed.workflow.status).toBe("ready_for_planning");
    expect(reviewed.reviews[0]?.round).toBe(1);
    expect(reviewed.plan).toBeUndefined();

    const reviewedAfterSupplement = await runDesignReviewStage({
      store,
      request: {
        ...request,
        workflowId: reviewed.workflow.workflowId,
        discussion: "Need one more review before planning.\n补充：管理员需要可以查看审计日志。"
      }
    });
    expect(reviewedAfterSupplement.workflow.workflowId).toBe(reviewed.workflow.workflowId);
    expect(reviewedAfterSupplement.reviews[0]?.round).toBe(1);

    const planned = await createTaskPlanStage({
      store,
      workflowId: reviewedAfterSupplement.workflow.workflowId
    });
    expect(planned.workflow.status).toBe("executing");
    expect(planned.plan?.tasks).toHaveLength(1);
  });
});
