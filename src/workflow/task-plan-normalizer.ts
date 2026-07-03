import { z } from "zod";
import { aoRoleSchema, type AoRole } from "../schemas/ao-role.js";
import {
  getExecutionPolicyForTaskType,
  type ExecutionPolicy
} from "../schemas/execution-policy.js";
import {
  taskPlanSchema,
  taskPhaseSchema,
  taskTypeSchema,
  type TaskPlan
} from "../schemas/task-plan.js";

export type TaskPlanNormalizationSource = "codex" | "artifact" | "cli";
export type TaskPlanNormalizationOutcome = "passed" | "raw_failed" | "strict_failed";

export const TASK_PLAN_NORMALIZATION_SOURCES = ["codex", "artifact", "cli"] as const;
export const TASK_PLAN_NORMALIZATION_SOURCE = {
  codex: TASK_PLAN_NORMALIZATION_SOURCES[0],
  artifact: TASK_PLAN_NORMALIZATION_SOURCES[1],
  cli: TASK_PLAN_NORMALIZATION_SOURCES[2]
} as const;
export const taskPlanNormalizationSourceSchema = z.enum(TASK_PLAN_NORMALIZATION_SOURCES);
export const taskPlanNormalizationOutcomeSchema = z.enum(["passed", "raw_failed", "strict_failed"]);
export const taskPlanNormalizationIssueSchema = z.object({
  path: z.string().min(1),
  message: z.string().min(1)
});
export const taskPlanNormalizationChangeSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1)
}).transform((change) => {
  const record = change as Record<string, unknown>;
  return {
    path: change.path,
    from: record.from,
    to: record.to,
    reason: change.reason
  };
});
export const taskPlanNormalizationDroppedEntrySchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  value: z.custom<unknown>(() => true).optional()
});
export const taskPlanNormalizationSourceHistorySchema = z.object({
  round: z.number().int().nonnegative(),
  source: taskPlanNormalizationSourceSchema,
  reason: z.string().min(1)
});
export const taskPlanNormalizationReportSchema = z.object({
  workflowId: z.string().min(1),
  round: z.number().int().nonnegative(),
  generatedAt: z.string().min(1),
  source: taskPlanNormalizationSourceSchema,
  sourceHistory: z.array(taskPlanNormalizationSourceHistorySchema).optional(),
  rawSchemaErrors: z.array(taskPlanNormalizationIssueSchema),
  changes: z.array(taskPlanNormalizationChangeSchema),
  droppedEntries: z.array(taskPlanNormalizationDroppedEntrySchema),
  strictSchemaErrors: z.array(taskPlanNormalizationIssueSchema),
  outcome: taskPlanNormalizationOutcomeSchema
}).superRefine((report, context) => {
  const reasonsByRoundAndSource = new Map<string, string>();
  for (const [index, history] of (report.sourceHistory ?? []).entries()) {
    const key = `${history.round}:${history.source}`;
    const previousReason = reasonsByRoundAndSource.get(key);
    if (previousReason !== undefined && previousReason !== history.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceHistory", index, "reason"],
        message: "sourceHistory entries for the same round and source must use the same reason"
      });
    }
    reasonsByRoundAndSource.set(key, history.reason);
  }
});

export interface TaskPlanNormalizationIssue {
  path: string;
  message: string;
}

export interface TaskPlanNormalizationChange {
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
}

export interface TaskPlanNormalizationDroppedEntry {
  path: string;
  reason: string;
  value?: unknown;
}

export interface TaskPlanNormalizationSourceHistory {
  round: number;
  source: TaskPlanNormalizationSource;
  reason: string;
}

export interface TaskPlanNormalizationReport {
  workflowId: string;
  round: number;
  generatedAt: string;
  source: TaskPlanNormalizationSource;
  sourceHistory?: TaskPlanNormalizationSourceHistory[];
  rawSchemaErrors: TaskPlanNormalizationIssue[];
  changes: TaskPlanNormalizationChange[];
  droppedEntries: TaskPlanNormalizationDroppedEntry[];
  strictSchemaErrors: TaskPlanNormalizationIssue[];
  outcome: TaskPlanNormalizationOutcome;
}

export interface TaskPlanNormalizationContext {
  workflowId?: string;
  round?: number;
  source: TaskPlanNormalizationSource;
  generatedAt?: string;
}

export interface TaskPlanNormalizationResult {
  plan?: TaskPlan;
  report: TaskPlanNormalizationReport;
  rawValue?: unknown;
  normalizedValue?: unknown;
}

