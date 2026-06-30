import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import { execa } from "execa";
import { designReviewSchema } from "../schemas/design-review.js";
import { taskPlanReviewSchema } from "../schemas/task-plan-review.js";

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly causeDetail?: unknown
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface ClaudeCodeAdapter {
  reviewDesign(input: {
    workflowId: string;
    round: number;
    designVersion: string;
    design: string;
  }, options?: { signal?: AbortSignal }): Promise<DesignReview>;
  reviewTaskPlan(input: {
    workflowId: string;
    round: number;
    planVersion: string;
    plan: TaskPlan;
    approvedDesign: string;
  }, options?: { signal?: AbortSignal }): Promise<TaskPlanReview>;
}

export interface ClaudeCodeCliAdapterOptions {
  projectRoot?: string;
  claudeBin?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  structuredOutputRepairAttempts?: number;
}

export class ClaudeCodeCliAdapter implements ClaudeCodeAdapter {
  constructor(private readonly options: ClaudeCodeCliAdapterOptions = {}) {}

  async reviewDesign(input: {
    workflowId: string;
    round: number;
    designVersion: string;
    design: string;
  }, options: { signal?: AbortSignal } = {}): Promise<DesignReview> {
    const rawOutput = await this.runClaude([
      "你是需求治理层的 ClaudeCode 设计审查员。请审查 Codex 生成的设计稿。",
      "",
      "必须只输出一个 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字。",
      "JSON 必须符合以下 TypeScript 形状：",
      "{",
      '  "workflowId": "string",',
      '  "round": number,',
      '  "designer": "codex",',
      '  "reviewer": "claude-code",',
      '  "designVersion": "string",',
      '  "reviewDecision": "approved" | "changes_requested" | "defer_to_implementation",',
      '  "findings": [{',
      '    "id": "DRF-001",',
      '    "title": "string",',
      '    "body": "string",',
      '    "severity": "blocking" | "major" | "minor" | "warning" | "observation",',
      '    "status": "addressed" | "accepted_as_is" | "unresolved",',
      '    "rationale": "optional string"',
      "  }]",
      "}",
      "",
      "审查规则：",
      "- 如果设计缺少关键章节、风险、验收或可实施性信息，输出 changes_requested。",
      "- 如果设计整体可实施，但仍有适合在实施阶段解决的问题，输出 defer_to_implementation。",
      "- 只能输出上面列出的三种 reviewDecision；人工介入由系统根据轮次控制。",
      "- approved 时不得包含 unresolved finding。",
      "- changes_requested 时至少包含一个 unresolved finding。",
      "- defer_to_implementation 时可以包含 unresolved finding，但 finding 必须描述应进入实施阶段处理的问题。",
      "",
      `workflowId: ${input.workflowId}`,
      `round: ${input.round}`,
      `designVersion: ${input.designVersion}`,
      "",
      "设计稿：",
      input.design
    ].join("\n"), options);

    try {
      return await parseStructuredOutputWithRepair({
        rawOutput,
        schema: designReviewSchema,
        errorMessage: `ClaudeCode review JSON is invalid for round ${input.round} (${input.designVersion})`,
        repairAttempts: this.options.structuredOutputRepairAttempts ?? 1,
        repair: async ({ error, rawOutput: invalidOutput }) =>
          this.runClaude([
            "你刚才作为 ClaudeCode 设计审查员的输出没有通过结构化 JSON 校验。",
            "请把上一条审查输出修复为严格 JSON。只能输出 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字。",
            "",
            "修复规则：",
            "- 不要重新审查设计稿，只把上一条审查结论和 findings 转换为合法 JSON。",
            "- 如果上一条输出表达仍需整改，reviewDecision 必须是 changes_requested。",
            "- 如果上一条输出表达设计已可实施但仍有实施阶段遗留项，reviewDecision 必须是 defer_to_implementation。",
            "- 只能输出上面列出的三种 reviewDecision；如上一条输出表达需要人工判断，请转换为 changes_requested。",
            "- changes_requested 时至少包含一个 finding.status 为 unresolved 的 finding。",
            "- approved 时 findings 中不得包含 unresolved。",
            "- 缺少字段时，使用下面提供的 workflowId、round、designVersion 补齐。",
            "",
            "JSON 必须符合以下 TypeScript 形状：",
            "{",
            '  "workflowId": "string",',
            '  "round": number,',
            '  "designer": "codex",',
            '  "reviewer": "claude-code",',
            '  "designVersion": "string",',
            '  "reviewDecision": "approved" | "changes_requested" | "defer_to_implementation",',
            '  "findings": [{',
            '    "id": "DRF-001",',
            '    "title": "string",',
            '    "body": "string",',
            '    "severity": "blocking" | "major" | "minor" | "warning" | "observation",',
            '    "status": "addressed" | "accepted_as_is" | "unresolved",',
            '    "rationale": "optional string"',
            "  }]",
            "}",
            "",
            `workflowId: ${input.workflowId}`,
            `round: ${input.round}`,
            `designVersion: ${input.designVersion}`,
            `校验错误：${error.message}`,
            "",
            "上一条无效输出：",
            invalidOutput
          ].join("\n"), options)
      });
    } catch (error) {
      if (error instanceof StructuredOutputError) {
        return createReviewFromUnstructuredOutput(input, error.rawOutput);
      }
      throw error;
    }
  }

