import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigStore } from "./project-config.js";

let tempDir: string | undefined;

describe("ProjectConfigStore", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it("serializes concurrent draft saves so workflow draft wins over title draft", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ao-control-plane-project-config-"));
    const store = new ProjectConfigStore(join(tempDir, "project-config.json"));

    await Promise.all([
      store.saveRequirementDraft({
        title: "Generated workflow draft",
        description: "Draft before workflow id is known.",
        maxDesignReviewRounds: 3
      }),
      store.saveRequirementDraft({
        workflowId: "WF-CONCURRENT",
        title: "Generated workflow draft",
        description: "Draft after workflow id is known.",
        maxDesignReviewRounds: 3
      })
    ]);

    const config = await store.read();
    expect(config.requirementDraft?.workflowId).toBe("WF-CONCURRENT");
    expect(config.requirementDrafts).toHaveLength(1);
    expect(config.requirementDrafts?.[0]?.draftKey).toBe("workflow:WF-CONCURRENT");
  });
});