const rawExecutionTaskSchema = z
  .object({
    taskId: z.string().min(1),
    workflowId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    aoPrompt: z.string().min(1)
  })
  .passthrough();

export const rawTaskPlanSchema = z
  .object({
    workflowId: z.string().min(1),
    title: z.string().min(1),
    tasks: z.array(rawExecutionTaskSchema).min(1)
  })
  .passthrough();

const knownTaskTypes = new Set(taskTypeSchema.options);
const knownTaskPhases = new Set(taskPhaseSchema.options);
const knownAoRoles = new Set(aoRoleSchema.options);
const roundLimits = new Set([1, 2, 3]);
const executionPolicyFields = [
  "developerSelfTestRequired",
  "qaRequired",
  "regressionRequired",
  "reviewerRequired",
  "maxQaRounds",
  "maxReviewRounds",
  "requirePrOrRp"
] as const;
const executionPolicyRationaleFields = new Set(["policyRationale", "rationale", "reason"]);

const taskTypeAliases = {
  calibration: { type: "review", phase: "calibration" },
  planning: { type: "design", phase: "planning" },
  release: { type: "verification", phase: "release" },
  validation: { type: "verification" },
  verify: { type: "verification" },
  qa: { type: "test" }
} as const;

const aoRoleAliases = {
  "human-reviewer": "reviewer",
  "human-review": "reviewer",
  "manual-reviewer": "reviewer",
  "senior-backend": "backend-senior",
  "backend-lead": "backend-senior",
  "senior-frontend": "frontend-senior"
} as const;

const phaseLikeValues = new Set([
  "calibration",
  "planning",
  "implementation",
  "verification",
  "release"
]);

const reportByPlan = new WeakMap<TaskPlan, TaskPlanNormalizationReport>();

export function normalizeTaskPlanModelOutput(
  raw: unknown,
  context: TaskPlanNormalizationContext
): TaskPlanNormalizationResult {
  const rawResult = rawTaskPlanSchema.safeParse(raw);
  const report = createBaseReport(raw, context);
  if (!rawResult.success) {
    report.rawSchemaErrors = formatZodIssues(rawResult.error.issues);
    report.outcome = "raw_failed";
    return { report, rawValue: raw };
  }

  const normalizedValue = normalizeRawTaskPlan(rawResult.data, report);
  const strictResult = taskPlanSchema.safeParse(normalizedValue);
  if (!strictResult.success) {
    report.strictSchemaErrors = formatZodIssues(strictResult.error.issues);
    report.outcome = "strict_failed";
    return { report, rawValue: raw, normalizedValue };
  }

  report.outcome = "passed";
  report.workflowId = strictResult.data.workflowId;
  reportByPlan.set(strictResult.data, report);
  return {
    plan: strictResult.data,
    report,
    rawValue: raw,
    normalizedValue
  };
}

export function getTaskPlanNormalizationReport(plan: TaskPlan): TaskPlanNormalizationReport | undefined {
  return reportByPlan.get(plan);
}

export function cloneTaskPlanNormalizationReport(
  report: TaskPlanNormalizationReport,
  overrides: Partial<Pick<TaskPlanNormalizationReport, "round" | "generatedAt" | "source">> = {}
): TaskPlanNormalizationReport {
  return {
    ...report,
    ...overrides,
    rawSchemaErrors: [...report.rawSchemaErrors],
    changes: report.changes.map((change) => ({ ...change })),
    droppedEntries: report.droppedEntries.map((entry) => ({ ...entry })),
    ...(report.sourceHistory
      ? { sourceHistory: report.sourceHistory.map((entry) => ({ ...entry })) }
      : {}),
    strictSchemaErrors: [...report.strictSchemaErrors]
  };
}

export function parseTaskPlanWithNormalization(
  value: unknown,
  context: TaskPlanNormalizationContext,
  errorMessage = "Task plan JSON is invalid"
): TaskPlan {
  const result = normalizeTaskPlanModelOutput(value, context);
  if (result.plan) {
    return result.plan;
  }

  throw new TaskPlanNormalizationError(errorMessage, result.report, result.normalizedValue ?? result.rawValue);
}

export class TaskPlanNormalizationError extends Error {
  constructor(
    message: string,
    readonly report: TaskPlanNormalizationReport,
    readonly value: unknown
  ) {
    const errors = report.outcome === "raw_failed" ? report.rawSchemaErrors : report.strictSchemaErrors;
    super(`${message}: ${formatNormalizationErrors(errors)}`);
    this.name = "TaskPlanNormalizationError";
  }
}

