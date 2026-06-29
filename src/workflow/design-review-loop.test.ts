import { describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import { runDesignReviewLoop } from "./design-review-loop.js";

describe("runDesignReviewLoop", () => {
  it("blocks for human when max design review rounds are exhausted", async () => {
    const codex: CodexAdapter = {
      async createDesign() {
        return "draft";
      },
      async reviseDesign(input) {
        return `${input.currentDesign}\nrevision`;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input) {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "DRF-001",
              title: "Missing testability",
              body: "Design lacks testability notes.",
              severity: "major",
              status: "unresolved"
            }
          ]
        };
      },
      async createTaskPlan() {
        throw new Error("should not plan before approval");
      }
    };

    const result = await runDesignReviewLoop({
      requirement: {
        id: "WF-001",
        title: "Feature",
        source: "user",
        description: "Build the feature.",
        acceptanceCriteria: [],
        constraints: []
      },
      codex,
      claudeCode,
      options: { maxDesignReviewRounds: 2 }
    });

    expect(result.approved).toBe(false);
    expect(result.blockedForHuman).toBe(true);
    expect(result.reviews).toHaveLength(2);
  });
});
