import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanApprovalReport } from "../schemas/task-plan-approval-report.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import {
  taskPlanSchema,
  type ExecutionTask,
  type TaskPlan
} from "../schemas/task-plan.js";

type DesignCoverageTrace = NonNullable<TaskPlan["designCoverageTrace"]>[number];

const manualGateTerms = ["人工", "复核", "放行", "确认", "审批", "决策", "切换", "授权", "等待"] as const;
const platformTerms = ["Linux", "Windows", "macOS", "io_uring", "epoll", "IOCP", "kqueue"] as const;
const g0GateTerms = [
  "G0",
  "Repo Reality Check",
  "仓库现实",
  "仓库校准",
  "预实施冻结稿",
  "不得进入文件级",
  "人工复核放行",
  "增量重构版"
] as const;
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
  approvalReport: TaskPlanApprovalReport;
}

export function validateTaskPlanApprovalGate(input: {
  workflowId: string;
  planVersion?: string;
  approvedDesign?: string;
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
    return {
      passed: false,
      findings,
      approvalReport: createTaskPlanApprovalReport({
        workflowId: input.workflowId,
        planVersion: input.planVersion ?? "task-plan-current",
        approved: false,
        approvedDesign: input.approvedDesign ?? "",
        plan: input.plan,
        findings
      })
    };
  }

  const plan = parsed.data;
  findings.push(...validateExecutionPolicies(plan));
  findings.push(...validateAoPromptContext(plan));
  findings.push(...validateManualGate(plan));
  findings.push(...validateReadinessAndG0Gate(input.approvedDesign ?? "", plan));
  findings.push(...validateArtifactDeliverables(input.approvedDesign ?? "", plan));
  findings.push(...validateCrossPlatformPrerequisites(plan));
  findings.push(...validateDeferredFindings(input.deferredFindings, plan));
  findings.push(...validatePreviousUnresolvedFindings(input.previousReviews, plan));

  return {
    passed: findings.length === 0,
    findings,
    approvalReport: createTaskPlanApprovalReport({
      workflowId: input.workflowId,
      planVersion: input.planVersion ?? "task-plan-current",
      approved: findings.length === 0,
      approvedDesign: input.approvedDesign ?? "",
      plan,
      findings
    })
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

function validateReadinessAndG0Gate(approvedDesign: string, plan: TaskPlan): TaskPlanGateFinding[] {
  if (!hasG0ReadinessSignal(approvedDesign, plan)) {
    return [];
  }

  const manualGateTasks = plan.tasks.filter((task) => task.dependencyCondition === "manual_gate");
  const missingManualGateFinding = validateG0ManualGateExists(manualGateTasks);
  if (missingManualGateFinding) {
    return [missingManualGateFinding];
  }

  return validatePostG0TaskDependencies(manualGateTasks, plan);
}

function hasG0ReadinessSignal(approvedDesign: string, plan: TaskPlan): boolean {
  const designRequiresG0 = containsAny(approvedDesign, g0GateTerms);
  const planCarriesG0 = plan.tasks.some((task) => containsAny(taskText(task), g0GateTerms));
  return designRequiresG0 || planCarriesG0;
}

function validateG0ManualGateExists(manualGateTasks: ExecutionTask[]): TaskPlanGateFinding | undefined {
  if (manualGateTasks.length > 0) {
    return undefined;
  }

  return {
    id: "TPG-G0-001",
    title: "G0 或预实施冻结语义缺少人工门禁",
    body: "设计稿或任务计划包含 G0、仓库现实校准、预实施冻结稿或人工复核放行语义，但任务计划没有 dependencyCondition=manual_gate 的人工门禁任务。",
    severity: "blocking",
    status: "unresolved",
    source: "local-gate"
  };
}

function validatePostG0TaskDependencies(manualGateTasks: ExecutionTask[], plan: TaskPlan): TaskPlanGateFinding[] {
  const manualGateIds = new Set(manualGateTasks.map((task) => task.taskId));
  const gatedTaskIds = new Set(
    plan.tasks
      .filter((task) => !manualGateIds.has(task.taskId) && !isG0CalibrationTask(task) && requiresPostG0Gate(task))
      .filter((task) => !dependsOnAny(task.taskId, manualGateIds, plan))
      .map((task) => task.taskId)
  );

  return gatedTaskIds.size > 0
    ? [
        {
          id: "TPG-G0-002",
          title: "G0 后续实施任务未被人工门禁阻塞",
          body: `存在 G0 或预实施冻结语义时，后续实现、重构、发布或平台实现任务必须直接或间接依赖人工门禁任务。未覆盖任务：${[...gatedTaskIds].join("、")}。`,
          severity: "blocking",
          status: "unresolved",
          source: "local-gate"
        }
      ]
    : [];
}

function validateArtifactDeliverables(approvedDesign: string, plan: TaskPlan): TaskPlanGateFinding[] {
  if (!approvedDesign.trim()) {
    return [];
  }

  const findings: TaskPlanGateFinding[] = [];
  const planText = plan.tasks.map(taskText).join("\n");

  if (
    containsAny(approvedDesign, ["JDK 21", "JAR", "依赖调用"]) &&
    !hasStructuredCoverage(plan, "java-jar-delivery") &&
    !hasJarDeliveryEvidence(planText)
  ) {
    findings.push({
      id: "TPG-COVERAGE-JAR",
      title: "设计要求 Java JAR 交付但任务计划缺少构建或发布验证",
      body: "设计稿包含 JDK 21、JAR 或依赖调用语义，但任务计划中没有 Java JAR 构建、打包、发布、Gradle/Maven 或示例依赖验证证据。",
      severity: "major",
      status: "unresolved",
      source: "local-gate"
    });
  }

  if (
    containsAny(approvedDesign, ["0700", "0600", "ACL", "/dev/shm", "ProgramData", "权限模型"]) &&
    !hasStructuredCoverage(plan, "shared-segment-permission") &&
    !hasSegmentPermissionEvidence(planText)
  ) {
    findings.push({
      id: "TPG-COVERAGE-PERMISSION",
      title: "设计要求共享段权限模型但任务计划缺少权限实现或验证",
      body: "设计稿包含共享段路径、0700、0600、ACL 或权限模型语义，但任务计划中没有共享段路径、文件权限、访问控制或跨平台权限验证证据。",
      severity: "major",
      status: "unresolved",
      source: "local-gate"
    });
  }

  if (
    containsAny(approvedDesign, ["IPv4/IPv6", "IPv6"]) &&
    !hasStructuredCoverage(plan, "ipv6-support") &&
    !containsAny(planText, ["IPv6", "ipv6"])
  ) {
    findings.push({
      id: "TPG-COVERAGE-IPV6",
      title: "设计要求 IPv4/IPv6 但任务计划缺少 IPv6 验收证据",
      body: "设计稿包含 IPv4/IPv6 或 IPv6 语义，但任务计划中没有 IPv6 实现、冒烟或验收证据。",
      severity: "major",
      status: "unresolved",
      source: "local-gate"
    });
  }

  if (
    containsAny(approvedDesign, ["OutboundTransport", "send", "发包能力预留"]) &&
    !hasStructuredCoverage(plan, "outbound-transport-reservation") &&
    !hasOutboundEvidence(planText)
  ) {
    findings.push({
      id: "TPG-COVERAGE-OUTBOUND",
      title: "设计要求发包能力预留但任务计划缺少落位或复核证据",
      body: "设计稿包含 OutboundTransport、send 或发包能力预留语义，但任务计划中没有发送接口预留落位、代码边界复核或明确不做代码落位的证据。",
      severity: "major",
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
    review.findings.filter(
      (finding) =>
        finding.status === "unresolved" &&
        (finding.severity === "blocking" || finding.severity === "major") &&
        !isLocalGateFinding(finding) &&
        !isSyntheticPreviousFinding(finding.id)
    )
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

function createTaskPlanApprovalReport(input: {
  workflowId: string;
  planVersion: string;
  approved: boolean;
  approvedDesign: string;
  plan: TaskPlan;
  findings: TaskPlanGateFinding[];
}): TaskPlanApprovalReport {
  const blockingFindingCount = input.findings.filter(
    (finding) => finding.status === "unresolved" && (finding.severity === "blocking" || finding.severity === "major")
  ).length;
  const dispatchSummary = summarizeDispatchability(input.plan, blockingFindingCount);
  const planReadiness = inferPlanReadiness(input.approvedDesign, input.plan, input.findings);
  return {
    workflowId: input.workflowId,
    planVersion: input.planVersion,
    generatedAt: new Date().toISOString(),
    approved: input.approved,
    planReadiness,
    dispatchSummary,
    designCoverageTrace: buildDesignCoverageTrace(input.approvedDesign, input.plan, input.findings),
    findingSummary: input.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      status: finding.status
    }))
  };
}

function inferPlanReadiness(
  approvedDesign: string,
  plan: TaskPlan,
  findings: TaskPlanGateFinding[]
): TaskPlanApprovalReport["planReadiness"] {
  const hasG0Finding = findings.some((finding) => finding.id.startsWith("TPG-G0"));
  const designRequiresG0 = containsAny(approvedDesign, g0GateTerms);
  if (hasG0Finding || (designRequiresG0 && plan.tasks.every((task) => task.phase === "calibration" || task.type === "review"))) {
    return "calibration_only";
  }
  if (designRequiresG0 || plan.tasks.some((task) => task.dependencyCondition === "manual_gate")) {
    return "gated_implementable";
  }
  return plan.planReadiness ?? "directly_implementable";
}

function summarizeDispatchability(
  plan: TaskPlan,
  blockingFindingCount: number
): TaskPlanApprovalReport["dispatchSummary"] {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.taskId));
  let dispatchableTaskCount = 0;
  let waitingTaskCount = 0;
  let manualGateTaskCount = 0;

  for (const task of plan.tasks) {
    if (task.status !== "pending") {
      continue;
    }
    if (task.dependencyCondition === "manual_gate") {
      manualGateTaskCount += 1;
      waitingTaskCount += 1;
      continue;
    }
    if (task.dependencies.length === 0) {
      dispatchableTaskCount += 1;
      continue;
    }
    const dependenciesSatisfied =
      task.dependencyCondition === "any_completed"
        ? task.dependencies.some((dependency) => completed.has(dependency))
        : task.dependencies.every((dependency) => completed.has(dependency));
    if (dependenciesSatisfied) {
      dispatchableTaskCount += 1;
    } else {
      waitingTaskCount += 1;
    }
  }

  return {
    dispatchableTaskCount,
    waitingTaskCount,
    manualGateTaskCount,
    blockingFindingCount
  };
}

function buildDesignCoverageTrace(
  approvedDesign: string,
  plan: TaskPlan,
  findings: TaskPlanGateFinding[]
): DesignCoverageTrace[] {
  const existing = new Map((plan.designCoverageTrace ?? []).map((trace) => [trace.requirementId, trace]));
  const findingIds = new Set(findings.map((finding) => finding.id));
  const entries: DesignCoverageTrace[] = [];

  addTraceIfRequired(entries, existing, approvedDesign, {
    requirementId: "g0-readiness-gate",
    requirement: "G0 / 预实施冻结稿必须被人工门禁承接",
    source: "approvedDesign",
    terms: g0GateTerms,
    missingFindingIds: ["TPG-G0-001", "TPG-G0-002"],
    evidenceTaskIds: findEvidenceTaskIds(plan, (task) => containsAny(taskText(task), g0GateTerms) || task.dependencyCondition === "manual_gate"),
    findingIds
  });
  addTraceIfRequired(entries, existing, approvedDesign, {
    requirementId: "java-jar-delivery",
    requirement: "JDK 21 JAR 构建、打包、发布或示例依赖验证",
    source: "approvedDesign",
    terms: ["JDK 21", "JAR", "依赖调用"],
    missingFindingIds: ["TPG-COVERAGE-JAR"],
    evidenceTaskIds: findEvidenceTaskIds(plan, (task) => hasJarDeliveryEvidence(taskText(task))),
    findingIds
  });
  addTraceIfRequired(entries, existing, approvedDesign, {
    requirementId: "shared-segment-permission",
    requirement: "共享段路径、文件权限、访问控制或跨平台权限验证",
    source: "approvedDesign",
    terms: ["0700", "0600", "ACL", "/dev/shm", "ProgramData", "权限模型"],
    missingFindingIds: ["TPG-COVERAGE-PERMISSION"],
    evidenceTaskIds: findEvidenceTaskIds(plan, (task) => hasSegmentPermissionEvidence(taskText(task))),
    findingIds
  });
  addTraceIfRequired(entries, existing, approvedDesign, {
    requirementId: "ipv6-support",
    requirement: "IPv6 实现、冒烟或验收证据",
    source: "approvedDesign",
    terms: ["IPv4/IPv6", "IPv6"],
    missingFindingIds: ["TPG-COVERAGE-IPV6"],
    evidenceTaskIds: findEvidenceTaskIds(plan, (task) => containsAny(taskText(task), ["IPv6", "ipv6"])),
    findingIds
  });
  addTraceIfRequired(entries, existing, approvedDesign, {
    requirementId: "outbound-transport-reservation",
    requirement: "OutboundTransport/send 发包能力预留落位或非一期边界复核",
    source: "approvedDesign",
    terms: ["OutboundTransport", "send", "发包能力预留"],
    missingFindingIds: ["TPG-COVERAGE-OUTBOUND"],
    evidenceTaskIds: findEvidenceTaskIds(plan, (task) => hasOutboundEvidence(taskText(task))),
    findingIds
  });

  return entries;
}

function addTraceIfRequired(
  entries: DesignCoverageTrace[],
  existing: ReadonlyMap<string, DesignCoverageTrace>,
  approvedDesign: string,
  input: {
    requirementId: string;
    requirement: string;
    source: string;
    terms: readonly string[];
    missingFindingIds: readonly string[];
    evidenceTaskIds: string[];
    findingIds: ReadonlySet<string>;
  }
): void {
  if (!containsAny(approvedDesign, input.terms) && !existing.has(input.requirementId)) {
    return;
  }
  const existingTrace = existing.get(input.requirementId);
  const hasMissingFinding = input.missingFindingIds.some((findingId) => input.findingIds.has(findingId));
  entries.push({
    requirementId: input.requirementId,
    requirement: existingTrace?.requirement ?? input.requirement,
    source: existingTrace?.source ?? input.source,
    status: hasMissingFinding ? "missing" : existingTrace?.status ?? "covered",
    evidenceTaskIds: existingTrace?.evidenceTaskIds.length ? existingTrace.evidenceTaskIds : input.evidenceTaskIds,
    rationale: hasMissingFinding
      ? "本地门禁未找到足够任务证据。"
      : existingTrace?.rationale ?? "本地门禁已找到任务证据。"
  });
}

function findEvidenceTaskIds(plan: TaskPlan, predicate: (task: ExecutionTask) => boolean): string[] {
  return plan.tasks.filter(predicate).map((task) => task.taskId);
}

function hasStructuredCoverage(plan: TaskPlan, requirementId: string): boolean {
  return (plan.designCoverageTrace ?? []).some(
    (trace) => trace.requirementId === requirementId && trace.status === "covered" && trace.evidenceTaskIds.length > 0
  );
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

function requiresPostG0Gate(task: ExecutionTask): boolean {
  const text = taskText(task);
  return (
    task.type === "implementation" ||
    task.type === "refactor" ||
    containsAny(text, ["重构", "发布", "release", "JAR", "Gradle", "Maven", "io_uring", "epoll", "IOCP", "kqueue"])
  );
}

function isG0CalibrationTask(task: ExecutionTask): boolean {
  const text = taskText(task);
  return (
    task.phase === "calibration" ||
    (containsAny(text, ["G0", "Repo Reality Check", "仓库现实校准", "校准"]) &&
      containsAny(text, ["校准", "盘点", "现实", "readiness", "Reality Check"]))
  );
}

function isSyntheticPreviousFinding(findingId: string): boolean {
  return findingId.startsWith("TPG-PREVIOUS-");
}

function isLocalGateFinding(finding: { id: string; body?: string }): boolean {
  return finding.id.startsWith("TPG-") || finding.body?.includes("[local-gate]") === true;
}

function dependsOnAny(taskId: string, dependencyIds: ReadonlySet<string>, plan: TaskPlan): boolean {
  const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const visited = new Set<string>();
  const visit = (currentTaskId: string): boolean => {
    if (visited.has(currentTaskId)) {
      return false;
    }
    visited.add(currentTaskId);
    const task = taskById.get(currentTaskId);
    if (!task) {
      return false;
    }
    return task.dependencies.some((dependency) => dependencyIds.has(dependency) || visit(dependency));
  };

  return visit(taskId);
}

function hasJarDeliveryEvidence(text: string): boolean {
  return containsAny(text, ["JAR", "jar"]) && containsAny(text, ["Gradle", "Maven", "构建", "打包", "发布", "依赖验证", "示例依赖"]);
}

function hasSegmentPermissionEvidence(text: string): boolean {
  return containsAny(text, ["权限", "访问控制", "ACL", "0700", "0600"]) && containsAny(text, ["共享段", "段路径", "段文件", "segment", "跨平台"]);
}

function hasOutboundEvidence(text: string): boolean {
  return containsAny(text, ["OutboundTransport", "send", "发送接口", "发包能力", "接口兼容位"]) && containsAny(text, ["预留", "落位", "复核", "不做代码落位", "兼容位"]);
}
