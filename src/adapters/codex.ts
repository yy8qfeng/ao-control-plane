import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import {
  formatExecutionPolicyTemplate,
  getExecutionPolicyForTaskType,
  type ExecutionPolicy
} from "../schemas/execution-policy.js";
import { taskPlanSchema } from "../schemas/task-plan.js";
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
  createTaskPlan(
    input: { workflowId: string; approvedDesign: string; deferredFindings?: DesignReview["findings"] },
    options?: { signal?: AbortSignal }
  ): Promise<TaskPlan>;
  reviseTaskPlan(
    input: { currentPlan: TaskPlan; review: TaskPlanReview; approvedDesign: string },
    options?: { signal?: AbortSignal }
  ): Promise<TaskPlan>;
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

  async createTaskPlan(
    input: { workflowId: string; approvedDesign: string; deferredFindings?: DesignReview["findings"] },
    options: { signal?: AbortSignal } = {}
  ): Promise<TaskPlan> {
    const deferredFindings = formatDeferredFindings(input.deferredFindings ?? []);
    const taskPlanRules = formatTaskPlanRules("create");
    const rawOutput = await this.runCodex([
      "你是需求治理层的 Codex 任务拆解负责人。请根据已批准设计稿输出 AO 执行层 task-plan。",
      "",
      "必须只输出一个 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字，不要修改文件。",
      "JSON 必须符合以下 TypeScript 形状：",
      "{",
      '  "workflowId": "string",',
      '  "title": "string",',
      '  "tasks": [{',
      '    "taskId": "TASK-001",',
      '    "workflowId": "string",',
      '    "title": "string",',
      '    "description": "string",',
      '    "type": "design" | "implementation" | "test" | "refactor" | "review" | "docs" | "verification",',
      '    "dependencies": ["TASK-001"],',
      '    "dependencyCondition": "all_completed" | "any_completed" | "manual_gate",',
      '    "aoRole": "architect" | "reviewer" | "ui-designer" | "frontend-senior" | "frontend-junior" | "backend-senior" | "backend-junior" | "qa" | "docs" | "second-opinion" | "frontend" | "backend",',
      '    "acceptanceCriteria": ["string"],',
      '    "aoPrompt": "string",',
      `    "executionPolicy": ${formatExecutionPolicyTemplate()},`,
      '    "status": "pending"',
      "  }]",
      "}",
      "",
      "硬性规则：",
      ...taskPlanRules,
      "",
      `workflowId: ${input.workflowId}`,
      "",
      "实施阶段遗留审查意见：",
      deferredFindings,
      "",
      "已批准设计稿：",
      input.approvedDesign
    ].join("\n"), options);

    return parseTaskPlanOutput(rawOutput, `Codex task plan JSON is invalid for workflow ${input.workflowId}`);
  }

  async reviseTaskPlan(
    input: { currentPlan: TaskPlan; review: TaskPlanReview; approvedDesign: string },
    options: { signal?: AbortSignal } = {}
  ): Promise<TaskPlan> {
    const taskPlanRules = formatTaskPlanRules("revise");
    const rawOutput = await this.runCodex([
      "你是需求治理层的 Codex 任务拆解负责人。请根据 ClaudeCode 的结构化审查意见整改 task-plan。",
      "",
      "必须只输出完整新版 task-plan JSON 对象，不要使用 Markdown 代码块，不要输出解释文字，不要修改文件。",
      "",
      "整改规则：",
      "- 保留合理任务，并逐条修复 unresolved finding。",
      ...taskPlanRules,
      "",
      "当前 task-plan JSON：",
      JSON.stringify(input.currentPlan, null, 2),
      "",
      "ClaudeCode 任务计划审查 JSON：",
      JSON.stringify(input.review, null, 2),
      "",
      "已批准设计稿：",
      input.approvedDesign
    ].join("\n"), options);

    return parseTaskPlanOutput(rawOutput, `Codex revised task plan JSON is invalid for workflow ${input.currentPlan.workflowId}`);
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
      this.options.model ?? "gpt-5.5",
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

function formatTaskPlanRules(mode: "create" | "revise"): string[] {
  return [
    "- 任务只能指定 aoRole，禁止出现 agent、model、provider、codex、claudeCode 字段。",
    "- aoPrompt 中禁止要求 AO worker 选择、切换或调用具体 agent 或 model。",
    "- 每个 aoPrompt 必须包含 workflowId、taskId、任务名称、AO 角色、验收标准和上下文摘要。",
    "- taskId 使用 TASK-001 递增。",
    "- status 全部使用 pending。",
    "- 每个任务必须包含完整 executionPolicy，并按任务类型显式差异化；禁止所有任务无脑使用同一套默认策略。",
    "- executionPolicy 只能包含 developerSelfTestRequired、qaRequired、regressionRequired、reviewerRequired、maxQaRounds、maxReviewRounds、requirePrOrRp 七个字段；禁止在 executionPolicy 内输出 policyRationale、rationale、reason 等说明字段，策略理由应写入 description、acceptanceCriteria 或 aoPrompt。",
    "- implementation/refactor 任务必须保留开发自测、QA、回归、审查、PR/RP，且 maxQaRounds=maxReviewRounds=3。",
    "- design/review/docs/test/verification 任务可按 JSON 模板中的任务类型策略降低不适用环节，但必须说明在任务类型上合理。",
    "- 任务必须足够细：每个任务只覆盖一个清晰模块或一个可验证交付物；单个任务验收标准不得超过 7 条，超过必须拆分。",
    "- 先拆接口、协议、契约、测试骨架等前置任务，再拆实现任务；跨平台实现必须通过共享抽象或接口冻结任务避免并行冲突。",
    "- 依赖必须完整、无环、无未知 taskId；人工放行门禁使用 dependencyCondition=manual_gate。",
    "- 对需要仓库实读或人工确认的前置校准任务，必须设为独立任务，并让后续实现任务显式依赖它。",
    mode === "revise"
      ? "- 如果当前计划已有实施阶段遗留审查意见，整改后必须继续保留在任务、验收标准或 aoPrompt 约束中，不能丢失。"
      : "- 如果存在实施阶段遗留审查意见，必须在任务、验收标准或 aoPrompt 约束中体现，不能丢失。",
    mode === "revise"
      ? "- 如果审查意见 body 包含 [local-gate]，必须按结构性含义整改，例如重新分配 executionPolicy、补充前置契约任务、修正依赖或显式 manual_gate；禁止只把 finding id 追加进 acceptanceCriteria 后声称已整改。"
      : "- 本地门禁会校验任务计划结构，不要依赖文字承诺绕过 executionPolicy、依赖、manual_gate 或跨轮 finding 闭环。"
  ];
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

  async createTaskPlan(input: {
    workflowId: string;
    approvedDesign: string;
    deferredFindings?: DesignReview["findings"];
  }): Promise<TaskPlan> {
    const deferredCriteria = (input.deferredFindings ?? []).map(
      (finding) => `处理或明确遗留审查意见 ${finding.id}：${finding.title}`
    );
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
          acceptanceCriteria: ["实现内容符合最终设计稿", "相关测试通过", ...deferredCriteria],
          aoPrompt: [
            `[${input.workflowId} / TASK-001]`,
            "任务名称：根据已批准设计实现功能",
            "AO 角色：backend-senior",
            "验收标准：",
            "1. 实现内容符合最终设计稿。",
            "2. 相关测试通过。",
            ...deferredCriteria.map((criterion, index) => `${index + 3}. ${criterion}。`),
            "上下文摘要：",
            summarizeDesignForAoPrompt(input.approvedDesign),
            formatDeferredFindingsForAoPrompt(input.deferredFindings ?? [])
          ].join("\n"),
          executionPolicy: {
            ...getExecutionPolicyForTaskType("implementation")
          },
          status: "pending"
        }
      ]
    };
  }

  async reviseTaskPlan(input: { currentPlan: TaskPlan; review: TaskPlanReview }): Promise<TaskPlan> {
    const unresolved = input.review.findings.filter((finding) => finding.status === "unresolved");
    if (unresolved.length === 0) {
      return input.currentPlan;
    }

    return {
      ...input.currentPlan,
      tasks: input.currentPlan.tasks.map((task) => ({
        ...task,
        executionPolicy: {
          ...getExecutionPolicyForTaskType(task.type)
        },
        acceptanceCriteria: [
          ...task.acceptanceCriteria,
          ...unresolved.map((finding) => `已整改任务计划审查意见 ${finding.id}：${finding.title}`)
        ],
        aoPrompt: [
          task.aoPrompt,
          "",
          "任务计划审查整改：",
          ...unresolved.map((finding) => `- ${finding.id}：${finding.body}`)
        ].join("\n")
      }))
    };
  }
}

