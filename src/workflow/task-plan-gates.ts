import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import { taskPlanSchema, type ExecutionTask, type TaskPlan } from "../schemas/task-plan.js";

const manualGateTerms = ["人工", "复核", "放行", "确认", "审批", "决策", "切换", "授权", "等待"] as const;
const platformTerms = ["Linux", "Windows", "macOS", "io_uring", "epoll", "IOCP", "kqueue"] as const;
const prerequisiteTerms = [
  "共享",
  "接口",
  "契约",
  "协议",
  "约定",
  "基线",
  "标准",
  "测试骨架",
  "feature matrix",
  "cfg",
  "harness",
  "冒烟矩阵",
  "文档同步"
] as const;

export interface TaskPlanGateFinding {
  id: string;
  title: string;
  body: string;
  severity: "blocking" | "major" | "minor" | "warning" | "observation";
  status: "unresolved" | "addressed" | "accepted_as_is";
  rationale?: string;
  source: "local-gate";
}

export interface TaskPlanGateResult {
  passed: boolean;
  findings: TaskPlanGateFinding[];
}

export function validateTaskPlanApprovalGate(input: {
  workflowId: string;
  deferredFindings: DesignReview["findings"];
  plan: TaskPlan;
  previousReviews: TaskPlanReview[];
}): TaskPlanGateResult {
  const findings: TaskPlanGateFinding[] = [];
  const parsed = taskPlanSchema.safeParse(input.plan);

  if (!parsed.success) {
    findings.push({
      id: "TPG-SCHEMA-001",
      title: "task-plan 未通过结构化校验",
      body: parsed.error.issues.map((issue) => `${issue.path.join(".") || "task-plan"}: ${issue.message}`).join("\n"),
      severity: "blocking",
      status: "unresolved",
      source: "local-gate"
    });
    return { passed: false, findings };
  }

  const plan = parsed.data;
  findings.push(...validateExecutionPolicies(plan));
  findings.push(...validateAoPromptContext(plan));
  findings.push(...validateManualGate(plan));
  findings.push(...validateCrossPlatformPrerequisites(plan));
  findings.push(...validateDeferredFindings(input.deferredFindings, plan));
  findings.push(...validatePreviousUnresolvedFindings(input.previousReviews, plan));

  return {
    passed: findings.length === 0,
    findings
  };
}

export function createLocalGateReview(input: {
  workflowId: string;
  round: number;
  planVersion: string;
  gate: TaskPlanGateResult;
}): TaskPlanReview {
  return {
    workflowId: input.workflowId,
    round: input.round,
    planner: "codex",
    reviewer: "claude-code",
    planVersion: input.planVersion,
    reviewDecision: "changes_requested",
    findings: input.gate.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      body: `[local-gate] ${finding.body}`,
      severity: finding.severity,
      status: finding.status,
      rationale: finding.rationale
    }))
  };
}

function validateExecutionPolicies(plan: TaskPlan): TaskPlanGateFinding[] {
  const findings: TaskPlanGateFinding[] = [];
  const serializedPolicies = plan.tasks.map((task) => JSON.stringify(task.executionPolicy));
  const allSamePolicy = new Set(serializedPolicies).size === 1;
  const allDefaultPolicy = plan.tasks.every((task) => JSON.stringify(task.executionPolicy) === JSON.stringify(defaultExecutionPolicy));

  if (plan.tasks.length > 1 && (allSamePolicy || allDefaultPolicy)) {
    findings.push({
      id: "TPG-POLICY-001",
      title: "executionPolicy 缺少差异化",
      body: "任务计划包含多个任务，但所有任务使用同一套 executionPolicy。请按任务类型和子任务特征显式设置自测、QA、回归、审查轮次与 PR/RP 策略。",
      severity: "blocking",
      status: "unresolved",
      source: "local-gate"
    });
  }

  return findings;
}

function validateAoPromptContext(plan: TaskPlan): TaskPlanGateFinding[] {
  const findings: TaskPlanGateFinding[] = [];
  const requiredPromptParts = [
    { label: "workflowId", test: (task: ExecutionTask) => task.aoPrompt.includes(task.workflowId) },
    { label: "taskId", test: (task: ExecutionTask) => task.aoPrompt.includes(task.taskId) },
    { label: "任务名称", test: (task: ExecutionTask) => task.aoPrompt.includes("任务名称") || task.aoPrompt.includes(task.title) },
    { label: "AO 角色", test: (task: ExecutionTask) => task.aoPrompt.includes("AO 角色") || task.aoPrompt.includes("aoRole") },
    { label: "验收标准", test: (task: ExecutionTask) => task.aoPrompt.includes("验收标准") },
    { label: "上下文摘要", test: (task: ExecutionTask) => task.aoPrompt.includes("上下文摘要") }
  ];

  for (const task of plan.tasks) {
    const missing = requiredPromptParts.filter((part) => !part.test(task)).map((part) => part.label);
    if (missing.length > 0) {
      findings.push({
        id: `TPG-PROMPT-${task.taskId}`,
        title: `${task.taskId} 的 aoPrompt 缺少必要上下文`,
        body: `${task.taskId} 的 aoPrompt 缺少：${missing.join("、")}。`,
        severity: "major",
        status: "unresolved",
        source: "local-gate"
      });
    }
  }

  return findings;
}

