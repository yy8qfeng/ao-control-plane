import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface CodexAdapter {
  createDesign(requirement: Requirement, options?: { signal?: AbortSignal }): Promise<string>;
  reviseDesign(
    input: { currentDesign: string; review: DesignReview },
    options?: { signal?: AbortSignal }
  ): Promise<string>;
}

export interface CodexCliAdapterOptions {
  projectRoot?: string;
  codexBin?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export class CodexCliAdapter implements CodexAdapter {
  constructor(private readonly options: CodexCliAdapterOptions = {}) {}

  async createDesign(requirement: Requirement, options: { signal?: AbortSignal } = {}): Promise<string> {
    return this.runCodex([
      "你是需求治理层的 Codex 设计负责人。请基于下面的需求和当前代码仓库，输出可供 ClaudeCode 审查的需求设计稿。",
      "",
      "输出要求：",
      "- 只输出 Markdown 设计稿，不要输出 JSON。",
      "- 不要修改文件。",
      "- 设计稿必须至少包含这些二级标题：背景与问题定义、目标与非目标、影响范围、方案概述、接口、数据或关键契约变化、任务拆解前置约束、风险、回滚方案和替代方案、可测试性自评。",
      "- 设计必须足够具体，能支撑后续拆解 AO 执行任务。",
      "",
      "需求 JSON：",
      JSON.stringify(requirement, null, 2)
    ].join("\n"), options);
  }

  async reviseDesign(
    input: { currentDesign: string; review: DesignReview },
    options: { signal?: AbortSignal } = {}
  ): Promise<string> {
    return this.runCodex([
      "你是需求治理层的 Codex 设计负责人。请根据 ClaudeCode 的结构化审查意见整改设计稿。",
      "",
      "输出要求：",
      "- 只输出完整的新版 Markdown 设计稿，不要输出 JSON。",
      "- 不要修改文件。",
      "- 保留并完善必需章节。",
      "- 逐条体现已整改项；如有不整改项，必须说明不整改理由、风险和替代方案。",
      "",
      "当前设计稿：",
      input.currentDesign,
      "",
      "ClaudeCode 审查 JSON：",
      JSON.stringify(input.review, null, 2)
    ].join("\n"), options);
  }

  private async runCodex(prompt: string, options: { signal?: AbortSignal }): Promise<string> {
    const workingDir = await mkdtemp(join(tmpdir(), "ao-control-plane-codex-"));
    const outputFile = join(workingDir, "last-message.md");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...(this.options.projectRoot ? ["-C", this.options.projectRoot] : []),
      "--output-last-message",
      outputFile,
      "-m",
      this.options.model ?? "gpt-5.2",
      "--config",
      `model_reasoning_effort="${this.options.reasoningEffort ?? "high"}"`,
      "-"
    ];

    try {
      const result = await execa(this.options.codexBin ?? "codex", args, {
        cwd: this.options.projectRoot,
        cancelSignal: options.signal,
        input: prompt,
        reject: false
      });

      if (options.signal?.aborted) {
        throw new Error("Workflow was stopped by user");
      }

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || "Codex CLI failed");
      }

      const output = (await readCodexOutputFile(outputFile)).trim();
      if (!output) {
        throw new Error("Codex CLI returned an empty design");
      }
      return output;
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  }
}

async function readCodexOutputFile(outputFile: string): Promise<string> {
  try {
    return await readFile(outputFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Codex CLI did not write its final message to ${outputFile}`);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
