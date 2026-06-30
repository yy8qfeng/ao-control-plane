import { describe, expect, it } from "vitest";
import { PlaceholderClaudeCodeAdapter } from "../adapters/claude-code.js";
import { PlaceholderCodexAdapter } from "../adapters/codex.js";
import { runPlanningWorkflow } from "./workflow-manager.js";

describe("runPlanningWorkflow", () => {
  it("creates an execution plan after design review approval", async () => {
    const result = await runPlanningWorkflow({
      requirement: {
        id: "WF-001",
        title: "Feature",
        source: "user",
        description: "Build the feature.",
        acceptanceCriteria: ["Feature works"],
        constraints: ["Do not modify AO"]
      },
      codex: new PlaceholderCodexAdapter(),
      claudeCode: new PlaceholderClaudeCodeAdapter(),
      maxDesignReviewRounds: 3
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.workflow.approvedDesignVersion).toBe("design-current");
    expect(result.reviews).toHaveLength(1);
    expect(result.taskPlanReviews).toHaveLength(1);
    expect(result.plan?.tasks[0]?.aoRole).toBe("backend-senior");
    expect(result.plan?.tasks[0]).not.toHaveProperty("agent");
  });
});