function validateManualGate(plan: TaskPlan): TaskPlanGateFinding[] {
  const findings: TaskPlanGateFinding[] = [];
  const manualGateTasks = plan.tasks.filter((task) => task.dependencyCondition === "manual_gate");
  const needsManualGate = plan.tasks.some((task) => containsAny(taskText(task), manualGateTerms));

  if (needsManualGate && manualGateTasks.length === 0) {
    findings.push({
      id: "TPG-GATE-001",
      title: "需要人工确认的前置任务缺少 manual_gate",
      body: "任务计划包含人工复核、放行或确认语义，但没有任何任务使用 dependencyCondition=manual_gate。",
      severity: "blocking",
      status: "unresolved",
      source: "local-gate"
    });
  }

  return findings;
}

function validateCrossPlatformPrerequisites(plan: TaskPlan): TaskPlanGateFinding[] {
  const platformImplementationTasks = plan.tasks.filter(
    (task) => isImplementationTask(task) && containsAny(taskText(task), platformTerms)
  );

  if (platformImplementationTasks.length < 2) {
    return [];
  }

  const prerequisiteTasks = plan.tasks.filter(
    (task) =>
      !isImplementationTask(task) &&
      containsAny(taskText(task), prerequisiteTerms)
  );

  if (prerequisiteTasks.length === 0) {
    return [
      {
        id: "TPG-XPLAT-001",
        title: "跨平台并行实现缺少共享契约前置任务",
        body: "任务计划包含多个跨平台实现任务，但没有发现共享接口、协议、契约或测试骨架冻结任务。",
        severity: "blocking",
        status: "unresolved",
        source: "local-gate"
      }
    ];
  }

  const prerequisiteIds = new Set(prerequisiteTasks.map((task) => task.taskId));
  const uncovered = platformImplementationTasks.filter((task) => !task.dependencies.some((dependency) => prerequisiteIds.has(dependency)));
  if (uncovered.length === 0) {
    return [];
  }

  return [
    {
      id: "TPG-XPLAT-002",
      title: "跨平台实现任务未依赖共享契约前置任务",
      body: `以下跨平台实现任务没有直接依赖共享契约、测试骨架或平台矩阵任务：${uncovered.map((task) => task.taskId).join("、")}。`,
      severity: "blocking",
      status: "unresolved",
      source: "local-gate"
    }
  ];
}

function validateDeferredFindings(deferredFindings: DesignReview["findings"], plan: TaskPlan): TaskPlanGateFinding[] {
  return deferredFindings
    .filter((finding) => finding.severity === "blocking" || finding.severity === "major")
    .filter((finding) => !hasFindingEvidence(finding, plan))
    .map((finding) => ({
      id: `TPG-DEFERRED-${finding.id}`,
      title: `设计遗留项未被任务计划承接：${finding.id}`,
      body: `设计审查遗留项 ${finding.id}（${finding.title}）没有在任务标题、描述、验收标准或 aoPrompt 中找到承接证据。`,
      severity: "blocking" as const,
      status: "unresolved" as const,
      rationale: finding.rationale,
      source: "local-gate" as const
    }));
}

function validatePreviousUnresolvedFindings(previousReviews: TaskPlanReview[], plan: TaskPlan): TaskPlanGateFinding[] {
  const unresolved = previousReviews.flatMap((review) =>
    review.findings.filter((finding) => finding.status === "unresolved" && (finding.severity === "blocking" || finding.severity === "major"))
  );
  const latestById = new Map(unresolved.map((finding) => [finding.id, finding]));

  return [...latestById.values()]
    .filter((finding) => !hasFindingEvidence(finding, plan))
    .map((finding) => ({
      id: `TPG-PREVIOUS-${finding.id}`,
      title: `上一轮任务计划审查问题未闭环：${finding.id}`,
      body: `上一轮 unresolved ${finding.severity} finding（${finding.title}）没有在新版任务计划中找到承接证据。`,
      severity: "blocking" as const,
      status: "unresolved" as const,
      rationale: finding.rationale,
      source: "local-gate" as const
    }));
}

function hasFindingEvidence(finding: { id: string; title: string; body: string }, plan: TaskPlan): boolean {
  const searchablePlan = normalize(plan.tasks.map(taskText).join("\n"));
  if (searchablePlan.includes(normalize(finding.id))) {
    return true;
  }

  const keywords = extractKeywords(`${finding.title}\n${finding.body}`);
  if (keywords.length === 0) {
    return true;
  }

  // Cap keyword scan to the most salient tokens so broad findings stay cheap to match while still requiring evidence.
  const matched = keywords.filter((keyword) => searchablePlan.includes(keyword));
  return matched.length >= Math.min(2, keywords.length);
}

function extractKeywords(text: string): string[] {
  const normalized = normalize(text);
  const tokens = normalized.match(/[a-z0-9_./-]{4,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
  const stopWords = new Set([
    "task",
    "finding",
    "unresolved",
    "changes_requested",
    "accepted_as_is",
    "status",
    "severity",
    "任务",
    "审查",
    "问题",
    "需要",
    "必须",
    "当前",
    "实现",
    "计划",
    "没有",
    "缺少",
    "输出"
  ]);
  return [...new Set(tokens.filter((token) => !stopWords.has(token)))].slice(0, 8);
}

function taskText(task: ExecutionTask): string {
  return [
    task.taskId,
    task.title,
    task.description,
    task.type,
    task.dependencyCondition,
    task.aoRole,
    task.dependencies.join(" "),
    task.acceptanceCriteria.join("\n"),
    task.aoPrompt
  ].join("\n");
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function containsAny(text: string, terms: readonly string[]): boolean {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
}

function isImplementationTask(task: ExecutionTask): boolean {
  return task.type === "implementation" || task.type === "refactor";
}