function normalizeRawTaskPlan(
  rawPlan: z.output<typeof rawTaskPlanSchema>,
  report: TaskPlanNormalizationReport
): unknown {
  const taskIds = new Set(
    rawPlan.tasks
      .map((task) => task.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string" && taskId.trim().length > 0)
  );
  const normalizedTasks = rawPlan.tasks.map((task, index) => normalizeTask(task, index, report));
  const normalizedTrace = normalizeDesignCoverageTrace(rawPlan.designCoverageTrace, taskIds, report);

  return {
    ...rawPlan,
    ...(normalizedTrace === undefined ? { designCoverageTrace: undefined } : { designCoverageTrace: normalizedTrace }),
    tasks: normalizedTasks
  };
}

function normalizeTask(
  task: z.output<typeof rawExecutionTaskSchema>,
  index: number,
  report: TaskPlanNormalizationReport
): Record<string, unknown> {
  const path = (field: string) => `tasks.${index}.${field}`;
  const taskRecord = { ...task };
  const typeResult = normalizeTaskType(task.type);
  if (typeResult.type !== task.type) {
    addChange(report, path("type"), task.type, typeResult.type, "task type alias normalized to supported enum");
  }
  taskRecord.type = typeResult.type;

  const phase = normalizeTaskPhase(task.phase, typeResult.phase, report, path("phase"));
  if (phase !== undefined) {
    taskRecord.phase = phase;
  }

  taskRecord.aoRole = normalizeAoRole(task, taskRecord, index, report);
  taskRecord.executionPolicy = normalizeExecutionPolicy(taskRecord.type, task.executionPolicy, report, path("executionPolicy"));
  return taskRecord;
}

function normalizeTaskType(value: unknown): { type: unknown; phase?: string } {
  const normalized = normalizeToken(value);
  if (normalized && normalized in taskTypeAliases) {
    return taskTypeAliases[normalized as keyof typeof taskTypeAliases];
  }
  return { type: normalized ?? value };
}

function normalizeTaskPhase(
  rawPhase: unknown,
  inferredPhase: string | undefined,
  report: TaskPlanNormalizationReport,
  path: string
): unknown {
  const normalizedPhase = normalizeToken(rawPhase);
  if (isKnownTaskPhase(normalizedPhase)) {
    return normalizedPhase;
  }
  if (normalizedPhase && normalizedPhase !== rawPhase) {
    addChange(report, path, rawPhase, normalizedPhase, "task phase spelling normalized");
    return normalizedPhase;
  }
  if (inferredPhase) {
    addChange(report, path, rawPhase, inferredPhase, "task phase inferred from task type alias");
    return inferredPhase;
  }
  return rawPhase;
}

function normalizeAoRole(
  rawTask: z.output<typeof rawExecutionTaskSchema>,
  normalizedTask: Record<string, unknown>,
  index: number,
  report: TaskPlanNormalizationReport
): unknown {
  const rawRole = rawTask.aoRole;
  const path = `tasks.${index}.aoRole`;
  const normalized = normalizeToken(rawRole);
  if (isKnownAoRole(normalized)) {
    if (normalized !== rawRole) {
      addChange(report, path, rawRole, normalized, "AO role spelling normalized");
    }
    return normalized;
  }
  if (normalized && normalized in aoRoleAliases) {
    const role = aoRoleAliases[normalized as keyof typeof aoRoleAliases];
    addChange(report, path, rawRole, role, "AO role alias normalized to supported enum");
    return role;
  }
  if (normalized && phaseLikeValues.has(normalized)) {
    if (normalizedTask.phase === undefined || !isKnownTaskPhase(normalizedTask.phase)) {
      const previousPhase = normalizedTask.phase;
      normalizedTask.phase = normalized;
      addChange(report, `tasks.${index}.phase`, previousPhase, normalized, "phase-like AO role moved to task phase");
    }
    const inferred = inferAoRoleFromTask({
      ...rawTask,
      ...normalizedTask,
      aoRole: rawRole
    });
    addChange(report, path, rawRole, inferred, "phase-like AO role replaced with inferred execution role");
    return inferred;
  }

  return rawRole;
}

function normalizeDesignCoverageTrace(
  value: unknown,
  taskIds: ReadonlySet<string>,
  report: TaskPlanNormalizationReport
): unknown {
  if (value === undefined) {
    return value;
  }
  if (!Array.isArray(value)) {
    report.droppedEntries.push({
      path: "designCoverageTrace",
      reason: "designCoverageTrace is not an array",
      value
    });
    return undefined;
  }

  const normalized = value.flatMap((trace, index) => {
    if (!isRecord(trace)) {
      report.droppedEntries.push({
        path: `designCoverageTrace.${index}`,
        reason: "design coverage trace entry is not an object",
        value: trace
      });
      return [];
    }

    const requirementId = firstString(
      trace.requirementId,
      trace.id,
      trace.requirementKey,
      trace.key,
      inferKnownRequirementId(trace.requirement, trace.title, trace.description)
    );
    if (!requirementId) {
      report.droppedEntries.push({
        path: `designCoverageTrace.${index}`,
        reason: "requirementId cannot be inferred",
        value: trace
      });
      return [];
    }
    if (requirementId !== trace.requirementId) {
      addChange(report, `designCoverageTrace.${index}.requirementId`, trace.requirementId, requirementId, "requirementId alias or text inference applied");
    }

    return [{
      requirementId,
      requirement: firstString(trace.requirement, trace.title, trace.description, requirementId) ?? requirementId,
      source: firstString(trace.source, trace.sourceRef, trace.section, trace.quote, "approvedDesign") ?? "approvedDesign",
      status: normalizeDesignCoverageStatus(trace.status),
      evidenceTaskIds: normalizeEvidenceTaskIds(
        taskIds,
        report,
        `designCoverageTrace.${index}.evidenceTaskIds`,
        trace.evidenceTaskIds,
        trace.taskIds,
        trace.evidenceTasks,
        trace.taskId
      ),
      ...(typeof trace.rationale === "string" && trace.rationale.trim()
        ? { rationale: trace.rationale.trim() }
        : {})
    }];
  });

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDesignCoverageStatus(value: unknown): "covered" | "missing" | "deferred" {
  return value === "covered" || value === "deferred" ? value : "missing";
}

function normalizeEvidenceTaskIds(
  taskIds: ReadonlySet<string>,
  report: TaskPlanNormalizationReport,
  path: string,
  ...values: unknown[]
): string[] {
  const ids = values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value;
    }
    return value === undefined ? [] : [value];
  });
  const normalizedIds = ids
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const knownIds = [...new Set(normalizedIds.filter((taskId) => taskIds.has(taskId)))];
  const unknownIds = normalizedIds.filter((taskId) => !taskIds.has(taskId));
  if (unknownIds.length > 0) {
    report.droppedEntries.push({
      path,
      reason: `unknown evidence task ids removed: ${[...new Set(unknownIds)].join(", ")}`
    });
  }
  return knownIds;
}

