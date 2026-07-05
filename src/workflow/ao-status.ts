import type { DesignReview } from "../schemas/design-review.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export interface AoSessionSnapshot {
  id: string;
  role?: string;
  status?: string;
  reportedState?: string;
  prompt?: string;
  createdAt?: string;
  displayName?: string;
  branch?: string;
  prUrl?: string;
  ciStatus?: string;
  reviewStatus?: string;
}

export interface TaskSessionMapping {
  taskId: string;
  aoSessionId?: string;
  status: ExecutionTask["status"];
}

export interface CompletionReport {
  workflowId: string;
  designReviews: Array<{
    round: number;
    designVersion: string;
    reviewDecision: DesignReview["reviewDecision"];
  }>;
  tasks: TaskSessionMapping[];
  completed: boolean;
}

const terminalSuccessStatuses = new Set(["completed", "mergeable", "merged", "done"]);
const terminalFailureStatuses = new Set(["failed", "stuck", "ci_failed", "needs_input"]);
const identifierBoundaryPattern = /(?:\s|$)/;

export function normalizeAoSessions(value: unknown): AoSessionSnapshot[] {
  const rawSessions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : isRecord(value) && Array.isArray(value.data)
        ? value.data
      : [];

  return rawSessions.filter(isRecord).map((session) => {
    const reportedState = readLatestAcceptedReportState(session);
    return {
      id: readString(session, ["id", "sessionId", "name"]) ?? "",
      role: readString(session, ["role"]),
      status: reportedState === "completed" ? "completed" : readString(session, ["status", "state"]),
      reportedState,
      prompt: readString(session, ["prompt"]),
      createdAt: readString(session, ["createdAt", "created_at"]),
      displayName: readString(session, ["displayName", "display_name", "name"]),
      branch: readString(session, ["branch"]),
      prUrl: readString(session, ["prUrl", "pr_url"]),
      ciStatus: readString(session, ["ciStatus", "ci_status"]),
      reviewStatus: readString(session, ["reviewStatus", "review_status"])
    };
  });
}

export function reconcileTaskSessions(input: {
  plan: TaskPlan;
  sessions: AoSessionSnapshot[];
}): TaskSessionMapping[] {
  return input.plan.tasks.map((task) => {
    const matchedSession = findSessionForTask(task, input.sessions);
    const status = matchedSession?.status ? mapAoStatusToTaskStatus(matchedSession.status) : task.status;

    return {
      taskId: task.taskId,
      aoSessionId: task.aoSessionId ?? matchedSession?.id,
      status
    };
  });
}

export function createCompletionReport(input: {
  workflowId: string;
  reviews: DesignReview[];
  plan: TaskPlan;
  sessions: AoSessionSnapshot[];
}): CompletionReport {
  const tasks = reconcileTaskSessions({
    plan: input.plan,
    sessions: input.sessions
  });

  return {
    workflowId: input.workflowId,
    designReviews: input.reviews.map((review) => ({
      round: review.round,
      designVersion: review.designVersion,
      reviewDecision: review.reviewDecision
    })),
    tasks,
    completed: tasks.every((task) => task.status === "completed")
  };
}

export function getAoSessionSnapshotKeys(): string[] {
  return [
    "branch",
    "ciStatus",
    "createdAt",
    "displayName",
    "id",
    "prUrl",
    "prompt",
    "reportedState",
    "reviewStatus",
    "role",
    "status"
  ];
}

function findSessionForTask(
  task: ExecutionTask,
  sessions: AoSessionSnapshot[]
): AoSessionSnapshot | undefined {
  if (task.aoSessionId) {
    return sessions.find((session) => session.id === task.aoSessionId);
  }

  const prefix = `[${task.workflowId} / ${task.taskId}]`;
  return sessions.find((session) =>
    [session.prompt, session.displayName, session.branch].some((value) => startsWithTaskPrefix(value, prefix))
  );
}

function mapAoStatusToTaskStatus(status: string): ExecutionTask["status"] {
  // TODO: Apply escalation thresholds before marking transient AO states as human-blocked.
  if (terminalSuccessStatuses.has(status)) {
    return "completed";
  }
  if (terminalFailureStatuses.has(status)) {
    return "blocked_for_human";
  }
  return "working";
}

function startsWithTaskPrefix(value: string | undefined, prefix: string): boolean {
  if (!value?.startsWith(prefix)) {
    return false;
  }

  return identifierBoundaryPattern.test(value.slice(prefix.length, prefix.length + 1));
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readLatestAcceptedReportState(session: Record<string, unknown>): string | undefined {
  const reports = session.reports;
  if (!Array.isArray(reports)) {
    return undefined;
  }
  const latestAccepted = findLatestAcceptedReport(reports);
  return latestAccepted ? readString(latestAccepted, ["reportState", "state"]) : undefined;
}

function findLatestAcceptedReport(reports: unknown[]): Record<string, unknown> | undefined {
  let latestReport: Record<string, unknown> | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const report of reports) {
    if (!isRecord(report) || report.accepted !== true) {
      continue;
    }

    const timestamp = readReportTimestamp(report);
    if (!latestReport || timestamp >= latestTimestamp) {
      latestReport = report;
      latestTimestamp = timestamp;
    }
  }

  return latestReport;
}

function readReportTimestamp(report: Record<string, unknown>): number {
  const timestamp = readString(report, ["timestamp", "createdAt", "created_at", "updatedAt", "updated_at"]);
  if (!timestamp) {
    return Number.NEGATIVE_INFINITY;
  }

  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
