import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";

export interface ClaudeCodeAdapter {
  reviewDesign(input: {
    workflowId: string;
    round: number;
    designVersion: string;
    design: string;
  }): Promise<DesignReview>;
  createTaskPlan(input: { workflowId: string; approvedDesign: string }): Promise<TaskPlan>;
}

export class PlaceholderClaudeCodeAdapter implements ClaudeCodeAdapter {
  async reviewDesign(input: {
    workflowId: string;
    round: number;
    designVersion: string;
    design: string;
  }): Promise<DesignReview> {
    const requiredSections = [
      "## 背景与问题定义",
      "## 目标与非目标",
      "## 影响范围",
      "## 方案概述",
      "## 接口、数据或关键契约变化",
      "## 任务拆解前置约束",
      "## 风险、回滚方案和替代方案",
      "## 可测试性自评"
    ];
    const missingSections = requiredSections.filter((section) => !input.design.includes(section));

    if (missingSections.length > 0) {
      return {
        workflowId: input.workflowId,
        round: input.round,
        designer: "codex",
        reviewer: "claude-code",
        designVersion: input.designVersion,
        reviewDecision: "changes_requested",
        findings: missingSections.map((section, index) => ({
          id: `DRF-${String(index + 1).padStart(3, "0")}`,
          title: "设计稿结构缺失",
          body: `缺少必需章节：${section}`,
          severity: "blocking",
          status: "unresolved"
        }))
      };
    }

    return {
      workflowId: input.workflowId,
      round: input.round,
      designer: "codex",
      reviewer: "claude-code",
      designVersion: input.designVersion,
      reviewDecision: input.design.trim().length > 0 ? "approved" : "changes_requested",
      findings: []
    };
  }

  async createTaskPlan(input: {
    workflowId: string;
    approvedDesign: string;
  }): Promise<TaskPlan> {
    return {
      workflowId: input.workflowId,
      title: "结构化执行计划",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: input.workflowId,
          title: "根据已批准设计实现功能",
          description: "根据最终设计稿完成代码、测试或文档变更。",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["实现内容符合最终设计稿", "相关测试通过"],
          aoPrompt: [
            `[${input.workflowId} / TASK-001]`,
            "任务名称：根据已批准设计实现功能",
            "AO 角色：backend-senior",
            "验收标准：",
            "1. 实现内容符合最终设计稿。",
            "2. 相关测试通过。",
            "上下文摘要：",
            summarizeDesignForAoPrompt(input.approvedDesign)
          ].join("\n"),
          status: "pending"
        }
      ]
    };
  }
}

function summarizeDesignForAoPrompt(design: string): string {
  const title = design.split("\n").find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim();
  return title
    ? `已批准设计：${title}。请参考已落盘最终设计稿完成实现。`
    : "请参考已落盘最终设计稿完成实现。";
}