function normalizeExecutionPolicy(
  type: unknown,
  policy: unknown,
  report: TaskPlanNormalizationReport,
  path: string
): unknown {
  if (!isKnownTaskType(type)) {
    return policy;
  }

  const fallback = getExecutionPolicyForTaskType(type);
  if (!isRecord(policy)) {
    addChange(report, path, policy, fallback, "executionPolicy missing or invalid; task-type default applied");
    return { ...fallback };
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (executionPolicyRationaleFields.has(key)) {
      report.droppedEntries.push({
        path: `${path}.${key}`,
        reason: "executionPolicy rationale field removed"
      });
      continue;
    }
    if (!executionPolicyFields.includes(key as (typeof executionPolicyFields)[number])) {
      report.droppedEntries.push({
        path: `${path}.${key}`,
        reason: "unsupported executionPolicy field removed"
      });
      continue;
    }
    normalized[key] = value;
  }

  const candidate: ExecutionPolicy = {
    developerSelfTestRequired: normalizeBooleanPolicyField(normalized.developerSelfTestRequired, fallback.developerSelfTestRequired),
    qaRequired: normalizeBooleanPolicyField(normalized.qaRequired, fallback.qaRequired),
    regressionRequired: normalizeBooleanPolicyField(normalized.regressionRequired, fallback.regressionRequired),
    reviewerRequired: normalizeBooleanPolicyField(normalized.reviewerRequired, fallback.reviewerRequired),
    maxQaRounds: normalizeRoundLimit(normalized.maxQaRounds, fallback.maxQaRounds),
    maxReviewRounds: normalizeRoundLimit(normalized.maxReviewRounds, fallback.maxReviewRounds),
    requirePrOrRp: normalizeBooleanPolicyField(normalized.requirePrOrRp, fallback.requirePrOrRp)
  };

  const restored = type === "implementation" || type === "refactor" ? { ...fallback } : candidate;
  if (JSON.stringify(restored) !== JSON.stringify(policy)) {
    addChange(report, path, policy, restored, "executionPolicy normalized for task type");
  }
  return restored;
}

