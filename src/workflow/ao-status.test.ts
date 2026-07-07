import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import {
  createCompletionReport,
  getAoSessionSnapshotKeys,
  normalizeAoSessions,
  reconcileTaskSessions
} from "./ao-status.js";

const plan: TaskPlan = {
  workflowId: "WF-001",
  title: "Plan",
  tasks: [
    {
      taskId: "TASK-001",
      workflowId: "WF-001",
      title: "Implement API",
      description: "Implement API.",
      type: "implementation",
      dependencies: [],
      dependencyCondition: "all_completed",
      aoRole: "backend-senior",
      acceptanceCriteria: ["API works"],
      aoPrompt: "[WF-001 / TASK-001] Implement API.",
      executionPolicy: defaultExecutionPolicy,
      status: "pending"
    }
  ]
};

describe("AO status collector helpers", () => {
  it("keeps AO session snapshot fields covered by a snapshot", () => {
    expect(getAoSessionSnapshotKeys()).toMatchInlineSnapshot(`
      [
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
        "worktreePath",
      ]
    `);
  });

  it("normalizes session JSON and maps tasks to AO sessions by prompt prefix", () => {
    const sessions = normalizeAoSessions({
      sessions: [
        {
          sessionId: "app-3",
          role: "worker",
          status: "completed",
          prompt: "[WF-001 / TASK-001] Implement API.",
          worktree_path: "C:\\Users\\niuniu\\.agent-orchestrator\\projects\\demo\\worktrees\\app-3",
          created_at: "2026-06-29T02:00:00.000Z"
        }
      ]
    });

    expect(sessions[0]?.worktreePath).toBe("C:\\Users\\niuniu\\.agent-orchestrator\\projects\\demo\\worktrees\\app-3");

    expect(reconcileTaskSessions({ plan, sessions })).toEqual([
      {
        taskId: "TASK-001",
        aoSessionId: "app-3",
        status: "completed"
      }
    ]);
  });

  it("normalizes AO CLI session ls data envelope", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          id: "ft-1",
          role: "worker",
          status: "spawning",
          branch: "session/ft-1",
          lastActivityAt: "2026-07-05T10:00:00.000Z"
        }
      ],
      meta: { hiddenTerminatedCount: 0 }
    });

    expect(sessions).toEqual([
      {
        id: "ft-1",
        lifecycleStatus: "spawning",
        role: "worker",
        status: "spawning",
        branch: "session/ft-1",
        createdAt: undefined,
        displayName: undefined,
        prompt: undefined,
        reportedAt: undefined,
        reportedNote: undefined,
        reportedState: undefined,
        prUrl: undefined,
        ciStatus: undefined,
        reviewStatus: undefined,
        worktreePath: undefined
      }
    ]);
  });

  it("treats accepted AO completed reports as task completion even when the session is idle", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          name: "ft-1",
          role: "worker",
          status: "idle",
          branch: "session/ft-1",
          reports: [
            {
              reportState: "completed",
              accepted: true,
              timestamp: "2026-07-05T14:39:36.016Z"
            }
          ]
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-1",
      displayName: "ft-1",
      status: "completed",
      reportedState: "completed"
    });
    expect(
      reconcileTaskSessions({
        plan: {
          ...plan,
          tasks: [
            {
              ...plan.tasks[0],
              aoSessionId: "ft-1"
            }
          ]
        },
        sessions
      })
    ).toEqual([
      {
        taskId: "TASK-001",
        aoSessionId: "ft-1",
        status: "completed"
      }
    ]);
  });

  it("uses the newest accepted AO report when reports arrive in chronological order", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          name: "ft-1",
          status: "idle",
          reports: [
            {
              reportState: "failed",
              accepted: true,
              timestamp: "2026-07-05T14:30:00.000Z"
            },
            {
              reportState: "completed",
              accepted: true,
              timestamp: "2026-07-05T14:39:36.016Z"
            }
          ]
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-1",
      status: "completed",
      reportedState: "completed"
    });
  });

  it("falls back to the last accepted AO report when report timestamps are absent", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          name: "ft-1",
          status: "idle",
          reports: [
            {
              reportState: "needs_input",
              accepted: true
            },
            {
              reportState: "completed",
              accepted: true
            }
          ]
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-1",
      status: "completed",
      reportedState: "completed"
    });
  });

  it("accepts epoch millisecond report timestamps", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          name: "ft-1",
          status: "idle",
          createdAt: "2026-07-07T06:00:00.000Z",
          reports: [
            {
              reportState: "waiting",
              accepted: true,
              timestamp: "1783404300000"
            }
          ]
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-1",
      status: "waiting",
      reportedState: "waiting"
    });
  });

  it("keeps the latest nested accepted report when top-level report time is invalid", () => {
    const sessions = normalizeAoSessions({
      data: [
        {
          name: "ft-1",
          status: "idle",
          agentReportedState: "waiting",
          agentReportedAt: "not-a-date",
          reports: [
            {
              reportState: "completed",
              accepted: true
            }
          ]
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-1",
      status: "completed",
      reportedState: "completed"
    });
  });

  it("normalizes top-level AO report fields and prompt aliases", () => {
    const sessions = normalizeAoSessions({
      sessions: [
        {
          id: "ft-12",
          workerRole: "reviewer",
          status: "idle",
          userPrompt: "[WF-001 / TASK-001] Review.",
          agentReportedState: "waiting",
          agentReportedAt: "2026-07-07T06:08:23.158Z",
          agentReportedNote: "只看到 README"
        }
      ]
    });

    expect(sessions[0]).toMatchObject({
      id: "ft-12",
      role: "reviewer",
      lifecycleStatus: "idle",
      status: "waiting",
      reportedState: "waiting",
      reportedAt: "2026-07-07T06:08:23.158Z",
      reportedNote: "只看到 README",
      prompt: "[WF-001 / TASK-001] Review."
    });
  });

  it("does not match task prefixes in the middle of unrelated session text", () => {
    const sessions = normalizeAoSessions({
      sessions: [
        {
          sessionId: "wrong-session",
          status: "completed",
          prompt: "debug copy [WF-001 / TASK-001] Implement API."
        },
        {
          sessionId: "right-session",
          status: "working",
          prompt: "[WF-001 / TASK-001] Implement API."
        }
      ]
    });

    expect(reconcileTaskSessions({ plan, sessions })).toEqual([
      {
        taskId: "TASK-001",
        aoSessionId: "right-session",
        status: "working"
      }
    ]);
  });

  it("maps terminal AO states to task statuses", () => {
    expect(
      reconcileTaskSessions({
        plan,
        sessions: [
          {
            id: "app-3",
            status: "mergeable",
            prompt: "[WF-001 / TASK-001] Implement API."
          }
        ]
      })
    ).toEqual([
      {
        taskId: "TASK-001",
        aoSessionId: "app-3",
        status: "completed"
      }
    ]);

    expect(
      reconcileTaskSessions({
        plan,
        sessions: [
          {
            id: "app-4",
            status: "stuck",
            prompt: "[WF-001 / TASK-001] Implement API."
          }
        ]
      })
    ).toEqual([
      {
        taskId: "TASK-001",
        aoSessionId: "app-4",
        status: "blocked_for_human"
      }
    ]);
  });

  it("creates a final report with review decisions and task mappings", () => {
    const report = createCompletionReport({
      workflowId: "WF-001",
      plan,
      sessions: [
        {
          id: "app-3",
          status: "completed",
          prompt: "[WF-001 / TASK-001] Implement API."
        }
      ],
      reviews: [
        {
          workflowId: "WF-001",
          round: 1,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: "design-v1",
          reviewDecision: "approved",
          findings: []
        }
      ]
    });

    expect(report).toEqual({
      workflowId: "WF-001",
      designReviews: [
        {
          round: 1,
          designVersion: "design-v1",
          reviewDecision: "approved"
        }
      ],
      tasks: [
        {
          taskId: "TASK-001",
          aoSessionId: "app-3",
          status: "completed"
        }
      ],
      completed: true
    });
  });
});
