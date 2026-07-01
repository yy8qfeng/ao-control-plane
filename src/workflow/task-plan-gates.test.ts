import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy, getExecutionPolicyForTaskType } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { validateTaskPlanApprovalGate } from "./task-plan-gates.js";

describe("validateTaskPlanApprovalGate", () => {
  it("rejects multi-type plans that use the same default execution policy everywhere", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", { executionPolicy: defaultExecutionPolicy }),
      createTask("TASK-002", "docs", { aoRole: "docs", executionPolicy: defaultExecutionPolicy })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-POLICY-001")).toBe(true);
  });

  it("rejects single-type multi-task plans that use the default execution policy everywhere", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", { executionPolicy: defaultExecutionPolicy }),
      createTask("TASK-002", "implementation", { executionPolicy: defaultExecutionPolicy })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-POLICY-001")).toBe(true);
  });

  it("requires deferred blocking and major findings to be represented in the task plan", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [
        {
          id: "DRF-IMPL-003",
          title: "clock_domain 字段需贯通",
          body: "clock_domain 必须在控制块、IpcStats、TransportStats、指标中真正贯通。",
          severity: "major",
          status: "unresolved"
        }
      ],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-DEFERRED-DRF-IMPL-003")).toBe(true);
  });

  it("accepts deferred findings when a task carries matching evidence", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", {
        acceptanceCriteria: ["clock_domain 贯通到 IpcStats、TransportStats 与指标输出。"],
        aoPrompt:
          "[WF-GATE / TASK-001]\n任务名称：实现 stats\nAO 角色：backend-senior\n验收标准：\n1. clock_domain 贯通到 IpcStats、TransportStats 与指标输出。\n上下文摘要：处理 DRF-IMPL-003。"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [
        {
          id: "DRF-IMPL-003",
          title: "clock_domain 字段需贯通",
          body: "clock_domain 必须在控制块、IpcStats、TransportStats、指标中真正贯通。",
          severity: "major",
          status: "unresolved"
        }
      ],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-DEFERRED-DRF-IMPL-003")).toBe(false);
  });

  it("rejects previous unresolved blocking review findings without follow-up evidence", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);
    const previousReview: TaskPlanReview = {
      workflowId: plan.workflowId,
      round: 1,
      planner: "codex",
      reviewer: "claude-code",
      planVersion: "task-plan-current",
      reviewDecision: "changes_requested",
      findings: [
        {
          id: "TPF-001",
          title: "缺少 RawIp 权限失败错误契约",
          body: "RawIpAdapter 必须定义固定错误码和结构化日志字段。",
          severity: "blocking",
          status: "unresolved"
        }
      ]
    };

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: [previousReview]
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-PREVIOUS-TPF-001")).toBe(true);
  });

  it("rejects cross-platform implementation tasks that do not depend on shared contract tasks", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", { title: "实现 Linux io_uring 后端" }),
      createTask("TASK-002", "implementation", { title: "实现 Windows IOCP 后端" })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-XPLAT-001")).toBe(true);
  });

  it("rejects manual approval semantics that are missing a manual gate", () => {
    const plan = createPlan([
      createTask("TASK-001", "review", {
        title: "审批实施决策",
        aoRole: "reviewer",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-002", "implementation")
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-GATE-001")).toBe(true);
  });

  it("recognizes protocol or baseline tasks as cross-platform prerequisites", () => {
    const plan = createPlan([
      createTask("TASK-001", "design", {
        title: "冻结跨平台协议基线",
        aoRole: "architect",
        executionPolicy: getExecutionPolicyForTaskType("design")
      }),
      createTask("TASK-002", "implementation", {
        title: "实现 Linux io_uring 后端",
        dependencies: ["TASK-001"]
      }),
      createTask("TASK-003", "implementation", {
        title: "实现 Windows IOCP 后端",
        dependencies: ["TASK-001"]
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id.startsWith("TPG-XPLAT"))).toBe(false);
  });

  it("rejects cross-platform implementation tasks that skip an existing prerequisite task", () => {
    const plan = createPlan([
      createTask("TASK-001", "design", {
        title: "冻结跨平台协议基线",
        aoRole: "architect",
        executionPolicy: getExecutionPolicyForTaskType("design")
      }),
      createTask("TASK-002", "implementation", {
        title: "实现 Linux io_uring 后端",
        dependencies: ["TASK-001"]
      }),
      createTask("TASK-003", "implementation", {
        title: "实现 Windows IOCP 后端"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-XPLAT-002")).toBe(true);
  });

  it("does not block generic findings when no evidence keyword can be extracted", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      deferredFindings: [
        {
          id: "DRF-GENERIC",
          title: "task finding status",
          body: "severity unresolved accepted_as_is changes_requested",
          severity: "major",
          status: "unresolved"
        }
      ],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-DEFERRED-DRF-GENERIC")).toBe(false);
  });
});

function createPlan(tasks: TaskPlan["tasks"]): TaskPlan {
  return {
    workflowId: "WF-GATE",
    title: "Gate plan",
    tasks
  };
}

function createTask(
  taskId: string,
  type: TaskPlan["tasks"][number]["type"],
  overrides: Partial<TaskPlan["tasks"][number]> = {}
): TaskPlan["tasks"][number] {
  const policy = overrides.executionPolicy ?? getExecutionPolicyForTaskType(type);
  return {
    taskId,
    workflowId: "WF-GATE",
    title: overrides.title ?? `任务 ${taskId}`,
    description: overrides.description ?? "实现一个可验证交付物。",
    type,
    dependencies: overrides.dependencies ?? [],
    dependencyCondition: overrides.dependencyCondition ?? "all_completed",
    aoRole: overrides.aoRole ?? "backend-senior",
    acceptanceCriteria: overrides.acceptanceCriteria ?? ["交付物通过自测。"],
    aoPrompt:
      overrides.aoPrompt ??
      `[WF-GATE / ${taskId}]\n任务名称：任务 ${taskId}\nAO 角色：backend-senior\n验收标准：\n1. 交付物通过自测。\n上下文摘要：按设计实施。`,
    status: overrides.status ?? "pending",
    executionPolicy: policy
  };
}
