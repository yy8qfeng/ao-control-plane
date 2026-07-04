import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError, ZodIssueCode, type ZodIssue } from "zod";
import type { DesignReview } from "../schemas/design-review.js";
import type { Requirement } from "../schemas/requirement.js";
import type { TaskPlanApprovalReport } from "../schemas/task-plan-approval-report.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import type { Workflow } from "../schemas/workflow.js";
import {
  TASK_PLAN_NORMALIZATION_SOURCE,
  normalizeTaskPlanModelOutput,
  parseTaskPlanWithNormalization,
  taskPlanNormalizationReportSchema,
  type TaskPlanNormalizationReport
} from "../workflow/task-plan-normalizer.js";

export interface GovernanceArtifacts {
  requirement: Requirement;
  workflow: Workflow;
  design: string;
  reviews: DesignReview[];
  /** Optional when no task-plan review has been persisted yet; callers should default to an empty array. */
  taskPlanReviews?: TaskPlanReview[];
  taskPlanApprovalReport?: TaskPlanApprovalReport;
  taskPlanNormalizationReports?: TaskPlanNormalizationReport[];
  taskPlanNormalizationReportErrors?: TaskPlanNormalizationReportError[];
  draftPlan?: TaskPlan;
  plan?: TaskPlan;
}

export interface TaskPlanNormalizationReportError {
  path: string;
  round: number;
  severity: "warning" | "critical";
  message: string;
  details?: string;
  issues?: TaskPlanNormalizationReportErrorIssue[];
}

export interface TaskPlanNormalizationReportErrorIssue {
  path: string;
  code: ZodIssue["code"];
  severity: "warning" | "critical";
  message: string;
  details?: string;
  detailFields?: Record<string, string>;
  detailValues?: Record<string, TaskPlanNormalizationReportErrorIssueDetailValue>;
}

export type TaskPlanNormalizationReportErrorIssueDetailValue =
  | string
  | number
  | boolean
  | null
  | TaskPlanNormalizationReportErrorIssueDetailValue[]
  | { [key: string]: TaskPlanNormalizationReportErrorIssueDetailValue };

export class ArtifactStore {
  constructor(private readonly rootDir: string) {}

  async saveWorkflow(artifacts: GovernanceArtifacts): Promise<string> {
    const workflowDir = this.getWorkflowDir(artifacts.workflow.workflowId);
    await mkdir(workflowDir, { recursive: true });

    await Promise.all([
      writeJson(join(workflowDir, "requirement.json"), artifacts.requirement),
      writeJson(join(workflowDir, "workflow.json"), artifacts.workflow),
      writeFile(join(workflowDir, "design.md"), artifacts.design, "utf8"),
      writeJson(join(workflowDir, "reviews.json"), artifacts.reviews),
      artifacts.taskPlanReviews
        ? writeTaskPlanReviewArtifacts(workflowDir, artifacts.taskPlanReviews)
        : Promise.resolve(),
      artifacts.taskPlanApprovalReport
        ? writeJson(join(workflowDir, "task-plan-approval-report.json"), artifacts.taskPlanApprovalReport)
        : removeOptionalFile(join(workflowDir, "task-plan-approval-report.json")),
      ...(artifacts.taskPlanNormalizationReports ?? []).map((report) =>
        writeJson(join(workflowDir, `task-plan-normalization-report-${report.round}.json`), report)
      ),
      artifacts.draftPlan
        ? writeJson(join(workflowDir, "task-plan-draft.json"), artifacts.draftPlan)
        : removeOptionalFile(join(workflowDir, "task-plan-draft.json")),
      artifacts.plan
        ? writeJson(join(workflowDir, "task-plan.json"), artifacts.plan)
        : removeOptionalFile(join(workflowDir, "task-plan.json"))
    ]);

    return workflowDir;
  }

  async readTaskPlan(workflowId: string): Promise<TaskPlan> {
    const raw = await readOptionalFile(join(this.getWorkflowDir(workflowId), "task-plan.json"));
    if (!raw) {
      throw new Error(`Workflow ${workflowId} is not ready for execution because no task plan was generated`);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed) {
      throw new Error(`Workflow ${workflowId} is not ready for execution because task-plan.json is empty`);
    }
    return parseTaskPlanWithNormalization(parsed, {
      workflowId,
      source: TASK_PLAN_NORMALIZATION_SOURCE.artifact
    }, `Workflow ${workflowId} task-plan.json is invalid`);
  }

