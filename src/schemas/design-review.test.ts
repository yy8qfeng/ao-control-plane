import { describe, expect, it } from "vitest";
import { designReviewSchema } from "./design-review.js";

const addressedFinding = {
  id: "DRF-001",
  title: "Missing testability",
  body: "Design lacks testability notes.",
  severity: "major",
  status: "addressed"
};

const unresolvedFinding = {
  ...addressedFinding,
  status: "unresolved"
};

describe("designReviewSchema", () => {
  it("rejects approved reviews that still contain unresolved findings", () => {
    const result = designReviewSchema.safeParse({
      workflowId: "WF-001",
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-v1",
      reviewDecision: "approved",
      findings: [unresolvedFinding]
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-approved reviews when all findings are already resolved", () => {
    const result = designReviewSchema.safeParse({
      workflowId: "WF-001",
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-v1",
      reviewDecision: "changes_requested",
      findings: [addressedFinding]
    });

    expect(result.success).toBe(false);
  });
});