function parseTaskPlanOutput(rawOutput: string, errorMessage: string): TaskPlan {
  const jsonText = extractJsonObject(rawOutput, errorMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return taskPlanSchema.parse(normalizeCodexTaskPlanOutput(parsed));
}

function normalizeCodexTaskPlanOutput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    return value;
  }

  return {
    ...value,
    tasks: value.tasks.map((task) => {
      if (!isRecord(task)) {
        return task;
      }

      return {
        ...task,
        executionPolicy: normalizeCodexExecutionPolicy(task.type, task.executionPolicy)
      };
    })
  };
}

function normalizeCodexExecutionPolicy(type: unknown, policy: unknown): unknown {
  if (!isKnownTaskType(type) || policy === undefined) {
    return policy;
  }

  if (!isRecord(policy)) {
    return policy;
  }

  const fallbackPolicy = getExecutionPolicyForTaskType(type);
  const policyWithoutRationale = omitPolicyRationaleFields(policy);

  return {
    ...policyWithoutRationale,
    maxQaRounds: normalizeRoundLimit(policyWithoutRationale.maxQaRounds, fallbackPolicy.maxQaRounds),
    maxReviewRounds: normalizeRoundLimit(policyWithoutRationale.maxReviewRounds, fallbackPolicy.maxReviewRounds)
  };
}

