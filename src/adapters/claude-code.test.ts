import { describe, expect, it } from "vitest";
import { designReviewSchema } from "../schemas/design-review.js";
import {
  createReviewFromUnstructuredOutput,
  PlaceholderClaudeCodeAdapter,
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

describe("PlaceholderClaudeCodeAdapter", () => {
  it("rejects designs that omit the project gate boundary section", async () => {
    const adapter = new PlaceholderClaudeCodeAdapter();

    const review = await adapter.reviewDesign({
      workflowId: "WF-001",
      round: 1,
      designVersion: "design-current",
      design: [
        "# Design",
        "",
        "## 背景与问题定义",
        "Build it.",
        "",
        "## 目标与非目标",
        "Do the work.",
        "",
        "## 影响范围",
        "Code.",
        "",
        "## 方案概述",
        "Plan.",
        "",
        "## 接口、数据或关键契约变化",
        "Contract.",
        "",
        "## 任务拆解前置约束",
        "None.",
        "",
        "## 风险、回滚方案和替代方案",
        "Rollback.",
        "",
        "## 可测试性自评",
        "Tests."
      ].join("\n")
    });

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.findings[0]?.body).toContain("## 项目门禁边界与放行策略");
  });

  it("rejects downgrade expressions in placeholder design reviews", async () => {
    const adapter = new PlaceholderClaudeCodeAdapter();

    const review = await adapter.reviewDesign({
      workflowId: "WF-001",
      round: 1,
      designVersion: "design-current",
      design: [
        "# Design",
        "",
        "## 背景与问题定义",
        "完整支持自定义 IPv4/IPv6 协议。",
        "",
        "## 目标与非目标",
        "目标：先保留协议抽象。",
        "",
        "## 项目门禁边界与放行策略",
        "- GATE-REQ-001；来源：requirement.description；来源文本：完整支持自定义 IPv4/IPv6 协议；硬需求边界：自定义 IPv4/IPv6 作为后续版本能力；通过条件：预留接口即可；必需证据：设计说明；阻断策略：不作为发布阻塞项。",
        "",
        "## 影响范围",
        "Code.",
        "",
        "## 方案概述",
        "Plan.",
        "",
        "## 接口、数据或关键契约变化",
        "Contract.",
        "",
        "## 任务拆解前置约束",
        "None.",
        "",
        "## 风险、回滚方案和替代方案",
        "Rollback.",
        "",
        "## 可测试性自评",
        "Tests."
      ].join("\n")
    });

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.findings.some((finding) => finding.id.startsWith("DRF-DOWNGRADE-"))).toBe(true);
    expect(review.findings.at(-1)?.body).toContain("降级表达");
  });

  it("rejects principle-only project gate sections in placeholder design reviews", async () => {
    const adapter = new PlaceholderClaudeCodeAdapter();

    const review = await adapter.reviewDesign({
      workflowId: "WF-001",
      round: 1,
      designVersion: "design-current",
      design: [
        "# Design",
        "",
        "## 背景与问题定义",
        "Build it.",
        "",
        "## 目标与非目标",
        "Do the work.",
        "",
        "## 项目门禁边界与放行策略",
        "所有硬需求都必须满足，后续任务计划负责验证。",
        "",
        "## 影响范围",
        "Code.",
        "",
        "## 方案概述",
        "Plan.",
        "",
        "## 接口、数据或关键契约变化",
        "Contract.",
        "",
        "## 任务拆解前置约束",
        "None.",
        "",
        "## 风险、回滚方案和替代方案",
        "Rollback.",
        "",
        "## 可测试性自评",
        "Tests."
      ].join("\n")
    });

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.findings.some((finding) => finding.id.startsWith("DRF-GATE-STRUCTURE-"))).toBe(true);
    expect(review.findings.at(-1)?.body).toContain("未提供任何 `GATE-*` 项目门禁");
  });

  it("rejects project gate lines that omit required evidence fields", async () => {
    const adapter = new PlaceholderClaudeCodeAdapter();

    const review = await adapter.reviewDesign({
      workflowId: "WF-001",
      round: 1,
      designVersion: "design-current",
      design: [
        "# Design",
        "",
        "## 背景与问题定义",
        "完整支持自定义 IPv4/IPv6 协议。",
        "",
        "## 目标与非目标",
        "目标：完整交付协议能力。",
        "",
        "## 项目门禁边界与放行策略",
        "- GATE-REQ-001；来源文本：完整支持自定义 IPv4/IPv6 协议；硬需求边界：本次完整支持自定义 IPv4/IPv6。",
        "",
        "## 影响范围",
        "Code.",
        "",
        "## 方案概述",
        "Plan.",
        "",
        "## 接口、数据或关键契约变化",
        "Contract.",
        "",
        "## 任务拆解前置约束",
        "None.",
        "",
        "## 风险、回滚方案和替代方案",
        "Rollback.",
        "",
        "## 可测试性自评",
        "Tests."
      ].join("\n")
    });

    expect(review.reviewDecision).toBe("changes_requested");
    expect(review.findings.some((finding) => finding.id.startsWith("DRF-GATE-STRUCTURE-"))).toBe(true);
    expect(review.findings.at(-1)?.body).toContain("通过条件、必需证据、阻断策略");
  });

  it("allows downgrade terms when they only appear in prohibition rules", async () => {
    const adapter = new PlaceholderClaudeCodeAdapter();

    const review = await adapter.reviewDesign({
      workflowId: "WF-001",
      round: 1,
      designVersion: "design-current",
      design: [
        "# Design",
        "",
        "## 背景与问题定义",
        "完整支持自定义 IPv4/IPv6 协议。",
        "",
        "## 目标与非目标",
        "目标：完整交付协议能力。",
        "",
        "## 项目门禁边界与放行策略",
        "- GATE-REQ-001；来源：requirement.description；来源文本：完整支持自定义 IPv4/IPv6 协议；硬需求边界：本次完整支持自定义 IPv4/IPv6；通过条件：协议矩阵验证通过；必需证据：IPv4/IPv6 构建运行和验证记录；阻断策略：不得降级为非一期、条件兼容或可选扩展。",
        "",
        "## 影响范围",
        "Code.",
        "",
        "## 方案概述",
        "Plan.",
        "",
        "## 接口、数据或关键契约变化",
        "Contract.",
        "",
        "## 任务拆解前置约束",
        "None.",
        "",
        "## 风险、回滚方案和替代方案",
        "Rollback.",
        "",
        "## 可测试性自评",
        "Tests."
      ].join("\n")
    });

    expect(review.reviewDecision).toBe("approved");
  });
});