  async readWorkflow(workflowId: string): Promise<GovernanceArtifacts> {
    const workflowDir = this.getWorkflowDir(workflowId);
    const [
      requirement,
      workflow,
      design,
      reviews,
      taskPlanReviews,
      taskPlanApprovalReport,
      taskPlanNormalizationReports,
      draftPlan,
      plan
    ] = await Promise.all([
      readJson<Requirement>(join(workflowDir, "requirement.json")),
      readJson<Workflow>(join(workflowDir, "workflow.json")),
      readFile(join(workflowDir, "design.md"), "utf8"),
      readJson<DesignReview[]>(join(workflowDir, "reviews.json")),
      readOptionalJson<TaskPlanReview[]>(join(workflowDir, "task-plan-reviews.json")),
      readOptionalJson<TaskPlanApprovalReport>(join(workflowDir, "task-plan-approval-report.json")),
      readTaskPlanNormalizationReports(workflowDir),
      readOptionalJson<unknown>(join(workflowDir, "task-plan-draft.json")),
      readOptionalJson<unknown>(join(workflowDir, "task-plan.json"))
    ]);
    const draftPlanResult = draftPlan
      ? normalizeTaskPlanModelOutput(draftPlan, { workflowId, source: TASK_PLAN_NORMALIZATION_SOURCE.artifact })
      : undefined;
    const finalPlanResult = plan
      ? normalizeTaskPlanModelOutput(plan, { workflowId, source: TASK_PLAN_NORMALIZATION_SOURCE.artifact })
      : undefined;

    return {
      requirement,
      workflow,
      design,
      reviews,
      taskPlanReviews: taskPlanReviews ?? undefined,
      taskPlanApprovalReport: taskPlanApprovalReport ?? undefined,
      taskPlanNormalizationReports: taskPlanNormalizationReports.reports.length > 0 ? taskPlanNormalizationReports.reports : undefined,
      taskPlanNormalizationReportErrors: taskPlanNormalizationReports.errors.length > 0 ? taskPlanNormalizationReports.errors : undefined,
      draftPlan: draftPlanResult?.plan,
      plan: finalPlanResult?.plan
    };
  }

  getWorkflowDir(workflowId: string): string {
    return join(this.rootDir, workflowId);
  }
}

