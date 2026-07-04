import { describe, expect, it } from "vitest";
import type { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import type { TaskPlanReview } from "../schemas/task-plan-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { runTaskPlanReviewLoop } from "./task-plan-review-loop.js";

describe("runTaskPlanReviewLoop", () => {
  it("lets Codex revise task-plan findings until ClaudeCode approves", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            acceptanceCriteria: [...task.acceptanceCriteria, "补齐任务计划审查意见 TPF-001：验收标准不足"]
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return input.round === 1
          ? {
              workflowId: input.workflowId,
              round: input.round,
              planner: "codex",
              reviewer: "claude-code",
              planVersion: input.planVersion,
              reviewDecision: "changes_requested",
              findings: [
                {
                  id: "TPF-001",
                  title: "验收标准不足",
                  body: "任务计划需要补充可验证验收标准。",
                  severity: "major",
                  status: "unresolved"
                }
              ]
            }
          : approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(reviseTaskPlanCalls).toBe(1);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("补齐任务计划审查意见 TPF-001：验收标准不足");
  });

  it("blocks for human when task-plan review rounds are exhausted", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
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
              title: "仍需整改",
              body: "任务计划仍不可执行。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        };
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-BLOCKED-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 2 }
    });

    expect(result.approved).toBe(false);
    expect(result.blockedForHuman).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(reviseTaskPlanCalls).toBe(1);
  });

  it("continues from an existing task plan without creating a new one", async () => {
    let createTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        createTaskPlanCalls += 1;
        return createPlan(input.workflowId, "新生成计划");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-CONTINUE-PLAN",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3, startingRound: 4 },
      initialPlan: createPlan("WF-CONTINUE-PLAN", "已有计划")
    });

    expect(createTaskPlanCalls).toBe(0);
    expect(result.reviews[0]?.round).toBe(4);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("已有计划");
  });

  it("uses codex as the fallback normalization source for newly generated plans", async () => {
    const reports: string[] = [];
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    await runTaskPlanReviewLoop({
      workflowId: "WF-NORMALIZATION-SOURCE",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      hooks: {
        onPlan: ({ normalizationReport }) => {
          reports.push(normalizationReport?.source ?? "");
        }
      }
    });

    expect(reports).toEqual(["codex"]);
  });

  it("uses artifact as the fallback normalization source for continued plans", async () => {
    const reports: string[] = [];
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from initial plan");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    await runTaskPlanReviewLoop({
      workflowId: "WF-NORMALIZATION-SOURCE-CONTINUE",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      initialPlan: createPlan("WF-NORMALIZATION-SOURCE-CONTINUE", "已有计划"),
      hooks: {
        onPlan: ({ normalizationReport }) => {
          reports.push(normalizationReport?.source ?? "");
        }
      }
    });

    expect(reports).toEqual(["artifact"]);
  });

  it("keeps the previous normalization source when revised plans have no bound report", async () => {
    const reports: Array<{ source: string; sourceHistory: Array<{ round: number; source: string }> }> = [];
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should continue from initial plan");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            acceptanceCriteria: [...task.acceptanceCriteria, "已整改"]
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return input.round === 1
          ? {
              workflowId: input.workflowId,
              round: input.round,
              planner: "codex",
              reviewer: "claude-code",
              planVersion: input.planVersion,
              reviewDecision: "changes_requested",
              findings: [
                {
                  id: "TPF-001",
                  title: "需要整改",
                  body: "需要补充验收标准。",
                  severity: "major",
                  status: "unresolved"
                }
              ]
            }
          : approveTaskPlan(input);
      }
    };

    await runTaskPlanReviewLoop({
      workflowId: "WF-NORMALIZATION-SOURCE-REVISION",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 2 },
      initialPlan: createPlan("WF-NORMALIZATION-SOURCE-REVISION", "已有计划"),
      hooks: {
        onPlan: ({ normalizationReport }) => {
          reports.push({
            source: normalizationReport?.source ?? "",
            sourceHistory: normalizationReport?.sourceHistory ?? []
          });
        }
      }
    });

    expect(reports.map((report) => report.source)).toEqual(["artifact", "artifact"]);
    expect(reports[0]?.sourceHistory).toEqual([
      { round: 1, source: "artifact", reason: "fallback normalization report created" }
    ]);
    expect(reports[1]?.sourceHistory).toEqual([
      { round: 1, source: "artifact", reason: "fallback normalization report created" },
      { round: 2, source: "artifact", reason: "previous normalization report carried forward" }
    ]);
  });

  it("does not approve a task plan when the local gate finds unresolved prior findings", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        const isLocalGateReview = input.review.findings.some((finding) => finding.body.includes("[local-gate]"));
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            acceptanceCriteria: [
              ...task.acceptanceCriteria,
              isLocalGateReview ? "补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP" : "补充通用审查整改记录"
            ],
            aoPrompt: isLocalGateReview
              ? `${task.aoPrompt}\n任务计划审查整改：补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP。`
              : `${task.aoPrompt}\n任务计划审查整改：补充通用审查整改记录。`
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        if (input.round === 1) {
          return {
            workflowId: input.workflowId,
            round: input.round,
            planner: "codex",
            reviewer: "claude-code",
            planVersion: input.planVersion,
            reviewDecision: "changes_requested",
            findings: [
              {
                id: "TPF-RAWIP",
                title: "RawIpAdapter 权限失败错误契约缺失",
                body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
                severity: "blocking",
                status: "unresolved"
              }
            ]
          };
        }
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(reviseTaskPlanCalls).toBe(2);
    expect(result.reviews.some((review) => review.findings.some((finding) => finding.id === "TPG-PREVIOUS-TPF-RAWIP"))).toBe(
      true
    );
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP");
  });

  it("lets ClaudeCode approve a task plan after arbitrating local gate findings", async () => {
    let reviseTaskPlanCalls = 0;
    let arbitrationCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "Final approved criterion");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      },
      async reviewTaskPlanLocalGate(input): Promise<TaskPlanReview> {
        arbitrationCalls += 1;
        expect(input.localGateReview.findings[0]?.id).toBe("TPG-PREVIOUS-TPF-RAWIP");
        return {
          workflowId: input.workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "approved",
          findings: [
            {
              id: "TPF-LOCAL-GATE-ACCEPTED",
              title: "本地门禁意见经仲裁不阻断",
              body: "ClaudeCode 判断该本地门禁意见不推翻 approved 结论。",
              severity: "observation",
              status: "accepted_as_is"
            }
          ]
        };
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE-ARBITRATION-APPROVED",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      previousReviews: [
        {
          workflowId: "WF-LOCAL-GATE-ARBITRATION-APPROVED",
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-RAWIP",
              title: "RawIpAdapter 权限失败错误契约缺失",
              body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ]
    });

    expect(result.approved).toBe(true);
    expect(arbitrationCalls).toBe(1);
    expect(reviseTaskPlanCalls).toBe(0);
    expect(result.reviews.map((review) => review.reviewDecision)).toEqual([
      "approved",
      "changes_requested",
      "approved"
    ]);
    expect(result.approvalReport.approved).toBe(true);
    expect(result.approvalReport.findingSummary[0]?.status).toBe("accepted_as_is");
    expect(result.approvalReport.localGateArbitration?.decision).toBe("approved");
    expect(result.approvalReport.localGateArbitration?.localGateFindingSummary[0]?.id).toBe("TPG-PREVIOUS-TPF-RAWIP");
  });

  it("keeps local gate findings in the approval report when arbitration approves without findings", async () => {
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "Final approved criterion");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      },
      async reviewTaskPlanLocalGate(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE-EMPTY-ARBITRATION",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      previousReviews: [createPreviousRawIpFindingReview("WF-LOCAL-GATE-EMPTY-ARBITRATION")]
    });

    expect(result.approved).toBe(true);
    expect(result.approvalReport.findingSummary).toEqual([
      expect.objectContaining({
        id: "TPG-PREVIOUS-TPF-RAWIP",
        status: "accepted_as_is"
      })
    ]);
    expect(result.approvalReport.localGateArbitration?.arbitrationFindingSummary).toEqual([]);
  });

  it("creates a ClaudeCode-shaped fallback arbitration review when the adapter lacks local gate arbitration", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "Final approved criterion");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE-MISSING-ARBITRATION",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      previousReviews: [createPreviousRawIpFindingReview("WF-LOCAL-GATE-MISSING-ARBITRATION")]
    });

    expect(result.approved).toBe(false);
    expect(reviseTaskPlanCalls).toBe(0);
    const fallbackReview = result.reviews.at(-1);
    expect(fallbackReview).toMatchObject({
      reviewer: "claude-code",
      reviewDecision: "changes_requested"
    });
    expect(fallbackReview?.findings[0]?.id).toContain("TPF-ARBITRATION-MISSING-001-TPG-PREVIOUS-TPF-RAWIP");
    expect(fallbackReview?.findings[0]?.body).toContain("adapter 未实现 reviewTaskPlanLocalGate");
  });

  it("revises task plans only after ClaudeCode agrees local gate findings are blocking", async () => {
    let reviseTaskPlanCalls = 0;
    let arbitrationCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "Final approved criterion");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            acceptanceCriteria: [...task.acceptanceCriteria, "补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP"],
            aoPrompt: `${task.aoPrompt}\n任务计划审查整改：补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP。`
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      },
      async reviewTaskPlanLocalGate(input): Promise<TaskPlanReview> {
        arbitrationCalls += 1;
        return {
          workflowId: input.workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "changes_requested",
          findings: input.localGateReview.findings.map((finding, index) => ({
            ...finding,
            id: `TPF-ARBITRATION-${String(index + 1).padStart(3, "0")}-${finding.id}`,
            body: `${finding.body}\nClaudeCode 仲裁：该本地门禁意见有效，需要 Codex 整改。`,
            status: "unresolved" as const
          }))
        };
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE-ARBITRATION-REVISE",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 2 },
      previousReviews: [
        {
          workflowId: "WF-LOCAL-GATE-ARBITRATION-REVISE",
          round: 1,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: "task-plan-current",
          reviewDecision: "changes_requested",
          findings: [
            {
              id: "TPF-RAWIP",
              title: "RawIpAdapter 权限失败错误契约缺失",
              body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
              severity: "blocking",
              status: "unresolved"
            }
          ]
        }
      ]
    });

    expect(result.approved).toBe(true);
    expect(arbitrationCalls).toBe(1);
    expect(reviseTaskPlanCalls).toBe(1);
    expect(result.reviews.map((review) => review.reviewDecision)).toEqual([
      "approved",
      "changes_requested",
      "changes_requested",
      "approved"
    ]);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("补齐 RawIpAdapter 权限失败错误契约 TPF-RAWIP");
  });

  it("blocks for human when arbitration rejects local gate findings at the final round", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "Final approved criterion");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return input.currentPlan;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      },
      async reviewTaskPlanLocalGate(input): Promise<TaskPlanReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          planner: "codex",
          reviewer: "claude-code",
          planVersion: input.planVersion,
          reviewDecision: "changes_requested",
          findings: input.localGateReview.findings.map((finding, index) => ({
            ...finding,
            id: `TPF-ARBITRATION-${String(index + 1).padStart(3, "0")}-${finding.id}`,
            body: `${finding.body}\nClaudeCode 仲裁：该本地门禁意见有效，需要 Codex 整改。`,
            status: "unresolved" as const
          }))
        };
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-LOCAL-GATE-ARBITRATION-BLOCKED",
      approvedDesign: "# Design",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 1 },
      previousReviews: [createPreviousRawIpFindingReview("WF-LOCAL-GATE-ARBITRATION-BLOCKED")]
    });

    expect(result.approved).toBe(false);
    expect(result.blockedForHuman).toBe(true);
    expect(reviseTaskPlanCalls).toBe(0);
    expect(result.reviews.map((review) => review.reviewDecision)).toEqual([
      "approved",
      "changes_requested",
      "changes_requested"
    ]);
  });

  it("passes approvedDesign into the local gate and revises missing deliverable coverage", async () => {
    let reviseTaskPlanCalls = 0;
    const codex: CodexAdapter = {
      createDesign: unusedDesignMethod,
      reviseDesign: unusedDesignRevision,
      async createTaskPlan(input): Promise<TaskPlan> {
        return createPlan(input.workflowId, "初版验收");
      },
      async reviseTaskPlan(input): Promise<TaskPlan> {
        reviseTaskPlanCalls += 1;
        return {
          ...input.currentPlan,
          tasks: input.currentPlan.tasks.map((task) => ({
            ...task,
            title: "实现 Java JAR 构建发布验证",
            acceptanceCriteria: [...task.acceptanceCriteria, "补齐 JDK 21 JAR 构建、打包、发布和示例依赖验证。"],
            aoPrompt: `${task.aoPrompt}\n任务计划审查整改：补齐 JDK 21 JAR 构建、打包、发布和示例依赖验证。`
          }))
        };
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      reviewDesign: unusedDesignReview,
      async reviewTaskPlan(input): Promise<TaskPlanReview> {
        return approveTaskPlan(input);
      }
    };

    const result = await runTaskPlanReviewLoop({
      workflowId: "WF-DESIGN-COVERAGE",
      approvedDesign: "Java 侧交付形态固定为 JDK 21 标准 JAR，供项目直接依赖调用。",
      deferredFindings: [],
      codex,
      claudeCode,
      options: { maxTaskPlanReviewRounds: 3 }
    });

    expect(result.approved).toBe(true);
    expect(reviseTaskPlanCalls).toBe(1);
    expect(result.reviews.some((review) => review.findings.some((finding) => finding.id === "TPG-COVERAGE-JAR"))).toBe(true);
    expect(result.plan.tasks[0]?.acceptanceCriteria).toContain("补齐 JDK 21 JAR 构建、打包、发布和示例依赖验证。");
  });
});

