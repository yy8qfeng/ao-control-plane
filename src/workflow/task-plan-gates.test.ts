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

  it("rejects G0 designs without a manual gate task", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "本稿为预实施冻结稿，必须先完成 G0 Repo Reality Check，未经人工复核不得进入文件级 AO。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-G0-001")).toBe(true);
  });

  it("rejects implementation tasks that do not transitively depend on the G0 manual gate", () => {
    const plan = createPlan([
      createTask("TASK-001", "review", {
        title: "G0 人工复核放行",
        aoRole: "reviewer",
        dependencyCondition: "manual_gate",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-002", "implementation", {
        title: "实现后续功能"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "当前为预实施冻结稿，G0 后必须人工复核放行。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.id === "TPG-G0-002")).toBe(true);
  });

  it("accepts implementation tasks that transitively depend on the G0 manual gate", () => {
    const plan = createPlan([
      createTask("TASK-001", "review", {
        title: "G0 仓库现实校准",
        aoRole: "architect",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-002", "review", {
        title: "G0 人工复核放行",
        aoRole: "reviewer",
        dependencies: ["TASK-001"],
        dependencyCondition: "manual_gate",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-003", "implementation", {
        title: "实现后续功能",
        dependencies: ["TASK-002"]
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "当前为预实施冻结稿，G0 后必须人工复核放行。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id.startsWith("TPG-G0"))).toBe(false);
  });

  it("does not require G0 gates for ordinary designs that do not mention G0 semantics", () => {
    const plan = createPlan([
      createTask("TASK-001", "review", {
        title: "普通人工确认",
        aoRole: "reviewer",
        dependencyCondition: "manual_gate",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-002", "implementation", {
        title: "实现普通功能"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "该设计已经达到直接实施标准。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id.startsWith("TPG-G0"))).toBe(false);
  });

  it("rejects JDK 21 JAR delivery designs without build or publish evidence", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "Java 侧交付形态固定为 JDK 21 标准 JAR，供项目直接依赖调用。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-JAR")).toBe(true);
  });

  it("accepts JDK 21 JAR delivery designs when build and publish evidence is present", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", {
        title: "实现 Java JAR 构建发布验证",
        acceptanceCriteria: ["使用 Gradle 构建 JDK 21 JAR，并完成打包、发布和示例依赖验证。"],
        aoPrompt:
          "[WF-GATE / TASK-001]\n任务名称：实现 Java JAR 构建发布验证\nAO 角色：backend-senior\n验收标准：\n1. 使用 Gradle 构建 JDK 21 JAR，并完成打包、发布和示例依赖验证。\n上下文摘要：覆盖 Java JAR 交付。"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "Java 侧交付形态固定为 JDK 21 标准 JAR，供项目直接依赖调用。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-JAR")).toBe(false);
  });

  it("accepts structured design coverage trace as coverage evidence", () => {
    const plan: TaskPlan = {
      ...createPlan([createTask("TASK-001", "implementation")]),
      designCoverageTrace: [
        {
          requirementId: "java-jar-delivery",
          requirement: "JDK 21 JAR 交付",
          source: "approvedDesign",
          status: "covered",
          evidenceTaskIds: ["TASK-001"],
          rationale: "TASK-001 承接 JAR 交付。"
        }
      ]
    };

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "Java 侧交付形态固定为 JDK 21 标准 JAR，供项目直接依赖调用。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-JAR")).toBe(false);
    expect(result.approvalReport.designCoverageTrace).toContainEqual(
      expect.objectContaining({
        requirementId: "java-jar-delivery",
        status: "covered",
        evidenceTaskIds: ["TASK-001"]
      })
    );
  });

  it("rejects shared segment permission designs without permission evidence", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "共享段默认位于 /dev/shm，Linux 目录建议 0700，段文件建议 0600，Windows 使用 ACL 控制。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-PERMISSION")).toBe(true);
  });

  it("accepts shared segment permission designs when permission evidence is present", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", {
        title: "实现共享段路径与权限控制",
        acceptanceCriteria: ["Linux 共享段目录使用 0700，段文件使用 0600，Windows 使用 ACL 做访问控制。"],
        aoPrompt:
          "[WF-GATE / TASK-001]\n任务名称：实现共享段路径与权限控制\nAO 角色：backend-senior\n验收标准：\n1. Linux 共享段目录使用 0700，段文件使用 0600，Windows 使用 ACL 做访问控制。\n上下文摘要：覆盖共享段权限模型。"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "共享段默认位于 /dev/shm，Linux 目录建议 0700，段文件建议 0600，Windows 使用 ACL 控制。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-PERMISSION")).toBe(false);
  });

  it("rejects IPv4 and IPv6 designs without IPv6 task evidence", () => {
    const plan = createPlan([createTask("TASK-001", "implementation", { title: "实现 UDP/TCP 主路径" })]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "主路径支持 UDP/TCP over IPv4/IPv6。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-IPV6")).toBe(true);
  });

  it("accepts IPv4 and IPv6 designs when IPv6 task evidence is present", () => {
    const plan = createPlan([
      createTask("TASK-001", "implementation", {
        title: "实现 UDP/TCP IPv4 与 IPv6 主路径冒烟",
        acceptanceCriteria: ["UDP/TCP 后端必须覆盖 IPv4 与 IPv6 冒烟验证。"],
        aoPrompt:
          "[WF-GATE / TASK-001]\n任务名称：实现 UDP/TCP IPv4 与 IPv6 主路径冒烟\nAO 角色：backend-senior\n验收标准：\n1. UDP/TCP 后端必须覆盖 IPv4 与 IPv6 冒烟验证。\n上下文摘要：覆盖协议矩阵。"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "主路径支持 UDP/TCP over IPv4/IPv6。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-IPV6")).toBe(false);
  });

  it("rejects outbound reservation designs without send interface evidence", () => {
    const plan = createPlan([createTask("TASK-001", "implementation")]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "一期保留 OutboundTransport send 发包能力预留接口。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-OUTBOUND")).toBe(true);
  });

  it("accepts outbound reservation designs when interface compatibility evidence is present", () => {
    const plan = createPlan([
      createTask("TASK-001", "design", {
        title: "复核发包接口兼容位",
        aoRole: "architect",
        acceptanceCriteria: ["明确发送接口兼容位只作边界复核，一期不做代码落位且不影响 ingress 主路径。"],
        aoPrompt:
          "[WF-GATE / TASK-001]\n任务名称：复核发包接口兼容位\nAO 角色：architect\n验收标准：\n1. 明确发送接口兼容位只作边界复核，一期不做代码落位且不影响 ingress 主路径。\n上下文摘要：覆盖 OutboundTransport send 发包能力预留边界。",
        executionPolicy: getExecutionPolicyForTaskType("design")
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "一期保留 OutboundTransport send 发包能力预留接口。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.findings.some((finding) => finding.id === "TPG-COVERAGE-OUTBOUND")).toBe(false);
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

  it("reports readiness, dispatchability, and missing coverage in the approval report", () => {
    const plan = createPlan([
      createTask("TASK-001", "review", {
        title: "G0 人工复核放行",
        aoRole: "reviewer",
        dependencyCondition: "manual_gate",
        executionPolicy: getExecutionPolicyForTaskType("review")
      }),
      createTask("TASK-002", "implementation", {
        title: "实现后续功能"
      })
    ]);

    const result = validateTaskPlanApprovalGate({
      workflowId: plan.workflowId,
      approvedDesign: "当前为预实施冻结稿，G0 后必须人工复核放行。主路径支持 UDP/TCP over IPv4/IPv6。",
      deferredFindings: [],
      plan,
      previousReviews: []
    });

    expect(result.approvalReport.approved).toBe(false);
    expect(result.approvalReport.planReadiness).toBe("calibration_only");
    expect(result.approvalReport.dispatchSummary.manualGateTaskCount).toBe(1);
    expect(result.approvalReport.findingSummary.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["TPG-G0-002", "TPG-COVERAGE-IPV6"])
    );
    expect(result.approvalReport.designCoverageTrace).toContainEqual(
      expect.objectContaining({
        requirementId: "ipv6-support",
        status: "missing"
      })
    );
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
