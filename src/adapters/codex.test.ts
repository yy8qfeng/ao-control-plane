import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../schemas/execution-policy.js";
import { taskPlanSchema, type TaskPlan } from "../schemas/task-plan.js";
import { CodexCliAdapter, PlaceholderCodexAdapter } from "./codex.js";

const { codexOutput, execaMock } = vi.hoisted(() => {
  const codexOutput = { value: "# Design\n\nGenerated design.", queue: [] as string[] };
  const execaMock = vi.fn(async (_command: string, args: string[], options?: { input?: string }) => {
    void options;
    const { writeFile } = await import("node:fs/promises");
    const outputFlagIndex = args.indexOf("--output-last-message");
    if (outputFlagIndex >= 0) {
      await writeFile(args[outputFlagIndex + 1] ?? "", codexOutput.queue.shift() ?? codexOutput.value);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { codexOutput, execaMock };
});

vi.mock("execa", () => ({
  execa: execaMock
}));

describe("CodexCliAdapter", () => {
  beforeEach(() => {
    codexOutput.value = "# Design\n\nGenerated design.";
    codexOutput.queue = [];
    execaMock.mockClear();
  });

  it("defaults the Codex CLI model to gpt-5.5", async () => {
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    await codex.createDesign({
      id: "REQ-001",
      source: "test",
      title: "Model default",
      description: "Verify default model.",
      acceptanceCriteria: [],
      constraints: []
    });

    const args = execaMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
  });

  it("requires project gates and forbids hard-requirement downgrades in design prompts", async () => {
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    await codex.createDesign({
      id: "REQ-001",
      source: "test",
      title: "Transport",
      description: "完整支持自定义 IPv4/IPv6 协议。",
      acceptanceCriteria: ["Windows 7/10/11 都成功编译运行。"],
      constraints: ["不得降级硬需求。"]
    });

    const prompt = execaMock.mock.calls[0]?.[2]?.input as string;
    expect(prompt).toContain("项目门禁边界与放行策略");
    expect(prompt).toContain("禁止把硬需求降级为非一期、条件兼容、可选扩展、实验性、默认关闭、不作为发布阻塞项或仅预留接口");
    expect(prompt).toContain("禁止用抽象适配器、预留接口、feature gate、默认关闭、实验性能力或其他替代边界");
    expect(prompt).toContain("若需求明确要求某类协议、平台、性能、交付形态或兼容矩阵，必须将其作为本次项目门禁定义能力范围、覆盖矩阵和验收证据");
    expect(prompt).toContain("降级表达字典：非一期、二期、后续版本、未来扩展、延后到、条件兼容、可选扩展、实验性、默认关闭、不作为发布阻塞项、仅预留接口");
    expect(prompt).not.toContain("RawIpAdapter");
  });

  it("requires the same project gate rules when revising designs", async () => {
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    await codex.reviseDesign({
      currentDesign: "# Design\n\n## 项目门禁边界与放行策略\n- Old gate.",
      review: {
        workflowId: "WF-001",
        round: 1,
        designer: "codex",
        reviewer: "claude-code",
        designVersion: "design-current",
        reviewDecision: "changes_requested",
        findings: [
          {
            id: "DRF-001",
            title: "补齐门禁",
            body: "必须把 Windows 7/10/11 成功编译运行转成项目门禁。",
            severity: "blocking",
            status: "unresolved"
          }
        ]
      }
    });

    const prompt = execaMock.mock.calls[0]?.[2]?.input as string;
    expect(prompt).toContain("必须包含并更新二级标题：项目门禁边界与放行策略");
    expect(prompt).toContain("requirement.description、acceptanceCriteria、constraints 里的硬需求逐条转成项目门禁");
    expect(prompt).toContain("降级表达字典：非一期、二期、后续版本、未来扩展、延后到、条件兼容、可选扩展、实验性、默认关闭、不作为发布阻塞项、仅预留接口");
  });

  it("normalizes Codex task-plan output that puts rationale fields inside executionPolicy", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending",
          executionPolicy: {
            developerSelfTestRequired: true,
            qaRequired: true,
            regressionRequired: true,
            reviewerRequired: true,
            maxReviewRounds: 3,
            requirePrOrRp: true,
            policyRationale: "Implementation tasks need the full delivery loop."
          }
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.executionPolicy).toEqual(defaultExecutionPolicy);
    expect("policyRationale" in (plan.tasks[0]?.executionPolicy ?? {})).toBe(false);
  });

  it("normalizes Codex design coverage trace aliases and unknown evidence task ids", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      designCoverageTrace: [
        {
          requirement: "IPv6 实现、冒烟或验收证据",
          sourceRef: "目标与非目标",
          status: "covered",
          taskIds: ["TASK-001", "TASK-999"],
          rationale: "IPv6 由 TASK-001 覆盖。"
        }
      ],
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Verify IPv6 support",
          description: "Verify IPv6 support.",
          type: "verification",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "qa",
          acceptanceCriteria: ["IPv6 smoke test passes"],
          aoPrompt: "[WF-001 / TASK-001] Verify IPv6 support.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.designCoverageTrace).toEqual([
      {
        requirementId: "ipv6-support",
        requirement: "IPv6 实现、冒烟或验收证据",
        source: "目标与非目标",
        status: "covered",
        evidenceTaskIds: ["TASK-001"],
        rationale: "IPv6 由 TASK-001 覆盖。"
      }
    ]);
  });

  it("skips unidentifiable Codex design coverage trace entries instead of failing schema parsing", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      designCoverageTrace: [
        {
          status: "covered",
          evidenceTaskIds: ["TASK-001"]
        }
      ],
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.designCoverageTrace).toBeUndefined();
  });

  it("normalizes human reviewer role aliases from Codex task-plan output", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Approve G0 result",
          description: "Human review and release gate for the G0 result.",
          type: "review",
          dependencies: [],
          dependencyCondition: "manual_gate",
          aoRole: "human-reviewer",
          acceptanceCriteria: ["G0 result is reviewed"],
          aoPrompt: "[WF-001 / TASK-001] Review G0 result.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.aoRole).toBe("reviewer");
  });

  it("normalizes calibration task type from Codex task-plan output into review phase calibration", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "G0 reality check",
          description: "Calibrate repository reality before implementation.",
          type: "calibration",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "architect",
          acceptanceCriteria: ["G0 result is documented"],
          aoPrompt: "[WF-001 / TASK-001] G0 reality check.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.type).toBe("review");
    expect(plan.tasks[0]?.phase).toBe("calibration");
  });

  it("repairs invalid task-plan schema output before returning a plan", async () => {
    codexOutput.queue = [
      JSON.stringify({
        workflowId: "WF-001",
        title: "Plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-001",
            title: "Implement feature",
            description: "Implement the feature.",
            type: "implementation",
            dependencies: ["TASK-404"],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Feature works"],
            aoPrompt: "[WF-001 / TASK-001] Implement feature.",
            status: "pending"
          }
        ]
      }),
      JSON.stringify({
        workflowId: "WF-001",
        title: "Plan",
        tasks: [
          {
            taskId: "TASK-001",
            workflowId: "WF-001",
            title: "Implement feature",
            description: "Implement the feature.",
            type: "implementation",
            dependencies: [],
            dependencyCondition: "all_completed",
            aoRole: "backend-senior",
            acceptanceCriteria: ["Feature works"],
            aoPrompt: "[WF-001 / TASK-001] Implement feature.",
            status: "pending"
          }
        ]
      })
    ];
    const codex = new CodexCliAdapter({ codexBin: "codex-test" });

    const plan = await codex.createTaskPlan({
      workflowId: "WF-001",
      approvedDesign: "# Design\n\nApproved design."
    });

    expect(plan.tasks[0]?.dependencies).toEqual([]);
    expect(execaMock).toHaveBeenCalledTimes(2);
    const repairPrompt = execaMock.mock.calls[1]?.[2]?.input as string;
    expect(repairPrompt).toContain("schema repair");
    expect(repairPrompt).toContain("Unknown dependency");
  });

  it("throws a structured repair error when schema repair rounds are exhausted", async () => {
    codexOutput.value = JSON.stringify({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: ["TASK-404"],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });
    const codex = new CodexCliAdapter({ codexBin: "codex-test", schemaRepairRounds: 1 });

    await expect(
      codex.createTaskPlan({
        workflowId: "WF-001",
        approvedDesign: "# Design\n\nApproved design."
      })
    ).rejects.toMatchObject({
      name: "TaskPlanSchemaRepairError",
      repairAttempts: 1
    });
    expect(execaMock).toHaveBeenCalledTimes(2);
  });
});

