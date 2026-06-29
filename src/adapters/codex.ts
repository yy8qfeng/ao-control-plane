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
      "## 需求概述",
      requirement.description,
      "",
      "## 验收标准",
      ...requirement.acceptanceCriteria.map((item) => `- ${item}`),
      "",
      "## 约束",
      ...requirement.constraints.map((item) => `- ${item}`)
    ].join("\n");
  }

  async reviseDesign(input: { currentDesign: string; review: DesignReview }): Promise<string> {
    const unresolved = input.review.findings.filter((finding) => finding.decision === "unresolved");
    if (unresolved.length === 0) {
      return input.currentDesign;
    }

    return [
      input.currentDesign,
      "",
      `## 第 ${input.review.round} 轮审查整改记录`,
      ...unresolved.map((finding) => `- ${finding.id}：${finding.recommendation}`)
    ].join("\n");
  }
}
