import { describe, expect, it } from "vitest";
import { designReviewSchema } from "../schemas/design-review.js";
import {
  createReviewFromUnstructuredOutput,
  parseStructuredOutput,
  parseStructuredOutputWithRepair,
  StructuredOutputError
} from "./claude-code.js";

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

  it("repairs non-JSON review output before failing the workflow", async () => {
    const review = await parseStructuredOutputWithRepair({
      rawOutput: "审查结论为 changes_requested，共发现 1 个阻塞问题：缺少验收标准。",
      schema: designReviewSchema,
      errorMessage: "invalid review",
      repairAttempts: 1,
      async repair() {
        return JSON.stringify({
          workflowId: "WF-001",
          round: 2,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-v2",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "DRF-001",
              title: "缺少验收标准",
              body: "设计稿没有给出可执行的验收标准。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        });
      }
    });

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.round).toBe(2);
  });

  it("keeps all invalid attempts in the final StructuredOutputError", async () => {
    await expect(
      parseStructuredOutputWithRepair({
        rawOutput: "not json",
        schema: designReviewSchema,
        errorMessage: "invalid review",
        repairAttempts: 1,
        async repair() {
          return "still not json";
        }
      })
    ).rejects.toMatchObject({
      rawOutput: expect.stringContaining("--- repair-output-1 ---")
    });
  });

  it("converts unstructured review text into an unresolved finding", () => {
    const review = createReviewFromUnstructuredOutput(
      {
        workflowId: "WF-001",
        round: 2,
        designVersion: "design-v2"
      },
      "审查结论为 changes_requested，需要补充 API 错误响应策略。"
    );

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.findings[0]?.status).toBe("unresolved");
    expect(review.findings[0]?.body).toContain("API 错误响应策略");
  });
});