const maxNormalizationReportRound = 9999;
const issueValueTruncateLength = 160;
const normalizationReportIssueSeverityByCode: Record<ZodIssue["code"], TaskPlanNormalizationReportError["severity"]> = {
  [ZodIssueCode.custom]: "warning",
  [ZodIssueCode.unrecognized_keys]: "warning",
  [ZodIssueCode.invalid_type]: "critical",
  [ZodIssueCode.invalid_literal]: "critical",
  [ZodIssueCode.invalid_union]: "critical",
  [ZodIssueCode.invalid_union_discriminator]: "critical",
  [ZodIssueCode.invalid_enum_value]: "critical",
  [ZodIssueCode.invalid_arguments]: "critical",
  [ZodIssueCode.invalid_return_type]: "critical",
  [ZodIssueCode.invalid_date]: "critical",
  [ZodIssueCode.invalid_string]: "critical",
  [ZodIssueCode.too_small]: "critical",
  [ZodIssueCode.too_big]: "critical",
  [ZodIssueCode.invalid_intersection_types]: "critical",
  [ZodIssueCode.not_multiple_of]: "critical",
  [ZodIssueCode.not_finite]: "critical"
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTaskPlanReviewArtifacts(workflowDir: string, reviews: TaskPlanReview[]): Promise<void> {
  await writeJson(join(workflowDir, "task-plan-reviews.json"), reviews);
  const latest = reviews.at(-1);
  if (!latest) {
    await removeOptionalFile(join(workflowDir, "task-plan-review-latest.json"));
    return;
  }

  await Promise.all([
    writeJson(join(workflowDir, "task-plan-review-latest.json"), latest),
    ...reviews.map((review, index) => writeJson(join(workflowDir, getTaskPlanReviewFileName(reviews, index)), review))
  ]);
}

function getTaskPlanReviewFileName(reviews: TaskPlanReview[], index: number): string {
  const review = reviews[index];
  if (!review) {
    throw new Error(`Task plan review index ${index} is out of range`);
  }
  const sameRound = reviews.filter((item) => item.round === review.round);
  const sameRoundIndex = reviews.slice(0, index + 1).filter((item) => item.round === review.round).length - 1;
  if (sameRound.length === 1) {
    return `task-plan-review-${review.round}.json`;
  }
  return `task-plan-review-${review.round}${getTaskPlanReviewFileSuffix(sameRound, sameRoundIndex)}.json`;
}

function getTaskPlanReviewFileSuffix(sameRound: TaskPlanReview[], sameRoundIndex: number): string {
  const review = sameRound[sameRoundIndex];
  if (!review) {
    throw new Error(`Task plan review round index ${sameRoundIndex} is out of range`);
  }
  if (review.findings.some((finding) => finding.body.startsWith("[local-gate]"))) {
    return "-local-gate";
  }
  const localGateIndex = sameRound.findIndex((item) =>
    item.findings.some((finding) => finding.body.startsWith("[local-gate]"))
  );
  if (localGateIndex >= 0 && sameRoundIndex > localGateIndex) {
    return "-local-gate-arbitration";
  }
  return "";
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  const raw = await readOptionalFile(file);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

async function readTaskPlanNormalizationReports(workflowDir: string): Promise<{
  reports: TaskPlanNormalizationReport[];
  errors: TaskPlanNormalizationReportError[];
}> {
  let entries: string[];
  try {
    entries = await readdir(workflowDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { reports: [], errors: [] };
    }
    throw error;
  }

  const reportFiles = entries
    .map((entry) => ({ entry, round: extractReportRound(entry) }))
    .filter((item): item is { entry: string; round: number } => item.round !== undefined)
    .sort((left, right) => left.round - right.round);
  const reports: TaskPlanNormalizationReport[] = [];
  const errors: TaskPlanNormalizationReportError[] = [];
  await Promise.all(
    reportFiles.map(async ({ entry, round }) => {
      const path = join(workflowDir, entry);
      try {
        reports.push(taskPlanNormalizationReportSchema.parse(await readJson<unknown>(path)));
      } catch (error) {
        const formattedError = formatNormalizationReportParseError(error);
        errors.push({
          path,
          round,
          severity: getNormalizationReportParseSeverity(error),
          message: formattedError.message,
          details: formattedError.details,
          issues: formattedError.issues
        });
      }
    })
  );
  reports.sort((left, right) => left.round - right.round);
  errors.sort((left, right) => left.round - right.round);
  return { reports, errors };
}

function extractReportRound(fileName: string): number | undefined {
  const roundText = fileName.match(/task-plan-normalization-report-(\d+)\.json/)?.[1];
  if (!roundText) {
    return undefined;
  }
  const round = Number(roundText);
  return Number.isInteger(round) && round >= 0 && round <= maxNormalizationReportRound ? round : undefined;
}

function formatNormalizationReportParseError(error: unknown): {
  message: string;
  details?: string;
  issues?: TaskPlanNormalizationReportErrorIssue[];
} {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => {
      const severity = classifyNormalizationReportIssueSeverity(issue);
      const details = formatZodIssueDetails(issue);
      return {
        path: formatZodIssuePath(issue),
        code: issue.code,
        severity,
        message: issue.message,
        details: details.text || undefined,
        detailFields: details.fields,
        detailValues: details.values
      };
    });
    return {
      message: issues.map((issue) => `${issue.severity} ${issue.path}: ${issue.message}`).join("; "),
      details: issues
        .filter((issue) => issue.details)
        .map((issue) => `${issue.path}: ${issue.details}`)
        .join("; ") || undefined,
      issues
    };
  }
  if (error instanceof Error) {
    return { message: error.message, details: "non-zod parse failure" };
  }
  return { message: String(error), details: "non-error parse failure" };
}

function getNormalizationReportParseSeverity(error: unknown): TaskPlanNormalizationReportError["severity"] {
  if (error instanceof ZodError) {
    return error.issues.some((issue) => classifyNormalizationReportIssueSeverity(issue) === "critical")
      ? "critical"
      : "warning";
  }
  return "critical";
}

