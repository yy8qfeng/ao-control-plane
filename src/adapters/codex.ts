import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";

export interface CodexAdapter {
  createDesign(requirement: Requirement): Promise<string>;
  reviseDesign(input: { currentDesign: string; review: DesignReview }): Promise<string>;
}

export class PlaceholderCodexAdapter implements CodexAdapter {
  async createDesign(requirement: Requirement): Promise<string> {
    return [
      `# ${requirement.title}`,
      "",
      "## 背景与问题定义",
      requirement.description,
      "",
      "## 目标与非目标",
      "目标：满足需求验收标准，并保持进入 AO 执行层后只按 AO 内置角色下发任务。",
      "非目标：不修改 AO core、CLI 或 Dashboard。",
      "",
      "## 影响范围",
      "待执行 worker 将根据最终任务计划修改相关代码、测试或文档。",
      "",
      "## 方案概述",
      "先完成需求设计审查，通过后拆解结构化任务，再由 AO 内置角色执行。",
      "",
      "## 接口、数据或关键契约变化",
      "任务计划必须包含 workflowId、taskId、aoRole、aoPrompt 与验收标准，不包含具体 agent 或 model。",
      "",
      "## 任务拆解前置约束",
      ...requirement.constraints.map((item) => `- ${item}`),
      "",
      "## 风险、回滚方案和替代方案",
      "风险：任务依赖或 AO session 映射失败时需要人工复核。回滚方案：停止继续下发新任务，并保留已生成设计与审查记录。",
      "",
      "## 可测试性自评",
      ...requirement.acceptanceCriteria.map((item) => `- ${item}`),
      "",
      "可通过 schema 校验、mock 审查循环和 AO 适配器单元测试验证。"
    ].join("\n");
  }

  async reviseDesign(input: { currentDesign: string; review: DesignReview }): Promise<string> {
    const unresolved = input.review.findings.filter((finding) => finding.status === "unresolved");
    if (unresolved.length === 0) {
      return input.currentDesign;
    }

    return [
      input.currentDesign,
      "",
      `## 第 ${input.review.round} 轮审查整改记录`,
      ...unresolved.map((finding) => `- 已整改 ${finding.id}：${finding.body}`),
      "- 未整改项：无。",
      "- 风险与替代方案：若审查仍不接受，进入下一轮审查或人工复核。"
    ].join("\n");
  }
}