function createPlan(workflowId: string, criterion: string): TaskPlan {
  return {
    workflowId,
    title: "Plan",
    tasks: [
      {
        taskId: "TASK-001",
        workflowId,
        title: "Implement feature",
        description: "Implement the feature.",
        type: "implementation",
        dependencies: [],
        dependencyCondition: "all_completed",
        aoRole: "backend-senior",
        acceptanceCriteria: [criterion],
        aoPrompt: `[${workflowId} / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. ${criterion}\n上下文摘要：Follow the approved design.`,
        executionPolicy: defaultExecutionPolicy,
        status: "pending"
      }
    ]
  };
}

function approveTaskPlan(input: {
  workflowId: string;
  round: number;
  planVersion: string;
}): TaskPlanReview {
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

function createPreviousRawIpFindingReview(workflowId: string): TaskPlanReview {
  return {
    workflowId,
    round: 1,
    planner: "codex",
    reviewer: "claude-code",
    planVersion: "task-plan-current",
    reviewDecision: "changes_requested",
    findings: [
      {
        id: "TPF-RAWIP",
        title: "RawIpAdapter 权限失败错误契约缺失",
        body: "RawIpAdapter 必须补齐固定错误码和结构化日志字段。",
        severity: "blocking",
        status: "unresolved"
      }
    ]
  };
}

async function unusedDesignMethod(): Promise<string> {
  throw new Error("should not create design inside task-plan review loop");
}

async function unusedDesignRevision(): Promise<string> {
  throw new Error("should not revise design inside task-plan review loop");
}

async function unusedDesignReview(): Promise<DesignReview> {
  throw new Error("should not review design inside task-plan review loop");
}