describe("PlaceholderCodexAdapter", () => {
  it("creates project gates for requirement description, acceptance criteria and constraints", async () => {
    const codex = new PlaceholderCodexAdapter();

    const design = await codex.createDesign({
      id: "WF-001",
      source: "test",
      title: "Transport",
      description: "完整支持自定义 IPv4/IPv6 协议。",
      acceptanceCriteria: ["Windows 7/10/11 都成功编译运行。"],
      constraints: ["不得用替代适配器模糊协议支持。"]
    });

    expect(design).toContain("## 项目门禁边界与放行策略");
    expect(design).toContain("GATE-REQ-001");
    expect(design).toContain("来源：requirement.description");
    expect(design).toContain("GATE-AC-001");
    expect(design).toContain("来源：requirement.acceptanceCriteria[0]");
    expect(design).toContain("GATE-C-001");
    expect(design).toContain("来源：requirement.constraints[0]");
    expect(design).toContain("必需证据");
    expect(design).toContain("阻断策略");
  });

  it("rewrites the project gate section when revising designs", async () => {
    const codex = new PlaceholderCodexAdapter();

    const revised = await codex.reviseDesign({
      currentDesign: [
        "# Design",
        "",
        "## 背景与问题定义",
        "Build it.",
        "",
        "## 目标与非目标",
        "Do it.",
        "",
        "## 影响范围",
        "Code."
      ].join("\n"),
      review: {
        workflowId: "WF-001",
        round: 2,
        designer: "codex",
        reviewer: "claude-code",
        designVersion: "design-current",
        reviewDecision: "changes_requested",
        findings: [
          {
            id: "DRF-SUPPLEMENT-001",
            title: "根据最新需求补充更新设计稿",
            body: "请吸收新增验收标准。",
            severity: "major",
            status: "unresolved",
            rationale: "新增要求：Windows 7/10/11 都成功编译运行。"
          }
        ]
      }
    });

    expect(revised).toContain("## 项目门禁边界与放行策略");
    expect(revised).toContain("GATE-DRF-SUPPLEMENT-001");
    expect(revised).toContain("新增要求：Windows 7/10/11 都成功编译运行。");
    expect(revised.indexOf("## 项目门禁边界与放行策略")).toBeLessThan(
      revised.indexOf("## 影响范围")
    );
    expect(revised).toContain("## 第 2 轮审查整改记录");
  });

  it("keeps revised task plans valid with the default execution policy", async () => {
    const codex = new PlaceholderCodexAdapter();
    const currentPlan: TaskPlan = taskPlanSchema.parse({
      workflowId: "WF-001",
      title: "Plan",
      tasks: [
        {
          taskId: "TASK-001",
          workflowId: "WF-001",
          title: "Implement feature",
          description: "Implement the feature.",
          type: "implementation",
          dependencies: [],
          dependencyCondition: "all_completed",
          aoRole: "backend-senior",
          acceptanceCriteria: ["Feature works"],
          aoPrompt: "[WF-001 / TASK-001] Implement feature.",
          status: "pending"
        }
      ]
    });

    const revised = await codex.reviseTaskPlan({
      currentPlan,
      review: {
        workflowId: "WF-001",
        round: 1,
        planner: "codex",
        reviewer: "claude-code",
        planVersion: "task-plan-current",
        reviewDecision: "changes_requested",
        findings: [
          {
            id: "TPF-001",
            title: "补充验收标准",
            body: "任务计划需要补充验收标准。",
            severity: "major",
            status: "unresolved"
          }
        ]
      }
    });

    expect(taskPlanSchema.safeParse(revised).success).toBe(true);
    expect(revised.tasks[0]?.executionPolicy).toEqual(defaultExecutionPolicy);
  });
});
