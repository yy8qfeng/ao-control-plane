import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";

let tempDir: string | undefined;

describe("ArtifactStore", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("does not write an empty task-plan.json before a plan exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-artifacts-"));
    const store = new ArtifactStore(tempDir);

    await store.saveWorkflow({
      requirement: {
        id: "WF-NO-PLAN",
        title: "No plan",
        source: "test",
        description: "Design review did not pass.",
        acceptanceCriteria: [],
        constraints: []
      },
      workflow: {
        workflowId: "WF-NO-PLAN",
        title: "No plan",
        rawRequirement: "Design review did not pass.",
        status: "blocked_for_human",
        designRounds: 1,
        maxDesignReviewRounds: 1,
        tasks: []
      },
      design: "# No plan",
      reviews: []
    });

    await expect(store.readTaskPlan("WF-NO-PLAN")).rejects.toThrow(
      "no task plan was generated"
    );
  });
});
