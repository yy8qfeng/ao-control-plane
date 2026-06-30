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

  it("rejects changes_requested reviews when all findings are already resolved", () => {
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

  it("rejects the removed human review decision", () => {
    const result = designReviewSchema.safeParse({
      workflowId: "WF-001",
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-current",
      reviewDecision: "human_review_required",
      findings: [unresolvedFinding]
    });

    expect(result.success).toBe(false);
  });

  it("allows deferred implementation findings to remain unresolved", () => {
    const result = designReviewSchema.safeParse({
      workflowId: "WF-001",
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-current",
      reviewDecision: "defer_to_implementation",
      findings: [unresolvedFinding]
    });

    expect(result.success).toBe(true);
  });

  it("rejects deferred implementation reviews without unresolved findings", () => {
    const result = designReviewSchema.safeParse({
      workflowId: "WF-001",
      round: 1,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: "design-current",
      reviewDecision: "defer_to_implementation",
      findings: [addressedFinding]
    });

    expect(result.success).toBe(false);
  });
});