function classifyNormalizationReportIssueSeverity(issue: ZodIssue): TaskPlanNormalizationReportError["severity"] {
  return normalizationReportIssueSeverityByCode[issue.code] ?? "critical";
}

function formatZodIssuePath(issue: ZodIssue): string {
  return issue.path.length ? issue.path.join(".") : "$";
}

function formatZodIssueDetails(issue: ZodIssue): {
  text: string;
  fields?: Record<string, string>;
  values?: Record<string, TaskPlanNormalizationReportErrorIssueDetailValue>;
} {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      return detailFields({ expected: issue.expected, received: issue.received });
    case ZodIssueCode.invalid_enum_value:
      return detailFields(
        { expected: formatEnumOptions(issue.options), received: formatIssueValue(issue.received) },
        { expectedOptions: issue.options, received: issue.received }
      );
    case ZodIssueCode.invalid_literal:
      return detailFields({ expected: formatIssueValue(issue.expected), received: formatIssueValue(issue.received) });
    case ZodIssueCode.invalid_union:
      return detailFields({ unionErrors: issue.unionErrors.length });
    case ZodIssueCode.invalid_union_discriminator:
      return detailFields({ expectedDiscriminator: formatEnumOptions(issue.options) });
    case ZodIssueCode.invalid_arguments:
      return detailFields({ argumentIssues: issue.argumentsError.issues.length });
    case ZodIssueCode.invalid_return_type:
      return detailFields({ returnIssues: issue.returnTypeError.issues.length });
    case ZodIssueCode.invalid_date:
      return detailFields({ expected: "valid date" });
    case ZodIssueCode.unrecognized_keys:
      return detailFields({ unrecognizedKeys: issue.keys.join(", ") });
    case ZodIssueCode.invalid_string:
      return detailFields({ validation: formatIssueValue(issue.validation) });
    case ZodIssueCode.too_small:
      return detailFields({ minimum: formatIssueValue(issue.minimum), inclusive: issue.inclusive, type: issue.type });
    case ZodIssueCode.too_big:
      return detailFields({ maximum: formatIssueValue(issue.maximum), inclusive: issue.inclusive, type: issue.type });
    case ZodIssueCode.not_multiple_of:
      return detailFields({ multipleOf: formatIssueValue(issue.multipleOf) });
    case ZodIssueCode.not_finite:
      return detailFields({ expected: "finite number" });
    case ZodIssueCode.invalid_intersection_types:
      return detailFields({ reason: "intersection types could not be merged" });
    case ZodIssueCode.custom:
      return issue.params ? detailFields({ params: formatIssueValue(issue.params) }) : emptyDetails();
    default:
      return emptyDetails();
  }
}

function detailFields(fields: Record<string, unknown>, values: Record<string, unknown> = fields): {
  text: string;
  fields: Record<string, string>;
  values: Record<string, TaskPlanNormalizationReportErrorIssueDetailValue>;
} {
  const formattedFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value : formatIssueValue(value)])
  );
  const detailValues = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, toDetailValue(value)])
  );
  return {
    text: Object.entries(formattedFields)
      .map(([key, value]) => `${key} ${value}`)
      .join(", "),
    fields: formattedFields,
    values: detailValues
  };
}

function emptyDetails(): { text: string } {
  return { text: "" };
}

function formatEnumOptions(options: unknown[]): string {
  const visibleOptions = options.slice(0, 8).map((option) => formatIssueValue(option));
  const suffix = options.length > visibleOptions.length ? ` | ... ${options.length - visibleOptions.length} more` : "";
  return `${visibleOptions.join(" | ")}${suffix}`;
}

function formatIssueValue(value: unknown): string {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value === undefined) {
    return "undefined";
  }
  const formatted = JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === "bigint") {
      return `${nestedValue.toString()}n`;
    }
    return nestedValue;
  });
  if (formatted === undefined) {
    return String(value);
  }
  return formatted.length > issueValueTruncateLength
    ? `${formatted.slice(0, issueValueTruncateLength - 3)}...`
    : formatted;
}

function toDetailValue(value: unknown): TaskPlanNormalizationReportErrorIssueDetailValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toDetailValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, toDetailValue(nestedValue)])
    );
  }
  return String(value);
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removeOptionalFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
