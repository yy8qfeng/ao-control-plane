import { describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { runDesignReviewLoop } from "./design-review-loop.js";

describe("runDesignReviewLoop", () => {
  it("blocks for human when max design review rounds are exhausted", async () => {
    let reviseDesignCalls = 0;
    const codex: CodexAdapter = {
      ...unusedTaskPlanMethods(),
      async createDesign() {
        return "draft";
      },
      async reviseDesign(input) {
        reviseDesignCalls += 1;
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
      async reviewTaskPlan(): Promise<TaskPlanReview> {
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
    expect(reviseDesignCalls).toBe(1);
  });

  it("keeps revising changes_requested reviews until a later round approves", async () => {
    let reviseDesignCalls = 0;
    const codex: CodexAdapter = {
      ...unusedTaskPlanMethods(),
      async createDesign() {
        return "draft";
      },
      async reviseDesign(input) {
        reviseDesignCalls += 1;
        return `${input.currentDesign}\nfixed`;
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
          reviewDecision: input.round === 1 ? "changes_requested" : "approved",
          findings:
            input.round === 1
              ? [
                  {
                    id: "DRF-001",
                    title: "Missing testability",
                    body: "Design lacks testability notes.",
                    severity: "major",
                    status: "unresolved"
                  }
                ]
              : []
        };
      },
      async reviewTaskPlan(): Promise<TaskPlanReview> {
        throw new Error("should not plan inside review loop");
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
      options: { maxDesignReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(result.blockedForHuman).toBe(false);
    expect(result.reviews).toHaveLength(2);
    expect(reviseDesignCalls).toBe(1);
  });

  it("treats deferred implementation findings as approved with deferred context", async () => {
    const codex: CodexAdapter = {
      ...unusedTaskPlanMethods(),
      async createDesign() {
        return "draft";
      },
      async reviseDesign() {
        throw new Error("should not revise deferred implementation findings");
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
          reviewDecision: "defer_to_implementation",
          findings: [
            {
              id: "DRF-001",
              title: "Add migration guardrails",
              body: "Implementation should include rollout checks.",
              severity: "major",
              status: "unresolved"
            }
          ]
        };
      },
      async reviewTaskPlan(): Promise<TaskPlanReview> {
        throw new Error("should not plan inside review loop");
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
      options: { maxDesignReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(result.blockedForHuman).toBe(false);
    expect(result.finalReviewDecision).toBe("defer_to_implementation");
    expect(result.deferredFindings).toHaveLength(1);
  });
});

function unusedTaskPlanMethods(): Pick<CodexAdapter, "createTaskPlan" | "reviseTaskPlan"> {
  return {
    async createTaskPlan(): Promise<TaskPlan> {
      throw new Error("should not create task plan inside design review loop");
    },
    async reviseTaskPlan(): Promise<TaskPlan> {
      throw new Error("should not revise task plan inside design review loop");
    }
  };
}