  async reviewTaskPlan(
    input: {
      workflowId: string;
      round: number;
      planVersion: string;
      plan: TaskPlan;
      approvedDesign: string;
    },
    options: { signal?: AbortSignal } = {}
  ): Promise<TaskPlanReview> {
    const rawOutput = await this.runClaude([
      "你是需求治理层的 ClaudeCode 任务计划审查员。请审查 Codex 生成的 AO 执行层 task-plan。",
      "",
      "必须只输出一个 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字。",
      "JSON 必须符合以下 TypeScript 形状：",
      "{",
      '  "workflowId": "string",',
      '  "round": number,',
      '  "planner": "codex",',
      '  "reviewer": "claude-code",',
      '  "planVersion": "string",',
      '  "reviewDecision": "approved" | "changes_requested",',
      '  "findings": [{',
      '    "id": "TPF-001",',
      '    "title": "string",',
      '    "body": "string",',
      '    "severity": "blocking" | "major" | "minor" | "warning" | "observation",',
      '    "status": "addressed" | "accepted_as_is" | "unresolved",',
      '    "rationale": "optional string"',
      "  }]",
      "}",
      "",
      "审查规则：",
      "- 只审查 task-plan 是否可安全下发给 AO 执行层，不重新设计需求。",
      "- 如果任务计划缺少关键任务、依赖错误、验收标准不可验证、AO 角色不合适、aoPrompt 缺少上下文，输出 changes_requested。",
      "- 如果 task-plan 中出现 agent、model、provider、codex、claudeCode 字段，或 aoPrompt 要求 worker 选择具体 agent/model，输出 changes_requested。",
      "- 如果 task-plan 已可执行且符合 AO 内置角色约束，输出 approved。",
      "- approved 时不得包含 unresolved finding。",
      "- changes_requested 时至少包含一个 unresolved finding。",
      "",
      `workflowId: ${input.workflowId}`,
      `round: ${input.round}`,
      `planVersion: ${input.planVersion}`,
      "",
      "task-plan JSON：",
      JSON.stringify(input.plan, null, 2),
      "",
      "已批准设计稿：",
      input.approvedDesign
    ].join("\n"), options);

    return parseStructuredOutputWithRepair({
      rawOutput,
      schema: taskPlanReviewSchema,
      errorMessage: `ClaudeCode task plan review JSON is invalid for round ${input.round} (${input.planVersion})`,
      repairAttempts: this.options.structuredOutputRepairAttempts ?? 1,
      repair: async ({ error, rawOutput: invalidOutput }) =>
        this.runClaude([
          "你刚才作为 ClaudeCode 任务计划审查员的输出没有通过结构化 JSON 校验。",
          "请把上一条审查输出修复为严格 JSON。只能输出 JSON 对象，不要使用 Markdown 代码块，不要输出解释文字。",
          "",
          "修复规则：",
          "- 不要重新审查 task-plan，只把上一条审查结论和 findings 转换为合法 JSON。",
          "- 如果上一条输出表达仍需整改，reviewDecision 必须是 changes_requested。",
          "- 如果上一条输出表达计划可执行，reviewDecision 必须是 approved。",
          "- changes_requested 时至少包含一个 finding.status 为 unresolved 的 finding。",
          "- approved 时 findings 中不得包含 unresolved。",
          "- 缺少字段时，使用下面提供的 workflowId、round、planVersion 补齐。",
          "",
          "JSON 必须符合以下 TypeScript 形状：",
          "{",
          '  "workflowId": "string",',
          '  "round": number,',
          '  "planner": "codex",',
          '  "reviewer": "claude-code",',
          '  "planVersion": "string",',
          '  "reviewDecision": "approved" | "changes_requested",',
          '  "findings": [{',
          '    "id": "TPF-001",',
          '    "title": "string",',
          '    "body": "string",',
          '    "severity": "blocking" | "major" | "minor" | "warning" | "observation",',
          '    "status": "addressed" | "accepted_as_is" | "unresolved",',
          '    "rationale": "optional string"',
          "  }]",
          "}",
          "",
          `workflowId: ${input.workflowId}`,
          `round: ${input.round}`,
          `planVersion: ${input.planVersion}`,
          `校验错误：${error.message}`,
          "",
          "上一条无效输出：",
          invalidOutput
        ].join("\n"), options)
    });
  }

