import { describe, expect, it } from "vitest";
import { designReviewSchema } from "../schemas/design-review.js";
import { parseStructuredOutput, StructuredOutputError } from "./claude-code.js";

describe("parseStructuredOutput", () => {
  it("parses JSON objects from plain output", () => {
    const review = parseStructuredOutput(
      JSON.stringify({
        workflowId: "WF-001",
        round: 1,
        designer: "codex",
        reviewer: "claude-code",
        designVersion: "design-v1",
        reviewDecision: "approved",
        findings: []
      }),
      designReviewSchema,
      "invalid review"
    );

    expect(review.reviewDecision).toBe("approved");
  });

  it("throws StructuredOutputError when JSON does not match the schema", () => {
    expect(() =>
      parseStructuredOutput(
        JSON.stringify({
          workflowId: "WF-001",
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-v1",
          reviewDecision: "approved",
          findings: [
            {
              id: "DRF-001",
              title: "Still unresolved",
              body: "Approved reviews cannot contain unresolved findings.",
              severity: "major",
              status: "unresolved"
            }
          ]
        }),
        designReviewSchema,
        "invalid review"
      )
    ).toThrow(StructuredOutputError);
  });
});