function omitPolicyRationaleFields(policy: Record<string, unknown>): Record<string, unknown> {
  const { policyRationale: _policyRationale, rationale: _rationale, reason: _reason, ...policyWithoutRationale } = policy;
  return policyWithoutRationale;
}

function normalizeRoundLimit(value: unknown, fallback: ExecutionPolicy["maxQaRounds"]): ExecutionPolicy["maxQaRounds"] {
  return value === 1 || value === 2 || value === 3 ? value : fallback;
}

function isKnownTaskType(type: unknown): type is Parameters<typeof getExecutionPolicyForTaskType>[0] {
  return (
    type === "implementation" ||
    type === "test" ||
    type === "verification" ||
    type === "design" ||
    type === "review" ||
    type === "docs" ||
    type === "refactor"
  );
}

function extractJsonObject(rawOutput: string, errorMessage: string): string {
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error(errorMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeDesignForAoPrompt(design: string): string {
  const title = design.split("\n").find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim();
  return title
    ? `已批准设计：${title}。请参考已落盘最终设计稿完成实现。`
    : "请参考已落盘最终设计稿完成实现。";
}

function formatDeferredFindings(findings: DesignReview["findings"]): string {
  const unresolvedFindings = findings.filter((finding) => finding.status === "unresolved");
  if (unresolvedFindings.length === 0) {
    return "无。";
  }

  return unresolvedFindings
    .map((finding) =>
      [
        `- ${finding.id}｜${finding.severity}｜${finding.title}`,
        `  内容：${finding.body}`,
        finding.rationale ? `  理由：${finding.rationale}` : undefined
      ].filter(Boolean).join("\n")
    )
    .join("\n");
}

function formatDeferredFindingsForAoPrompt(findings: DesignReview["findings"]): string {
  const formatted = formatDeferredFindings(findings);
  return formatted === "无。" ? "" : `实施阶段遗留审查意见：\n${formatted}`;
}
