import type { DesignReview } from "../schemas/design-review.js";
import type { ExecutionTask, TaskPlan } from "../schemas/task-plan.js";

export interface AoSessionSnapshot {
  id: string;
  role?: string;
  status?: string;
  lifecycleStatus?: string;
  reportedState?: string;
  reportedAt?: string;
  reportedNote?: string;
  prompt?: string;
  createdAt?: string;
  displayName?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  ciStatus?: string;
  reviewStatus?: string;
  // Reserved for consumers that persist delivery diagnostics on session snapshots.
  deliveryCheck?: {
    status: "delivered" | "marker_missing" | "field_truncated" | "unknown";
    checkedAt: string;
    dispatchContextPath?: string;
  };
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
const terminalFailureStatuses = new Set(["failed", "stuck", "ci_failed"]);
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
    const report = readLatestAcceptedReport(session);
    const lifecycleStatus = readString(session, ["status", "state"]);
    const createdAt = readString(session, ["createdAt", "created_at"]);
    const status = resolveNormalizedStatus({ lifecycleStatus, report, createdAt });
    return {
      id: readString(session, ["id", "sessionId", "name"]) ?? "",
      role: readString(session, ["role", "workerRole", "worker_role", "agent_role"]),
      status,
      lifecycleStatus,
      reportedState: report?.state,
      reportedAt: report?.at,
      reportedNote: report?.note,
      prompt: readString(session, ["prompt", "userPrompt", "user_prompt", "inputPrompt", "input_prompt"]),
      createdAt,
      displayName: readString(session, ["displayName", "display_name", "name"]),
      branch: readString(session, ["branch"]),
      worktreePath: readString(session, ["worktreePath", "worktree_path", "worktree", "workspacePath", "workspace_path", "workspace"]),
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
    "lifecycleStatus",
    "prUrl",
    "prompt",
    "reportedAt",
    "reportedNote",
    "reportedState",
    "reviewStatus",
    "role",
    "status",
    "worktreePath"
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

function readLatestAcceptedReport(session: Record<string, unknown>):
  | { state: string; at?: string; note?: string }
  | undefined {
  const reports = session.reports;
  const latestAccepted = Array.isArray(reports) ? findLatestAcceptedReport(reports) : undefined;
  const topLevelState = readString(session, ["agentReportedState", "agent_reported_state"]);
  const topLevelAt = readString(session, ["agentReportedAt", "agent_reported_at"]);
  const topLevelNote = readString(session, ["agentReportedNote", "agent_reported_note"]);
  const topLevel = topLevelState
    ? { state: topLevelState, at: topLevelAt, note: topLevelNote }
    : undefined;
  const nested = latestAccepted
    ? {
        state: readString(latestAccepted, ["reportState", "state", "agentReportedState"]) ?? "",
        at: readString(latestAccepted, ["timestamp", "createdAt", "created_at", "updatedAt", "updated_at", "reportedAt", "reported_at"]),
        note: readString(latestAccepted, ["note", "message", "summary", "agentReportedNote"])
      }
    : undefined;
  if (nested && !nested.state) {
    return topLevel;
  }
  if (!nested || !topLevel) {
    return nested ?? topLevel;
  }
  const topLevelTime = readReportTime(topLevel.at);
  const nestedTime = readReportTime(nested.at);
  if (topLevelTime === Number.NEGATIVE_INFINITY && nestedTime === Number.NEGATIVE_INFINITY) {
    return nested;
  }
  return topLevelTime >= nestedTime ? topLevel : nested;
}

function resolveNormalizedStatus(input: {
  lifecycleStatus?: string;
  report?: { state: string; at?: string };
  createdAt?: string;
}): string | undefined {
  if (input.lifecycleStatus && terminalFailureStatuses.has(input.lifecycleStatus)) {
    return input.lifecycleStatus;
  }
  if (input.report && isReportCurrentEnough(input.report.at, input.createdAt)) {
    return input.report.state;
  }
  return input.lifecycleStatus;
}

function isReportCurrentEnough(reportedAt: string | undefined, createdAt: string | undefined): boolean {
  if (!createdAt || !reportedAt) {
    return true;
  }
  const reportTime = readReportTime(reportedAt);
  const createdTime = readReportTime(createdAt);
  if (reportTime === Number.NEGATIVE_INFINITY || createdTime === Number.NEGATIVE_INFINITY) {
    return true;
  }
  return reportTime >= createdTime;
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
  return readReportTime(timestamp);
}

function readReportTime(timestamp: string | undefined): number {
  if (!timestamp) {
    return Number.NEGATIVE_INFINITY;
  }

  if (/^\d+$/.test(timestamp)) {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