  private async runClaude(prompt: string, options: { signal?: AbortSignal }): Promise<string> {
    const args = [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
      "--effort",
      this.options.effort ?? "high",
      ...(this.options.model ? ["--model", this.options.model] : [])
    ];

    const result = await execa(this.options.claudeBin ?? "claude", args, {
      cwd: this.options.projectRoot,
      cancelSignal: options.signal,
      input: prompt,
      reject: false
    });

    if (options.signal?.aborted) {
      throw new Error("Workflow was stopped by user");
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "ClaudeCode CLI failed");
    }

    if (!result.stdout.trim()) {
      throw new StructuredOutputError("ClaudeCode CLI returned empty output", result.stdout);
    }

    return result.stdout;
  }
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

  async reviewTaskPlan(input: {
    workflowId: string;
    round: number;
    planVersion: string;
    plan: TaskPlan;
  }): Promise<TaskPlanReview> {
    if (input.plan.workflowId !== input.workflowId) {
      return {
        workflowId: input.workflowId,
        round: input.round,
        planner: "codex",
        reviewer: "claude-code",
        planVersion: input.planVersion,
        reviewDecision: "changes_requested",
        findings: [
          {
            id: "TPF-001",
            title: "任务计划 workflowId 不一致",
            body: "task-plan.workflowId 必须与当前 workflowId 一致。",
            severity: "blocking",
            status: "unresolved"
          }
        ]
      };
    }

    return {
      workflowId: input.workflowId,
      round: input.round,
      planner: "codex",
      reviewer: "claude-code",
      planVersion: input.planVersion,
      reviewDecision: "approved",
      findings: []
    };
  }
}

export function parseStructuredOutput<T>(
  rawOutput: string,
  schema: { parse(value: unknown): T },
  errorMessage: string
): T {
  const jsonText = extractJsonObject(rawOutput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new StructuredOutputError(errorMessage, rawOutput, error);
  }

  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new StructuredOutputError(errorMessage, rawOutput, error);
  }
}

export function createReviewFromUnstructuredOutput(
  input: {
    workflowId: string;
    round: number;
    designVersion: string;
  },
  rawOutput: string
): DesignReview {
  return {
    workflowId: input.workflowId,
    round: input.round,
    designer: "codex",
    reviewer: "claude-code",
    designVersion: input.designVersion,
    reviewDecision: "changes_requested",
    findings: [
      {
        id: "DRF-UNSTRUCTURED-001",
        title: "ClaudeCode 审查输出未符合结构化 JSON，已按原文纳入整改",
        body: rawOutput.trim() || "ClaudeCode 审查输出为空或无法解析。",
        severity: "major",
        status: "unresolved",
        rationale: "为避免审查流程因输出格式中断，将非结构化审查内容作为未解决意见交由 Codex 继续整改。"
      }
    ]
  };
}

export async function parseStructuredOutputWithRepair<T>(input: {
  rawOutput: string;
  schema: { parse(value: unknown): T };
  errorMessage: string;
  repairAttempts?: number;
  repair: (input: {
    attempt: number;
    rawOutput: string;
    error: StructuredOutputError;
  }) => Promise<string>;
}): Promise<T> {
  const repairAttempts = Math.max(0, input.repairAttempts ?? 0);
  const outputs: Array<{ label: string; output: string }> = [
    { label: "initial-output", output: input.rawOutput }
  ];
  let currentOutput = input.rawOutput;
  let lastError: StructuredOutputError | undefined;

  for (let attempt = 0; attempt <= repairAttempts; attempt += 1) {
    try {
      return parseStructuredOutput(currentOutput, input.schema, input.errorMessage);
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) {
        throw error;
      }

      lastError = error;
      if (attempt === repairAttempts) {
        throw new StructuredOutputError(
          `${input.errorMessage} after ${outputs.length} attempt(s): ${error.message}`,
          formatStructuredOutputAttempts(outputs),
          error.causeDetail
        );
      }

      currentOutput = await input.repair({
        attempt: attempt + 1,
        rawOutput: currentOutput,
        error
      });
      outputs.push({
        label: `repair-output-${attempt + 1}`,
        output: currentOutput
      });
    }
  }

  throw new StructuredOutputError(
    `${input.errorMessage}: ${lastError?.message ?? "unknown structured output error"}`,
    formatStructuredOutputAttempts(outputs),
    lastError?.causeDetail
  );
}

function formatStructuredOutputAttempts(outputs: Array<{ label: string; output: string }>): string {
  return outputs.map((entry) => `--- ${entry.label} ---\n${entry.output}`).join("\n\n");
}

function extractJsonObject(rawOutput: string): string {
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

  throw new StructuredOutputError("ClaudeCode output does not contain a JSON object", rawOutput);
}
