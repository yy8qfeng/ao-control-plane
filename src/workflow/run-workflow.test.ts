import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StructuredOutputError, type ClaudeCodeAdapter } from "../adapters/claude-code.js";
import type { CodexAdapter } from "../adapters/codex.js";
import type { DesignReview } from "../schemas/design-review.js";
import type { TaskPlan } from "../schemas/task-plan.js";
import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow", () => {
  it("persists every design, review, and the final task plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-001",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        acceptanceCriteria: ["Feature works"],
        constraints: ["Use AO roles only"],
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    const codex: CodexAdapter = {
      async createDesign() {
        return "# Feature\n\n## 背景与问题定义\nBuild it.";
      },
      async reviseDesign() {
        throw new Error("should not revise approved design");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input): Promise<DesignReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "approved",
          findings: []
        };
      },
      async createTaskPlan(input): Promise<TaskPlan> {
        return {
          workflowId: input.workflowId,
          title: "Plan",
          tasks: [
            {
              taskId: "TASK-001",
              workflowId: input.workflowId,
              title: "Implement feature",
              description: "Implement the feature.",
              type: "implementation",
              dependencies: [],
              dependencyCondition: "all_completed",
              aoRole: "backend-senior",
              acceptanceCriteria: ["Feature works"],
              aoPrompt: "[WF-001 / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. Feature works\n上下文摘要：Follow the approved design.",
              status: "pending"
            }
          ]
        };
      }
    };

    const result = await runWorkflow({
      requirementFile,
      artifactRoot: join(root, "artifacts"),
      codex,
      claudeCode
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.taskPlanPath).toBe(join(root, "artifacts", "WF-001", "task-plan.json"));
    await expect(readFile(join(root, "artifacts", "WF-001", "design.md"), "utf8")).resolves.toContain(
      "# Feature"
    );
    await expect(readFile(join(root, "artifacts", "WF-001", "review-1.json"), "utf8")).resolves.toContain(
      '"reviewDecision": "approved"'
    );
    await expect(readFile(join(root, "artifacts", "WF-001", "task-plan.json"), "utf8")).resolves.toContain(
      '"taskId": "TASK-001"'
    );
  });

  it("plans deferred implementation findings instead of blocking for human", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-DEFER",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    const codex: CodexAdapter = {
      async createDesign() {
        return "# Feature\n\n## 背景与问题定义\nBuild it.";
      },
      async reviseDesign() {
        throw new Error("should not revise deferred implementation findings");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input): Promise<DesignReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "defer_to_implementation",
          findings: [
            {
              id: "DRF-ROLLBACK",
              title: "补充回滚校验",
              body: "实施阶段需要增加回滚校验任务。",
              severity: "major",
              status: "unresolved"
            }
          ]
        };
      },
      async createTaskPlan(input): Promise<TaskPlan> {
        expect(input.deferredFindings?.[0]?.id).toBe("DRF-ROLLBACK");
        return {
          workflowId: input.workflowId,
          title: "Plan",
          tasks: [
            {
              taskId: "TASK-001",
              workflowId: input.workflowId,
              title: "Implement feature",
              description: "Implement the feature and deferred review finding.",
              type: "implementation",
              dependencies: [],
              dependencyCondition: "all_completed",
              aoRole: "backend-senior",
              acceptanceCriteria: ["处理 DRF-ROLLBACK 遗留审查意见"],
              aoPrompt:
                "[WF-DEFER / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. 处理 DRF-ROLLBACK 遗留审查意见\n上下文摘要：Follow the approved design.",
              status: "pending"
            }
          ]
        };
      }
    };

    const result = await runWorkflow({
      requirementFile,
      artifactRoot: join(root, "artifacts"),
      codex,
      claudeCode
    });

    expect(result.workflow.status).toBe("executing");
    expect(result.taskPlanPath).toBe(join(root, "artifacts", "WF-DEFER", "task-plan.json"));
    await expect(readFile(join(root, "artifacts", "WF-DEFER", "review-1.json"), "utf8")).resolves.toContain(
      '"reviewDecision": "defer_to_implementation"'
    );
    await expect(readFile(join(root, "artifacts", "WF-DEFER", "task-plan.json"), "utf8")).resolves.toContain(
      "DRF-ROLLBACK"
    );
  });

  it("fails and writes human review artifacts when ClaudeCode returns invalid structured output", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-002",
        title: "Feature",
        description: "Build the feature."
      }),
      "utf8"
    );

    const codex: CodexAdapter = {
      async createDesign() {
        return "# Feature";
      },
      async reviseDesign() {
        return "# Feature revised";
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(): Promise<DesignReview> {
        throw new StructuredOutputError("invalid review", "not json");
      },
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should not plan after failed review");
      }
    };

    await expect(
      runWorkflow({
        requirementFile,
        artifactRoot: join(root, "artifacts"),
        codex,
        claudeCode
      })
    ).rejects.toThrow("invalid review");

    await expect(
      readFile(join(root, "artifacts", "WF-002", "invalid-claude-output.txt"), "utf8")
    ).resolves.toBe("not json");
    await expect(
      readFile(join(root, "artifacts", "WF-002", "human-review-required.json"), "utf8")
    ).resolves.toContain("invalid review");
  });

  it("continues an existing workflow by revising the current design and appending review rounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-CONTINUE",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    let createDesignCalls = 0;
    let reviseDesignCalls = 0;
    const codex: CodexAdapter = {
      async createDesign() {
        createDesignCalls += 1;
        return "# Feature\n\n## 初稿\nv1";
      },
      async reviseDesign(input) {
        reviseDesignCalls += 1;
        return `${input.currentDesign}\n\n## 续跑更新\n${input.review.findings[0]?.title ?? ""}`;
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(input): Promise<DesignReview> {
        return {
          workflowId: input.workflowId,
          round: input.round,
          designer: "codex",
          reviewer: "claude-code",
          designVersion: input.designVersion,
          reviewDecision: "approved",
          findings: []
        };
      },
      async createTaskPlan(input): Promise<TaskPlan> {
        return {
          workflowId: input.workflowId,
          title: "Plan",
          tasks: [
            {
              taskId: "TASK-001",
              workflowId: input.workflowId,
              title: "Implement feature",
              description: "Implement the feature.",
              type: "implementation",
              dependencies: [],
              dependencyCondition: "all_completed",
              aoRole: "backend-senior",
              acceptanceCriteria: ["Feature works"],
              aoPrompt:
                "[WF-CONTINUE / TASK-001]\n任务名称：Implement feature\nAO 角色：backend-senior\n验收标准：\n1. Feature works\n上下文摘要：Follow the approved design.",
              status: "pending"
            }
          ]
        };
      }
    };

    const artifactRoot = join(root, "artifacts");
    await runWorkflow({ requirementFile, artifactRoot, codex, claudeCode });
    await runWorkflow({ requirementFile, artifactRoot, codex, claudeCode });

    expect(createDesignCalls).toBe(1);
    expect(reviseDesignCalls).toBe(1);
    const artifactEntries = await readdir(join(artifactRoot, "WF-CONTINUE"));
    expect(artifactEntries.filter((entry) => /^design-v\d+\.md$/.test(entry))).toEqual([]);
    expect(artifactEntries).toContain("review-1.json");
    expect(artifactEntries).toContain("review-2.json");
    await expect(readFile(join(artifactRoot, "WF-CONTINUE", "reviews.json"), "utf8")).resolves.toContain(
      '"round": 2'
    );
    await expect(readFile(join(artifactRoot, "WF-CONTINUE", "workflow.json"), "utf8")).resolves.toContain(
      '"designRounds": 2'
    );
    await expect(readFile(join(artifactRoot, "WF-CONTINUE", "design.md"), "utf8")).resolves.toContain(
      "续跑更新"
    );
    await expect(readFile(join(artifactRoot, "WF-CONTINUE", "review-2.json"), "utf8")).resolves.toContain(
      '"round": 2'
    );
  });

  it("persists stopped workflow status when the user aborts the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao-control-plane-workflow-"));
    const requirementFile = join(root, "requirement.json");
    await writeFile(
      requirementFile,
      JSON.stringify({
        id: "WF-STOPPED",
        title: "Feature",
        source: "test",
        description: "Build the feature.",
        maxDesignReviewRounds: 2
      }),
      "utf8"
    );

    const controller = new AbortController();
    const codex: CodexAdapter = {
      async createDesign(_requirement, options) {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Workflow was stopped by user")), {
            once: true
          });
        });
        return "# never";
      },
      async reviseDesign() {
        throw new Error("should not revise stopped workflow");
      }
    };
    const claudeCode: ClaudeCodeAdapter = {
      async reviewDesign(): Promise<DesignReview> {
        throw new Error("should not review stopped workflow");
      },
      async createTaskPlan(): Promise<TaskPlan> {
        throw new Error("should not plan stopped workflow");
      }
    };

    const promise = runWorkflow({
      requirementFile,
      artifactRoot: join(root, "artifacts"),
      codex,
      claudeCode,
      signal: controller.signal
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Workflow was stopped by user");
    await expect(readFile(join(root, "artifacts", "WF-STOPPED", "workflow.json"), "utf8")).resolves.toContain(
      '"status": "stopped"'
    );
  });
});