function normalizeBooleanPolicyField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRoundLimit(value: unknown, fallback: ExecutionPolicy["maxQaRounds"]): ExecutionPolicy["maxQaRounds"] {
  return roundLimits.has(Number(value)) ? (Number(value) as ExecutionPolicy["maxQaRounds"]) : fallback;
}

function inferAoRoleFromTask(task: Record<string, unknown>): AoRole {
  if (task.phase === "release") {
    return "docs";
  }
  if (task.phase === "verification" || task.type === "test" || task.type === "verification") {
    return "qa";
  }
  if (task.phase === "planning" || task.type === "design") {
    return "architect";
  }
  if (task.dependencyCondition === "manual_gate" || task.type === "review") {
    return "reviewer";
  }
  if (task.type === "implementation" || task.type === "refactor") {
    return "backend-senior";
  }

  const text = [task.title, task.description, task.aoPrompt].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  if (/review|审核|复核|放行/.test(text)) {
    return "reviewer";
  }
  if (/design|architecture|架构|设计/.test(text)) {
    return "architect";
  }
  if (/test|qa|verify|verification|验证|测试|冒烟|回归/.test(text)) {
    return "qa";
  }
  if (/docs|doc|文档|release note|发布说明/.test(text)) {
    return "docs";
  }
  return "reviewer";
}

function inferKnownRequirementId(...values: unknown[]): string | undefined {
  const text = values.filter((value): value is string => typeof value === "string").join("\n");
  if (!text.trim()) {
    return undefined;
  }
  if (containsAny(text, ["G0", "Repo Reality Check", "仓库现实", "仓库校准", "预实施冻结", "人工复核"])) {
    return "g0-readiness-gate";
  }
  if (containsAny(text, ["JDK 21", "JAR", "依赖调用", "Gradle", "Maven"])) {
    return "java-jar-delivery";
  }
  if (containsAny(text, ["0700", "0600", "ACL", "/dev/shm", "ProgramData", "权限模型", "共享段"])) {
    return "shared-segment-permission";
  }
  if (containsAny(text, ["IPv4/IPv6", "IPv6"])) {
    return "ipv6-support";
  }
  if (containsAny(text, ["OutboundTransport", "send", "发包能力预留", "发送接口"])) {
    return "outbound-transport-reservation";
  }
  return undefined;
}

function createBaseReport(raw: unknown, context: TaskPlanNormalizationContext): TaskPlanNormalizationReport {
  return {
    workflowId: context.workflowId ?? inferWorkflowId(raw),
    round: context.round ?? 0,
    generatedAt: context.generatedAt ?? new Date().toISOString(),
    source: context.source,
    rawSchemaErrors: [],
    changes: [],
    droppedEntries: [],
    strictSchemaErrors: [],
    outcome: "strict_failed"
  };
}

function inferWorkflowId(value: unknown): string {
  if (isRecord(value) && typeof value.workflowId === "string" && value.workflowId.trim()) {
    return value.workflowId.trim();
  }
  return "unknown";
}

function addChange(
  report: TaskPlanNormalizationReport,
  path: string,
  from: unknown,
  to: unknown,
  reason: string
): void {
  report.changes.push({ path, from, to, reason });
}

function formatZodIssues(issues: z.ZodIssue[]): TaskPlanNormalizationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    message: issue.message
  }));
}

function formatNormalizationErrors(errors: TaskPlanNormalizationIssue[]): string {
  if (errors.length === 0) {
    return "unknown task plan normalization error";
  }
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function normalizeToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase().replace(/_/g, "-")
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownTaskType(type: unknown): type is Parameters<typeof getExecutionPolicyForTaskType>[0] {
  return typeof type === "string" && knownTaskTypes.has(type as Parameters<typeof getExecutionPolicyForTaskType>[0]);
}

function isKnownTaskPhase(value: unknown): value is z.infer<typeof taskPhaseSchema> {
  return typeof value === "string" && knownTaskPhases.has(value as z.infer<typeof taskPhaseSchema>);
}

function isKnownAoRole(value: unknown): value is AoRole {
  return typeof value === "string" && knownAoRoles.has(value as AoRole);
}

function containsAny(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}
